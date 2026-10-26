// Strict quantitative identity gate. Broad forecast disagreement remains a separate cohort.
// Call after normalization to SI and UTC; unknown provenance is never equal provenance.
const instant = (value) =>
  typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const sameTime = (a, b) => instant(a) && instant(b) && Date.parse(a) === Date.parse(b);

export function intervalIssue(a, b) {
  if (!a && !b) return null;
  if (!a || !b || a.kind !== b.kind) return 'incompatible-time-support';
  if (a.kind === 'instant') return sameTime(a.validAt, b.validAt) ? null : 'different-valid-time';
  if (!['mean', 'accumulation', 'maximum'].includes(a.kind)) return 'unknown-time-support';
  return sameTime(a.start, b.start) && sameTime(a.end, b.end) && Date.parse(a.start) < Date.parse(a.end)
    ? null
    : 'incompatible-accumulation-interval';
}

/** Descriptors require quantity, unit, datum and UTC time. Strict runs additionally require verified model initialization. */
export function comparisonIssue(a, b, { sameRun = false, sameGrid = false } = {}) {
  if (!a?.quantity || !b?.quantity) return 'unknown-field-definition';
  if (a.quantity !== b.quantity) return 'different-field-definition';
  if (!a.unit || !b.unit) return 'unknown-unit';
  if (a.unit !== b.unit) return 'different-normalized-unit';
  if (!a.heightReference || !b.heightReference) return 'unknown-height-reference';
  if (a.heightReference !== b.heightReference) return 'different-height-reference';
  if (!sameTime(a.validAt, b.validAt)) return 'different-valid-time';
  if (a.heightReference === 'AGL' && (!Number.isFinite(a.terrainM) || !Number.isFinite(b.terrainM)))
    return 'unknown-terrain-reference';
  const interval = intervalIssue(a.interval, b.interval);
  if (interval) return interval;
  if (sameRun) {
    if (!a.model || !b.model) return 'unknown-model';
    if (a.model !== b.model) return 'different-model';
    if (!instant(a.referenceTime) || !instant(b.referenceTime)) return 'unknown-initialization';
    if (a.referenceTimeVerified !== true || b.referenceTimeVerified !== true) return 'unverified-initialization';
    if (!sameTime(a.referenceTime, b.referenceTime)) return 'different-initialization';
    if (Date.parse(a.validAt) < Date.parse(a.referenceTime) || Date.parse(b.validAt) < Date.parse(b.referenceTime))
      return 'negative-lead-time';
  }
  if (sameGrid) {
    if (!a.gridId || !b.gridId || a.cellId == null || b.cellId == null) return 'unknown-native-cell';
    if (a.gridId !== b.gridId || a.cellId !== b.cellId) return 'different-native-cell';
  }
  return null;
}
