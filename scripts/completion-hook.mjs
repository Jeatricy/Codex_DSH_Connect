import path from 'node:path';
import { waitForCompletion } from '../src/completion-hook.mjs';

let input;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--state-dir' || !path.isAbsolute(args[1])) throw new Error('Invalid hook arguments');
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Hook input too large');
  }
  input = JSON.parse(body.replace(/^\uFEFF/, ''));
  const result = await waitForCompletion({ stateDir: args[1], input });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('DSH completion hook failed to inspect local state. Check hook installation and bridge database.\n');
  // Surface a failure once without turning repeated Stop failures into a model loop.
  process.stdout.write(JSON.stringify(input?.hook_event_name === 'Stop' && !input.stop_hook_active
    ? { decision: 'block', reason: 'DSH completion hook could not inspect its local state. Check installation and task status once. Do not assume pending tasks completed or cleanup succeeded.' } : {}) + '\n');
}
