import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { JsonRpcPeer } from './rpc.mjs';

export function bounded(promise, ms, fallback = null) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })])
    .finally(() => clearTimeout(timer));
}

export class AcpWorker extends EventEmitter {
  constructor(config, cwd) {
    super(); this.config = config; this.cwd = cwd; this.stopping = false;
    const env = { ...process.env, ...config.env };
    let executable = config.executable, args = config.args;
    if (process.platform === 'win32') {
      env.DSH_BRIDGE_WORKER_SPEC = JSON.stringify({ executable, args });
      executable = config.powershell;
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'scripts', 'worker-host.ps1'), '-Source', path.join(ROOT, 'scripts', 'JobHost.cs')];
    }
    this.child = spawn(executable, args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => {
        this.spawnError = error; this.emit('diagnostic', error.message);
        resolve({ code: null, error: error.message });
      });
      this.child.once('close', (code, signal) => {
        this.exitInfo = { code, signal }; this.emit('exit', this.exitInfo); resolve(this.exitInfo);
      });
    });
    this.rpc = new JsonRpcPeer(this.child.stdout, this.child.stdin);
    this.rpc.onRequest = (method, params) => {
      if (method === 'session/request_permission' && this.onPermission) return this.onPermission(params);
      throw new Error(`Unsupported ACP client request: ${method}`);
    };
    this.rpc.on('notification', (method, params) => this.emit('notification', method, params));
    this.rpc.on('protocolError', error => { this.emit('protocolError', error); this.rpc.close(error); });
    this.rpc.on('closed', error => this.emit('disconnect', error));
    this.child.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString('utf8')));
  }

  get pid() { return this.child.pid ?? null; }
  request(method, params, timeoutMs = this.config.startupTimeoutMs) {
    return this.rpc.request(method, params, { timeoutMs });
  }
  notify(method, params) { this.rpc.notify(method, params); }
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codex-dsh-bridge', version: '0.2.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (result.protocolVersion !== 1) throw new Error(`Unsupported ACP version: ${result.protocolVersion}`);
    return result;
  }

  async shutdown(sessionId) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      let closeError;
      if (sessionId && !this.rpc.closed) {
        try { await this.request('session/close', { sessionId }, this.config.closeGraceMs); }
        catch (error) { closeError = error.message; }
      }
      this.child.stdin.end();
      let exit = await bounded(this.exited, this.config.closeGraceMs);
      let forced = false;
      if (!exit) { forced = true; exit = await this.forceStop(); }
      this.rpc.close();
      return { confirmed: !!exit, forced, close_error: closeError, exit };
    })();
    return this.stopPromise;
  }

  async forceStop() {
    this.stopping = true;
    try {
      if (process.platform === 'win32') this.child.kill('SIGKILL'); // Closing guardian's Job Object kills its whole tree.
      else process.kill(-this.child.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') this.emit('diagnostic', `Kill failed: ${error.message}`); }
    return bounded(this.exited, this.config.killGraceMs);
  }
}
