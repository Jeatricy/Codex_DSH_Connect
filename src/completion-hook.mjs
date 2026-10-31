import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ACTIVE, TERMINAL } from './store.mjs';
import { UUID } from './completion.mjs';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// The receipt table is independent of task JSON: concurrent manager saves cannot erase delivery state.
function inspect(db, thread, expired) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const tasks = db.prepare("SELECT record FROM tasks WHERE json_extract(record,'$.completion.thread_id')=?").all(thread)
      .map(row => JSON.parse(row.record));
    const events = [];
    let pending = false, permissionAlreadyDelivered = false;
    const claim = db.prepare('INSERT OR IGNORE INTO continuation_receipts(event_key,thread_id,delivered_at) VALUES(?,?,?)');
    const delivered = db.prepare('SELECT 1 FROM continuation_receipts WHERE event_key=?');
    for (const task of tasks) {
      if (!UUID.test(task.id) || !UUID.test(task.completion?.run_id)) continue;
      let kind, suffix;
      if (TERMINAL.has(task.state) && task.ended_at) kind = suffix = task.state;
      else if (ACTIVE.has(task.state)) {
        if (!alive(task.bridge_pid)) kind = suffix = 'bridge_disconnected';
        else if (task.state === 'waiting_permission' && task.permissions?.length) {
          const permission = task.permissions.find(p => UUID.test(p.id));
          if (permission) { kind = 'waiting_permission'; suffix = permission.id; }
        } else if (delivered.get(`${task.id}:${task.completion.run_id}:wait_expired`)) continue;
        else if (expired) kind = suffix = 'wait_expired';
        else pending = true;
      }
      if (!kind) continue;
      const key = `${task.id}:${task.completion.run_id}:${suffix}`;
      if (!claim.run(key, thread, Date.now()).changes) {
        if (kind === 'waiting_permission') permissionAlreadyDelivered = true;
        continue;
      }
      // Only metadata and parent-authored follow-up cross into the continuation prompt.
      // Never insert an agent answer, tool output, error string or MCP connection credentials.
      events.push({ task_id: task.id, event: kind, state: task.state,
        cleanup_confirmed: task.cleanup?.confirmed === true,
        follow_up: typeof task.completion.follow_up === 'string' ? task.completion.follow_up.slice(0, 2000) : '' });
    }
    db.exec('COMMIT');
    return { events, pending: pending && !permissionAlreadyDelivered };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function waitForCompletion({ stateDir, input, maxWaitMs = 7_300_000, intervalMs = 1000 }) {
  if (input?.hook_event_name !== 'Stop' || typeof input.session_id !== 'string' || !UUID.test(input.session_id)) return {};
  const database = path.join(stateDir, 'bridge.sqlite');
  if (!fs.existsSync(database)) return {};
  const db = new DatabaseSync(database);
  try {
    db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS continuation_receipts (event_key TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL, delivered_at INTEGER NOT NULL);`);
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const { events, pending } = inspect(db, input.session_id.toLowerCase(), Date.now() >= deadline);
      if (events.length) return { decision: 'block', reason:
        'DSH bridge event(s) for this parent chat. Read each task status/result once; review actual changes and run relevant tests before acceptance. Completion alone is not validation. For waiting_permission inspect the real request and act only within user authorization. For bridge_disconnected, stop_unconfirmed or wait_expired inspect cleanup/recovery; do not retry blindly. The following JSON contains metadata and parent-authored follow-up only:\n'
        + JSON.stringify(events) };
      if (!pending) return {};
      await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }
  } finally { db.close(); }
}
