import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from '../src/config.mjs';
import { JsonRpcPeer } from '../src/rpc.mjs';
import { TaskManager } from '../src/manager.mjs';
import { AcpWorker } from '../src/worker.mjs';
import { modelCatalog, selectModel, configureModel } from '../src/models.mjs';
import { callTool, validateArguments } from '../src/tools.mjs';

const temp = path.join(ROOT, '.tmp', 'tests-' + randomUUID());
fs.mkdirSync(temp, { recursive: true });
const configBase = loadConfig();
function config(name, overrides = {}) {
  return { ...configBase, executable: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'acp-worker.mjs')], env: {},
    stateDir: path.join(temp, name), autoReview: false, startupTimeoutMs: 15000, defaultTimeoutMs: 15000,
    cancelGraceMs: 100, closeGraceMs: 200, killGraceMs: 5000, idleWarningMs: 200, ...overrides };
}
function workspace(name) { const dir = path.join(temp, 'workspaces', name); fs.mkdirSync(dir, { recursive: true }); return dir; }
async function until(manager, id, predicate, ms = 20000) {
  const end = Date.now() + ms;
  do { const s = manager.status(id); if (predicate(s)) return s; await delay(30); } while (Date.now() < end);
  throw new Error('Task condition timed out: ' + JSON.stringify(manager.status(id)));
}
const finished = s => ['completed', 'failed', 'timed_out', 'cancelled', 'stop_unconfirmed'].includes(s.state);
function exists(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function manager(t, name, overrides) { const m = new TaskManager(config(name, overrides)); t.after(() => m.shutdown()); return m; }

test('JSON-RPC tolerates split UTF-8 and rejects pending calls on disconnect', async () => {
  const incoming = new PassThrough(), outgoing = new PassThrough();
  const rpc = new JsonRpcPeer(incoming, outgoing);
  const seen = new Promise(resolve => rpc.once('notification', (_, p) => resolve(p)));
  const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notice', params: { text: '模型' } }) + '\n');
  const cut = frame.indexOf(Buffer.from('模')) + 1;
  incoming.write(frame.subarray(0, cut)); incoming.write(frame.subarray(cut));
  assert.equal((await seen).text, '模型');
  const pending = rpc.request('hang', {}); rpc.close();
  await assert.rejects(pending, /closed/);
});

test('model selection is exact and ambiguity is rejected', () => {
  const options = [{ id: 'model', currentValue: 'opaque', options: [
    { group: 'a', options: [{ value: 'opaque', name: 'Same' }] },
    { group: 'b', options: [{ value: 'other', name: 'Same' }] },
  ] }];
  assert.throws(() => selectModel(options, 'Same'), /Ambiguous/);
  assert.equal(selectModel(options, 'Same', 'b').value, 'other');
  assert.throws(() => selectModel(options, 'missing'), /unavailable/);
  assert.equal(modelCatalog(options).models[0].selector, 'opaque');
});

test('model-default allows models with no reasoning control while explicit unsupported strengths fail', async () => {
  const options = [{ id: 'model', currentValue: 'opaque', options: [{ value: 'opaque', name: 'No thinking' }] }];
  const worker = { request: async (_method, params) => {
    assert.equal(params.configId, 'model'); return { configOptions: options };
  } };
  const selected = await configureModel(worker, 'session', options, 'opaque', undefined, 'model-default');
  assert.equal(selected.reasoning_effort, null);
  await assert.rejects(configureModel(worker, 'session', options, 'opaque', undefined, 'high'), /unsupported/);
});

test('tool argument validation rejects bad budgets, unknown keys and path traversal IDs', async t => {
  assert.throws(() => validateArguments('deepseek_wait', { task_id: 'x', timeout_sec: 999 }), /maximum/);
  assert.throws(() => validateArguments('deepseek_spawn', { cwd: 'x', task: 'x', model: 'x', shell: true }), /Unknown/);
  const m = manager(t, 'validation');
  assert.throws(() => m.store.taskDir('../escape'), /Invalid task/);
  await assert.rejects(callTool(m, 'deepseek_spawn', { cwd: '.', task: 'x', model: 'x' }), /absolute/);
});

test('MCP configuration rejects malformed or ambiguous connections before launching work', async t => {
  const m = manager(t, 'mcp-validation'), cwd = workspace('mcp-validation');
  const http = { type: 'http', name: 'UnityMCP', url: 'http://127.0.0.1:8080/mcp' };
  const invalid = [null, {}, [null], [{ ...http, name: '../bad' }], [http, http],
    [{ ...http, type: 'sse' }], [{ ...http, url: 'file:///local' }], [{ ...http, command: process.execPath }],
    [{ ...http, headers: [{ name: 'Authorization', value: 'a' }, { name: 'authorization', value: 'b' }] }],
    [{ ...http, headers: [{ name: 'X-Test', value: 'bad\r\nInjected: header' }] }],
    [{ name: 'local', command: 'relative.exe' }], [{ name: 'local', command: process.execPath, args: [1] }],
    [{ name: 'local', command: process.execPath, env: { TOKEN: 'value' } }],
    [{ name: 'local', command: process.execPath, env: [{ name: 'A=B', value: 'value' }] }],
    Array.from({ length: 33 }, (_, i) => ({ ...http, name: 'server' + i })),
    [{ ...http, headers: [{ name: 'X-Test', value: 'x'.repeat(128001) }] }],
  ];
  for (const mcp_servers of invalid) {
    const args = { cwd, task: 'Answer', model: 'model-a', mcp_servers };
    assert.throws(() => validateArguments('deepseek_spawn', args), /mcp_servers/);
    assert.throws(() => m.spawn(args), /mcp_servers/);
  }
  assert.deepEqual(m.list(), [], 'invalid attachments must not reserve workspaces or create tasks');
});

test('MCP attachments reach ACP new/resume, persist privately, inherit, replace and detach', async t => {
  const m = manager(t, 'mcp-lifecycle'), cwd = workspace('mcp-lifecycle');
  const capture = path.join(cwd, 'mcp.json'), taskText = `Answer\nMCP_CAPTURE_FILE=${capture}`;
  const http = { type: 'http', name: 'UnityMCP', url: 'http://127.0.0.1:8080/mcp?token=fixture-url-secret',
    headers: [{ name: 'Authorization', value: 'Bearer fixture-header-secret' }] };
  const stdio = { type: 'stdio', name: 'local', command: process.execPath,
    args: ['--token', 'fixture-arg-secret'], env: [{ name: 'TOKEN', value: 'fixture-env-secret' }] };
  const expected = [structuredClone(http), { ...structuredClone(stdio) }]; delete expected[1].type;
  const task = await callTool(m, 'deepseek_spawn', { cwd, task: taskText, model: 'model-a', mcp_servers: [http, stdio] });
  http.headers[0].value = 'mutated-after-spawn'; stdio.args.push('mutated-after-spawn');
  const first = await until(m, task.id, finished);
  assert.equal(first.state, 'completed'); assert.deepEqual(JSON.parse(fs.readFileSync(capture)), expected);
  for (const secret of ['fixture-url-secret', 'fixture-header-secret', 'fixture-arg-secret', 'fixture-env-secret']) {
    assert.equal(JSON.stringify(first).includes(secret), false, 'status must contain connection summaries only');
  }
  assert.deepEqual(m.store.get(task.id).mcp_servers, expected, 'private state preserves credentials for resume');
  await m.shutdown();
  const resumed = manager(t, 'mcp-lifecycle');
  await callTool(resumed, 'deepseek_send', { task_id: task.id, message: taskText });
  const inherited = await until(resumed, task.id, finished);
  assert.equal(inherited.state, 'completed'); assert.equal(inherited.session_id, first.session_id);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)), expected, 'new bridge connection inherits persisted attachments');
  assert.throws(() => resumed.send({ task_id: task.id, message: taskText, mcp_servers: null }), /mcp_servers/);
  assert.deepEqual(resumed.store.get(task.id).mcp_servers, expected, 'invalid send leaves saved configuration untouched');
  const replacement = [{ type: 'http', name: 'replacement', url: 'https://localhost/mcp' }];
  await callTool(resumed, 'deepseek_send', { task_id: task.id, message: taskText, mcp_servers: replacement });
  const replaced = await until(resumed, task.id, finished);
  assert.equal(replaced.state, 'completed');
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)), [{ ...replacement[0], headers: [] }]);
  await callTool(resumed, 'deepseek_send', { task_id: task.id, message: taskText, mcp_servers: [] });
  const detached = await until(resumed, task.id, finished);
  assert.equal(detached.state, 'completed'); assert.deepEqual(JSON.parse(fs.readFileSync(capture)), []);
  for (const secret of ['fixture-url-secret', 'fixture-header-secret', 'fixture-arg-secret', 'fixture-env-secret']) {
    assert.equal(JSON.stringify(detached).includes(secret), false, 'historical summaries must also omit credentials');
  }
  const legacy = resumed.store.get(task.id); delete legacy.mcp_servers; resumed.store.save(legacy);
  resumed.send({ task_id: task.id, message: taskText });
  assert.equal((await until(resumed, task.id, finished)).state, 'completed');
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)), [], 'tasks saved before this feature resume with no attachments');
});

