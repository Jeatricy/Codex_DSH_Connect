import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.mjs';

export function prepareReviewWorker(config, task, directory) {
  if (!config.autoReview) return { config, control: null };
  const nonce = randomUUID();
  const runDirectory = path.join(directory, 'runs', nonce);
  fs.mkdirSync(runDirectory, { recursive: true });
  const control = {
    version: 1, nonce, task_id: task.id, cwd: task.cwd,
    parent_instruction: task.task, project_constraints: task.instructions,
    review_reasoning_effort: task.requested_review_reasoning_effort,
    report_file: path.join(runDirectory, 'auto-review.json'),
    events_file: path.join(runDirectory, 'auto-review-events.jsonl'),
  };
  const filename = path.join(runDirectory, 'control.json');
  const patch = path.join(runDirectory, 'auto-review.patch.yml');
  fs.writeFileSync(filename, JSON.stringify(control, null, 2));
  fs.writeFileSync(patch, '- insert:\n    - id: codex-bridge-auto-review\n      name: '
    + JSON.stringify(pathToFileURL(path.join(ROOT, 'dsh', 'auto-review.mjs')).href) + '\n');
  return {
    config: { ...config, args: [...config.args, '--patch', patch],
      env: { ...config.env, DSH_BRIDGE_TASK_CONTEXT_FILE: filename, DSH_BRIDGE_DSH_ROOT: config.dshRuntimeRoot } },
    control,
  };
}

export function readReviewReport(control, sessionId) {
  if (!control) return null;
  let report;
  try { report = JSON.parse(fs.readFileSync(control.report_file, 'utf8')); }
  catch { throw new Error('DSH Auto review did not confirm activation. Task was not submitted.'); }
  if (report.nonce !== control.nonce || report.session_id !== sessionId || report.enabled !== true
    || report.permission_mode !== 'auto' || report.sandbox_mode !== 'danger-full-access'
    || report.approval_policy !== 'ask') {
    throw new Error('DSH Auto review activation mismatch. Task was not submitted.');
  }
  return report;
}

export function validateReviewEffort(selected, effort) {
  if (!['inherit', 'model-default'].includes(effort) && !selected.available_reasoning_efforts.includes(effort)) {
    throw new Error(`Review reasoning effort '${effort}' is unsupported by the selected model.`);
  }
}
