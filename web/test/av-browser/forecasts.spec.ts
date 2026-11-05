import { test, expect } from '@playwright/test';
import { avFetch, createAvFixture } from '../../../packages/data-client/test/av-fixture.mjs';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
test('AV regional point scrubbing uses one pinned profile, retains raw native coordinates and reopens saved profiles offline', async ({
  page,
}) => {
  const transport = avFetch(createAvFixture(24)),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/av-api/')) {
      const response = await transport.fetch(url.href);
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    } else if (url.hostname === '127.0.0.1') await route.continue();
    else if (route.request().resourceType() === 'image')
      await route.fulfill({ contentType: 'image/png', body: png });
    else await route.abort();
  });
  await page.goto('/soaring?region=north-sound&model=gfs&launch=wa-blanchard');
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  await expect(page.locator('#launches-table-body tr')).not.toHaveCount(0);
  await expect(page.locator('#cell-location')).toContainText('Native cell');
  await expect(page.locator('#cell-title')).toHaveText('Blanchard');
  const count = transport.calls.filter((url) => url.includes('/profile?')).length;
  await page.locator('#replay-next').click();
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  expect(transport.calls.filter((url) => url.includes('/profile?')).length).toBe(count);
  const pointSelect = page.getByLabel('Point forecast');
  await pointSelect.selectOption(transport.data.profile.frames[20].validTime);
  await expect(page.locator('#windgram-subtitle')).toContainText('Map:');
  expect(transport.calls.filter((url) => url.includes('/profile?')).length).toBe(count);
  await page.getByRole('button', { name: 'Load route profiles for this hour' }).click();
  await expect(page.locator('#replay-cross-section > svg')).toHaveCount(1);
  const route = await page.locator('#replay-cross-section').innerHTML();
  const routeLabel = await page.locator('#cross-section-route').textContent();
  const location = await page.locator('#cell-location').textContent();
  await page.getByRole('button', { name: 'Save point and loaded route profiles' }).click();
  await expect(page.locator('#cell-notice')).toContainText('Saved native profiles');
  await expect(page.locator('#launches-table-body')).toHaveAttribute(
    'data-valid-at',
    transport.data.profile.frames[1].validTime,
  );
  const before = transport.calls.length;
  await page.getByRole('link', { name: 'Open saved point and route profiles' }).click();
  await expect(page.locator('#replay-run')).toContainText('SAVED NATIVE PROFILES');
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  await expect(page.locator('#cell-title')).toHaveText('Blanchard');
  await expect(page.locator('#cell-location')).toHaveText(location!);
  await expect(page.getByLabel('Point forecast')).toHaveValue(transport.data.profile.frames[20].validTime);
  await page.getByRole('button', { name: 'Load route profiles for this hour' }).click();
  await expect(page.locator('#replay-cross-section > svg')).toHaveCount(1);
  await expect(page.locator('#cross-section-route')).toHaveText(routeLabel!);
  expect(await page.locator('#replay-cross-section').innerHTML()).toBe(route);
  expect(transport.calls.length).toBe(before);
  expect(errors).toEqual([]);
});
test('AV launch failures stay unavailable while unrelated HRRR keeps its legacy data source', async ({ page }) => {
  await page.route('**/av-api/**', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.goto('/launches/wa-blanchard?model=hrrr-conus&day=2026-10-25');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await expect(page.locator('#model-select option[value=gfs]')).toHaveCount(0);
});

test('AV weather configuration retains the existing sunlight terrain source', async ({ page }) => {
  await page.route('**/av-api/**', route => route.fulfill({ status: 404, body: '{}' }));
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/solar/wa-blanchard/index.json', async route => {
    await response;
    await route.fulfill({ status: 404, body: '{}' });
  });
  const index = page.waitForRequest(request => request.url().includes('/data/solar/wa-blanchard/index.json'));
  try {
    await page.goto('/launches/wa-blanchard?model=hrrr-conus&day=2026-10-25');
    await page.locator('#sun-section').scrollIntoViewIfNeeded();
    expect(new URL((await index).url()).pathname).toBe('/data/solar/wa-blanchard/index.json');
  } finally { release(); }
});
