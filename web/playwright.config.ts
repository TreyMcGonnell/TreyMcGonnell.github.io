import { defineConfig } from '@playwright/test';

// End-to-end tests run against a production build made from generated sample content (tests/.content)
// and a mock API with real streaming (tests/e2e/mock-api.ts). One worker: the mock API holds one scenario.
const MOCK_PORT = 8787;
const WEB_PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: process.env.PW_CHANNEL || 'chrome',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --experimental-strip-types --no-warnings tests/e2e/mock-api.ts',
      port: MOCK_PORT,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_PORT: String(MOCK_PORT) },
    },
    {
      command: `node --experimental-strip-types --no-warnings tests/e2e/fixture-content.ts && npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { CONTENT_DIR: 'tests/.content', VITE_API_BASE: `http://localhost:${MOCK_PORT}` },
    },
  ],
});
