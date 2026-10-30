import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, ROOT } from '../src/config.mjs';
import { TaskManager } from '../src/manager.mjs';
import { TERMINAL } from '../src/store.mjs';

// Real packaged DSH, real native reviewer/parser/tool pipeline. Only the model
// endpoint is local and deterministic; these tests spend no provider credits.
async function environment(t, verdict = 'allow') {
  const directory = path.join(ROOT, '.tmp', 'native-auto-' + randomUUID());
  const cwd = path.join(directory, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  const target = path.join(directory, 'outside-workspace.txt');
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    if (request.url.endsWith('/models')) {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return;
    }
    const body = JSON.parse(raw); requests.push(body);
    const review = JSON.stringify(body.messages).includes('DIRECT_EXTERNAL_PARENT_INSTRUCTION');
    if (review && verdict === 'hang') return;
    let delta, finish;
    if (review) {
      delta = { content: verdict === 'malformed' ? 'invalid reviewer output'
        : JSON.stringify({ risk: 'medium', decision: verdict }) }; finish = 'stop';
    } else if (body.messages?.findLastIndex(m => m.role === 'tool') > body.messages?.findLastIndex(m =>
      m.role === 'user' && JSON.stringify(m.content).includes('This exact write outside the workspace is authorized.'))) {
      delta = { content: 'MOCK_TASK_DONE' }; finish = 'stop';
    } else {
      const functions = (body.tools || []).map(tool => tool.function || tool);
      const write = functions.find(f => f.name === 'write');
      const run = functions.find(f => /run_code$/.test(f.name));
      if (!write && !run) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `No write/run_code tool: ${functions.map(f => f.name).join(',')}` } })); return;
      }
      const selected = write || run;
      const input = write ? { file_path: target, content: 'AUTO_REVIEW_TEST_OK' }
        : { code: `await tools.write(${JSON.stringify({ file_path: target, content: 'AUTO_REVIEW_TEST_OK' })});` };
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call-write-fixture', type: 'function',
        function: { name: selected.name, arguments: JSON.stringify(input) } }] }; finish = 'tool_calls';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta_, reason) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk',
      created: 1, model: 'fixture-model', choices: [{ index: 0, delta: delta_, finish_reason: reason }] });
    response.write('data: ' + JSON.stringify(chunk(delta, null)) + '\n\n');
    response.write('data: ' + JSON.stringify(chunk({}, finish)) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const patch = path.join(directory, 'mock-model.patch.yml');
  fs.writeFileSync(patch, JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { 'bridge-test': {
      api: 'openai-completions', apiKeyEnv: 'DSH_BRIDGE_FIXTURE_KEY',
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: [{ id: 'fixture-model', contextWindow: 262144, maxTokens: 8192,
        reasoningEfforts: { low: 'low', high: 'high' } }],
    } } } },
    { id: 'acp', config: { provider: 'bridge-test', model: 'fixture-model' } },
  ]));
  const base = loadConfig();
  const manager = new TaskManager({ ...base, stateDir: path.join(directory, 'state'),
    args: [...base.args, '--patch', patch], env: { ...base.env, DSH_BRIDGE_FIXTURE_KEY: 'fixture-no-real-secret' },
    cancelGraceMs: 300, closeGraceMs: 400, startupTimeoutMs: 15000 });
  t.after(() => manager.shutdown());
  const spawn = extra => manager.spawn({ cwd, provider: 'bridge-test', model: 'fixture-model',
    task: `Create the new file ${target} with AUTO_REVIEW_TEST_OK. This exact write outside the workspace is authorized.`,
    reasoning_effort: 'low', review_reasoning_effort: 'high', timeout_sec: 30, ...extra });
  return { manager, requests, cwd, target, spawn };
}
async function until(m, id, predicate, ms = 40000) {
  const end = Date.now() + ms;
  do { const status = m.status(id); if (predicate(status)) return status; await delay(50); } while (Date.now() < end);
  throw new Error('Native DSH task timed out in test: ' + JSON.stringify(m.status(id)));
}
const terminal = s => TERMINAL.has(s.state);

