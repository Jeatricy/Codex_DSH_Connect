import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, ROOT } from '../src/config.mjs';
import { TaskManager } from '../src/manager.mjs';
import { TERMINAL } from '../src/store.mjs';

const directory = path.join(ROOT, '.tmp', 'live-auto-' + randomUUID());
const cwd = path.join(directory, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
const target = path.join(directory, 'approved-outside-workspace.txt');
const manager = new TaskManager(loadConfig());
try {
  const task = manager.spawn({ cwd, provider: 'deepseek-official', model: 'deepseek-flash',
    reasoning_effort: 'low', review_reasoning_effort: 'high', timeout_sec: 120, max_tool_calls: 6,
    instructions: '这是桥接器的单文件验证任务，只授权创建指定的新文件，不执行其他文件操作。',
    task: `使用 write 文件工具创建这个新文件：${target}\n文件内容必须是 DSH_AUTO_REVIEW_FILE_OK。`
      + '\n这是父代理明确授权的一次工作区外写入，动作、目标和范围仅限上述新文件。'
      + '\n必须通过 write 工具（或 tools.write 内部工具）写入，不要直接使用 Node 文件 API，不要使用 shell。'
      + '\n工具执行成功后，只回复 DSH_AUTO_REVIEW_OK。' });
  process.stdout.write(JSON.stringify({ task_id: task.id, target }) + '\n');
  let status;
  do {
    status = await manager.wait(task.id, 10000);
    process.stdout.write(JSON.stringify({ state: status.state, elapsed_sec: status.elapsed_sec,
      progress: status.last_progress, auto_review: status.auto_review }) + '\n');
    if (status.state === 'waiting_permission') {
      await manager.cancel(task.id);
      throw new Error('Native reviewer requested approval for the authorized test. Cancelled without overriding its decision.');
    }
  } while (!TERMINAL.has(status.state));
  process.stdout.write(JSON.stringify({ task_id: task.id, state: status.state, model: status.selected_model,
    auto_review: status.auto_review, output: status.output_tail, cleanup: status.cleanup, error: status.error }, null, 2) + '\n');
  if (status.state !== 'completed' || !status.cleanup?.confirmed || status.auto_review?.reviews_completed < 1
    || status.auto_review?.last_review?.reasoning_effort !== 'high'
    || !status.output_tail.includes('DSH_AUTO_REVIEW_OK')
    || fs.readFileSync(target, 'utf8').trim() !== 'DSH_AUTO_REVIEW_FILE_OK') {
    throw new Error('Native Auto review live verification failed.');
  }
} catch (error) { process.stderr.write(`Auto live check: ${error.message}\n`); process.exitCode = 1; }
finally { await manager.shutdown(); }
