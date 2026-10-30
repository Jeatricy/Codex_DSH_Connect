import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ACTIVE = new Set(['starting', 'running', 'waiting_permission', 'cancelling', 'closing']);
export const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'stop_unconfirmed']);
export function overlaps(a, b) {
  const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
  a = normalize(a); b = normalize(b);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
    || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export class TaskStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'bridge.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        operation TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);`);
  }
  get(id) {
    const row = this.db.prepare('SELECT record FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown task: ${id}`);
    return JSON.parse(row.record);
  }
  all() { return this.db.prepare('SELECT record FROM tasks').all().map(row => JSON.parse(row.record)); }
  reserve(task, maxConcurrent) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const others = this.all().filter(t => t.id !== task.id);
      const blocking = others.find(t => (ACTIVE.has(t.state) || t.state === 'stop_unconfirmed') && overlaps(t.cwd, task.cwd));
      if (blocking) throw new Error(`Workspace is reserved by task ${blocking.id} (${blocking.state}). Wait for confirmed cleanup or use a separate workspace.`);
      if (others.filter(t => ACTIVE.has(t.state)).length >= maxConcurrent) throw new Error('Concurrent task limit reached.');
      const current = this.db.prepare('SELECT record FROM tasks WHERE id=?').get(task.id);
      if (current && (ACTIVE.has(JSON.parse(current.record).state) || JSON.parse(current.record).state === 'stop_unconfirmed')) {
        throw new Error('This task is still running or its stop is unconfirmed.');
      }
      this.db.prepare('INSERT INTO tasks(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record')
        .run(task.id, JSON.stringify(task));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    fs.mkdirSync(this.taskDir(task.id), { recursive: true });
    this.save(task);
  }
  taskDir(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task ID');
    return path.join(this.directory, 'tasks', id);
  }
  save(task) {
    this.db.prepare('UPDATE tasks SET record=? WHERE id=?').run(JSON.stringify(task), task.id);
    const dir = this.taskDir(task.id);
    fs.mkdirSync(dir, { recursive: true });
    // SQLite is authoritative; this snapshot is also convenient to inspect without a DB viewer.
    const target = path.join(dir, 'task.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify(task, null, 2) + '\n');
    fs.renameSync(target + '.tmp', target);
  }
  append(id, filename, text) { fs.appendFileSync(path.join(this.taskDir(id), filename), text); }
  read(id, filename) {
    try { return fs.readFileSync(path.join(this.taskDir(id), filename), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  enqueue(id, owner, operation, payload) {
    this.db.prepare('INSERT INTO commands(id,owner,operation,payload,created) VALUES(?,?,?,?,?)')
      .run(id, owner, operation, JSON.stringify(payload), Date.now());
  }
  commands(owner) { return this.db.prepare('SELECT * FROM commands WHERE owner=? AND result IS NULL ORDER BY created').all(owner); }
  finishCommand(id, result) { this.db.prepare('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify(result), id); }
  commandResult(id) { const r = this.db.prepare('SELECT result FROM commands WHERE id=?').get(id); return r?.result ? JSON.parse(r.result) : null; }
  close() { this.db.close(); }
}
