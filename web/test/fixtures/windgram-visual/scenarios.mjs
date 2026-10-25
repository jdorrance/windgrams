import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Published records are exact local-date subsets. Synthetic cases are labelled recipes. */
export function loadVisualFixture(entry) {
  if (entry.kind === 'published') {
    const compressed = readFileSync(new URL(entry.file, import.meta.url));
    assert.equal(sha256(compressed), entry.gzipSha256, entry.id + ' gzip provenance');
    const bytes = gunzipSync(compressed);
    assert.equal(sha256(bytes), entry.sha256, entry.id + ' record provenance');
    const profile = JSON.parse(bytes);
    assert.equal(profile.run.referenceTime, entry.source.referenceTime);
    assert.equal(profile.run.generatedAt, entry.source.generatedAt);
    assert.equal(profile.hours.length, entry.hourCount);
    return profile;
  }
  const bytes = readFileSync(repoRoot + entry.source.path);
  assert.equal(sha256(bytes), entry.source.sha256, entry.id + ' synthetic source provenance');
  const profile = JSON.parse(bytes);
  // A fictional UTC site puts the source's 10–19Z hours in daylight.
  profile.site = { ...profile.site, id: entry.id, name: entry.label, latitude: 45, longitude: 0, timeZone: 'Etc/UTC' };
  if (entry.recipe === 'synthetic-inversions') {
    for (const hour of profile.hours) {
      hour.surface.temperatureC = 18;
      hour.surface.dewPointC = -15;
      hour.derived.cloudBaseM = 15000;
      hour.levels.forEach((level, i) => {
        level.temperatureC = [12, 16, 7, 11, -4][i] ?? -4 - (i - 4) * 5;
        level.dewPointC = level.temperatureC - 25;
        level.cloudFractionPercent = 0;
      });
    }
  } else if (entry.recipe === 'synthetic-clouds') {
    for (const hour of profile.hours) {
      hour.derived.cloudBaseM = hour.levels[2].heightM;
      hour.levels.forEach((level, i) => {
        const cloudy = i >= 2 && i <= 4;
        level.dewPointC = level.temperatureC - (cloudy ? 0.2 : 25);
        level.cloudFractionPercent = cloudy ? 75 : 0;
      });
    }
  } else {
    assert.equal(entry.recipe, 'synthetic-strong-lift');
  }
  return profile;
}
