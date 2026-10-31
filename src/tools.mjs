import { MCP_SERVERS_SCHEMA, normalizeMcpServers } from './mcp.mjs';

const str = description => ({ type: 'string', description });
const taskId = str('Task ID returned by deepseek_spawn; not a raw DSH session ID.');
const model = str('Exact selector from deepseek_list_models, or an unambiguous advertised model ID/name. No silent fallback.');
const provider = str('Optional advertised provider ID to disambiguate a model.');
const effort = str('Task reasoning strength from this model\'s advertised values. Configured default: high. model-default uses the model/provider default, including models with no reasoning control.');
const reviewEffort = str('DSH native Auto review reasoning: inherit follows the task (default); model-default uses provider default; otherwise use an advertised reasoning value such as low/high/max. Reviewer uses the current task model.');
const timeout = { type: 'number', minimum: 1, maximum: 7200, description: 'Total task deadline, including startup, in seconds. Default 600. Does not reset on progress.' };
const budget = { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum top-level tool-call updates before cancellation. Default 100.' };
const cwd = str('Absolute existing project directory. Overlapping directories are serialized; separate worktrees can run in parallel.');
function tool(name, description, properties, required, readOnly = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly } };
}

export const TOOLS = [
  tool('deepseek_list_models', 'Discover models visible to the DSH ACP profile without submitting a model prompt. Optionally choose a model to see its reasoning options. Catalog membership does not prove credentials or inference work.',
    { cwd, model, provider }, ['cwd']),
  tool('deepseek_spawn', 'Delegate a task to DSH with an explicit model. The configured bridge uses native Auto review with Full access after activation is confirmed. Returns immediately; collect results with status/wait. Set task and reviewer reasoning independently. Denied actions can request one-shot permission.',
    { cwd, task: str('Concrete task, authorized actions/targets and expected deliverables.'), model, provider, reasoning_effort: effort,
      review_reasoning_effort: reviewEffort, mcp_servers: MCP_SERVERS_SCHEMA,
      instructions: str('Task scope, allowed changes and acceptance criteria. These are instructions, not OS access controls.'),
      timeout_sec: timeout, max_tool_calls: budget }, ['cwd', 'task', 'model']),
  tool('deepseek_status', 'Read task state, confirmed model, recent answer, pending permissions and cleanup status. A slow flag is advisory. stop_unconfirmed keeps the workspace reserved.',
    { task_id: taskId, max_chars: { type: 'integer', minimum: 0, maximum: 24000 } }, ['task_id'], true),
  tool('deepseek_list_tasks', 'List persisted tasks, including tasks owned by another local bridge connection.', {}, [], true),
  tool('deepseek_wait', 'Wait at most 20 seconds for a terminal state or a permission request. A wait timeout does not cancel the DSH task. Recheck only while useful; the watchdog runs independently.',
    { task_id: taskId, timeout_sec: { type: 'number', minimum: 0, maximum: 20 } }, ['task_id'], true),
  tool('deepseek_read_output', 'Read an answer in bounded chunks using character offsets. Complete progress/tool events are also retained in the local task artifact directory.',
    { task_id: taskId, offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 24000 } }, ['task_id'], true),
  tool('deepseek_send', 'Continue a terminated DSH task in its persistent session, optionally choosing another model. Requires confirmed cleanup; after an unsuccessful submitted task, review partial changes before setting reviewed_partial_work=true. No automatic retry or model fallback.',
    { task_id: taskId, message: str('Next task or follow-up instructions.'), model, provider, reasoning_effort: effort,
      review_reasoning_effort: reviewEffort, mcp_servers: MCP_SERVERS_SCHEMA,
      timeout_sec: timeout, max_tool_calls: budget,
      reviewed_partial_work: { type: 'boolean', description: 'Set true only after checking the prior partial answer and file/side effects.' } }, ['task_id', 'message']),
  tool('deepseek_cancel', 'Request cancellation. Returns immediately in cancelling state; inspect status to confirm cleanup. Escalation and worker-tree termination are bounded by the bridge watchdog.',
    { task_id: taskId }, ['task_id']),
  tool('deepseek_close', 'Cancel a running task if necessary and mark it closed so it cannot accept follow-up work. Keeps its persisted records and output.',
    { task_id: taskId }, ['task_id']),
  tool('deepseek_respond_permission', 'Answer an actual DSH permission request with one of its advertised one-shot options. Allow only actions within the user-authorized scope. Persistent allow-always options are not exposed.',
    { task_id: taskId, permission_id: str('Pending permission ID from status.'), option_id: str('Advertised one-shot optionId.') }, ['task_id', 'permission_id', 'option_id']),
  tool('deepseek_recover', 'Inspect an orphaned task after its bridge died. Releases the reservation only if the Windows job guardian is confirmed dead. Never kills an arbitrary or existing desktop process.',
    { task_id: taskId }, ['task_id']),
];

export function validateArguments(name, args = {}) {
  const definition = TOOLS.find(t => t.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('arguments must be an object');
  for (const key of definition.inputSchema.required) if (!(key in args)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.inputSchema.properties[key];
    if (!schema) throw new Error(`Unknown argument: ${key}`);
    if (key === 'mcp_servers') { normalizeMcpServers(value); continue; }
    if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error(`Invalid type for ${key}`);
    if (schema.type === 'string' && value.length > 128000) throw new Error(`Argument too long: ${key}`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${key} is below its minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${key} exceeds its maximum`);
  }
  return args;
}

export async function callTool(manager, name, input) {
  const a = validateArguments(name, input);
  switch (name) {
    case 'deepseek_list_models': return manager.listModels(a);
    case 'deepseek_spawn': return manager.spawn(a);
    case 'deepseek_status': return manager.status(a.task_id, a.max_chars ?? 6000);
    case 'deepseek_list_tasks': return { tasks: manager.list() };
    case 'deepseek_wait': return manager.wait(a.task_id, 1000 * (a.timeout_sec ?? 10));
    case 'deepseek_read_output': return manager.readOutput(a.task_id, a.offset ?? 0, a.max_chars ?? 12000);
    case 'deepseek_send': return manager.send(a);
    case 'deepseek_cancel': return manager.cancel(a.task_id);
    case 'deepseek_close': return manager.close(a.task_id);
    case 'deepseek_respond_permission': return manager.respondPermission(a.task_id, a.permission_id, a.option_id);
    case 'deepseek_recover': return manager.recover(a.task_id);
  }
}
