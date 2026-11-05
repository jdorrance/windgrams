import { defineConfig, devices } from '@playwright/test';
import { fixtureServer } from './playwright-server.ts';
export default defineConfig({
  testDir: './test/av-browser',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4398', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: fixtureServer(4398, '/av-api'),
});
