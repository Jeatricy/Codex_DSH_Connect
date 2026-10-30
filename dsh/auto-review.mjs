import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installNativeReview } from '../src/dsh-auto-review.mjs';

export const name = 'codex-bridge-auto-review';
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory', 'sandboxPolicy'];
export async function apply(ctx) {
  const filename = process.env.DSH_BRIDGE_TASK_CONTEXT_FILE;
  const runtime = process.env.DSH_BRIDGE_DSH_ROOT;
  if (!filename || !runtime) throw new Error('Missing bridge Auto review control context');
  const control = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (control.version !== 1 || !control.nonce || !path.isAbsolute(control.report_file)) throw new Error('Invalid Auto review control context');
  const native = await import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai',
    'dsh-experimental-auto-review', 'lib', 'index.js')).href);
  installNativeReview(ctx, native, Object.freeze(control));
}
