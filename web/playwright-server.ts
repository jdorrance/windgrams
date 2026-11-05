/** Shared fixture server for legacy and AV browser contracts. */
export function fixtureServer(port: number, avBase = '') {
  return {
    command: `node scripts/make-dev-data.mjs --site wa-blanchard --site nz-coronet-peak --site mx-valle-de-bravo-el-penon --site mx-la-salina --skip-solar --now 2026-10-25T18:00:00Z && node node_modules/astro/bin/astro.mjs build && node scripts/preview-data.mjs && node node_modules/astro/bin/astro.mjs preview --ignore-lock --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/launches/wa-blanchard`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      WINDGRAMS_DATA_MODE: 'fixtures',
      PUBLIC_WINDGRAMS_DATA_BASE: '',
      PUBLIC_AV_API_BASE: avBase,
      WINDGRAMS_BASE: '/',
    },
  };
}
