import { test, expect } from '@playwright/test';

const launch = '/launches/wa-blanchard?model=hrrr-conus&day=2026-10-25';
const now = new Date('2026-10-25T18:00:00Z');
const transparentPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: now });
  // App data comes from the local fixture server. Basemap tiles never require the internet.
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') await route.continue();
    else if (route.request().resourceType() === 'image') await route.fulfill({ contentType: 'image/png', body: transparentPixel });
    else await route.abort();
  });
});

test('launch model switching preserves one interactive chart across resize, units and page restoration', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(launch);
  await expect(page.locator('#fixture-mode-notice')).toHaveText('Synthetic test data');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await page.locator('#model-select').selectOption('gfs');
  await expect(page.locator('#model-selected-name')).toHaveText('GFS');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await expect(page).toHaveURL(/model=gfs/);
  await page.locator('#unit-system').selectOption('metric');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await expect(page.locator('#meteogram > svg')).toHaveAttribute('viewBox', /^0 0 356 /);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const previous = Number(await page.locator('#forecast-hour').inputValue());
  await page.locator('#forecast-hour-next').click();
  await expect(page.locator('#forecast-hour')).toHaveValue(String(previous + 1));
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  await page.locator('#forecast-hour-next').click();
  await expect(page.locator('#forecast-hour')).toHaveValue(String(previous + 1));
  expect(errors).toEqual([]);
});

test('an old run keeps a visible stale notice alongside its chart', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-26T10:00:00Z'));
  await page.goto(launch);
  const notice = page.locator('#forecast-freshness');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-freshness', 'stale');
  await expect(notice).toHaveText('Old forecast · reload for update');
});

test('archived regional replay labels history and advances the chart with its hour', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/soaring?case=synthetic-archive&hour=11');
  await expect(page.locator('#fixture-mode-notice')).toBeVisible();
  await expect(page.locator('#replay-freshness')).toHaveAttribute('data-freshness', 'historical');
  await expect(page.locator('#replay-freshness')).toHaveText('Historical forecast');
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  const previous = Number(await page.locator('#replay-hour').inputValue());
  await page.locator('#replay-next').click();
  await expect(page.locator('#replay-hour')).toHaveValue(String(previous + 1));
  await expect(page).toHaveURL(/hour=12/);
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  expect(errors).toEqual([]);
});
