import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class RpcError extends Error {
  constructor(message, code = -32603, data) {
    super(message); this.code = code; this.data = data;
  }
}

// Both MCP stdio and DSH ACP use UTF-8, newline-delimited JSON-RPC, not LSP framing.
export class JsonRpcPeer extends EventEmitter {
  constructor(input, output, { maxLineBytes = 8 * 1024 * 1024 } = {}) {
    super(); this.input = input; this.output = output; this.maxLineBytes = maxLineBytes;
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.closed = false;
    const decoder = new StringDecoder('utf8');
    input.on('data', chunk => {
      this.buffer += decoder.write(chunk);
      let at;
      while ((at = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
        if (Buffer.byteLength(line) > maxLineBytes) { this.close(new Error('JSON-RPC frame too large')); return; }
        if (line) this.receive(line);
      }
      if (Buffer.byteLength(this.buffer) > maxLineBytes) this.close(new Error('JSON-RPC frame too large'));
    });
    input.on('end', () => this.close(new Error('JSON-RPC connection closed')));
    input.on('error', error => this.close(error));
    output.on('error', error => this.close(error));
  }

  send(message) {
    if (this.closed) throw new Error('JSON-RPC connection is closed');
    this.output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        try { this.notify('$/cancel_request', { id }); } catch {}
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.send({ method, params }); }

  receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit('protocolError', new Error('Invalid JSON from peer')); return; }
    if (!message || message.jsonrpc !== '2.0') {
      this.emit('protocolError', new Error('Invalid JSON-RPC message')); return;
    }
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) { this.emit('notification', message.method, message.params || {}); return; }
      Promise.resolve().then(() => {
        if (!this.onRequest) throw new RpcError(`Unsupported method: ${message.method}`, -32601);
        return this.onRequest(message.method, message.params || {}, message.id);
      }).then(result => {
        if (!this.closed) this.send({ id: message.id, result: result ?? {} });
      }, error => {
        if (!this.closed) this.send({ id: message.id, error: {
          code: error.code || -32603, message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        } });
      }).catch(error => this.close(error));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new RpcError(message.error.message, message.error.code, message.error.data));
    else pending.resolve(message.result);
  }

  close(error = new Error('JSON-RPC connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
}
