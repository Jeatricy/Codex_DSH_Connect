import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.mjs';
import { TaskManager } from '../src/manager.mjs';
import { TERMINAL } from '../src/store.mjs';

const args = process.argv.slice(2);
function arg(name) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }
const config = loadConfig(arg('--config'));
const cwd = path.resolve(arg('--cwd') || ROOT);
const manager = new TaskManager(config);
try {
  const models = await manager.listModels({ cwd, model: arg('--model'), provider: arg('--provider') });
  process.stdout.write(JSON.stringify({ check: 'catalog', executable: config.executable, ...models }, null, 2) + '\n');
  if (args.includes('--smoke')) {
    const chosen = models.selected || models.models.find(m => m.current);
    if (!chosen) throw new Error('No current model was advertised.');
    const task = manager.spawn({ cwd, model: chosen.selector, timeout_sec: 90,
      task: '请只回复 DSH_BRIDGE_OK。不要调用工具，不要读取或修改任何文件。', max_tool_calls: 1 });
    process.stdout.write(JSON.stringify({ check: 'inference-started', task_id: task.id, model: chosen }) + '\n');
    let status;
    do {
      status = await manager.wait(task.id, 10000);
      process.stdout.write(JSON.stringify({ check: 'inference-progress', state: status.state,
        elapsed_sec: status.elapsed_sec, last_progress: status.last_progress }) + '\n');
      if (status.state === 'waiting_permission') { await manager.cancel(task.id); throw new Error('Smoke task unexpectedly requested permission; cancelled.'); }
    } while (!TERMINAL.has(status.state));
    process.stdout.write(JSON.stringify({ check: 'inference-result', ...status }, null, 2) + '\n');
    if (status.state !== 'completed' || !status.cleanup?.confirmed || !status.output_tail.includes('DSH_BRIDGE_OK')) {
      throw new Error('Inference smoke test did not complete with the expected marker and confirmed cleanup.');
    }
  }
} catch (error) {
  process.stderr.write(`Doctor failed: ${error.message}\n`); process.exitCode = 1;
} finally { await manager.shutdown(); }