test('real isolated worker discovers models and confirms selected model before prompt', async t => {
  const m = manager(t, 'selection'), cwd = workspace('selection');
  const catalog = await m.listModels({ cwd, model: 'model-b' });
  assert.equal(catalog.models.length, 2); assert.equal(catalog.selected.model, 'model-b');
  const start = Date.now();
  const task = m.spawn({ cwd, task: 'Answer', model: 'model-b', reasoning_effort: 'high' });
  assert.ok(Date.now() - start < 1000, 'spawn must return without waiting for worker initialization');
  const done = await until(m, task.id, finished);
  assert.equal(done.state, 'completed'); assert.equal(done.selected_model.model, 'model-b');
  assert.equal(done.selected_model.reasoning_effort, 'high'); assert.match(done.output_tail, /模型验证/);
  assert.ok(done.cleanup.confirmed); assert.notEqual(done.guardian_pid, process.pid);
  const output = m.readOutput(task.id, 0, 7); assert.equal(output.text.length, 7);
  assert.equal(m.status(task.id, 0).output_tail, '');
});

test('unavailable model fails without submitting a prompt or falling back', async t => {
  const m = manager(t, 'missing-model');
  const task = m.spawn({ cwd: workspace('missing-model'), task: 'Answer', model: 'does-not-exist' });
  const done = await until(m, task.id, finished);
  assert.equal(done.state, 'failed'); assert.equal(done.prompt_submitted, false);
  assert.match(done.error, /unavailable/); assert.equal(done.output_tail, ''); assert.ok(done.cleanup.confirmed);
});

