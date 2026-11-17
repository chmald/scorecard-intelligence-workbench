import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(root, name), 'utf8');

async function sourceFiles(directory, extensions) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['assets', 'public', 'node_modules', '__pycache__'].includes(entry.name)) {
        result.push(...await sourceFiles(name, extensions));
      }
    } else if (extensions.includes(path.extname(entry.name))) result.push(name);
  }
  return result;
}

test('configuration reference covers deployed substitutions, outputs and runtime reads', async () => {
  const doc = await read('docs\\08-configuration-reference.md');
  const variables = new Set();
  for (const match of (await read('infra\\azd.parameters.json')).matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)) variables.add(match[1]);
  for (const match of (await read('infra\\azd.bicep')).matchAll(/^output ([A-Z][A-Z0-9_]+) /gm)) variables.add(match[1]);
  for (const file of [
    ...await sourceFiles('app', ['.mjs']),
    ...await sourceFiles('scripts', ['.mjs', '.ps1', '.py']),
    ...await sourceFiles('infra\\hooks', ['.ps1']),
  ]) {
    const text = await read(file);
    for (const pattern of [
      /\benv\.([A-Z][A-Z0-9_]+)/g,
      /\$env:([A-Z][A-Z0-9_]+)/g,
      /Get-(?:Boolean)?Setting\s+['"]([A-Z][A-Z0-9_]+)['"]/g,
      /(?:environ\.get|environ\[|getenv)\(?['"]([A-Z][A-Z0-9_]+)['"]/g,
    ]) for (const match of text.matchAll(pattern)) variables.add(match[1]);
  }
  const missing = [...variables].filter(name => !doc.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `Undocumented configuration: ${missing.join(', ')}`);
});

test('azd wrapper forwards every shared main parameter without a fork', async () => {
  const main = await read('infra\\main.bicep');
  const wrapper = await read('infra\\azd.bicep');
  const doc = await read('docs\\08-configuration-reference.md');
  for (const [, name] of main.matchAll(/^param (\w+) /gm)) {
    assert.match(wrapper, new RegExp(`\\b${name}:\\s*${name}\\b`), `Missing forwarding for ${name}`);
    assert.ok(doc.includes(`\`${name}\``), `Undocumented shared deployment parameter ${name}`);
  }
});

test('configuration reference covers deployment placeholders and every domain field', async () => {
  const config = JSON.parse(await read('demo-ids.template.json'));
  const doc = await read('docs\\08-configuration-reference.md');
  for (const key of Object.keys(config)) {
    assert.ok(doc.includes(`\`${key}\``), `Missing deployment placeholder ${key}`);
  }
  for (const key of Object.keys(config.domain)) assert.ok(doc.includes(`domain.${key}`), `Missing domain.${key}`);
  for (const kpi of config.domain.kpis) {
    for (const key of Object.keys(kpi)) {
      assert.ok(doc.includes(`domain.kpis[].${key}`), `Missing KPI ${key}`);
      if (kpi[key] && typeof kpi[key] === 'object' && !Array.isArray(kpi[key])) {
        for (const nested of Object.keys(kpi[key])) {
          assert.ok(doc.includes(`domain.kpis[].${key}.${nested}`), `Missing KPI ${key}.${nested}`);
        }
      }
    }
  }
});

test('operator script parameters and Python tool flags are discoverable in the reference', async () => {
  const doc = await read('docs\\08-configuration-reference.md');
  for (const file of ['scripts\\deploy.ps1', 'scripts\\start-local.ps1']) {
    const text = await read(file);
    const header = text.slice(0, text.indexOf("$ErrorActionPreference"));
    for (const [, name] of header.matchAll(/\$(\w+)\s*(?:=|,|\r?$)/gm)) {
      assert.ok(doc.includes(`\`-${name}\``), `Missing parameter -${name} from ${file}`);
    }
  }
  for (const file of ['scripts\\export_diagrams.py', 'scripts\\lint_doc_visuals.py', 'scripts\\make_badges.py']) {
    for (const [, flag] of (await read(file)).matchAll(/add_argument\(["'](--[\w-]+)["']/g)) {
      assert.ok(doc.includes(`\`${flag}\``), `Missing option ${flag} from ${file}`);
    }
  }
});
