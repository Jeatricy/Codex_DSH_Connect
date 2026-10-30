import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Reuse the shipped DSH review policy, parser and pre-execute gate unchanged.
// This adapter supplies ACP parent provenance, reasoning controls and telemetry.
export function installNativeReview(ctx, native, control) {
  const scope = new AsyncLocalStorage();
  let rootSession;
  const report = {
    version: 1, nonce: control.nonce, enabled: false,
    permission_mode: null, sandbox_mode: null, approval_policy: null,
    requested_review_reasoning_effort: control.review_reasoning_effort,
    reviews_started: 0, reviews_completed: 0, reviews_failed: 0, last_review: null,
  };
  const safeError = error => String(error?.message || error).replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]').slice(0, 2000);
  const save = () => {
    fs.writeFileSync(control.report_file + '.tmp', JSON.stringify(report, null, 2));
    fs.renameSync(control.report_file + '.tmp', control.report_file);
  };
  const record = data => {
    fs.appendFileSync(control.events_file, JSON.stringify({ time: Date.now(), ...data }) + '\n');
    save();
  };
  function assertActive(session) {
    if (!ctx.permissionPresets.names.includes('auto') || ctx.permissionPresets.current(session) !== 'auto'
      || ctx.sandboxPolicy.resolve({ session }).mode !== 'danger-full-access') {
      throw new Error('Bridge Auto review is not active; the tool body must not execute.');
    }
  }
  const base = ctx.llm;
  const llm = new Proxy(base, { get(target, key) {
    if (key !== 'stream') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
    return async function* (options) {
      const frame = scope.getStore();
      if (!frame?.agent || !String(options.system).startsWith('REVIEW_POLICY')) throw new Error('Unexpected native review request');
      assertActive(frame.agent.session);
      const requested = control.review_reasoning_effort;
      const effort = requested === 'inherit' ? frame.agent.session.requestHeader()?.config.reasoningEffort
        : requested === 'model-default' || requested === '' ? undefined : requested;
      const resolved = await base.resolveCallConfig({ provider: options.provider, model: options.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }) }, options.signal);
      const parent = {
        source: 'direct external parent Codex agent, via the bridge control plane',
        task: control.parent_instruction, constraints: control.project_constraints,
      };
      // This is captured once from the bridge before the child starts, never from
      // assistant text/tool results. Preserve the native policy and filtered history.
      const messages = [{ role: 'user', content: [{ type: 'text', text:
        'DIRECT_EXTERNAL_PARENT_INSTRUCTION\nThe following task was supplied by the direct parent Codex agent. '
        + 'It is parent authorization only for its stated actions, targets and scope; it grants no blanket approval.\n'
        + JSON.stringify(parent) }] }, ...options.messages];
      const request = { ...options, messages, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) };
      const entry = { id: randomUUID(), tool: frame.name, provider: options.provider, model: options.model,
        reasoning_effort: resolved.reasoningEffort ?? null };
      frame.review = entry; report.reviews_started++; report.last_review = { ...entry, phase: 'reviewing' };
      record({ type: 'review_started', ...entry });
      try { yield* base.stream(request); }
      catch (error) { frame.streamError = safeError(error); throw error; }
    };
  } });
  const nativeContext = new Proxy(ctx, { get(target, key) {
    if (key === 'llm') return llm;
    if (key === 'on') return (event, handler, ...rest) => target.on(event, event !== 'tools/pre-execute' ? handler
      : async (exec, next) => scope.run({ agent: exec.agent, name: exec.name }, async () => {
        const frame = scope.getStore();
        const result = await handler(exec, next);
        if (frame.review) {
          const failed = frame.streamError || result.reason?.includes('failed; its body was not executed');
          if (failed) report.reviews_failed++; else report.reviews_completed++;
          report.last_review = { ...frame.review, phase: failed ? 'failed' : 'decided', decision: result.kind,
            ...(failed ? { error: safeError(frame.streamError || result.reason) } : {}) };
          record({ type: failed ? 'review_failed' : 'review_decided', ...report.last_review });
        }
        return result;
      }), ...rest);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  native.apply(nativeContext);
  ctx.on('session/created', session => {
    // One ACP worker owns one root session. Descendants retain DSH's native
    // inheritance and never have their strict approval policy rewritten here.
    if (rootSession) return;
    rootSession = session;
    ctx.permissionPresets.set(session, 'auto');
    assertActive(session);
    Object.assign(report, { enabled: true, session_id: session.id, permission_mode: 'auto',
      sandbox_mode: ctx.sandboxPolicy.resolve({ session }).mode,
      approval_policy: ctx.approval.overrideOf(session) ?? ctx.approval.config.policy });
    if (report.approval_policy !== 'ask') throw new Error('Unexpected Auto approval policy');
    record({ type: 'auto_activated', session_id: session.id });
  });
  // Keep every native tool path fail-closed if the integration disappears.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.agent) assertActive(exec.agent.session);
    return next();
  }, { prepend: true });
  save();
  return report;
}