test('native DSH Auto review allows an authorized Full access write and sends separate reasoning strengths', async t => {
  const e = await environment(t); const task = e.spawn();
  const done = await until(e.manager, task.id, terminal);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.auto_review.permission_mode, 'auto');
  assert.equal(done.auto_review.sandbox_mode, 'danger-full-access');
  assert.equal(done.auto_review.approval_policy, 'ask');
  assert.ok(done.auto_review.reviews_completed > 0, JSON.stringify(done));
  assert.equal(fs.readFileSync(e.target, 'utf8'), 'AUTO_REVIEW_TEST_OK');
  const review = e.requests.find(r => JSON.stringify(r.messages).includes('DIRECT_EXTERNAL_PARENT_INSTRUCTION'));
  assert.ok(review, 'native reviewer must actually call the model');
  assert.equal(review.reasoning_effort, 'high');
  assert.equal(e.requests[0].reasoning_effort, 'low');
  assert.ok(JSON.stringify(review.messages).includes('DIRECT_EXTERNAL_PARENT_INSTRUCTION'));
  assert.ok(done.cleanup.confirmed);
});

test('native reviewer denial enters one-shot approval and does not execute a rejected action', async t => {
  const e = await environment(t, 'deny'); const task = e.spawn();
  const waiting = await until(e.manager, task.id, s => s.state === 'waiting_permission' || terminal(s));
  assert.equal(waiting.state, 'waiting_permission', JSON.stringify(waiting));
  assert.equal(fs.existsSync(e.target), false);
  const permission = waiting.permissions[0];
  const reject = permission.options.find(o => o.kind === 'reject_once'); assert.ok(reject);
  await e.manager.respondPermission(task.id, permission.id, reject.optionId);
  const done = await until(e.manager, task.id, terminal);
  assert.equal(fs.existsSync(e.target), false); assert.ok(done.cleanup.confirmed);
});

test('native malformed reviewer output fails closed without running the file write', async t => {
  const e = await environment(t, 'malformed'); const task = e.spawn();
  const done = await until(e.manager, task.id, terminal);
  assert.equal(fs.existsSync(e.target), false);
  assert.ok(done.auto_review?.reviews_failed > 0, JSON.stringify(done));
  assert.equal(done.state, 'failed');
  assert.ok(done.cleanup.confirmed);
});

test('a hung native reviewer is bounded by the task deadline and worker-tree cleanup', async t => {
  const e = await environment(t, 'hang'); const task = e.spawn({ timeout_sec: 10 });
  const done = await until(e.manager, task.id, terminal);
  assert.equal(done.state, 'timed_out', JSON.stringify(done));
  assert.equal(fs.existsSync(e.target), false); assert.ok(done.cleanup.confirmed);
});

test('unsupported reviewer reasoning is rejected before any model task is submitted', async t => {
  const e = await environment(t); const task = e.spawn({ review_reasoning_effort: 'not-an-effort' });
  const done = await until(e.manager, task.id, terminal);
  assert.equal(done.state, 'failed'); assert.equal(done.prompt_submitted, false);
  assert.match(done.error, /Review reasoning effort/); assert.equal(e.requests.length, 0);
});

test('inherit uses the current task reasoning for native review', async t => {
  const e = await environment(t); const task = e.spawn({ reasoning_effort: 'low', review_reasoning_effort: 'inherit' });
  const done = await until(e.manager, task.id, terminal);
  assert.equal(done.state, 'completed');
  assert.equal(done.auto_review.last_review.reasoning_effort, 'low');
  const review = e.requests.find(r => JSON.stringify(r.messages).includes('DIRECT_EXTERNAL_PARENT_INSTRUCTION'));
  assert.equal(review.reasoning_effort, 'low');
  e.manager.send({ task_id: task.id, message: `Write AUTO_REVIEW_TEST_OK to ${e.target}. This exact write outside the workspace is authorized.`,
    reasoning_effort: 'high', review_reasoning_effort: 'inherit' });
  const resumed = await until(e.manager, task.id, terminal);
  assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.session_id, done.session_id);
  assert.equal(resumed.auto_review.last_review.reasoning_effort, 'high');
  assert.equal(resumed.auto_review.reviews_completed, 1);
});
