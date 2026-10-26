// Trace fixed cases and every field/region maximum back to the frozen source hour.
import { scalar, sampleProfile } from './fields.mjs';
import { referenceLcl, referenceWstar } from './science.mjs';

export function buildCases(report, profiles, snapshot) {
  const selected = new Map();
  for (const row of report.rows) {
    const key = `${row.field}/${row.region}`;
    const old = selected.get(key);
    if (!old || Math.abs(row.difference) > Math.abs(old.difference)) selected.set(key, row);
  }
  for (const site of ['wa-blanchard', 'wa-tiger-mountain', 'wa-rampart-ridge'])
    for (const field of ['wind10mVector', 'temperature2m', 'thermalVelocity', 'lift225', 'surfaceLcl']) {
      const row = report.rows
        .filter((r) => r.site === site && r.field === field)
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))[0];
      if (row) selected.set(`${site}/${field}`, row);
    }
  report.cases = [...new Set(selected.values())].map((row) => {
    const item = profiles.find((p) => p.entry.sha256 === row.evidence.ours),
      p = item.profile,
      h = p.hours.find((h) => Date.parse(h.validAt) === Date.parse(row.validAt));
    const heightField = ['thermalTop', 'lift225', 'surfaceLcl', 'mixedLcl'].includes(row.field);
    const commonLowerM = Math.max(p.site.modelElevationM, row.wxModelElevationM ?? -Infinity);
    const higherGroundSample = sampleProfile(h.levels ?? [], commonLowerM, p.site.modelElevationM);
    return {
      row,
      source: {
        surface: h.surface,
        levels: h.levels,
        soaring: h.soaring,
        profileSite: p.site,
        run: p.run,
        method: p.soaringMeta ?? null,
      },
      referenceCalculations: {
        surfaceLclM: referenceLcl(scalar(h.surface.temperatureC), scalar(h.surface.dewPointC), p.site.modelElevationM),
        wstarMps: referenceWstar(h, p.site.modelElevationM),
        role: 'Separate equation check; never substitutes recomputed values into issued scores.',
      },
      heightDecomposition:
        heightField && row.wxModelElevationM !== null
          ? {
              oursAglM: row.ours - row.modelElevationM,
              wxAglM: row.wx - row.wxModelElevationM,
              aglDifferenceM: row.difference - row.terrainDifferenceM,
              terrainDifferenceM: row.terrainDifferenceM,
            }
          : null,
      aboveGroundSampling: {
        lowerBoundM: commonLowerM,
        oursAtHigherGround: higherGroundSample,
        status:
          'No current counterpart numeric WxToFly column. Bracketing only; this sample is not an upper-air difference score.',
      },
      explanation: heightField
        ? 'The MSL difference decomposes exactly into terrain difference plus diagnostic AGL difference. This is accounting, not proof that terrain caused the forecast difference.'
        : row.field.includes('Wind') || row.field.startsWith('wind') || row.field === 'blWind'
          ? 'Vector disagreement can arise from different flow, grid terrain and layer definitions. Native columns and matched observations at this hour are needed to allocate cause.'
          : row.field === 'thermalVelocity'
            ? 'W* depends on source virtual heat flux and resolved depth. Our source fluxes and depth are preserved; WxToFly does not publish an equivalent complete column/flux interval here.'
            : 'The exact valid time is matched. Source model, initialization, terrain, method and printed precision remain separate; a difference alone is not a defect.',
      unresolvedQuestion: `Would the difference persist for ${row.siteName} at ${row.validAt} with a verified WxToFly initialization, native column and matched terrain/layer definitions?`,
      confidence: 'high for measured difference; unresolved attribution',
    };
  });
  report.fixedCases = ['wa-blanchard', 'wa-tiger-mountain', 'wa-rampart-ridge'].map((site) => {
    const match = snapshot.matches.find((m) => m.site.slug === site),
      w = snapshot.wxProducts.find((w) => w.id === match?.wxId);
    return {
      site,
      match,
      wxDate: w?.date ?? null,
      images: w?.windgram?.images ?? [],
      latestProfiles: profiles
        .filter((p) => p.cohort === 'latest-live' && p.profile.site.id === site)
        .map((p) => ({
          model: p.profile.model,
          referenceTime: p.profile.run.referenceTime,
          terrainM: p.profile.site.modelElevationM,
          launchElevationM: p.profile.soaringMeta?.launchElevationM ?? null,
          levels: p.profile.hours[0]?.levels?.length,
          evidence: p.entry.sha256,
        })),
      summaries: report.bySite.filter((r) => r.site === site),
      cases: report.cases.filter((c) => c.row.site === site),
    };
  });
}
