export const DEFAULT_RRFS_BASE = 'https://noaa-rrfs-ops-pds.s3.amazonaws.com';
export function rrfsBase(env: Record<string, string | undefined> = process.env): string { return (env.METEO_RRFS_BASE || DEFAULT_RRFS_BASE).replace(/\/+$/, ''); }
export function modelFeedEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> { return { ...env, METEO_RRFS_BASE: rrfsBase(env) }; }
export function configureModelFeeds(env: Record<string, string | undefined> = process.env): void { env.METEO_RRFS_BASE = rrfsBase(env); }
