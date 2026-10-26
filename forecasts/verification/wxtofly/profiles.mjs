// Exact-time normalized profile comparisons; no acquisition, file IO or report rendering.
import { FIELDS, ourValue, wxValue, scalar, windVector, circularDifference } from './fields.mjs';
import { number } from './html.mjs';
import { events } from './statistics.mjs';
import { comparisonIssue } from '../comparability.mjs';
const hourKey = Date.parse;

const leadBucket = (h) =>
  h === null ? 'unknown' : h <= 6 ? '0–6 h' : h <= 12 ? '6–12 h' : h <= 24 ? '12–24 h' : h <= 48 ? '24–48 h' : '>48 h';
const liftPresence = (h, terrain) => {
  const v = scalar(h.soaring?.hcritWxtoflyM);
  return v !== null ? v > terrain : scalar(h.soaring?.thermalVelocityV2Mps) === null ? null : false;
};
export function compareProfile(profile, wx, match, cohort, evidence) {
  const rows = [],
    excluded = [],
    eventRows = [],
    byTime = new Map(profile.hours.map((h) => [hourKey(h.validAt), h]));
  const terrain = profile.site.modelElevationM;
  for (const w of wx.hours) {
    const h = byTime.get(hourKey(w.validAt));
    if (!h) {
      excluded.push({ reason: 'no-exact-valid-time', validAt: w.validAt });
      continue;
    }
    const lead = (hourKey(h.validAt) - hourKey(profile.run.referenceTime)) / 3600000;
    if (!Number.isFinite(lead) || lead < 0) {
      excluded.push({ reason: 'invalid-or-negative-lead', validAt: w.validAt });
      continue;
    }
    const base = {
      cohort,
      site: match.site.slug,
      siteName: match.site.name,
      region: match.site.slug.slice(0, 2),
      model: profile.model,
      wxModel: `RASP/${wx.domain ?? 'unknown'}`,
      validAt: h.validAt,
      localDate: wx.date,
      referenceTime: profile.run.referenceTime,
      wxReferenceTime: wx.referenceTime,
      leadHours: lead,
      leadBucket: leadBucket(lead),
      wxLeadHours: w.leadHours,
      modelElevationM: terrain,
      wxModelElevationM: wx.modelElevationM,
      terrainDifferenceM: Number.isFinite(wx.modelElevationM) ? terrain - wx.modelElevationM : null,
      distanceKm: match.distanceKm,
      statistic: profile.model === 'geps' ? 'published ensemble p50 versus deterministic' : 'deterministic',
      method: profile.soaringMeta?.contractVersion ?? h.soaring?.contractVersion ?? 'legacy',
      coordinates: {
        ours: { latitude: profile.site.latitude, longitude: profile.site.longitude },
        wx: { latitude: wx.latitude, longitude: wx.longitude },
      },
      comparability: wx.referenceTime
        ? 'same-valid-time; model and lead differences retained'
        : 'same-valid-time; WxToFly initialization unknown',
      evidence,
    };
    const runDescriptor = { quantity: 'source-run', unit: '1', heightReference: 'not-applicable', validAt: h.validAt };
    base.strictSameRunIssue = comparisonIssue(
      { ...runDescriptor, model: profile.model, referenceTime: profile.run.referenceTime, referenceTimeVerified: true },
      { ...runDescriptor, model: base.wxModel, referenceTime: wx.referenceTime, referenceTimeVerified: false },
      { sameRun: true },
    );
    for (const field of FIELDS) {
      const a = ourValue(h, field, terrain),
        b = wxValue(w, field);
      if (['shear', 'blTopWind', 'sensibleHeat'].includes(field.id)) {
        excluded.push({ ...base, field: field.id, reason: field.qualification });
        continue;
      }
      if (a === null || b === null) {
        excluded.push({ ...base, field: field.id, reason: a === null ? 'our-value-missing' : 'wx-value-missing' });
        continue;
      }
      if (field.id === 'lift225' && number(w.raw.MaxSoar_AGL ?? '') === 0) {
        excluded.push({
          ...base,
          field: field.id,
          reason: 'WxToFly encodes no-lift as model-ground MSL; compare presence separately',
        });
        continue;
      }
      let difference = a - b;
      if (field.unit === '°') {
        const speed =
          field.id === 'wind10mDirection'
            ? FIELDS.find((f) => f.id === 'wind10m')
            : FIELDS.find((f) => f.id === 'blWind');
        if (!(ourValue(h, speed, terrain) > 1 && wxValue(w, speed) > 1)) {
          excluded.push({ ...base, field: field.id, reason: 'direction excluded at wind speeds ≤1 m/s' });
          continue;
        }
        difference = circularDifference(a, b);
      }
      const descriptor = {
        quantity: field.id,
        unit: field.unit,
        heightReference: field.heightReference,
        validAt: h.validAt,
      };
      const strictSameRunIssue = comparisonIssue(
        { ...descriptor, model: profile.model, referenceTime: profile.run.referenceTime, referenceTimeVerified: true },
        { ...descriptor, model: base.wxModel, referenceTime: wx.referenceTime, referenceTimeVerified: false },
        { sameRun: true },
      );
      rows.push({
        ...base,
        field: field.id,
        label: field.label,
        unit: field.unit,
        ours: a,
        wx: b,
        difference,
        strictSameRunIssue,
        qualification: field.qualification,
        wxRaw: w.raw[field.wx],
        wxOriginalUnit: field.originalWxUnit,
        heightReference: field.heightReference,
        sourcePrecision: /\./.test(w.raw[field.wx]) ? 'decimal text' : 'integer text',
      });
    }
    for (const [id, speedId, dirId] of [
      ['wind10mVector', 'wind10m', 'wind10mDirection'],
      ['blWindVector', 'blWind', 'blDirection'],
    ]) {
      const speed = FIELDS.find((f) => f.id === speedId),
        dir = FIELDS.find((f) => f.id === dirId),
        a = windVector(ourValue(h, speed, terrain), ourValue(h, dir, terrain)),
        b = windVector(wxValue(w, speed), wxValue(w, dir));
      if (profile.model === 'geps') {
        excluded.push({
          ...base,
          field: id,
          reason: 'Ensemble median speed and aggregate direction do not define a member or mean vector',
        });
        continue;
      }
      if (a && b)
        rows.push({
          ...base,
          field: id,
          label: `${speed.label}: vector difference`,
          unit: 'm/s',
          ours: Math.hypot(a.u, a.v),
          wx: Math.hypot(b.u, b.v),
          difference: Math.hypot(a.u - b.u, a.v - b.v),
          vectorComponents: { ours: a, wx: b },
          qualification: 'Nonnegative vector-distance magnitude; not signed speed bias.',
        });
    }
    const wxAgl = number(w.raw.MaxSoar_AGL ?? '');
    eventRows.push({
      ...base,
      event: 'usable-lift-225',
      ours: liftPresence(h, terrain),
      wx: wxAgl === null ? null : wxAgl > 0,
      interpretation:
        'Null published ceiling means no resolved usable height, not necessarily observed absence of lift.',
    });
  }
  const matchedHours = wx.hours.filter((w) => byTime.has(hourKey(w.validAt)));
  const liftO = events(matchedHours, (w) => liftPresence(byTime.get(hourKey(w.validAt)), terrain));
  const liftW = events(matchedHours, (w) => {
    const v = number(w.raw.MaxSoar_AGL ?? '');
    return v === null ? null : v > 0;
  });
  return {
    rows,
    excluded,
    eventRows,
    timing: {
      cohort,
      site: match.site.slug,
      model: profile.model,
      event: 'usable-lift-225',
      ours: liftO,
      wx: liftW,
      firstDifferenceMinutes:
        liftO.firstValidAt && liftW.firstValidAt
          ? (Date.parse(liftO.firstValidAt) - Date.parse(liftW.firstValidAt)) / 60000
          : null,
    },
  };
}