test('missing native Auto activation acknowledgement prevents prompt submission', async t => {
  const m = manager(t, 'auto-missing', { autoReview: true });
  const task = m.spawn({ cwd: workspace('auto-missing'), task: 'Answer', model: 'model-a' });
  const done = await until(m, task.id, finished);
  assert.equal(done.state, 'failed'); assert.equal(done.prompt_submitted, false);
  assert.match(done.error, /Auto review did not confirm activation/); assert.ok(done.cleanup.confirmed);
});

test('background deadline stops silent work without polling and records timeout', async t => {
  const m = manager(t, 'deadline');
  const task = m.spawn({ cwd: workspace('deadline'), task: 'TEST_HANG', model: 'model-a', timeout_sec: 4 });
  await delay(6000); // The deadline must fire even while the coordinator is doing nothing.
  const done = m.status(task.id);
  assert.equal(done.state, 'timed_out'); assert.ok(done.cleanup.confirmed); assert.match(done.error, /deadline/);
});

test('stalled cancellation force-kills only the owned worker tree including descendants', async t => {
  const m = manager(t, 'kill-tree'), cwd = workspace('kill-tree'), pidFile = path.join(cwd, 'child.pid');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => unrelated.kill());
  const task = m.spawn({ cwd, task: `TEST_IGNORE_CANCEL\nCHILD_PID_FILE=${pidFile}`, model: 'model-a' });
  await until(m, task.id, s => s.prompt_submitted && fs.existsSync(pidFile));
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(exists(childPid));
  const cancelling = await m.cancel(task.id); assert.equal(cancelling.state, 'cancelling');
  const done = await until(m, task.id, finished);
  assert.equal(done.state, 'cancelled'); assert.ok(done.cleanup.confirmed); assert.ok(done.cleanup.forced);
  await delay(100); assert.equal(exists(childPid), false); assert.ok(exists(unrelated.pid));
});

test('permission requests are explicit, one-shot and cancellable', async t => {
  const m = manager(t, 'permissions');
  const task = m.spawn({ cwd: workspace('permissions'), task: 'TEST_PERMISSION', model: 'model-a' });
  const waiting = await until(m, task.id, s => s.state === 'waiting_permission');
  const p = waiting.permissions[0]; assert.equal(p.options.some(o => o.kind === 'allow_always'), false);
  await assert.rejects(m.respondPermission(task.id, p.id, 'always'), /one-shot/);
  await m.respondPermission(task.id, p.id, 'allow-once');
  const done = await until(m, task.id, finished); assert.equal(done.state, 'completed');
  assert.match(done.output_tail, /granted once/);
  const next = m.send({ task_id: task.id, message: 'TEST_PERMISSION' });
  await until(m, next.id, s => s.state === 'waiting_permission');
  await m.cancel(next.id);
  assert.equal((await until(m, next.id, finished)).state, 'cancelled');
});

