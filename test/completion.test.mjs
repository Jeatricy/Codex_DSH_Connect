import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, loadConfig } from '../src/config.mjs';
import { TaskStore } from '../src/store.mjs';
import { TaskManager } from '../src/manager.mjs';
import { normalizeCompletion, nextCompletion } from '../src/completion.mjs';
import { waitForCompletion } from '../src/completion-hook.mjs';
import { hookDefinition, installCompletionHook, mergeCompletionHook, STATUS } from '../src/install-completion.mjs';
import { validateArguments } from '../src/tools.mjs';
import { JsonRpcPeer } from '../src/rpc.mjs';
import { writeReviewReport } from '../src/review-report.mjs';

const temp = path.join(ROOT, '.tmp', 'completion-' + randomUUID());
fs.mkdirSync(temp, { recursive: true });
const thread = randomUUID();
const stop = { hook_event_name: 'Stop', session_id: thread };
function store(t) { const s = new TaskStore(path.join(temp, randomUUID())); t.after(() => s.close()); return s; }
function task(s, overrides = {}) {
  const record = { id: randomUUID(), cwd: temp, state: 'running', bridge_pid: process.pid,
    started_at: Date.now(), completion: normalizeCompletion({ thread_id: thread, follow_up: 'Review changes and test.' }),
    permissions: [], ...overrides };
  s.reserve(record, 100); return record;
}
const wait = (s, extra = {}) => waitForCompletion({ stateDir: s.directory, input: stop, intervalMs: 10, maxWaitMs: 3000, ...extra });
function hook(stateDir, input = stop, command) {
  const child = command
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
    : spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts', 'completion-hook.mjs'), '--state-dir', stateDir], { windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
  child.stdin.end(JSON.stringify(input));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Hook exited ${code}: ${errors}`)));
  });
  return { child, done, output: () => output };
}

test('completion validates explicit targets and never forwards unexpected fields', () => {
  for (const completion of [[], 'x', {}, { thread_id: 'current' }, { thread_id: thread, follow_up: 1 },
    { thread_id: thread, follow_up: 'x'.repeat(2001) }, { thread_id: thread, run_id: randomUUID() }]) {
    assert.throws(() => normalizeCompletion(completion), /completion/);
    assert.throws(() => validateArguments('deepseek_send', { task_id: 'x', message: 'next', completion }), /completion/);
  }
  const first = normalizeCompletion({ thread_id: thread.toUpperCase() });
  assert.equal(first.thread_id, thread);
  assert.notEqual(nextCompletion(undefined, first).run_id, first.run_id);
  assert.equal(nextCompletion(null, first), null);
});

test('unarmed, legacy, wrong-chat and non-Stop calls are fast no-ops', async t => {
  const s = store(t);
  task(s, { completion: null, state: 'completed', ended_at: Date.now() });
  task(s, { completion: undefined, state: 'completed', ended_at: Date.now() });
  task(s, { completion: normalizeCompletion({ thread_id: randomUUID() }), state: 'completed', ended_at: Date.now() });
  assert.deepEqual(await wait(s), {});
  assert.deepEqual(await wait(s, { input: { ...stop, hook_event_name: 'SessionEnd' } }), {});
  assert.deepEqual(await wait(s, { input: { ...stop, session_id: 'bad' } }), {});
  assert.deepEqual(await waitForCompletion({ stateDir: path.join(temp, 'absent'), input: stop }), {});
});

test('terminal outcomes are delivered once across concurrent hook processes without output/credential leakage', async t => {
  const s = store(t);
  for (const state of ['completed', 'failed', 'timed_out', 'cancelled', 'stop_unconfirmed']) task(s, {
    state, ended_at: Date.now(), cleanup: { confirmed: state !== 'stop_unconfirmed' },
    task: 'CHILD_INJECTION', error: 'SECRET_ERROR', instructions: 'SECRET_INSTRUCTIONS',
    mcp_servers: [{ name: 'x', headers: [{ name: 'Authorization', value: 'SECRET_TOKEN' }] }],
  });
  const results = await Promise.all([hook(s.directory).done, hook(s.directory).done]);
  assert.equal(results.filter(r => r.decision === 'block').length, 1);
  const reason = results.find(r => r.decision === 'block').reason;
  for (const state of ['completed', 'failed', 'timed_out', 'cancelled', 'stop_unconfirmed']) assert.ok(reason.includes(state));
  assert.ok(reason.includes('Review changes and test.'));
  assert.doesNotMatch(reason, /SECRET_|CHILD_INJECTION/);
  assert.deepEqual(await wait(s, { input: { ...stop, stop_hook_active: true } }), {});
});

test('local waiter stays silent through progress and only continues after final cleanup is saved', async t => {
  const s = store(t), record = task(s), running = hook(s.directory);
  t.after(() => { if (running.child.exitCode === null) running.child.kill(); });
  await delay(200);
  record.last_progress = 'still working'; s.save(record);
  await delay(100); assert.equal(running.output(), '');
  record.state = 'closing'; s.save(record);
  await delay(100); assert.equal(running.output(), '');
  Object.assign(record, { state: 'completed', ended_at: Date.now(), cleanup: { confirmed: true } }); s.save(record);
  const result = await running.done;
  assert.equal(result.decision, 'block'); assert.match(result.reason, /"cleanup_confirmed":true/);
});

test('permissions notify once, permit human waiting, and resume to terminal notification', async t => {
  const s = store(t), record = task(s, { state: 'waiting_permission', permissions: [{ id: randomUUID(), tool_call: 'SECRET_TOOL' }] });
  assert.match((await wait(s)).reason, /waiting_permission/);
  assert.deepEqual(await wait(s), {});
  record.permissions = [{ id: randomUUID() }]; s.save(record);
  assert.equal((await wait(s)).decision, 'block');
  record.permissions = []; record.state = 'running'; s.save(record);
  const pending = wait(s);
  await delay(30); Object.assign(record, { state: 'completed', ended_at: Date.now(), cleanup: { confirmed: true } }); s.save(record);
  assert.match((await pending).reason, /"event":"completed"/);
});

test('bridge loss and local deadline produce bounded recovery events without killing or rewriting task state', async t => {
  const s = store(t), record = task(s, { bridge_pid: 2147483647 });
  assert.match((await wait(s)).reason, /bridge_disconnected/);
  assert.equal(s.get(record.id).state, 'running');
  assert.deepEqual(await wait(s), {});
  const another = store(t); task(another);
  assert.match((await wait(another, { maxWaitMs: 20 })).reason, /wait_expired/);
  // A previously surfaced wait limit must not start another two-hour wait on the next Stop.
  assert.deepEqual(await wait(another), {});
});

test('new rounds inherit, replace or disable completion and can notify during a hook continuation', async t => {
  const config = { ...loadConfig(), executable: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'acp-worker.mjs')],
    env: {}, autoReview: false, stateDir: path.join(temp, randomUUID()), startupTimeoutMs: 15000,
    defaultTimeoutMs: 15000, cancelGraceMs: 100, closeGraceMs: 200, killGraceMs: 5000 };
  const m = new TaskManager(config); t.after(() => m.shutdown());
  const cwd = path.join(temp, 'work'); fs.mkdirSync(cwd, { recursive: true });
  const initial = m.spawn({ cwd, task: 'Answer', model: 'model-a', completion: { thread_id: thread, follow_up: 'Review.' } });
  async function complete() {
    const end = Date.now() + 20000;
    while (!m.store.get(initial.id).ended_at && Date.now() < end) await delay(30);
    assert.equal(m.status(initial.id).state, 'completed');
  }
  await complete(); assert.equal((await wait(m.store)).decision, 'block');
  const second = m.send({ task_id: initial.id, message: 'Answer again' });
  assert.notEqual(second.completion.run_id, initial.completion.run_id);
  assert.equal(second.completion.follow_up, 'Review.');
  await complete(); assert.equal((await wait(m.store, { input: { ...stop, stop_hook_active: true } })).decision, 'block');
  const other = randomUUID();
  m.send({ task_id: initial.id, message: 'Third', completion: { thread_id: other } });
  await complete(); assert.deepEqual(await wait(m.store), {});
  assert.equal((await wait(m.store, { input: { ...stop, session_id: other } })).decision, 'block');
  m.send({ task_id: initial.id, message: 'Fourth', completion: null });
  await complete(); assert.equal(m.status(initial.id).completion, null);
  assert.deepEqual(await wait(m.store, { input: { ...stop, session_id: other } }), {});
});

test('real ACP cancellation and cleanup drive the standalone Stop hook', async t => {
  const m = new TaskManager({ ...loadConfig(), executable: process.execPath,
    args: [path.join(ROOT, 'test', 'fixtures', 'acp-worker.mjs')], env: {}, autoReview: false,
    stateDir: path.join(temp, randomUUID()), cancelGraceMs: 100, closeGraceMs: 200, killGraceMs: 5000 });
  t.after(() => m.shutdown());
  const cwd = path.join(temp, 'cancel-work'); fs.mkdirSync(cwd, { recursive: true });
  const running = m.spawn({ cwd, task: 'TEST_HANG', model: 'model-a', completion: { thread_id: thread } });
  const watcher = hook(m.store.directory);
  t.after(() => { if (watcher.child.exitCode === null) watcher.child.kill(); });
  await delay(300); assert.equal(watcher.output(), '');
  await m.cancel(running.id);
  const result = await watcher.done;
  assert.match(result.reason, /"event":"cancelled"/);
  assert.match(result.reason, /"cleanup_confirmed":true/);
});

test('public MCP stdio accepts completion and delivers a task result to its parent hook', async t => {
  const directory = path.join(temp, 'public-mcp'); fs.mkdirSync(directory, { recursive: true });
  const stateDir = path.join(directory, 'state'), configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ executable: process.execPath,
    args: [path.join(ROOT, 'test', 'fixtures', 'acp-worker.mjs')], auto_review: false,
    state_dir: stateDir, default_timeout_sec: 15, cancel_grace_sec: 0.1, close_grace_sec: 0.2 }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--config', configFile], { windowsHide: true });
  const rpc = new JsonRpcPeer(child.stdout, child.stdin);
  child.stderr.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { rpc.close(); child.stdin.end(); await exited; });
  const info = await rpc.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'completion-test', version: '1' }, capabilities: {} });
  assert.equal(info.serverInfo.version, '0.3.0');
  const list = await rpc.request('tools/list', {});
  assert.ok(list.tools.find(tool => tool.name === 'deepseek_spawn').inputSchema.properties.completion);
  const invalid = await rpc.request('tools/call', { name: 'deepseek_spawn', arguments: {
    cwd: directory, model: 'model-a', task: 'Answer', completion: { thread_id: 'guessed-thread' },
  } });
  assert.equal(invalid.isError, true);
  const spawned = await rpc.request('tools/call', { name: 'deepseek_spawn', arguments: {
    cwd: directory, model: 'model-a', task: 'Answer', completion: { thread_id: thread, follow_up: 'Verify this result.' },
  } });
  assert.equal(spawned.isError, undefined);
  const result = await hook(stateDir).done;
  assert.match(result.reason, /"event":"completed"/);
  assert.match(result.reason, /Verify this result/);
  assert.ok(result.reason.includes(spawned.structuredContent.id));
});

test('installer preserves existing hooks, backs up, is idempotent and removes only its own hook', t => {
  const hooksFile = path.join(temp, randomUUID(), 'hooks.json');
  const original = { setting: true, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing-start' }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'existing-stop' }] }] } };
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true }); fs.writeFileSync(hooksFile, JSON.stringify(original));
  const definition = hookDefinition({ root: ROOT, stateDir: path.join(temp, 'state') });
  const installed = installCompletionHook({ hooksFile, definition });
  assert.equal(installed.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(installed.backup, 'utf8')), original);
  assert.equal(installCompletionHook({ hooksFile, definition }).changed, false);
  const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  assert.equal(after.hooks.Stop.filter(g => g.hooks.some(h => h.statusMessage === STATUS)).length, 1);
  installCompletionHook({ hooksFile, definition: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile, 'utf8')), original);
  fs.writeFileSync(hooksFile, '{broken');
  assert.throws(() => installCompletionHook({ hooksFile, definition }));
  assert.equal(fs.readFileSync(hooksFile, 'utf8'), '{broken');
  assert.throws(() => mergeCompletionHook({ hooks: { Stop: {} } }, definition), /Invalid/);
});

test('Windows installed command and UTF-8 wrapper preserve special paths and emit clean JSON', { skip: process.platform !== 'win32' }, async t => {
  const stateDir = path.join(temp, "state & $value `tick 'quote %PATH% 中文");
  const s = new TaskStore(stateDir); t.after(() => s.close());
  task(s, { state: 'completed', ended_at: Date.now() });
  const definition = hookDefinition({ root: ROOT, stateDir });
  const result = await hook(stateDir, stop, definition.command).done;
  assert.equal(result.decision, 'block');
});

