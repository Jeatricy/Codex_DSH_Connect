import os from 'node:os';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.mjs';
import { hookDefinition, installCompletionHook } from '../src/install-completion.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--uninstall') options.uninstall = true;
  else if (['--hooks-file', '--state-dir', '--config'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
  else throw new Error('Usage: node scripts/install-completion.mjs [--hooks-file PATH] [--state-dir PATH] [--config PATH] [--uninstall]');
}
const hooksFile = path.resolve(options['hooks-file'] || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'));
const stateDir = options.uninstall ? null : path.resolve(options['state-dir'] || loadConfig(options.config).stateDir);
const result = installCompletionHook({ hooksFile, definition: options.uninstall ? null : hookDefinition({ root: ROOT, stateDir }) });
process.stdout.write(JSON.stringify({ ...result, hooks_file: hooksFile, state_dir: stateDir,
  next_step: options.uninstall ? 'Reload hooks in Codex.' : 'In Codex, use /hooks to review and trust this exact Stop hook, then reload the MCP server. No trust records are changed by this installer.' }, null, 2) + '\n');
