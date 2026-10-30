import { execFileSync, spawn } from 'node:child_process';
import { JsonRpcPeer } from '../src/rpc.mjs';

const args = process.argv.slice(2);
function arg(name) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }
const codex = arg('--codex') || 'codex';
const entry = JSON.parse(execFileSync(codex, ['mcp', 'get', 'deepseek_harness', '--json'], { encoding: 'utf8', windowsHide: true }));
const transport = entry.transport || entry;
const child = spawn(transport.command, transport.args, {
  cwd: transport.cwd || process.cwd(), env: { ...process.env, ...(transport.env || {}) },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
const closed = new Promise(resolve => child.once('close', resolve));
const peer = new JsonRpcPeer(child.stdout, child.stdin);
async function call(name, arguments_) {
  const result = await peer.request('tools/call', { name, arguments: arguments_ }, { timeoutMs: 55000 });
  if (result.isError) throw new Error(result.content.map(c => c.text || '').join('\n'));
  return result.structuredContent;
}
try {
  const init = await peer.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'installed-bridge-check', version: '1' } }, { timeoutMs: 10000 });
  peer.notify('notifications/initialized', {});
  const tools = await peer.request('tools/list', {});
  process.stdout.write(JSON.stringify({ check: 'registered-mcp', server: init.serverInfo,
    tools: tools.tools.map(t => t.name),
    task_reasoning_parameter: !!tools.tools.find(t => t.name === 'deepseek_spawn')?.inputSchema.properties.reasoning_effort,
    review_reasoning_parameter: !!tools.tools.find(t => t.name === 'deepseek_spawn')?.inputSchema.properties.review_reasoning_effort }, null, 2) + '\n');
  const statusId = arg('--status');
  if (statusId) {
    const status = await call('deepseek_status', { task_id: statusId, max_chars: 1000 });
    process.stdout.write(JSON.stringify({ check: 'registered-mcp-status', task_id: statusId,
      state: status.state, selected_model: status.selected_model, auto_review: status.auto_review,
      output: status.output_tail, cleanup: status.cleanup }, null, 2) + '\n');
  }
  const id = arg('--resume');
  if (id) {
    const sent = await call('deepseek_send', { task_id: id, model: 'deepseek-flash',
      provider: 'deepseek-official', reasoning_effort: 'low', timeout_sec: 90,
      message: '请只回复 DSH_BRIDGE_RESUME_OK。不要调用工具，不要读取或修改任何文件。' });
    let status = sent;
    while (!['completed', 'failed', 'timed_out', 'cancelled', 'stop_unconfirmed'].includes(status.state)) {
      status = await call('deepseek_wait', { task_id: id, timeout_sec: 10 });
      if (status.state === 'waiting_permission') { await call('deepseek_cancel', { task_id: id }); throw new Error('Unexpected permission in resume smoke test.'); }
    }
    process.stdout.write(JSON.stringify({ check: 'registered-mcp-resume', task_id: id,
      state: status.state, selected_model: status.selected_model, output_tail: status.output_tail,
      cleanup: status.cleanup, error: status.error }, null, 2) + '\n');
    if (status.state !== 'completed' || !status.cleanup?.confirmed || !status.output_tail.includes('DSH_BRIDGE_RESUME_OK')) {
      throw new Error('Registered MCP resume smoke test failed.');
    }
  }
} catch (error) { process.stderr.write(`Installed check failed: ${error.message}\n`); process.exitCode = 1; }
finally { child.stdin.end(); await closed; }
