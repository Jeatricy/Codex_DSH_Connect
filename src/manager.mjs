import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpWorker, bounded } from './worker.mjs';
import { configureModel, modelCatalog } from './models.mjs';
import { TaskStore, ACTIVE, TERMINAL } from './store.mjs';
import { prepareReviewWorker, readReviewReport, validateReviewEffort } from './review-control.mjs';
import { normalizeMcpServers, summarizeMcpServers } from './mcp.mjs';

function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path.');
  const real = fs.realpathSync.native(cwd);
  if (!fs.statSync(real).isDirectory()) throw new Error('cwd must be a directory.');
  return real;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string.`);
  if (value.length > 128_000) throw new Error(`${name} is too long.`);
  return value;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function safeError(error) {
  return String(error?.message || error).replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]').slice(0, 4000);
}

export class TaskManager {
  constructor(config, { workerFactory = (c, cwd) => new AcpWorker(c, cwd) } = {}) {
    this.config = config; this.workerFactory = workerFactory; this.store = new TaskStore(config.stateDir);
    this.owner = randomUUID(); this.live = new Map(); this.probes = new Set(); this.closing = false;
    this.commandTimer = setInterval(() => this.pollCommands(), 250); this.commandTimer.unref();
  }

  async listModels({ cwd, model, provider } = {}) {
    if (this.closing) throw new Error('Bridge is shutting down.');
    if (this.probes.size) throw new Error('Model discovery is already in progress on this connection.');
    const worker = this.workerFactory(this.config, canonicalCwd(cwd));
    this.probes.add(worker);
    let session;
    // No prompt is submitted: only initialize, discover the catalog, optionally select a model.
    worker.onPermission = async () => ({ outcome: { outcome: 'cancelled' } });
    let timer;
    const discover = async () => {
      await worker.initialize();
      session = await worker.request('session/new', { cwd: canonicalCwd(cwd), mcpServers: [] });
      let options = session.configOptions;
      let selected;
      if (model) {
        selected = await configureModel(worker, session.sessionId, options, model, provider);
        // configureModel returns a selection; query the dependent reasoning options by reselecting it.
        options = (await worker.request('session/set_config_option', {
          sessionId: session.sessionId, configId: 'model', value: selected.selector,
        })).configOptions;
      }
      return { ...modelCatalog(options), selected, note: 'Catalog visibility is not a successful inference test.' };
    };
    try {
      // Bound discovery as a whole, rather than giving every handshake step a fresh budget.
      return await Promise.race([discover(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Model discovery deadline exceeded.')), this.config.startupTimeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      const cleanup = await worker.shutdown(session?.sessionId);
      this.probes.delete(worker);
      if (!cleanup.confirmed) throw new Error('Model catalog worker stop is unconfirmed.');
    }
  }

  limits(input) {
    const timeout = input.timeout_sec === undefined ? this.config.defaultTimeoutMs : input.timeout_sec * 1000;
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 7_200_000) throw new Error('timeout_sec must be between 1 and 7200.');
    const calls = input.max_tool_calls ?? this.config.maxToolCalls;
    if (!Number.isInteger(calls) || calls < 1 || calls > 10_000) throw new Error('max_tool_calls must be an integer between 1 and 10000.');
    return { timeout, calls };
  }

  spawn(input) {
    if (this.closing) throw new Error('Bridge is shutting down.');
    const cwd = canonicalCwd(input.cwd), taskText = text(input.task, 'task'), model = text(input.model, 'model');
    const { timeout, calls } = this.limits(input);
    const mcpServers = normalizeMcpServers(input.mcp_servers === undefined ? [] : input.mcp_servers);
    const now = Date.now();
    const task = {
      id: randomUUID(), cwd, task: taskText, instructions: input.instructions || '',
      requested_model: model, requested_provider: input.provider,
      requested_reasoning_effort: input.reasoning_effort ?? this.config.defaultReasoningEffort,
      requested_review_reasoning_effort: input.review_reasoning_effort ?? this.config.defaultReviewReasoningEffort,
      mcp_servers: mcpServers,
      permission_mode: this.config.autoReview ? 'auto' : 'dsh-profile', auto_review: null,
      state: 'starting', created_at: now, started_at: now, updated_at: now,
      deadline_at: now + timeout, timeout_ms: timeout, max_tool_calls: calls,
      owner_token: this.owner, bridge_pid: process.pid, guardian_pid: null,
      session_id: null, selected_model: null, tool_calls: 0, output_chars: 0, log_bytes: 0,
      prompt_submitted: false, last_progress_at: now, last_progress: 'Starting isolated ACP worker',
      cleanup: null, error: null, stop_reason: null, closed: false, turns: [], permissions: [],
    };
    this.store.reserve(task, this.config.maxConcurrent);
    this.launch(task, false);
    return this.status(task.id);
  }

  send(input) {
    if (this.closing) throw new Error('Bridge is shutting down.');
    const task = this.store.get(input.task_id);
    if (!TERMINAL.has(task.state) || task.state === 'stop_unconfirmed') throw new Error('Wait for confirmed task termination before sending another turn.');
    if (task.closed) throw new Error('This task has been closed.');
    if (!task.session_id) throw new Error('No resumable DSH session was created. Start a new task.');
    if (task.state !== 'completed' && task.prompt_submitted && input.reviewed_partial_work !== true) {
      throw new Error('Review existing output and file changes, then set reviewed_partial_work=true before retrying.');
    }
    const { timeout, calls } = this.limits(input);
    const mcpServers = normalizeMcpServers(input.mcp_servers === undefined ? (task.mcp_servers ?? []) : input.mcp_servers);
    task.turns.push({ started_at: task.started_at, ended_at: task.ended_at, state: task.state,
      model: task.selected_model, auto_review: task.auto_review, error: task.error, cleanup: task.cleanup,
      mcp_servers: summarizeMcpServers(task.mcp_servers) });
    Object.assign(task, {
      task: text(input.message, 'message'), state: 'starting', started_at: Date.now(), updated_at: Date.now(),
      ended_at: null, deadline_at: Date.now() + timeout, timeout_ms: timeout, max_tool_calls: calls,
      requested_model: input.model ?? task.selected_model?.selector ?? task.requested_model,
      requested_provider: input.provider ?? task.requested_provider,
      requested_reasoning_effort: input.reasoning_effort ?? (input.model ? this.config.defaultReasoningEffort
        : task.requested_reasoning_effort ?? this.config.defaultReasoningEffort),
      requested_review_reasoning_effort: input.review_reasoning_effort ?? task.requested_review_reasoning_effort
        ?? this.config.defaultReviewReasoningEffort,
      permission_mode: this.config.autoReview ? 'auto' : 'dsh-profile', auto_review: null,
      selected_model: null, owner_token: this.owner, bridge_pid: process.pid, guardian_pid: null,
      mcp_servers: mcpServers,
      prompt_submitted: false, tool_calls: 0, error: null, cleanup: null, stop_reason: null,
      permissions: [], last_progress_at: Date.now(), last_progress: 'Resuming persistent DSH session',
    });
    this.store.reserve(task, this.config.maxConcurrent); this.launch(task, true);
    return this.status(task.id);
  }

  launch(task, resume) {
    const runtime = { task, worker: null, stopped: false, permissions: new Map(), prompt: null, stopPromise: null,
      outputStart: task.output_chars };
    this.live.set(task.id, runtime);
    // Deadline is armed before any protocol handshake. It does not depend on GPT polling.
    runtime.timer = setTimeout(() => { void this.stopOwned(runtime, 'timed_out', 'Task wall-clock deadline exceeded.'); }, Math.max(1, task.deadline_at - Date.now()));
    runtime.done = this.run(runtime, resume).catch(async error => {
      // Last-resort bookkeeping: run normally handles execution failures and cleanup.
      clearTimeout(runtime.timer);
      try { await runtime.worker?.forceStop(); } catch {}
      task.error = safeError(error); task.state = 'stop_unconfirmed'; task.ended_at = Date.now();
      this.store.save(task); this.live.delete(task.id);
    });
  }

  save(runtime) { runtime.task.updated_at = Date.now(); this.store.save(runtime.task); }

  event(runtime, event) {
    const task = runtime.task;
    const line = JSON.stringify({ time: Date.now(), ...event }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (task.log_bytes + bytes > this.config.maxLogBytes) {
      void this.stopOwned(runtime, 'failed', 'Task log quota exceeded.'); return false;
    }
    this.store.append(task.id, 'events.jsonl', line); task.log_bytes += bytes;
    return true;
  }

  update(runtime, method, params) {
    if (method !== 'session/update' || params.sessionId !== runtime.task.session_id) return;
    const task = runtime.task, update = params.update || {};
    task.last_progress_at = Date.now();
    const kind = update.sessionUpdate;
    const logged = kind === 'agent_thought_chunk'
      ? { sessionUpdate: kind, text_chars: update.content?.text?.length || 0 } : update;
    if (!this.event(runtime, { type: 'update', update: logged })) return;
    if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
      const chunk = update.content.text || '';
      this.store.append(task.id, 'answer.txt', chunk); task.output_chars += chunk.length;
      task.last_progress = 'Assistant output received';
    } else if (kind === 'tool_call') {
      task.tool_calls++; task.last_progress = `Tool: ${String(update.title || 'unnamed').slice(0, 200)}`;
      if (task.tool_calls > task.max_tool_calls) void this.stopOwned(runtime, 'failed', 'Tool-call budget exceeded.');
    } else if (kind === 'tool_call_update') {
      task.last_progress = `Tool ${update.status || 'updated'}: ${update.toolCallId || ''}`;
    } else if (kind === 'agent_thought_chunk') task.last_progress = 'Model activity received';
    this.save(runtime);
  }

  requestPermission(runtime, params) {
    if (runtime.stopped) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    if (params.sessionId !== runtime.task.session_id) throw new Error('Permission request for an unowned session');
    const id = randomUUID();
    const permission = { id, tool_call: params.toolCall, options: (params.options || [])
      .filter(o => o.kind !== 'allow_always' && o.kind !== 'reject_always') };
    runtime.task.permissions.push(permission); runtime.task.state = 'waiting_permission';
    this.event(runtime, { type: 'permission', permission }); this.save(runtime);
    return new Promise(resolve => runtime.permissions.set(id, resolve));
  }

  async run(runtime, resume) {
    const task = runtime.task;
    let outcome = 'failed', cleanup;
    try {
      if (runtime.stopped) return;
      const prepared = prepareReviewWorker(this.config, task, this.store.taskDir(task.id));
      runtime.reviewControl = prepared.control;
      task.review_control = prepared.control ? { nonce: prepared.control.nonce,
        report_file: prepared.control.report_file, events_file: prepared.control.events_file } : null;
      const worker = runtime.worker = this.workerFactory(prepared.config, task.cwd);
      task.guardian_pid = worker.pid; this.save(runtime);
      worker.onPermission = params => this.requestPermission(runtime, params);
      worker.on('notification', (method, params) => {
        try { this.update(runtime, method, params); }
        catch (error) { void this.stopOwned(runtime, 'failed', `Progress persistence failed: ${safeError(error)}`); }
      });
      worker.on('diagnostic', message => {
        // Bound local diagnostic growth as well as structured protocol output.
        if (this.event(runtime, { type: 'diagnostic', message: safeError(message) })) {
          this.store.append(task.id, 'stderr.log', safeError(message) + '\n');
        }
      });
      await worker.initialize();
      if (runtime.stopped) return;
      const session = await worker.request(resume ? 'session/resume' : 'session/new', {
        ...(resume ? { sessionId: task.session_id } : {}), cwd: task.cwd, mcpServers: task.mcp_servers ?? [],
      });
      task.session_id = session.sessionId ?? task.session_id;
      if (!task.session_id) throw new Error('DSH did not return a session ID.');
      task.auto_review = readReviewReport(runtime.reviewControl, task.session_id);
      this.save(runtime);
      if (runtime.stopped) return;
      task.selected_model = await configureModel(worker, task.session_id, session.configOptions,
        task.requested_model, task.requested_provider, task.requested_reasoning_effort);
      if (this.config.autoReview) validateReviewEffort(task.selected_model, task.requested_review_reasoning_effort);
      if (runtime.stopped) return;
      task.state = 'running'; task.prompt_submitted = true;
      task.last_progress = 'Requested model confirmed; task submitted'; this.save(runtime);
      const prompt = [
        task.instructions && `Task constraints:\n${task.instructions}`,
        'Work only within the assigned task. Return results, changed files, and validation evidence. Do not switch to a different model.',
        task.task,
      ].filter(Boolean).join('\n\n');
      runtime.prompt = worker.request('session/prompt', {
        sessionId: task.session_id, prompt: [{ type: 'text', text: prompt }],
      }, 0);
      const result = await runtime.prompt;
      if (runtime.stopped) return;
      task.stop_reason = result.stopReason;
      this.event(runtime, { type: 'prompt_result', result });
      // ACP end_turn alone also covers some DSH error/blocked outcomes. Require an answer
      // and report the protocol stop reason; never infer successful code validation.
      outcome = result.stopReason === 'cancelled' ? 'cancelled'
        : result.stopReason === 'end_turn' && task.output_chars > (runtime.outputStart || 0) ? 'completed' : 'failed';
      if (outcome === 'failed') task.error = `DSH stopped with ${result.stopReason}; no complete answer was confirmed.`;
    } catch (error) {
      if (!runtime.stopped) task.error = safeError(error);
    } finally {
      if (runtime.stopPromise) await runtime.stopPromise;
      clearTimeout(runtime.timer);
      this.clearPermissions(runtime);
      if (runtime.worker) {
        if (!runtime.stopped) { task.state = 'closing'; this.save(runtime); }
        cleanup = await runtime.worker.shutdown(task.session_id);
      } else cleanup = { confirmed: true, forced: false, exit: null };
      task.cleanup = cleanup;
      if (runtime.reviewControl && task.session_id) {
        try { task.auto_review = readReviewReport(runtime.reviewControl, task.session_id); } catch {}
      }
      if (!runtime.stopped && outcome === 'completed' && task.auto_review?.reviews_failed > 0) {
        outcome = 'failed'; task.error = `DSH Auto review failed: ${task.auto_review.last_review?.error || 'review request failed'}`;
      }
      task.state = cleanup.confirmed ? runtime.stopOutcome || outcome : 'stop_unconfirmed';
      task.ended_at = Date.now(); this.save(runtime); this.live.delete(task.id);
    }
  }

  clearPermissions(runtime) {
    for (const resolve of runtime.permissions.values()) resolve({ outcome: { outcome: 'cancelled' } });
    runtime.permissions.clear(); runtime.task.permissions = [];
  }

  stopOwned(runtime, outcome, reason) {
    if (runtime.stopPromise) return runtime.stopPromise;
    runtime.stopped = true; runtime.stopOutcome = outcome; runtime.task.state = 'cancelling';
    runtime.task.error = reason; this.clearPermissions(runtime); this.save(runtime);
    runtime.stopPromise = (async () => {
      const worker = runtime.worker;
      if (!worker) return;
      if (runtime.task.session_id && !worker.rpc.closed) {
        try { worker.notify('session/cancel', { sessionId: runtime.task.session_id }); } catch {}
        if (runtime.prompt) await bounded(runtime.prompt.catch(() => {}), this.config.cancelGraceMs);
      }
      // Also handles a wedged initialize/session-new/model-selection request.
      await worker.shutdown(runtime.task.session_id);
    })();
    return runtime.stopPromise;
  }

  async cancel(id) {
    const runtime = this.live.get(id);
    if (!runtime) {
      const task = this.store.get(id);
      if (ACTIVE.has(task.state)) return this.remote(task, 'cancel', {});
      return this.status(id);
    }
    void this.stopOwned(runtime, 'cancelled', 'Cancelled by caller.');
    return this.status(id);
  }

  async close(id) {
    const runtime = this.live.get(id);
    if (runtime) { runtime.task.closed = true; return this.cancel(id); }
    const task = this.store.get(id);
    if (ACTIVE.has(task.state)) return this.remote(task, 'close', {});
    if (task.state === 'stop_unconfirmed') throw new Error('Recover the unconfirmed stop before closing this task.');
    task.closed = true; this.store.save(task); return this.status(id);
  }

  async respondPermission(id, permissionId, optionId) {
    const runtime = this.live.get(id);
    if (!runtime) return this.remote(this.store.get(id), 'permission', { permission_id: permissionId, option_id: optionId });
    const permission = runtime.task.permissions.find(p => p.id === permissionId);
    if (!permission || !runtime.permissions.has(permissionId)) throw new Error('Permission request is no longer pending.');
    if (!permission.options.some(o => o.optionId === optionId)) throw new Error('Choose an advertised one-shot option ID.');
    runtime.permissions.get(permissionId)({ outcome: { outcome: 'selected', optionId } });
    runtime.permissions.delete(permissionId);
    runtime.task.permissions = runtime.task.permissions.filter(p => p.id !== permissionId);
    runtime.task.state = runtime.permissions.size ? 'waiting_permission' : 'running'; this.save(runtime);
    return this.status(id);
  }

  status(id, maxChars = 6000) {
    const task = this.store.get(id);
    if (task.review_control && task.session_id) {
      try { task.auto_review = readReviewReport(task.review_control, task.session_id); } catch {}
    }
    const output = this.store.read(id, 'answer.txt');
    return {
      ...task, mcp_servers: summarizeMcpServers(task.mcp_servers),
      task: task.task.slice(0, 4000), instructions: task.instructions.slice(0, 2000),
      elapsed_sec: Math.round(((task.ended_at || Date.now()) - task.started_at) / 1000),
      no_progress_sec: Math.round((Date.now() - task.last_progress_at) / 1000),
      slow: ACTIVE.has(task.state) && Date.now() - task.last_progress_at > this.config.idleWarningMs,
      owner_alive: ACTIVE.has(task.state) ? alive(task.bridge_pid) : undefined,
      output_tail: maxChars === 0 ? '' : output.slice(-maxChars), output_truncated: output.length > maxChars,
      artifacts_dir: this.store.taskDir(id),
      task_id: task.id,
      partial_work_may_exist: task.prompt_submitted && task.state !== 'completed',
      completion_note: task.state === 'completed' ? 'ACP returned an answer; the coordinator must validate its claims and file changes.' : undefined,
    };
  }

  list() { return this.store.all().sort((a, b) => b.created_at - a.created_at).map(t => ({
    task_id: t.id, state: t.state, cwd: t.cwd, model: t.selected_model,
    last_progress: t.last_progress, updated_at: t.updated_at,
  })); }

  readOutput(id, offset = 0, maxChars = 12000) {
    this.store.get(id);
    const output = this.store.read(id, 'answer.txt');
    return { task_id: id, text: output.slice(offset, offset + maxChars), offset,
      next_offset: Math.min(output.length, offset + maxChars), total_chars: output.length };
  }

  async wait(id, timeoutMs = 10_000) {
    const deadline = Date.now() + Math.min(timeoutMs, 20_000);
    do {
      const task = this.status(id);
      if (TERMINAL.has(task.state) || task.state === 'waiting_permission') return task;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return this.status(id);
  }

  recover(id) {
    const task = this.store.get(id);
    if (this.live.has(id) || (alive(task.bridge_pid) && task.owner_token !== this.owner)) {
      throw new Error('Owning bridge is still alive; cancel the task through its owner.');
    }
    if (!ACTIVE.has(task.state) && task.state !== 'stop_unconfirmed') return this.status(id);
    // Windows guardian owns a kill-on-close job. A dead guardian confirms its job handle
    // is closed. A missing PID or a possibly reused live PID cannot establish cleanup.
    if (process.platform !== 'win32' || !task.guardian_pid || alive(task.guardian_pid)) {
      task.state = 'stop_unconfirmed'; task.error = 'Cannot confirm worker-tree termination; workspace remains reserved.';
    } else {
      task.state = 'failed'; task.error = 'Owning bridge stopped; its Windows job guardian has exited.';
      task.cleanup = { confirmed: true, forced: true, recovered: true };
    }
    task.ended_at = Date.now(); this.store.save(task); return this.status(id);
  }

  async remote(task, operation, payload) {
    if (!ACTIVE.has(task.state) || !alive(task.bridge_pid)) throw new Error('Task owner is unavailable. Use deepseek_recover to inspect cleanup.');
    const id = randomUUID(); this.store.enqueue(id, task.owner_token, operation, { task_id: task.id, ...payload });
    for (let i = 0; i < 30; i++) {
      await delay(100); const result = this.store.commandResult(id);
      if (result && !result.pending) { if (result.error) throw new Error(result.error); return result.value; }
    }
    throw new Error('Owner has not acknowledged the command. Inspect task status before retrying.');
  }

  pollCommands() {
    try {
      for (const command of this.store.commands(this.owner)) {
        // Mark claimed before dispatch; otherwise the next interval could duplicate it.
        this.store.finishCommand(command.id, { pending: true });
        const p = JSON.parse(command.payload);
        const result = command.operation === 'cancel' ? this.cancel(p.task_id)
          : command.operation === 'close' ? this.close(p.task_id)
          : this.respondPermission(p.task_id, p.permission_id, p.option_id);
        Promise.resolve(result).then(value => this.store.finishCommand(command.id, { value }),
          error => this.store.finishCommand(command.id, { error: safeError(error) }));
      }
    } catch (error) { process.stderr.write(`DSH command dispatch: ${safeError(error)}\n`); }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = (async () => {
      clearInterval(this.commandTimer);
      const running = [...this.live.values()];
      await Promise.allSettled(running.map(r => this.stopOwned(r, 'cancelled', 'MCP connection closed.')));
      await Promise.allSettled(running.map(r => r.done));
      await Promise.allSettled([...this.probes].map(w => w.shutdown()));
      this.store.close();
    })();
    return this.shutdownPromise;
  }
}
