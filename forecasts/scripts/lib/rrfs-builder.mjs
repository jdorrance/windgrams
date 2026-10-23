// @azohra/meteo.forecast 0.6.0 supports pinned reference times in buildNoaa,
// but its public CLI/registry omit that option. Keep this compatibility bridge
// isolated; its contract test must pass whenever the dependency is upgraded.
export async function loadRrfsBuilder() {
  const adapter = await import(new URL('./builders/noaa.js', import.meta.resolve('@azohra/meteo.forecast')));
  if (typeof adapter.buildNoaa !== 'function' || adapter.RRFS?.slug !== 'rrfs' || typeof adapter.RRFS.completionUrls !== 'function') {
    throw new Error('The forecast dependency no longer exposes the pinned RRFS builder contract');
  }
  return { build: options => adapter.buildNoaa(adapter.RRFS, options), model: adapter.RRFS };
}
