import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../app/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.env.WORKBENCH_BROWSER_STATE || path.join(root, 'tests', 'browser', '.state', `manual-${process.pid}`));
const boundary = path.join(root, 'tests', 'browser', '.state') + path.sep;
if (!directory.startsWith(boundary)) throw new Error('Browser state must be isolated under tests/browser/.state.');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const config = JSON.parse(await readFile(path.join(root, 'demo-ids.template.json'), 'utf8'));
const server = await start({
  config,
  env: { HOST: '127.0.0.1', PORT: process.env.PLAYWRIGHT_PORT || '4387', AUTH_MODE: 'local', STATE_FILE: path.join(directory, 'state.json'), EXTRACTION_PROVIDER: 'local', ANSWER_PROVIDER: 'local' },
  sampleDirectory: path.join(directory, 'samples'),
});
console.log(`Isolated browser workbench ready on 127.0.0.1:${server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => { await rm(directory, { recursive: true, force: true }); process.exit(0); }));
}
