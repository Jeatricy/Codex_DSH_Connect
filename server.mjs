import { loadConfig } from './src/config.mjs';
import { TaskManager } from './src/manager.mjs';
import { JsonRpcPeer, RpcError } from './src/rpc.mjs';
import { TOOLS, callTool } from './src/tools.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: node server.mjs [--config /absolute/path/bridge.config.json]\n');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Use --config <file>');
const config = loadConfig(args[1]);
const manager = new TaskManager(config);
const rpc = new JsonRpcPeer(process.stdin, process.stdout);
let initialized = false;
rpc.onRequest = async (method, params) => {
  if (method === 'initialize') {
    initialized = true;
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    return {
      protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : supported[0],
      serverInfo: { name: 'codex-dsh-bridge', version: '0.3.0' }, capabilities: { tools: { listChanged: false } },
      instructions: 'Delegate with deepseek_spawn using an explicit model from deepseek_list_models. This bridge enables DSH native Auto review with Full access, verified before prompt submission. reasoning_effort controls the task; review_reasoning_effort controls its reviewer (default inherit). Spawn is asynchronous. If the completion Stop hook is installed and trusted, set completion with the explicit current parent CODEX_THREAD_ID and a concise parent-authored follow_up. Finish the dispatch turn instead of polling; the local hook waits and continues this chat on completion or permission. Read final output once, inspect review telemetry and actual changes, and run relevant tests. Without a trusted hook use bounded status/wait. Deadlines/cancellation are independent. No model fallback. Overlapping workspaces are serialized. Respond to actual one-shot permissions within user scope.',
    };
  }
  if (method === 'ping') return {};
  if (!initialized) throw new RpcError('Initialize first', -32002);
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    if (!TOOLS.some(t => t.name === params.name)) throw new RpcError('Unknown tool', -32602);
    try {
      const result = await callTool(manager, params.name, params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  }
  throw new RpcError(`Unsupported method: ${method}`, -32601);
};
let closing;
function finish() {
  if (closing) return closing;
  const hardStop = setTimeout(() => process.exit(1),
    config.cancelGraceMs + 2 * config.closeGraceMs + config.killGraceMs + 5000);
  closing = manager.shutdown().finally(() => { clearTimeout(hardStop); process.exit(0); });
  return closing;
}
rpc.on('closed', () => { void finish(); });
rpc.on('protocolError', error => { process.stderr.write(error.message + '\n'); });
process.on('SIGINT', () => { void finish(); });
process.on('SIGTERM', () => { void finish(); });
process.on('uncaughtException', error => {
  process.stderr.write(`Bridge fatal error: ${error.message}\n`); void finish();
});
process.on('unhandledRejection', error => {
  process.stderr.write(`Bridge unhandled rejection: ${error?.message || error}\n`); void finish();
});
