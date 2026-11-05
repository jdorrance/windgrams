/** Project AV point data into existing regional view types without recalculating diagnostics. */
import type { AvProfile } from '@windgrams/data-client/av';
import type { ReplayHour } from '@windgrams/contracts/regional';
export function avProfilesToReplayHour(profiles: readonly AvProfile[], frameId: string): ReplayHour {
  const frames = profiles.map((profile) => profile.frames.find((frame) => frame.id === frameId));
  const first = frames.find((frame) => frame !== undefined);
  if (!first) throw new Error('AV route frame unavailable');
  const raw = (layer: string) => frames.map((frame) => frame?.layers[layer]?.value ?? null);
  const view = <Key extends keyof AvProfile['frames'][number]['derived']>(key: Key) =>
    frames.map((frame) => frame?.derived[key] ?? null);
  return {
    validAt: first.validTime,
    forecastHour: Math.round((Date.parse(first.validTime) - Date.parse(profiles[0].cycle)) / 3600000),
    thermalVelocityMps: raw('thermal-velocity'),
    thermalVelocityV2Mps: raw('thermal-velocity'),
    boundaryLayerTopM: raw('thermal-top-msl'),
    resolvedThermalTopM: raw('thermal-top-msl'),
    usableLiftTopM: view('usableLiftTopV2M'),
    usableLiftTopV2M: view('usableLiftTopV2M'),
    hcritWxtoflyM: view('hcritWxtoflyM'),
    cloudBaseM: raw('surface-lcl-msl'),
    surfaceLclM: raw('surface-lcl-msl'),
    pblHeightM: raw('pbl-height-agl'),
    mixedLayerLclM: view('mixedLayerLclM'),
    effectiveCloudLimitM: view('effectiveCloudLimitM'),
    status: frames.map((frame) => (frame?.profile.status === 'valid' ? 'valid' : 'missing')),
    levelCount: frames.map((frame) => frame?.profile.levels.length ?? 0),
    ceilingReached: frames.map(() => false),
  };
}
