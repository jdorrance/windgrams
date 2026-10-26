// Product and field accounting is separate from scoring: absence cannot become a zero.
import { jsonOf, textOf } from '../evidence-store.mjs';
import { parseSounding } from './html.mjs';
import { distanceKm } from './matching.mjs';
import { DRJACK_WXTOFLY_COMPARISON } from '../provider-inventory.mjs';
const ok = (e) => e?.status === 200;

export async function inventoryCoverage(root, snapshot, report) {
  const matched = new Map(snapshot.matches.filter((m) => m.status === 'matched').map((m) => [m.wxId, m]));
  report.providerInventory = snapshot.wxProducts.map((w) => {
    const m = matched.get(w.id),
      catalogue = snapshot.wxSites?.find((s) => s.id === w.id);
    return {
      product: 'wx-blipspot',
      wxId: w.id,
      site: m?.site.slug ?? null,
      status:
        w.status !== 'parsed'
          ? 'unavailable'
          : m
            ? 'accounted-for-in-pair-coverage'
            : 'outside-verified-shared-coverage',
      date: w.date,
      referenceTime: w.referenceTime,
      validTimes: w.hours.map((h) => h.validAt),
      stable: w.stable,
      domain: w.domain,
      latitude: w.latitude,
      longitude: w.longitude,
      terrainM: w.modelElevationM,
      terrainProvenance: w.terrainProvenance,
      catalogueSeparationKm: catalogue ? distanceKm(w, catalogue) : null,
      evidence: w.entry.sha256,
    };
  });
  report.coverage.push(...report.providerInventory);
  for (const m of snapshot.catalogue.models.filter((m) => !snapshot.models.some((p) => p.slug === m.slug)))
    report.coverage.push({
      product: 'point-model',
      model: m.slug,
      status: 'unavailable',
      reason: 'Listed in served catalogue but absent from served run inventory; no published run assumed.',
    });
  for (const product of ['nws', 'ecmwf'])
    for (const m of matched.values()) {
      const e = snapshot.auxiliary.find(
        (e) => e.kind === `${product}-profile` && e.url.endsWith(`/sites/${m.site.slug}.json`),
      );
      if (!ok(e)) {
        report.coverage.push({ product, site: m.site.slug, status: 'unavailable', evidence: e });
        continue;
      }
      const p = await jsonOf(root, e),
        w = snapshot.wxProducts.find((w) => w.id === m.wxId),
        wxTimes = new Set(w.hours.map((h) => Date.parse(h.validAt)));
      const overlap = (p.hours ?? []).filter((h) => wxTimes.has(Date.parse(h.validAt))).length;
      report.coverage.push({
        product,
        site: m.site.slug,
        status: overlap ? 'ambiguous' : 'no-exact-time-overlap',
        overlapHours: overlap,
        reason: overlap
          ? 'Sparse adapter semantics require explicit field mapping before scoring'
          : 'All available adapter hours checked; WxToFly numeric valid times do not intersect.',
        referenceTime: product === 'ecmwf' ? (p.models?.surface?.run ?? null) : null,
        issuedAt: product === 'nws' ? p.updateTime : null,
        firstValidAt: p.hours?.[0]?.validAt,
        lastValidAt: p.hours?.at(-1)?.validAt,
        modelTerrainM: p.grid?.elevationM ?? null,
        evidence: e.sha256,
      });
    }
  report.soundings = [];
  for (const e of snapshot.auxiliary.filter(
    (e) => e.kind === 'wx-sounding-or-legend' && /lap(?:se)?(?:rap|nam|gfs|op40)\.html$/.test(e.url) && ok(e),
  )) {
    const parsed = parseSounding(await textOf(root, e));
    report.soundings.push({ ...parsed, url: e.url, evidence: e.sha256 });
    report.coverage.push({
      product: 'wx-sounding',
      status: 'unavailable-for-current-time',
      reason: parsed.heading,
      evidence: e.sha256,
      nativeLevels: parsed.levels.length,
      comparison: 'No same-time initialized counterpart established; no extrapolated or image-derived scores.',
    });
  }
  const maps = [...new Map((snapshot.wxMapInventory ?? []).map((m) => [`${m.region}/${m.grid}`, m])).values()];
  report.wxMapInventory = maps;
  for (const m of maps)
    for (const parameter of m.parameters)
      for (const time of m.times) {
        const asset = m.assets?.find((a) => a.parameter === parameter && a.time === time);
        report.coverage.push({
          product: parameter.startsWith('sounding') ? 'wx-map-sounding' : 'wx-map',
          region: m.region,
          grid: m.grid,
          parameter,
          time,
          status: asset ? (ok(asset.entry) ? 'visually-comparable' : 'unavailable') : 'outside-shared-coverage',
          resolution: m.resolution ?? null,
          reason: asset
            ? 'No native numeric map arrays advertised. Image timestamps and run identities require visual validation.'
            : 'No verified shared launch uses this advertised map grid.',
          evidence: asset?.entry ?? m.source,
        });
      }
  const definitions = {
    'surface wind': ['numeric', '10 m scalar and vector winds; direction only above 1 m/s.'],
    'upper-air wind': [
      'visual / stale numeric sounding',
      'Current windgrams are images; accessible literal sounding arrays are dated outside the review window.',
    ],
    temperature: [
      'numeric surface; visual aloft',
      '2 m °F to °C; image contours are bounded qualitative evidence only.',
    ],
    moisture: ['numeric surface; visual aloft', '2 m dew point °F to °C; no current shared numeric upper-air column.'],
    'lapse rate': [
      'visual',
      'Wx °C/1000 ft; ours displayed °C/km or °F/1000 ft; never compare legend numbers without conversion.',
    ],
    inversion: [
      'visual',
      'Gray/inverted lapse shading; no current shared numeric inversion layers or exact event times.',
    ],
    'freezing level': [
      'visual',
      'Temperature contour; no current shared numeric crossing heights. Multiple crossings cannot be inferred from a single marker.',
    ],
    precipitation: [
      'unavailable for quantitative scoring',
      'One-hour Wx accumulation versus model rate/window-average. Units/window endpoints must be explicit; no assumed hourly integration.',
    ],
    'cloud indicators': [
      'visual / incompatible scalar',
      'Boundary-layer cloud fraction is distinct from total/low cloud. RH >94% is distinct from model condensate and potential LCL.',
    ],
    'heat flux': ['excluded', 'Wx table averaging interval unspecified; no interval-compatible score.'],
    CAPE: ['qualified numeric', 'Parcel choice unspecified; model differences retained.'],
    'native PBL depth': ['incompatible', 'Wx thermal-index BL top is not native model PBL height.'],
    'thermal depth': [
      'qualified numeric',
      'Each model terrain subtracted independently; thermal-index versus resolved parcel-depth methods.',
    ],
    'W*': [
      'qualified numeric',
      'ft/min to m/s. Convective velocity scale is neither instantaneous updraft nor net glider climb.',
    ],
    'lift ceilings': [
      'qualified numeric',
      '225 ft/min = 1.143 m/s. Our 1 m/s marker is separately audited; ground-coded Wx zero lift handled as presence.',
    ],
    LCL: [
      'qualified numeric',
      'Surface and mixed-layer potential LCLs, meters MSL; ambient cloud layers remain separate.',
    ],
    'layer wind': [
      'qualified numeric',
      'Vector averaging through differently defined layers; terrain and grid differences retained.',
    ],
    shear: [
      'excluded',
      'Legacy numeric units and layer endpoints unresolved; ratio comparisons are separately qualified.',
    ],
    'vertical motion': [
      'visual / unresolved',
      'Wx cm/s convergence denotes vertical air motion; layer extremum/sign/support must match before scoring.',
    ],
    'horizontal convergence': [
      'incompatible',
      'Native grid horizontal divergence derivative (10^-5 s^-1), not Wx wblmaxmin vertical velocity.',
    ],
  };
  report.familyCoverage = report.requiredFamilies.map((family) => ({
    family,
    status: definitions[family][0],
    reason: definitions[family][1],
  }));
  report.inventoryReassessment = DRJACK_WXTOFLY_COMPARISON.map((p) => ({
    parameter: p.parameter,
    previousLabel: p.status,
    previousDrjackId: p.drjackId,
    verdict: p.parameter.startsWith('Horizontal')
      ? 'no equivalent provider quantity'
      : 'implementation audit does not establish provider equivalence',
    explanation: p.parameter.startsWith('Horizontal')
      ? 'wblmaxmin is vertical velocity; retain horizontal convergence as a separate quantity.'
      : 'Use the field-specific qualifications and exclusions in this review. Different source weather, depth, terrain and layer definitions remain identifiable.',
  }));
}
