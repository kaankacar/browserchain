// End-to-end tests: the production build in real Chromium, several tabs =
// several validators. Real ledgers close about every 5 s, so the timeouts are
// long and the tests wait on node state, not on time.
// Run: npx playwright test (E2E_WEBRTC=1 adds the WebRTC spec, which needs the internet).
import { defineConfig, devices } from '@playwright/test';

// Parallel runs (several terminals or agents) set E2E_PORT to get their own
// port, build folder and result files.
const PORT = Number(process.env.E2E_PORT ?? 4173);
const SUFFIX = process.env.E2E_PORT ? `-${PORT}` : '';
const OUT_DIR = process.env.E2E_PORT ? `dist-e2e-${PORT}` : 'dist';

export default defineConfig({
  testDir: './e2e',
  // the other test-results/* folders belong to other tools: keep ours apart
  outputDir: `test-results/e2e${SUFFIX}`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: `test-results/e2e-report${SUFFIX}.json` }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx vite build --outDir ${OUT_DIR} && npx vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
