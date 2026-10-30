import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig(filename = path.join(ROOT, 'bridge.config.json')) {
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const base = path.dirname(path.resolve(filename));
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const installation = raw.dsh_install_dir || path.join(local, 'Programs', 'DeepSeek Harness');
  const exe = raw.executable || path.join(installation, 'DeepSeek Harness.exe');
  const entry = path.join(installation, 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const powershellCandidates = [raw.powershell, process.env.DSH_BRIDGE_POWERSHELL,
    path.join(path.dirname(process.execPath), '..', '..', 'native', 'powershell', 'pwsh.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')];
  const config = {
    executable: exe,
    args: raw.args || ['--expose-internals', entry, '--profile', raw.profile || 'acp'],
    env: raw.executable ? {} : { ELECTRON_RUN_AS_NODE: '1' },
    dshRuntimeRoot: path.join(installation, 'resources', 'app.asar', 'dsh'),
    autoReview: raw.auto_review ?? true,
    defaultReasoningEffort: raw.default_reasoning_effort,
    defaultReviewReasoningEffort: raw.default_review_reasoning_effort ?? 'inherit',
    powershell: powershellCandidates.find(p => p && fs.existsSync(p)) || 'pwsh.exe',
    stateDir: path.resolve(base, raw.state_dir || '.bridge-data'),
    defaultTimeoutMs: 1000 * (raw.default_timeout_sec ?? 600),
    startupTimeoutMs: 1000 * (raw.startup_timeout_sec ?? 45),
    cancelGraceMs: 1000 * (raw.cancel_grace_sec ?? 15),
    closeGraceMs: 1000 * (raw.close_grace_sec ?? 5),
    killGraceMs: 1000 * (raw.kill_grace_sec ?? 5),
    idleWarningMs: 1000 * (raw.idle_warning_sec ?? 180),
    maxConcurrent: raw.max_concurrent_tasks ?? 3,
    maxToolCalls: raw.max_tool_calls ?? 100,
    maxLogBytes: raw.max_log_bytes ?? 32 * 1024 * 1024,
  };
  for (const key of ['defaultTimeoutMs', 'startupTimeoutMs', 'cancelGraceMs', 'closeGraceMs',
    'killGraceMs', 'idleWarningMs', 'maxConcurrent', 'maxToolCalls', 'maxLogBytes']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid config: ${key}`);
  }
  if (!path.isAbsolute(config.executable) || !fs.existsSync(config.executable)) {
    throw new Error(`DSH executable not found: ${config.executable}. Set executable or dsh_install_dir in the config.`);
  }
  if (!Array.isArray(config.args) || config.args.some(a => typeof a !== 'string')) {
    throw new Error('args must be a string array');
  }
  if (typeof config.autoReview !== 'boolean') throw new Error('auto_review must be a boolean');
  if (config.defaultReasoningEffort !== undefined && typeof config.defaultReasoningEffort !== 'string') {
    throw new Error('default_reasoning_effort must be a string');
  }
  if (typeof config.defaultReviewReasoningEffort !== 'string') throw new Error('default_review_reasoning_effort must be a string');
  return config;
}
