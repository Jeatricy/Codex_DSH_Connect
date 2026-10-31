import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATUS = 'DSH bridge completion (local wait)';
export function hookDefinition({ root, stateDir, node = process.execPath, platform = process.platform }) {
  for (const value of [root, stateDir, node]) {
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('Hook paths must be absolute and contain no control characters.');
  }
  let command;
  if (platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    // EncodedCommand avoids cmd.exe expansion and PowerShell interpolation of paths.
    const script = `& ${quote(path.join(root, 'scripts', 'completion-hook.ps1'))} -NodePath ${quote(node)} -StateDir ${quote(stateDir)}`;
    command = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '
      + Buffer.from(script, 'utf16le').toString('base64');
  } else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    command = `${quote(node)} --no-warnings ${quote(path.join(root, 'scripts', 'completion-hook.mjs'))} --state-dir ${quote(stateDir)}`;
  }
  return { type: 'command', command, timeout: 7440, statusMessage: STATUS };
}

export function mergeCompletionHook(original, definition) {
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || (original.hooks !== undefined && (!original.hooks || typeof original.hooks !== 'object' || Array.isArray(original.hooks)))) {
    throw new Error('Invalid hooks configuration; existing file left intact.');
  }
  const result = structuredClone(original);
  result.hooks ??= {};
  if (result.hooks.Stop !== undefined && !Array.isArray(result.hooks.Stop)) throw new Error('Invalid Stop hooks; existing file left intact.');
  const groups = [];
  for (const group of result.hooks.Stop || []) {
    if (!group || !Array.isArray(group.hooks)) throw new Error('Invalid Stop hook group; existing file left intact.');
    const remaining = group.hooks.filter(h => h.statusMessage !== STATUS);
    if (remaining.length) groups.push({ ...group, hooks: remaining });
  }
  if (definition) groups.push({ hooks: [definition] });
  if (groups.length) result.hooks.Stop = groups;
  else delete result.hooks.Stop;
  return result;
}

export function installCompletionHook({ hooksFile, definition }) {
  if (!path.isAbsolute(hooksFile)) throw new Error('hooksFile must be absolute.');
  const before = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : null;
  const result = mergeCompletionHook(before === null ? {} : JSON.parse(before.replace(/^\uFEFF/, '')), definition);
  if (before !== null && JSON.stringify(JSON.parse(before.replace(/^\uFEFF/, ''))) === JSON.stringify(result)) return { changed: false };
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const backup = before === null ? null : `${hooksFile}.dsh-backup-${Date.now()}-${randomUUID()}`;
  if (backup) fs.writeFileSync(backup, before, { flag: 'wx' });
  const temporary = `${hooksFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, hooksFile);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { changed: true, backup };
}
