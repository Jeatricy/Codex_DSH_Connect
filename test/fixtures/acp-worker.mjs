import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const first = JSON.stringify(['test-provider', 'model-a']);
const second = JSON.stringify(['test-provider', 'model-b']);
let selected = first, effort = 'low', session = 'fixture-session', active, ignore = false;
const keepalive = setInterval(() => {}, 1000);
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
function result(id, value) { send({ id, result: value }); }
function options() { return [
  { id: 'model', type: 'select', currentValue: selected, options: [{ group: 'test-provider', name: 'Test provider', options: [
    { value: first, name: 'Model A' }, { value: second, name: 'Model B' },
  ] }] },
  { id: 'reasoning_effort', type: 'select', currentValue: effort, options: [
    { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
  ] },
]; }
function update(value) { send({ method: 'session/update', params: { sessionId: session, update: value } }); }
function answer(id, body) {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body } });
  result(id, { stopReason: 'end_turn' }); active = null;
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line), p = m.params || {};
  if (m.id === 'permission') {
    answer(active, m.result?.outcome?.optionId === 'allow-once' ? 'Permission granted once' : 'Permission denied'); return;
  }
  switch (m.method) {
    case 'initialize': result(m.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } }); break;
    case 'session/new': result(m.id, { sessionId: session, configOptions: options() }); break;
    case 'session/resume': session = p.sessionId; result(m.id, { sessionId: session, configOptions: options() }); break;
    case 'session/set_config_option':
      if (p.configId === 'model') selected = p.value; else effort = p.value;
      result(m.id, { configOptions: options() }); break;
    case 'session/prompt': {
      active = m.id;
      const task = p.prompt.map(c => c.text || '').join('');
      if (task.includes('TEST_CRASH')) { process.exit(22); break; }
      if (task.includes('TEST_IGNORE_CANCEL')) ignore = true;
      const childFile = task.match(/CHILD_PID_FILE=([^\r\n]+)/)?.[1];
      if (childFile) {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
        fs.writeFileSync(childFile.trim(), String(child.pid));
      }
      if (task.includes('TEST_PERMISSION')) {
        send({ id: 'permission', method: 'session/request_permission', params: { sessionId: session,
          toolCall: { toolCallId: 'write-file', title: 'Write fixture file' }, options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ] } }); break;
      }
      if (task.includes('TEST_TOOL_LOOP')) {
        for (let i = 0; i < 20; i++) update({ sessionUpdate: 'tool_call', toolCallId: String(i), title: 'loop', status: 'in_progress' });
        break;
      }
      if (task.includes('TEST_LARGE_OUTPUT')) { answer(m.id, 'x'.repeat(10000)); break; }
      if (task.includes('TEST_EMPTY')) { result(m.id, { stopReason: 'end_turn' }); break; }
      if (task.includes('TEST_HANG') || ignore) break;
      answer(m.id, `Fixture answer 模型验证: ${selected} / ${effort}`); break;
    }
    case 'session/cancel':
      if (!ignore && active !== null && active !== undefined) { result(active, { stopReason: 'cancelled' }); active = null; }
      break;
    case 'session/close':
      if (!ignore) { result(m.id, {}); setTimeout(() => process.exit(0), 10); }
      break;
  }
});
rl.on('close', () => { if (!ignore) { clearInterval(keepalive); process.exit(0); } });