test('same and nested workspaces cannot overlap, including across bridge connections', async t => {
  const m = manager(t, 'workspace-lock'), cwd = workspace('workspace-lock');
  const nested = path.join(cwd, 'nested'); fs.mkdirSync(nested);
  const other = new TaskManager(config('workspace-lock')); t.after(() => other.shutdown());
  const task = m.spawn({ cwd, task: 'TEST_HANG', model: 'model-a' });
  assert.throws(() => other.spawn({ cwd: nested, task: 'Answer', model: 'model-a' }), /reserved/);
  await until(m, task.id, s => s.state === 'running');
  await other.cancel(task.id);
  assert.equal((await until(m, task.id, finished)).state, 'cancelled');
});

test('follow-up resumes the same session and can explicitly change model', async t => {
  const m = manager(t, 'resume'), cwd = workspace('resume');
  const task = m.spawn({ cwd, task: 'Answer', model: 'model-a' });
  const first = await until(m, task.id, finished);
  m.send({ task_id: task.id, message: 'Answer again', model: 'model-b', reasoning_effort: 'high' });
  const done = await until(m, task.id, finished);
  assert.equal(done.state, 'completed'); assert.equal(done.session_id, first.session_id);
  assert.equal(done.turns.length, 1); assert.equal(done.selected_model.model, 'model-b');
  m.send({ task_id: task.id, message: 'TEST_EMPTY' });
  const empty = await until(m, task.id, finished);
  assert.equal(empty.state, 'failed', 'old answers must not make an empty follow-up look successful');
  assert.throws(() => m.send({ task_id: task.id, message: 'retry' }), /Review/);
});

test('tool loops and oversized output are bounded', async t => {
  const m = manager(t, 'limits'), task = m.spawn({ cwd: workspace('limits'), task: 'TEST_TOOL_LOOP', model: 'model-a', max_tool_calls: 2 });
  const done = await until(m, task.id, finished); assert.equal(done.state, 'failed'); assert.match(done.error, /budget/);
  const small = manager(t, 'log-quota', { maxLogBytes: 2000 });
  const large = small.spawn({ cwd: workspace('log-quota'), task: 'TEST_LARGE_OUTPUT', model: 'model-a' });
  const over = await until(small, large.id, finished); assert.equal(over.state, 'failed'); assert.match(over.error, /quota/);
});

test('worker crash is a terminal failure with confirmed cleanup', async t => {
  const m = manager(t, 'crash');
  const task = m.spawn({ cwd: workspace('crash'), task: 'TEST_CRASH', model: 'model-a' });
  const done = await until(m, task.id, finished); assert.equal(done.state, 'failed'); assert.ok(done.cleanup.confirmed);
});

test('close persists records and prohibits another follow-up', async t => {
  const m = manager(t, 'close');
  const task = m.spawn({ cwd: workspace('close'), task: 'Answer', model: 'model-a' });
  await until(m, task.id, finished); await m.close(task.id);
  assert.throws(() => m.send({ task_id: task.id, message: 'more' }), /closed/);
  assert.ok(fs.existsSync(path.join(m.store.taskDir(task.id), 'task.json')));
});

