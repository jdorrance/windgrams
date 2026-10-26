// Evidence-based cases and recommendations; no transport or forecast calculations.
import { COMPARISON_FIELDS } from './profiles.mjs';
const finite = Number.isFinite;
const unique = (values) => [...new Set(values)];
const fieldById = new Map(COMPARISON_FIELDS.map((field) => [field.id, field]));

export function groupCounts(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return counts;
}
export function buildFixedCases(report) {
  return ['wa-blanchard', 'wa-tiger-mountain', 'wa-rampart-ridge'].map((site) => {
    const hours = report.hourPairs.filter((hour) => hour.site === site && hour.cohort === 'latest-live');
    return {
      site,
      siteName: hours[0]?.siteName ?? site,
      cohort: 'latest-live',
      models: unique(hours.map((hour) => hour.model))
        .sort()
        .map((model) => {
          const matched = hours.filter((hour) => hour.model === model),
            coverage = report.coverage.find((item) => item.site === site && item.model === model);
          return {
            model,
            matchedHours: matched.length,
            firstValidAt: matched[0]?.validAt ?? null,
            lastValidAt: matched.at(-1)?.validAt ?? null,
            referenceTime: matched[0]?.referenceTime ?? null,
            modelElevationM: matched[0]?.modelElevationM ?? null,
            xcElevationRangeM: matched.length
              ? [
                  Math.min(...matched.map((hour) => hour.xcModelElevationM).filter(finite)),
                  Math.max(...matched.map((hour) => hour.xcModelElevationM).filter(finite)),
                ]
              : null,
            terrainDifferenceRangeM: matched.length
              ? [
                  Math.min(...matched.map((hour) => hour.terrainDifferenceM).filter(finite)),
                  Math.max(...matched.map((hour) => hour.terrainDifferenceM).filter(finite)),
                ]
              : null,
            summary: report.bySite.filter(
              (row) => row.site === site && row.model === model && row.cohort === 'latest-live',
            ),
            evidence: unique(matched.map((hour) => hour.evidence.ours)),
            xcEvidence: coverage?.evidence ?? null,
            repeatCheckCount: coverage?.repeatChecks?.length ?? 0,
            repeatedCaptureChanged: coverage?.repeatedCaptureChanged ?? false,
            largest: Object.fromEntries(
              ['temperature', 'windVector', 'lift225'].map((field) => [
                field,
                report.rows
                  .filter(
                    (row) =>
                      row.site === site && row.model === model && row.cohort === 'latest-live' && row.field === field,
                  )
                  .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))[0] ?? null,
              ]),
            ),
          };
        }),
      limitation:
        'Different model horizons and sampling counts prevent interpreting this table as a skill ranking. Lift differences are method-sensitive.',
    };
  });
}
export function buildCases(report) {
  const context = new Map(report.hourPairs.map((hour) => [hour.id, hour]));
  const cases = [];
  for (const cohort of ['latest-live', 'retained-issued-archive'])
    for (const field of ['temperature', 'windVector']) {
      const row = report.rows
        .filter((item) => item.field === field && item.cohort === cohort)
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))[0];
      if (!row) continue;
      const hour = context.get(row.hourPairId),
        definition = fieldById.get(field);
      const explain =
        field === 'temperature'
          ? `At ${row.heightM.toFixed(1)} m MSL, Windgrams is ${row.ours.toFixed(2)} °C and XC is ${row.xc.toFixed(2)} °C; the signed difference is ${row.difference.toFixed(2)} °C.`
          : `At ${row.heightM.toFixed(1)} m MSL, the wind vectors differ by ${row.difference.toFixed(2)} m/s. Speeds are ${row.ours.toFixed(2)} versus ${row.xc.toFixed(2)} m/s, so the scalar speed difference alone is ${(row.ours - row.xc).toFixed(2)} m/s.`;
      cases.push({
        id: `largest-${cohort}-${field}`,
        title: `${cohort === 'latest-live' ? 'Latest frozen issue' : 'Retained archive'}: largest ${definition.label.toLowerCase()} difference`,
        field,
        row,
        context: hour,
        interpretation: `${hour.siteName}, ${hour.model}, ${hour.validAt}. ${explain} XC brackets are ${row.xcBracketM.join('–')} m MSL; both exceed the higher ground (${Math.max(hour.modelElevationM, hour.xcModelElevationM).toFixed(1)} m). Windgrams was initialized ${hour.referenceTime} with a ${hour.leadHours}-hour lead; XC lead remains unverified.`,
        conclusion:
          'This is a measured disagreement, with source evidence retained. Different initialization, native cell, vertical representation or terrain processing remain possible; this comparison alone cannot select a cause.',
        matchedColumn: report.rows.filter((other) => other.hourPairId === row.hourPairId),
      });
    }
  const terrain = report.hourPairs
    .filter((hour) => finite(hour.terrainDifferenceM))
    .sort((a, b) => Math.abs(b.terrainDifferenceM) - Math.abs(a.terrainDifferenceM))[0];
  if (terrain)
    cases.push({
      id: 'largest-terrain',
      title: 'Largest displayed-ground difference',
      field: 'terrain',
      context: terrain,
      interpretation: `${terrain.siteName}, ${terrain.model}: Windgrams ground ${terrain.modelElevationM.toFixed(1)} m MSL versus XC displayed ground ${terrain.xcModelElevationM.toFixed(1)} m MSL, a ${terrain.terrainDifferenceM.toFixed(1)} m signed difference. Atmospheric scoring excludes levels and interpolation brackets at or below ${Math.max(terrain.modelElevationM, terrain.xcModelElevationM).toFixed(1)} m.`,
      conclusion:
        'This is a ground-reference disagreement, not proof of an elevation error. XC native terrain and adjustment provenance are unresolved; preserve both MSL columns.',
    });
  return cases;
}
export function buildFindings(report) {
  const atmosphere = report.summary.filter((row) => row.category === 'atmosphere'),
    largestTerrain = report.hourPairs
      .filter((row) => finite(row.terrainDifferenceM))
      .sort((a, b) => Math.abs(b.terrainDifferenceM) - Math.abs(a.terrainDifferenceM))[0];
  const changing = report.runtimeAudit.models.filter((model) => model.changedRunHours || model.changedStateHours),
    repeated = report.repeatAudit.valueChangedProducts;
  const affected = unique(report.hourPairs.map((hour) => hour.model));
  return [
    {
      id: 'XC01',
      priority: 'P1',
      category: 'capture provenance',
      classification:
        changing.length || repeated.length
          ? 'observed provider refresh; unresolved per-hour provenance'
          : 'unresolved per-hour provenance',
      confidence: 'high',
      confidenceBasis:
        'Frozen before/after runtime objects and repeated response values are directly compared. Their relationship to individual profile initializations remains unproven.',
      title:
        changing.length || repeated.length
          ? `The capture crossed a provider update: ${repeated.length} repeated profiles changed values.`
          : 'Equal-valid-time comparison is possible; equal-run comparison remains unproven.',
      affectedProducts: [
        ...changing.map((model) => ({
          product: 'runtime routing',
          model: model.model,
          changedRunHours: model.changedRunHours,
        })),
        ...repeated.map((item) => ({ product: 'PointCast response', model: item.model, site: item.site })),
      ],
      evidence: {
        runtimeAudit: report.runtimeAudit,
        repeatAudit: report.repeatAudit,
        routingStates: groupCounts(
          report.hourPairs.map((row) => row.xcRouting),
          'status',
        ),
      },
      validationNeeded: [
        'Attach authoritative initialization and generation identifiers to every profile hour.',
        'Repeat atmospheric comparisons against one immutable common source cycle; keep primary and repeated captures distinct.',
      ],
      nextStep:
        'The scored inputs remain the primary frozen responses. Resolve each hour’s source run before attributing discrepancies to forecast processing.',
    },
    {
      id: 'XC02',
      priority: 'P1',
      category: 'terrain',
      classification: 'measured ground-reference mismatch; mechanism unresolved',
      confidence: 'high',
      confidenceBasis:
        'The retained profile values establish the height difference; XC native terrain and terrain adjustments are not identified.',
      title: 'Displayed terrain can differ by much more than a thermal-height discrepancy.',
      affectedProducts: affected.map((model) => ({ product: 'point profile and derived MSL/AGL heights', model })),
      evidence: largestTerrain ?? null,
      validationNeeded: [
        'Obtain native model cell coordinates, terrain elevation and any XC elevation adjustment.',
        'Inspect common MSL levels above both grounds and preserve each provider’s ground reference.',
      ],
      nextStep: largestTerrain
        ? `At ${largestTerrain.siteName}, ${largestTerrain.model} ground differs by ${Math.abs(largestTerrain.terrainDifferenceM).toFixed(1)} m. Resolve the source of that offset before interpreting launch-relative lift differences.`
        : 'Resolve native terrain and elevation adjustment before interpreting launch-relative lift differences.',
    },
    {
      id: 'XC03',
      priority: 'P1',
      category: 'scientific definitions',
      classification: 'confirmed definition mismatch; no supported implementation defect',
      confidence: 'high',
      confidenceBasis:
        'Provider documentation and the captured renderer establish different labels and thresholds; the server algorithms are not supplied.',
      title: 'Lift, condensation height and updraft strength do not share an exact physical contract.',
      affectedProducts: ['lift225', 'lift1', 'cloudBase', 'thermalTop'].map((field) => ({
        product: 'method-sensitive diagnostic',
        field,
      })),
      evidence: {
        methodSensitiveRows: report.sampleCounts.methodSensitiveRows,
        definitions: COMPARISON_FIELDS.filter((field) => field.category === 'method-sensitive'),
      },
      validationNeeded: [
        'Match the parcel starting state, entrainment, sink threshold, cloud cap and ground datum before comparing algorithms.',
        'Keep parcel vertical velocity separate from W*, CCL separate from LCL, and parcel tops separate from native model PBL depth.',
      ],
      nextStep:
        'Treat the height contrasts as diagnostic leads, not calibration targets. No production calculation change is justified by these differences alone.',
    },
    {
      id: 'XC04',
      priority: 'P2',
      category: 'atmospheric comparison',
      classification: 'measured forecast disagreement; cause unresolved',
      confidence: 'high',
      confidenceBasis:
        'Exact valid UTC, published source values and bounded interpolation establish the measured differences; forecast skill is not evaluated.',
      title: 'Temperature and wind discrepancies are measurable at shared above-ground heights.',
      affectedProducts: affected.map((model) => ({ product: 'upper-air temperature and wind', model })),
      evidence: { summary: atmosphere, cases: report.cases.filter((item) => item.field !== 'terrain') },
      validationNeeded: [
        'Reproduce largest discrepancies at identical initialization and native cell before isolating interpolation effects.',
        'After matching the source cycle and cell, check temperature conversion and quantization, and grid-relative versus earth-relative wind rotation. These are hypotheses, not established defects.',
        'Use independent coincident soundings or aircraft observations to determine which forecast better represents the atmosphere.',
      ],
      nextStep:
        'Start with the latest-issue temperature and wind cases. Their long GFS lead times and unknown XC initialization remain material comparison limits.',
    },
    {
      id: 'XC05',
      priority: 'P2',
      category: 'history and coverage',
      classification: 'limited retrospective coverage; no forecast-skill evidence',
      confidence: 'high',
      confidenceBasis:
        'Available captures and issued archives determine the measured coverage. No first-issued XC archive or new observation validation was collected.',
      title: 'Retrospective XC hours and future valid dates do not constitute an observation record.',
      affectedProducts: [
        {
          product: 'all comparisons',
          requestedLocations: report.sampleCounts.sitesRequested,
          pairedLocations: report.sampleCounts.sitesPaired,
        },
      ],
      evidence: { archiveCoverage: report.archiveCoverage, sampleCounts: report.sampleCounts },
      validationNeeded: [
        'Collect simultaneous first-issued XC and Windgrams snapshots through multiple weather regimes.',
        'Separate historical valid times from future forecast dates, and report independent observation-day coverage explicitly.',
      ],
      nextStep: `The ${report.sampleCounts.localSiteDays} location-day count describes available valid dates, including future forecasts; it is not an independent sample size. Expand immutable history before making skill claims.`,
    },
  ];
}
