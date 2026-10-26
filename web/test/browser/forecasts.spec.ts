import { test, expect } from '@playwright/test';
import { buildSolarTerrain, domainFor, expandBounds, gridFromFunction } from '@windgrams/providers/solar';
import { latLonToPixel } from '../../src/lib/relief.ts';

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
  await page.locator('#forecast-hour-prev').click();
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

test('launch wind basis and native support remain explicit beside the chart', async ({ page }) => {
  await page.route('**/hrrr-conus/sites/wa-blanchard.json', async route => {
    const response = await route.fetch(), profile = await response.json();
    const field = { firstLevelAglM: 550, levelsInLowest1000M: 2, maxGapInLowest1000M: 700 };
    profile.site.modelElevationM = 1000;
    for (const hour of profile.hours) {
      hour.surface.windSpeedMps = 0;
      hour.surface.windDirectionDeg = 0;
      hour.soaring = {
        thermalVelocityV2Mps: hour.derived.thermalVelocityMps, resolvedThermalTopM: hour.derived.boundaryLayerTopM,
        usableLiftTopV2M: hour.derived.usableLiftTopM, surfaceLclM: hour.derived.cloudBaseM,
        verticalResolution: { nativeLevelCount: 8, aboveGroundLevelCount: 8, isSparseProfile: true, hasSub925Levels: false, hasUpperAirAbove600Levels: false, has80mWind: false, synthesizedLevels: 0, sampling: { temperature: field, moisture: field, wind: field } },
        diagnosticSupport: { thermalDepth: { branch: 'profile-top', bracketMslM: null, topLimited: true }, cloudLimit: { source: 'surface-lcl' }, surfacePressure: { source: 'hypsometric', valueHpa: 950 } },
      };
    }
    await route.fulfill({ json: profile });
  });
  await page.goto(`${launch}&units=metric`);
  await expect(page.locator('#forecast-wind-basis')).toContainText('Wind is 10 m above model ground. Model ground: 1,000 m MSL');
  await expect(page.locator('#forecast-wind-basis')).toContainText('Model − launch:');
  await expect(page.locator('#forecast-conditions dt').first()).toHaveText('Model surface wind');
  await expect(page.locator('#forecast-conditions dd').first()).toHaveText('Light / calm');
  await expect(page.locator('#skewt-chart .skewt-barb-calm')).toHaveCount(1);
  await expect(page.locator('#forecast-data-limit')).toBeVisible();
  await expect(page.locator('#forecast-data-limit')).toContainText('upper boundary is unresolved');
  await page.getByText('Profile data support', { exact: true }).click();
  await expect(page.locator('#forecast-data-support')).toContainText('First native level: 550 m above model ground');
  await expect(page.locator('#forecast-data-support')).toContainText('Native model boundary-layer depth');
  await page.locator('#model-select').selectOption('gfs');
  await expect(page.locator('#forecast-wind-basis')).toContainText('Model ground: 1,380 m MSL');
  await expect(page.locator('#forecast-data-limit')).toBeHidden();
  await expect(page.locator('#forecast-data-support')).toContainText('Not published for this forecast');
});

test('NZ launches retain their country, local day and global models on mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?country=NZ');
  await expect(page.locator('#launch-country')).toHaveValue('NZ');
  await expect(page.locator('.state-group[data-country="US"]:visible')).toHaveCount(0);
  await page.getByRole('link', { name: 'Coronet Peak', exact: true }).click();
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'Launch info', exact: true }).click();
  await expect(page.locator('#launch-info a[href="https://southernclub.co.nz/visiting-pilots/"]')).toBeVisible();
  await page.getByRole('button', { name: 'Close launch info', exact: true }).click();
  expect(await page.locator('#model-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['gfs', 'gdps', 'geps']);
  await expect(page).toHaveURL(/day=2026-10-26/);
  for (const model of ['gdps', 'geps', 'gfs']) {
    await page.locator('#model-select').selectOption(model);
    await expect(page.locator('#model-selected-name')).toHaveText(model.toUpperCase());
    await expect(page.locator('#meteogram > svg')).toHaveCount(1);
    await expect(page).toHaveURL(/day=2026-10-26/);
  }
  await page.locator('#unit-system').selectOption('metric');
  const chart = page.locator('#meteogram > svg');
  await expect(chart.locator('.wg-hour-top')).toHaveText(['8a', '11a', '2p', '5p', '8p']);
  const initialSize = await chart.getAttribute('viewBox');
  await page.locator('#forecast-hour-next').click();
  await expect(page.locator('#forecast-hour-panel')).toHaveAttribute('data-valid-at', '2026-10-26T04:00:00Z');
  await expect(page.locator('#forecast-hour-label')).toHaveText('5 PM');
  await expect(chart).toHaveAttribute('viewBox', initialSize!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#soaring-nav-link').click();
  await expect(page).toHaveURL(/country=NZ/);
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /New Zealand launches/i })).toBeVisible();
  await page.getByRole('link', { name: /New Zealand launches/i }).click();
  await expect(page.locator('#launch-country')).toHaveValue('NZ');
  expect(errors).toEqual([]);
});