test('hook CLI reports malformed state once and does not create a continuation loop', async t => {
  const stateDir = path.join(temp, randomUUID()); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'bridge.sqlite'), 'invalid database');
  assert.equal((await hook(stateDir).done).decision, 'block');
  assert.deepEqual(await hook(stateDir, { ...stop, stop_hook_active: true }).done, {});
});

test('review snapshots survive temporary Windows destination locks and bound persistent failures', t => {
  const file = path.join(temp, 'locked-review.json');
  fs.writeFileSync(file, JSON.stringify({ phase: 'reviewing' }));
  const rename = fs.renameSync;
  let calls = 0;
  const mocked = t.mock.method(fs, 'renameSync', (...args) => {
    calls++;
    if (calls <= 2) {
      assert.equal(JSON.parse(fs.readFileSync(file)).phase, 'reviewing');
      throw Object.assign(new Error('Windows destination locked'), { code: 'EPERM' });
    }
    return rename(...args);
  });
  writeReviewReport(file, { phase: 'failed', reviews_failed: 1 });
  assert.equal(calls, 3);
  assert.equal(JSON.parse(fs.readFileSync(file)).reviews_failed, 1);
  mocked.mock.mockImplementation(() => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); });
  const start = Date.now();
  assert.throws(() => writeReviewReport(file, { phase: 'decided' }), /locked/);
  assert.ok(Date.now() - start < 2000);
  assert.equal(JSON.parse(fs.readFileSync(file)).phase, 'failed');
});
