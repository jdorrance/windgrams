import type { AtmosphericLevel } from '@windgrams/contracts';
import { finite } from '@windgrams/meteorology/thermodynamics';
import type { VerticalResolution, VerticalSampling } from './types.js';

/** Describe the native geometry, independently for each measured quantity. */
export function verticalSampling(terrainM: number, levels: readonly AtmosphericLevel[]): NonNullable<VerticalResolution['sampling']> {
  const sample = (supports: (level: AtmosphericLevel) => boolean): VerticalSampling => {
    const heights = [...new Set(levels.filter(level => finite(level.heightM) && level.heightM > terrainM && supports(level))
      .map(level => level.heightM - terrainM))].sort((a, b) => a - b);
    const gaps = heights.slice(1).flatMap((height, i) => heights[i] < 1000 ? [height - heights[i]] : []);
    return { firstLevelAglM: heights[0] ?? null, levelsInLowest1000M: heights.filter(height => height <= 1000).length,
      maxGapInLowest1000M: gaps.length ? Math.max(...gaps) : null };
  };
  return {
    temperature: sample(level => finite(level.temperatureC)),
    moisture: sample(level => finite(level.dewPointC) || (finite(level.temperatureC) && finite(level.dewPointDepressionC))),
    wind: sample(level => finite(level.windSpeedMps) && level.windSpeedMps >= 0 && (level.windSpeedMps === 0 || finite(level.windDirectionDeg))),
  };
}
