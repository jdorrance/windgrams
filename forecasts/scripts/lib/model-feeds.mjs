// Keep the operator on NOAA's replacement RRFS feed until the pinned forecast
// package adopts it. Explicit mirrors/test endpoints remain supported.
export const DEFAULT_RRFS_BASE = 'https://noaa-rrfs-ops-pds.s3.amazonaws.com';

export function rrfsBase(env = process.env) {
  return (env.METEO_RRFS_BASE || DEFAULT_RRFS_BASE).replace(/\/+$/, '');
}

export function modelFeedEnvironment(env = process.env) {
  return { ...env, METEO_RRFS_BASE: rrfsBase(env) };
}

export function configureModelFeeds(env = process.env) {
  env.METEO_RRFS_BASE = rrfsBase(env);
}
