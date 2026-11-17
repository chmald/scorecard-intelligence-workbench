import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PLAYWRIGHT_PORT || 4387);
process.env.WORKBENCH_BROWSER_STATE ??= path.join(root, 'tests', 'browser', '.state', `run-${process.pid}`);

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  outputDir: './tests/browser/.results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 12000 },
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'node scripts/browser-server.mjs',
    cwd: root,
    env: { PLAYWRIGHT_PORT: String(port), WORKBENCH_BROWSER_STATE: process.env.WORKBENCH_BROWSER_STATE },
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 30000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
