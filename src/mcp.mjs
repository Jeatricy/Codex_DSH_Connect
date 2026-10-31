import path from 'node:path';
import { validateHeaderName, validateHeaderValue } from 'node:http';

const string = { type: 'string', maxLength: 128000 };
const name = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' };
const pairs = {
  type: 'array', items: { type: 'object', properties: { name: string, value: string },
    required: ['name', 'value'], additionalProperties: false },
};
export const MCP_SERVERS_SCHEMA = {
  type: 'array', maxItems: 32,
  description: 'Session MCP servers in ACP format. HTTP: {type:"http",name,url,headers?:[{name,value}]}. Stdio: {type?:"stdio",name,command,args?:[],env?:[{name,value}]}; command must be absolute. Spawn defaults to []; send inherits when omitted, replaces when supplied, and [] detaches all. Credentials are persisted locally; status exposes only connection summaries.',
  items: { oneOf: [
    { type: 'object', properties: { type: { const: 'http' }, name, url: string, headers: pairs },
      required: ['type', 'name', 'url'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'stdio' }, name, command: string,
      args: { type: 'array', items: string }, env: pairs },
      required: ['name', 'command'], additionalProperties: false },
  ] },
};

function fail(message) { throw new Error(`Invalid mcp_servers: ${message}`); }
function object(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field} has an unknown field`);
}
function text(value, field, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 128000) fail(`${field} must be a valid string`);
  return value;
}
function entries(value, field, header) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  const names = new Set();
  return value.map(entry => {
    object(entry, ['name', 'value'], field);
    const key = text(entry.name, `${field}.name`), val = text(entry.value, `${field}.value`, true);
    const identity = header || process.platform === 'win32' ? key.toLowerCase() : key;
    if (names.has(identity)) fail(`${field} contains duplicate names`);
    names.add(identity);
    if (header) {
      try { validateHeaderName(key); validateHeaderValue(key, val); }
      catch { fail(`${field} contains an invalid HTTP header`); }
    } else if (/[=\0]/.test(key) || val.includes('\0')) fail(`${field} contains an invalid environment entry`);
    return { name: key, value: val };
  });
}

// Validate before reserving a workspace or starting a process. Return detached,
// normalized ACP values so later caller mutations cannot change authorization.
export function normalizeMcpServers(value) {
  if (!Array.isArray(value) || value.length > 32) fail('must be an array of at most 32 servers');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('must be JSON serializable'); }
  if (Buffer.byteLength(serialized) > 128000) fail('configuration exceeds 128000 bytes');
  const names = new Set();
  return value.map((server, index) => {
    const field = `server ${index}`;
    object(server, ['type', 'name', 'url', 'headers', 'command', 'args', 'env'], field);
    if (typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server.name)) fail(`${field}.name must match [A-Za-z0-9_-]{1,32}`);
    if (names.has(server.name)) fail('server names must be unique');
    names.add(server.name);
    if (server.type === 'http') {
      object(server, ['type', 'name', 'url', 'headers'], field);
      const url = text(server.url, `${field}.url`);
      try { if (!['http:', 'https:'].includes(new URL(url).protocol)) fail('unsupported URL scheme'); }
      catch { fail(`${field}.url must be an absolute HTTP(S) URL`); }
      return { type: 'http', name: server.name, url, headers: entries(server.headers, `${field}.headers`, true) };
    }
    if (server.type !== undefined && server.type !== 'stdio') fail(`${field}.type must be http or stdio`);
    object(server, ['type', 'name', 'command', 'args', 'env'], field);
    const command = text(server.command, `${field}.command`);
    if (!path.isAbsolute(command) || command.includes('\0')) fail(`${field}.command must be an absolute executable path`);
    const args = server.args === undefined ? [] : server.args;
    if (!Array.isArray(args)) fail(`${field}.args must be an array`);
    return { name: server.name, command, args: args.map(arg => {
      text(arg, `${field}.args`, true);
      if (arg.includes('\0')) fail(`${field}.args contains an invalid argument`);
      return arg;
    }), env: entries(server.env, `${field}.env`, false) };
  });
}

// Status and historical turn summaries must not expose auth headers, env, args,
// or URL credentials/query values. Full configs stay in private local task state.
export function summarizeMcpServers(servers = []) {
  return servers.map(server => {
    if (server.type !== 'http') return { name: server.name, type: 'stdio', command: server.command };
    const url = new URL(server.url);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
    if (url.hash) url.hash = '[redacted]';
    return { name: server.name, type: 'http', url: url.href };
  });
}
