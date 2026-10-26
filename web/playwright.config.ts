import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4397', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev-data --site wa-blanchard --site nz-coronet-peak --site mx-valle-de-bravo-el-penon --site mx-la-salina --skip-solar --now 2026-10-25T18:00:00Z && pnpm preview:fixtures --ignore-lock --host 127.0.0.1 --port 4397',
    url: 'http://127.0.0.1:4397/launches/wa-blanchard',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PUBLIC_WINDGRAMS_DATA_BASE: '', WINDGRAMS_BASE: '/' },
  },
});
