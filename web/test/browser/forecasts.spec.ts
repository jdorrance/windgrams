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

test('a current forecast shows a failed refresh without hiding the chart or changing its age', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-25T14:00:00Z'));
  await page.route('**/health/noaa-cloud.json', route => route.fulfill({ json: {
    schemaVersion: 1, group: 'noaa-cloud', models: { 'hrrr-conus': {
      attemptedAt: '2026-10-25T13:00:00Z', completedAt: '2026-10-25T13:30:00Z',
      lastSuccessfulRefreshAt: '2026-10-25T12:00:00Z', outcome: 'retained', reason: '/tmp/provider private diagnostic',
    } },
  } }));
  await page.goto(launch);
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  const notice = page.locator('#forecast-freshness');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-freshness', 'current');
  await expect(notice).toHaveText('Latest update did not complete; showing the available forecast.');
  await page.locator('#model-select').selectOption('gfs');
  await expect(page.locator('#model-selected-name')).toHaveText('GFS');
  await expect(notice).toBeHidden();
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

test('regional map loads lazily, retries failures and ignores superseded hours', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', request => {
    if (/\/hour-\d+\.json$/.test(request.url())) requested.push(new URL(request.url()).pathname.split('/').at(-1)!);
  });
  let unavailable = true;
  let release: () => void = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/hour-11.json', async route => {
    if (unavailable) await route.fulfill({ status: 404, body: 'unavailable' });
    else { await delayed; await route.continue(); }
  });
  await page.goto('/soaring?case=synthetic-archive&hour=10');
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  expect(requested).toEqual(['hour-10.json']);
  await expect(page.locator('#replay-prev')).toBeDisabled();
  const validAt = await page.locator('#soaring-map').getAttribute('data-valid-at');
  await page.locator('#replay-next').click();
  await expect(page.locator('#cell-notice')).toContainText('Forecast unavailable');
  await expect(page.locator('#replay-prev')).toBeEnabled();
  await expect(page.locator('#soaring-map')).toHaveAttribute('data-valid-at', validAt!);
  await page.locator('#replay-prev').click();
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  await expect(page.locator('#cell-notice')).toBeHidden();

  unavailable = false;
  try {
    await page.locator('#replay-next').click();
    await expect(page.locator('#cell-notice')).toHaveText('Loading forecast…');
    await page.locator('#replay-prev').click();
    await expect(page.locator('#cell-notice')).toBeHidden();
    const response = page.waitForResponse('**/hour-11.json');
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#soaring-map')).toHaveAttribute('data-valid-at', validAt!);
    await expect(page).toHaveURL(/hour=10/);
    await page.locator('#replay-next').click();
    await expect(page).toHaveURL(/hour=11/);
    await expect(page.locator('#cell-notice')).toBeHidden();
    expect(requested).toEqual(['hour-10.json', 'hour-11.json', 'hour-11.json']);
  } finally { release(); }
});

test('selecting a location again retries a failed profile', async ({ page }) => {
  await page.route('**/cell-0.json.gz', route => route.fulfill({ status: 404, body: 'unavailable' }));
  await page.goto('/soaring?case=synthetic-archive&hour=11');
  await expect(page.locator('#replay-windgram')).toContainText('Profile unavailable:');
  await page.unroute('**/cell-0.json.gz');
  await page.locator('#select-blanchard').click();
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
});
