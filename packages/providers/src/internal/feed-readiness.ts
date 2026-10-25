import type { CycleCandidate, CycleSelection, Readiness, ReadinessOptions, FeedAvailabilitySpec } from './readiness-types.ts';
import { rrfsBase } from '../feeds.ts';
import { modelDescriptor } from '../registry.ts';
const templates: Record<string, FeedAvailabilitySpec> = {
  'hrrr-conus': {
    slug: 'hrrr-conus',
    provider: 'NOAA NOMADS / AWS Open Data (noaa-hrrr-bdp-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 48,
    completeRunAvailabilityMinutes: 107,
    typicalMaxLagMinutes: 150,
    completionProbeTemplate: 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{YYYYMMDD}/conus/hrrr.t{HH}z.wrfprsf48.grib2.idx',
  },
  rrfs: {
    slug: 'rrfs',
    provider: 'NOAA AWS Open Data (noaa-rrfs-ops-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 84,
    completeRunAvailabilityMinutes: 185,
    typicalMaxLagMinutes: 225,
    completionProbeTemplates: ['prslev', '2dfld'].map(product =>
      `{RRFS_BASE}/rrfs.{YYYYMMDD}/{HH}/rrfs.t{HH}z.${product}.3km.f084.conus.grib2.idx`),
  },
  rdps: {
    slug: 'rdps',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 84,
    completeRunAvailabilityMinutes: 220,
    typicalMaxLagMinutes: 255,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/model_rdps/10km/{HH}/084/',
  },
  'hrdps-continental': {
    slug: 'hrdps-continental',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 48,
    completeRunAvailabilityMinutes: 250,
    typicalMaxLagMinutes: 285,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/model_hrdps/continental/2.5km/{HH}/048/',
  },
  gfs: {
    slug: 'gfs',
    provider: 'NOAA AWS Open Data (noaa-gfs-bdp-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 384,
    completeRunAvailabilityMinutes: 315,
    typicalMaxLagMinutes: 360,
    completionProbeTemplate: 'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{YYYYMMDD}/{HH}/atmos/gfs.t{HH}z.pgrb2.0p25.f384.idx',
  },
  gdps: {
    slug: 'gdps',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 12],
    horizonHours: 240,
    completeRunAvailabilityMinutes: 345,
    typicalMaxLagMinutes: 380,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/model_gem_global/15km/grib2/lat_lon/{HH}/240/',
  },
  geps: {
    slug: 'geps',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 12],
    horizonHours: 384,
    completeRunAvailabilityMinutes: 375,
    typicalMaxLagMinutes: 420,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/ensemble/geps/grib2/raw/{HH}/384/',
  },
};

export const FEED_AVAILABILITY_SPECS: Readonly<Record<string, FeedAvailabilitySpec>> = Object.freeze(Object.fromEntries(Object.entries(templates).map(([id, spec]) => { const model = modelDescriptor(id); return [id, { ...spec, cyclesUtc: model.cyclesUtc, horizonHours: model.horizonHours, completeRunAvailabilityMinutes: model.expectedLagMinutes }]; })));
export function selectTargetCycles(modelSlug: string, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): CycleSelection {
  const spec = FEED_AVAILABILITY_SPECS[modelSlug];
  if (!spec) throw new Error(`Unknown model feed: ${modelSlug}`);
  if (!Number.isFinite(nowMs)) throw new Error('Readiness clock must be a valid timestamp');

  const candidates: CycleCandidate[] = [];
  const baseDayMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  for (const dayOffset of [-1, 0]) {
    for (const cycleHour of spec.cyclesUtc) {
      const refMs = baseDayMs + dayOffset * 86_400_000 + cycleHour * 3_600_000;
      const elapsedMinutes = (nowMs - refMs) / 60_000;
      if (elapsedMinutes >= spec.completeRunAvailabilityMinutes) {
        const dt = new Date(refMs);
        const yyyymmdd = dt.toISOString().slice(0, 10).replace(/-/g, '');
        const hh = String(cycleHour).padStart(2, '0');
        const probeUrls = (spec.completionProbeTemplates ?? (spec.completionProbeTemplate ? [spec.completionProbeTemplate] : [])).map(template => template
          .replaceAll('{RRFS_BASE}', rrfsBase(env))
          .replaceAll('{YYYYMMDD}', yyyymmdd)
          .replaceAll('{HH}', hh));
        candidates.push({
          referenceTime: dt.toISOString().replace('.000Z', 'Z'),
          cycleHourUtc: cycleHour,
          elapsedMinutes: Math.round(elapsedMinutes),
          expectedAvailableAtMinutes: spec.completeRunAvailabilityMinutes,
          probeUrl: probeUrls[0],
          probeUrls,
        });
      }
    }
  }
  candidates.sort((a, b) => Date.parse(b.referenceTime) - Date.parse(a.referenceTime));
  return {
    model: modelSlug,
    evaluatedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    completeRunAvailabilityMinutes: spec.completeRunAvailabilityMinutes,
    primaryCandidate: candidates[0] ?? null,
    fallbackCandidate: candidates[1] ?? null,
  };
}

export async function probeCycleReadiness(modelSlug: string, {
  nowMs,
  now = nowMs === undefined ? Date.now : () => nowMs,
  maxAttempts = 3,
  retryDelayMs = 5_000,
  fetchImpl = globalThis.fetch,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  env = process.env,
}: ReadinessOptions = {}): Promise<Readiness> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('retryDelayMs must be nonnegative');
  const isReady = async (candidate: CycleCandidate | null): Promise<boolean> => {
    if (!candidate) return false;
    const probes = await Promise.allSettled(candidate.probeUrls.map(url =>
        fetchImpl(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(15_000),
        })));
    return probes.every(result => result.status === 'fulfilled' && result.value.ok);
  };
  const readyResult = (candidate: CycleCandidate, attempts: number, fallback: boolean): Readiness => ({
    ready: true, model: modelSlug, selectedCycle: candidate, attempts, fallback,
  });
  let selection: CycleSelection | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-evaluate after waiting: a newly eligible cycle or UTC day boundary must
    // never leave the heavy builder pinned to an obsolete readiness decision.
    selection = selectTargetCycles(modelSlug, now(), env);
    if (selection.primaryCandidate && await isReady(selection.primaryCandidate)) return readyResult(selection.primaryCandidate, attempt, false);
    if (attempt < maxAttempts && retryDelayMs > 0) await sleep(retryDelayMs);
  }
  if (selection?.fallbackCandidate && await isReady(selection.fallbackCandidate)) {
    return readyResult(selection.fallbackCandidate, maxAttempts, true);
  }
  return {
    ready: false, model: modelSlug, selectedCycle: null, attempts: maxAttempts,
  };
}