test('Windows job guardian reaps a child even if its root already exited', { skip: process.platform !== 'win32' }, async () => {
  const cwd = workspace('early-exit'), pidFile = path.join(cwd, 'child.pid');
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref();process.exit(0);`;
  const worker = new AcpWorker({ ...config('early-exit'), args: ['-e', code, pidFile] }, cwd);
  await worker.exited; await worker.shutdown();
  const pid = Number(fs.readFileSync(pidFile, 'utf8')); await delay(100); assert.equal(exists(pid), false);
});

test('MCP initialize, tool discovery and structured errors work over real stdio', async t => {
  const cfg = config('mcp');
  const file = path.join(temp, 'mcp-config.json');
  fs.writeFileSync(file, JSON.stringify({ executable: process.execPath, args: cfg.args, powershell: cfg.powershell,
    state_dir: cfg.stateDir, auto_review: false, cancel_grace_sec: 0.1, close_grace_sec: 0.2 }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--config', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const peer = new JsonRpcPeer(child.stdout, child.stdin);
  t.after(async () => { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); });
  const init = await peer.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.serverInfo.name, 'codex-dsh-bridge');
  const tools = await peer.request('tools/list', {}); assert.equal(tools.tools.length, 11);
  for (const name of ['deepseek_spawn', 'deepseek_send']) {
    assert.equal(tools.tools.find(tool => tool.name === name).inputSchema.properties.mcp_servers.type, 'array');
  }
  const error = await peer.request('tools/call', { name: 'deepseek_spawn', arguments: { task: 'incomplete' } });
  assert.equal(error.isError, true); assert.match(error.content[0].text, /Missing/);
  const catalog = await peer.request('tools/call', { name: 'deepseek_list_models', arguments: { cwd: workspace('mcp') } });
  assert.equal(catalog.structuredContent.models.length, 2);
  const capture = path.join(workspace('mcp'), 'attached.json');
  const attached = await peer.request('tools/call', { name: 'deepseek_spawn', arguments: {
    cwd: workspace('mcp'), task: `Answer\nMCP_CAPTURE_FILE=${capture}`, model: 'model-a',
    mcp_servers: [{ type: 'http', name: 'UnityMCP', url: 'http://127.0.0.1:8080/mcp' }],
  } });
  assert.equal(attached.isError, undefined);
  const deadline = Date.now() + 20000;
  let status;
  do {
    status = (await peer.request('tools/call', { name: 'deepseek_status', arguments: { task_id: attached.structuredContent.id } })).structuredContent;
    if (finished(status)) break;
    await delay(30);
  } while (Date.now() < deadline);
  assert.equal(status.state, 'completed'); assert.ok(status.cleanup.confirmed);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)), [{ type: 'http', name: 'UnityMCP', url: 'http://127.0.0.1:8080/mcp', headers: [] }]);
});

test('a dead MCP bridge cannot leave its Windows task tree running; orphan recovery checks the guardian', { skip: process.platform !== 'win32' }, async t => {
  const cfg = config('bridge-death'), cwd = workspace('bridge-death');
  const file = path.join(temp, 'death-config.json'), pidFile = path.join(cwd, 'child.pid');
  fs.writeFileSync(file, JSON.stringify({ executable: process.execPath, args: cfg.args, powershell: cfg.powershell,
    state_dir: cfg.stateDir, auto_review: false, startup_timeout_sec: 15 }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--config', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); t.after(() => child.kill('SIGKILL'));
  const peer = new JsonRpcPeer(child.stdout, child.stdin);
  await peer.request('initialize', { protocolVersion: '2025-11-25' });
  const spawned = (await peer.request('tools/call', { name: 'deepseek_spawn', arguments: {
    cwd, task: `TEST_IGNORE_CANCEL\nCHILD_PID_FILE=${pidFile}`, model: 'model-a',
  } })).structuredContent;
  const end = Date.now() + 20000;
  while (!fs.existsSync(pidFile) && Date.now() < end) await delay(50);
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await gone;
  const deadline = Date.now() + 8000;
  while (exists(pid) && Date.now() < deadline) await delay(100);
  assert.equal(exists(pid), false, 'guard must kill descendants after parent-pipe EOF');
  const m = manager(t, 'bridge-death');
  assert.throws(() => m.spawn({ cwd, task: 'new', model: 'model-a' }), /reserved/);
  const recovered = m.recover(spawned.id); assert.equal(recovered.state, 'failed'); assert.ok(recovered.cleanup.confirmed);
});

test('unconfirmed cleanup holds the workspace until verified recovery', { skip: process.platform !== 'win32' }, async t => {
  const cfg = config('uncertain'), cwd = workspace('uncertain');
  const m = new TaskManager(cfg, { workerFactory: (c, dir) => {
    const worker = new AcpWorker(c, dir), original = worker.shutdown.bind(worker);
    worker.shutdown = async (...args) => { await original(...args); return { confirmed: false, forced: true }; };
    return worker;
  } });
  t.after(() => m.shutdown());
  const task = m.spawn({ cwd, task: 'Answer', model: 'model-a' });
  const done = await until(m, task.id, finished); assert.equal(done.state, 'stop_unconfirmed');
  assert.throws(() => m.spawn({ cwd, task: 'new', model: 'model-a' }), /reserved/);
  assert.equal(m.recover(task.id).cleanup.confirmed, true);
});
