import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.TSGIT_BROWSER_PORT ?? 5181);
const isCi = process.env.CI !== undefined;

export default defineConfig({
  testDir: './test/browser',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  retries: isCi ? 1 : 0,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'reports/playwright',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node test/browser/serve.mjs',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !isCi,
    timeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
