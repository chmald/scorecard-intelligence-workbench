import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAzureAdapters, createCredential, resolveAzureEnvironment, validateContentUnderstanding } from '../app/azure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadConfiguration() {
  for (const name of ['demo-ids.local.json', 'demo-ids.template.json']) {
    try { return JSON.parse(await readFile(path.join(root, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Document domain configuration is required.');
}

export async function configureContentUnderstanding({ env = process.env, config, credential, fetchImpl } = {}) {
  config ??= await loadConfiguration();
  const resolved = resolveAzureEnvironment(env, config);
  validateContentUnderstanding(resolved);
  const identity = credential ?? await createCredential(resolved);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      return await createAzureAdapters({ env: resolved, credential: identity, fetchImpl, timeoutMs: deadline - Date.now() }).configureAnalyzer(config.domain);
    } catch (error) {
      if (!/HTTP 403/.test(error.message) || Date.now() + 5000 >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  throw new Error('Content Understanding setup timed out while waiting for resource role propagation.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await configureContentUnderstanding();
    console.log(`Content Understanding analyzer ${result.analyzerId} is ${result.status}. Existing schemas and model mappings were not replaced.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