test('Mexico launches retain local forecasts and return from the unavailable grid map on mobile', async ({ page }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?country=MX');
  await expect(page.locator('#launch-country')).toHaveValue('MX');
  await expect(page.locator('.state-group:not([data-country="MX"]):visible')).toHaveCount(0);
  const cards = page.locator('.state-group[data-country="MX"] .launch-card');
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  await expect(page.locator('#launch-map .map-dot')).toHaveCount(count);
  await page.locator('.launch-card[href="/launches/mx-valle-de-bravo-el-penon"]').click();
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await expect(page).toHaveURL(/day=2026-10-25/);
  await page.getByRole('button', { name: 'Launch info', exact: true }).click();
  await expect(page.locator('#launch-info')).toContainText('America/Mexico_City');
  await expect(page.locator('#launch-info a[href*="paraglidingearth.com"]')).toBeVisible();
  await page.getByRole('button', { name: 'Close launch info', exact: true }).click();
  expect(await page.locator('#model-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['gfs', 'gdps', 'geps']);
  for (const model of ['gdps', 'geps', 'gfs']) {
    await page.locator('#model-select').selectOption(model);
    await expect(page.locator('#model-selected-name')).toHaveText(model.toUpperCase());
    await expect(page.locator('#meteogram > svg')).toHaveCount(1);
    await expect(page).toHaveURL(/day=2026-10-25/);
  }
  await page.locator('#unit-system').selectOption('metric');
  await page.locator('#forecast-hour-next').click();
  const validAt = await page.locator('#forecast-hour-panel').getAttribute('data-valid-at');
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric' }).format(new Date(validAt!));
  await expect(page.locator('#forecast-hour-label')).toHaveText(hour);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests.filter(path => /\/(nws|raob)\//.test(path))).toEqual([]);
  await page.locator('#soaring-nav-link').click();
  await expect(page).toHaveURL(/country=MX/);
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(0);
  await expect(page.locator('#soaring-map canvas')).toHaveCount(0);
  await expect(page.locator('#replay-status')).toHaveText('Regional map unavailable.');
  await expect(page.getByRole('link', { name: 'Mexico launches', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Mexico launches', exact: true }).click();
  await expect(page.locator('#launch-country')).toHaveValue('MX');
  expect(errors).toEqual([]);
});

test('long launch names keep heading controls inside the card on narrow screens', async ({ page }) => {
  await page.goto('/launches/mx-valle-de-bravo-el-penon?model=gfs&units=metric');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.locator('.forecast-heading').evaluate(heading => ({
      headingRight: heading.getBoundingClientRect().right,
      controlsRight: Math.max(...Array.from(heading.querySelectorAll('button'), button => button.getBoundingClientRect().right)),
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    }));
    expect(layout.controlsRight, `heading controls at ${width}px`).toBeLessThanOrEqual(layout.headingRight);
    expect(layout.pageWidth, `page width at ${width}px`).toBeLessThanOrEqual(layout.viewportWidth);
  }
});

test('northern Mexican launches offer published regional point forecasts', async ({ page }) => {
  await page.goto('/launches/mx-la-salina');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  expect(await page.locator('#model-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['hrrr-conus', 'gfs', 'rrfs', 'gdps', 'geps']);
  await page.locator('#model-select').selectOption('rrfs');
  await expect(page.locator('#model-selected-name')).toHaveText('RRFS');
  await expect(page.locator('#meteogram > svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'Launch info', exact: true }).click();
  await expect(page.locator('#launch-info')).toContainText('America/Tijuana');
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
  await expect(notice).toHaveText('Latest update failed');
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

test('regional legend explains the layer sign conventions', async ({ page }) => {
  await page.goto('/soaring?case=synthetic-archive&hour=11');
  await expect(page.locator('#replay-windgram > svg')).toHaveCount(1);
  // The archived replay opens on surface wind; its layer note must be in the legend,
  // not only the numeric stops (previously spec.legend was never rendered).
  await expect(page.locator('#replay-legend')).toContainText('Wind at model surface.');
});

test('regional audit caveats render as text inside forecast details', async ({ page }) => {
  const limitations = ['Native levels cannot resolve every inversion.', '<img src=x onerror=alert(1)>'];
  await page.route('**/audit.json', async route => {
    const response = await route.fetch();
    const audit = await response.json();
    await route.fulfill({ json: { ...audit, limitations } });
  });
  await page.goto('/soaring?case=synthetic-archive&hour=11');
  await page.getByText('About this forecast', { exact: true }).click();
  await expect(page.locator('#audit-limitations > li')).toHaveText(limitations);
  await expect(page.locator('#audit-limitations img')).toHaveCount(0);
});

test('launch chart owners retain observers through bfcache and release them on final departure', async ({ page }) => {
  await page.addInitScript(() => {
    const native = window.ResizeObserver;
    const observed = new Map<ResizeObserver, string[]>();
    Object.defineProperty(window, 'observedCharts', { value: observed });
    window.ResizeObserver = class extends native {
      observe(target: Element, options?: ResizeObserverOptions) {
        observed.set(this, [...(observed.get(this) ?? []), target.id]);
        super.observe(target, options);
      }
      disconnect() { observed.delete(this); super.disconnect(); }
    };
  });
  await page.goto(launch);
  await expect(page.locator('#skewt-chart > svg')).toHaveCount(1);
  const activeCharts = () => page.evaluate(() => [...(window as unknown as { observedCharts: Map<ResizeObserver, string[]> }).observedCharts.values()]
    .flat().filter(id => ['skewt-chart', 'sun-curve', 'nws-charts', 'ecmwf-charts', 'balloon-chart'].includes(id)).sort());
  const initial = await activeCharts();
  expect(initial).toContain('skewt-chart'); expect(initial).toContain('sun-curve');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(await activeCharts()).toEqual(initial);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.locator('#forecast-hour-next').click();
  await expect(page.locator('#skewt-chart > svg')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  expect(await activeCharts()).toEqual([]);
  await expect(page.locator('#skewt-chart > svg')).toHaveCount(0);
});

test('station polling recovers from a stalled body, resumes after bfcache and aborts on departure', async ({ page }) => {
  await page.addInitScript(() => {
    const native = window.fetch;
    const signals: AbortSignal[] = [];
    Object.defineProperty(window, 'stationSignals', { value: signals });
    window.fetch = (input, init) => {
      if (String(input).startsWith('/api/stations/') && init?.signal) {
        signals.push(init.signal);
        if (signals.length === 1) {
          const signal = init.signal;
          return Promise.resolve(new Response(new ReadableStream({
            start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
          })));
        }
      }
      return native(input, init);
    };
  });
  await page.route('**/launches/wa-blanchard?**', async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('</body>', `<section id="station"><script id="station-config" type="application/json">{"id":"KTEST1","name":"Test station","url":"https://example.com/station"}</script><p id="station-status"></p><div id="station-body"></div><svg id="station-compass"></svg><p id="station-age"></p></section></body>`);
    await route.fulfill({ response, body: html });
  });
  let calls = 0, release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/stations/KTEST1', async route => {
    if (++calls > 1) await held;
    await route.fulfill({ status: 503, json: { error: 'not connected' } });
  });
  await page.goto(launch);
  await expect.poll(() => page.evaluate(() => (window as unknown as { stationSignals: AbortSignal[] }).stationSignals[0]?.aborted), { timeout: 20_000 }).toBe(true);
  await page.clock.fastForward(120_000);
  await expect(page.locator('#station-status')).toContainText('not connected');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.clock.runFor(150_000);
  expect(calls).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => calls).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  expect(await page.evaluate(() => (window as unknown as { stationSignals: AbortSignal[] }).stationSignals.every(signal => signal.aborted))).toBe(true);
  release();
  await page.clock.runFor(150_000);
  expect(calls).toBe(2);
  await expect(page.locator('#station-status')).toContainText('not connected');
});

test('sunlight retries tiles, ignores older point selections and retains suspended 3D rendering', async ({ page }) => {
  const site = { slug: 'wa-blanchard', latitude: 48.6097, longitude: -122.426 };
  const bounds = domainFor(site.latitude, site.longitude, 1).bounds;
  const grid = gridFromFunction(() => 100, { ...expandBounds(bounds, 1500), dLon: 1 / 3600, dLat: 1 / 3600 });
  const { index, tiles, relief } = buildSolarTerrain(site, { fine: grid, coarse: grid, radiusKm: 1, maxDistanceKm: 1,
    sources: { surface: { id: 'test', name: 'Flat test terrain', resolutionM: 30, licence: 'test', url: '' } } });
  const paths = new Map(tiles.map(tile => [index.tiles.path.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y)), tile.body]));
  let tilesAvailable = false, releaseRelief = () => {};
  const heldRelief = new Promise<void>(resolve => { releaseRelief = resolve; });
  const launchPixel = latLonToPixel(site.latitude, site.longitude, index.tiles.maxZoom);
  const westernTile = index.tiles.path.replace('{z}', String(index.tiles.maxZoom))
    .replace('{x}', String(Math.floor(launchPixel.x / 256) - 1)).replace('{y}', String(Math.floor(launchPixel.y / 256)));
  let holdWesternTile = false, westernRequested = false, releaseWestern = () => {};
  const heldWestern = new Promise<void>(resolve => { releaseWestern = resolve; });
  await page.route('**/solar/wa-blanchard/**', async route => {
    const path = route.request().url().split('/solar/wa-blanchard/')[1];
    if (path === 'index.json') return route.fulfill({ json: index });
    if (path === index.relief.path) {
      await heldRelief;
      return route.fulfill({ body: Buffer.from(relief.body) });
    }
    if (holdWesternTile && path === westernTile) { westernRequested = true; await heldWestern; }
    const body = tilesAvailable ? paths.get(path) : undefined;
    await route.fulfill(body ? { body: Buffer.from(body) } : { status: 404 });
  });
  await page.addInitScript(() => {
    const graphics = { draws: 0, deletedTextures: 0 };
    Object.defineProperty(window, 'sunlightGraphics', { value: graphics });
    const draw = WebGL2RenderingContext.prototype.drawElements;
    const remove = WebGL2RenderingContext.prototype.deleteTexture;
    WebGL2RenderingContext.prototype.drawElements = function(...args) {
      if ((this.canvas as HTMLCanvasElement).closest('#sun-3d')) graphics.draws++;
      return draw.apply(this, args);
    };
    WebGL2RenderingContext.prototype.deleteTexture = function(texture) {
      if (texture && (this.canvas as HTMLCanvasElement).closest('#sun-3d')) graphics.deletedTextures++;
      return remove.call(this, texture);
    };
  });
  await page.goto(launch);
  await page.locator('#sun-section').scrollIntoViewIfNeeded();
  await expect(page.locator('#sun-map canvas')).toHaveCount(1);
  await expect(page.locator('#sun-readout')).not.toBeEmpty();
  await expect(page.locator('#sun-curve > svg')).toHaveCount(0);
  tilesAvailable = true;
  await page.locator('#sun-map canvas').click();
  await expect(page.locator('#sun-curve > svg')).toHaveCount(1);
  holdWesternTile = true;
  const mapBox = (await page.locator('#sun-map canvas').boundingBox())!;
  await page.locator('#sun-map canvas').click({ position: { x: mapBox.width / 2 - 60, y: mapBox.height / 2 } });
  await expect.poll(() => westernRequested).toBe(true);
  await page.locator('#sun-reset').click();
  await expect(page.locator('#sun-reset')).toBeHidden();
  const selectedPoint = await page.locator('#sun-point').textContent();
  releaseWestern();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#sun-point')).toHaveText(selectedPoint!);
  await page.locator('#sun-view [data-view="3d"]').click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  releaseRelief();
  await expect(page.locator('#sun-3d canvas')).toHaveCount(1);
  await page.clock.runFor(100);
  const graphics = () => page.evaluate(() => (window as unknown as { sunlightGraphics: { draws: number; deletedTextures: number } }).sunlightGraphics);
  expect((await graphics()).draws).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(async () => (await graphics()).draws).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  await expect(page.locator('#sun-3d canvas, #sun-map canvas')).toHaveCount(0);
  expect((await graphics()).deletedTextures).toBeGreaterThan(0);
});

test('a balloon with missing humidity visibly qualifies its dry parcel estimate', async ({ page }) => {
  await page.route('**/raob/sites/wa-blanchard.json', route => route.fulfill({ json: {
    schemaVersion: 1, generatedAt: '2026-10-25T13:00:00Z',
    station: { id: 'KTEST', name: 'Test station', latitude: 48, longitude: -122, distanceKm: 10, elevationM: 100 },
    soundings: [{ validAt: '2026-10-25T12:00:00Z', levels: Array.from({ length: 11 }, (_, i) => ({
      pressureHpa: 1000 - i * 50, heightM: 100 + i * 500, temperatureC: 20 - i * 4,
      dewPointC: null, windSpeedMps: 0, windDirectionDeg: null,
    })) }],
  } }));
  await page.goto(launch);
  await expect(page.locator('#balloon-headline')).toContainText('Dry estimate');
  await expect(page.locator('#balloon-findings li').filter({ hasText: 'Cloud base' })).toContainText('Unavailable · humidity missing');
  await expect(page.locator('#balloon-chart .skewt-dew')).toHaveCount(0);
  await expect(page.locator('#balloon-chart .skewt-mark-base')).toHaveCount(0);
  await expect(page.locator('#balloon-chart .skewt-barb-calm')).not.toHaveCount(0);
});

test('model and balloon Skew-T charts on one page use unique SVG ids', async ({ page }) => {
  await page.goto(launch);
  await expect(page.locator('#skewt-chart > svg')).toHaveCount(1);
  await expect(page.locator('#balloon-chart > svg')).toHaveCount(1);
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('#skewt-chart svg [id], #balloon-chart svg [id]')].map(node => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicates).toEqual([]);
  await expect(page.locator('#skewt-chart svg clipPath')).toHaveCount(1);
  await expect(page.locator('#balloon-chart svg clipPath')).toHaveCount(1);
});

test('a late sunlight response cannot mount or update a departed view', async ({ page }) => {
  await page.addInitScript(() => {
    const native = window.fetch;
    window.fetch = (input, init) => {
      if (!String(input).includes('/solar/wa-blanchard/index.json')) return native(input, init);
      Object.defineProperty(window, 'solarSignal', { value: init?.signal });
      // Deliberately ignore cancellation to exercise the late-completion guard too.
      return new Promise<Response>(resolve => Object.defineProperty(window, 'finishSolarRead', {
        value: () => resolve(new Response('{}', { status: 404 })),
      }));
    };
  });
  await page.goto(launch);
  await page.locator('#sun-section').scrollIntoViewIfNeeded();
  await expect(page.locator('#sun-status')).toHaveText('Loading the terrain…');
  await expect.poll(() => page.evaluate(() => 'solarSignal' in window)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(await page.evaluate(() => (window as unknown as { solarSignal: AbortSignal }).solarSignal.aborted)).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.evaluate(async () => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    (window as unknown as { finishSolarRead(): void }).finishSolarRead();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
  expect(await page.evaluate(() => (window as unknown as { solarSignal: AbortSignal }).solarSignal.aborted)).toBe(true);
  await expect(page.locator('#sun-status')).toHaveText('Loading the terrain…');
  await expect(page.locator('#sun-map canvas')).toHaveCount(0);
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
