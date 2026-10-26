// Offline regression experiment; never replaces first-issued forecast values.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveDiagnosticsV2, SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { sourceFromPublishedDeterministicHour } from '@windgrams/soaring/compatibility';
import { parseAtmosphericColumn } from '@windgrams/contracts';
import { jsonOf, sha256 } from './evidence-store.mjs';

/** Recompute only from frozen published inputs; this is not an independent skill test. */
export async function methodImpact(baselinePath) {
  const bytes = await readFile(baselinePath),
    baseline = JSON.parse(bytes),
    root = dirname(baselinePath);
  const report = {
    schemaVersion: 1,
    baselineSha256: sha256(bytes),
    methodVersion: SOARING_CONTRACT_VERSION,
    purpose: 'recomputed diagnostic experiment; issued values remain immutable',
    limitation: 'published rounded columns cannot prove raw-source parity or forecast accuracy',
    profiles: [],
    excluded: [],
    totals: { hours: 0, scalarComparisons: 0, changedScalars: 0 },
  };
  for (const model of baseline.models)
    for (const captured of model.profiles ?? []) {
      if (!model.stable || !captured.valid) {
        report.excluded.push({ model: model.slug, site: captured.site, reason: 'unstable-or-invalid-profile' });
        continue;
      }
      const profile = await jsonOf(root, captured.entry);
      const result = {
        model: model.slug,
        site: captured.site,
        sourceSha256: captured.entry.sha256,
        referenceTime: profile.run.referenceTime,
        fromMethods: captured.methodVersions,
        hours: 0,
        suppliedPressureHours: 0,
        fields: {},
        excludedHours: 0,
      };
      for (const hour of profile.hours ?? []) {
        const source = parseAtmosphericColumn(sourceFromPublishedDeterministicHour(hour));
        if (!source || !hour.soaring) {
          result.excludedHours++;
          continue;
        }
        const next = deriveDiagnosticsV2(profile.site.modelElevationM, source, hour);
        if (!next) {
          result.excludedHours++;
          continue;
        }
        result.hours++;
        report.totals.hours++;
        if (source.surfacePressureHpa > 0) result.suppliedPressureHours++;
        for (const [field, after] of Object.entries(next)) {
          if (!(field in hour.soaring) || (after !== null && typeof after !== 'number')) continue;
          const before = hour.soaring[field];
          if (before !== null && typeof before !== 'number') continue;
          const stat = (result.fields[field] ??= { compared: 0, changed: 0, absenceChanges: 0, maxAbsoluteDelta: 0 });
          stat.compared++;
          report.totals.scalarComparisons++;
          if (before !== after) {
            stat.changed++;
            report.totals.changedScalars++;
            if (before === null || after === null) stat.absenceChanges++;
            else stat.maxAbsoluteDelta = Math.max(stat.maxAbsoluteDelta, Math.abs(after - before));
          }
        }
      }
      report.profiles.push(result);
    }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baselinePath, output] = process.argv.slice(2);
  if (!baselinePath || !output) throw new Error('Usage: method-impact.mjs BASELINE_JSON NEW_OUTPUT_JSON');
  const report = await methodImpact(resolve(baselinePath));
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        output,
        methodVersion: report.methodVersion,
        ...report.totals,
        changedFields: [
          ...new Set(
            report.profiles.flatMap((profile) =>
              Object.entries(profile.fields)
                .filter(([, field]) => field.changed)
                .map(([field]) => field),
            ),
          ),
        ],
      },
      null,
      2,
    ),
  );
}
