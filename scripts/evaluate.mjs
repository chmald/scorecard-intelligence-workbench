import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { evaluateSamples } from '../app/evaluation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'demo-ids.template.json'), 'utf8'));
const result = await evaluateSamples(path.join(root, 'samples'), config.domain);
console.log(JSON.stringify(result, null, 2));
if (!result.summary.total || result.summary.passed !== result.summary.total) process.exitCode = 1;
