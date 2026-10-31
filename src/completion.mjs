import { randomUUID } from 'node:crypto';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const COMPLETION_SCHEMA = {
  description: 'Optional Codex Stop-hook continuation. Requires the installed, trusted completion hook. Use the current parent CODEX_THREAD_ID explicitly; never guess another chat. null disables. send omission inherits, with a fresh delivery ID. Finish the dispatch turn instead of polling; on continuation read the result once and review/test it.',
  anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['thread_id'], properties: {
    thread_id: { type: 'string', description: 'Explicit authorized parent Codex thread UUID.' },
    follow_up: { type: 'string', maxLength: 2000, description: 'Parent-authored next step, for example review changes and run relevant tests. Never copy child output here.' },
  } }],
};

export function normalizeCompletion(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['thread_id', 'follow_up'].includes(k))
    || typeof value.thread_id !== 'string' || !UUID.test(value.thread_id)
    || (value.follow_up !== undefined && (typeof value.follow_up !== 'string' || value.follow_up.length > 2000))) {
    throw new Error('completion requires an explicit thread_id UUID and optional follow_up string (at most 2000 characters).');
  }
  return { thread_id: value.thread_id.toLowerCase(), follow_up: value.follow_up || '', run_id: randomUUID() };
}

export function nextCompletion(input, previous) {
  return normalizeCompletion(input === undefined && previous
    ? { thread_id: previous.thread_id, follow_up: previous.follow_up } : input);
}
