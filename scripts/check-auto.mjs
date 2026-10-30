import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, ROOT } from '../src/config.mjs';
import { prepareReviewWorker, readReviewReport } from '../src/review-control.mjs';
import { AcpWorker } from '../src/worker.mjs';

const config = loadConfig();
const directory = path.join(ROOT, '.tmp', 'auto-preflight-' + randomUUID());
fs.mkdirSync(directory, { recursive: true });
const prepared = prepareReviewWorker(config, { id: randomUUID(), cwd: directory,
  task: 'Control-plane activation check only.', instructions: '', requested_review_reasoning_effort: 'inherit' }, directory);
const worker = new AcpWorker(prepared.config, directory);
worker.on('diagnostic', text => process.stderr.write(text));
let session;
try {
  await worker.initialize();
  session = await worker.request('session/new', { cwd: directory, mcpServers: [] });
  process.stdout.write(JSON.stringify(readReviewReport(prepared.control, session.sessionId), null, 2) + '\n');
} catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
finally { process.stdout.write(JSON.stringify({ cleanup: await worker.shutdown(session?.sessionId) }) + '\n'); }
