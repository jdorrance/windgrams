// Differences describe forecast disagreement; no independence or forecast-skill claim.
export function summarize(rows) {
  const values = rows.map((r) => r.difference).filter(Number.isFinite),
    absolute = values.map(Math.abs).sort((a, b) => a - b);
  const quantile = (p) => {
    if (!absolute.length) return null;
    const index = (absolute.length - 1) * p,
      i = Math.floor(index);
    return absolute[i] + (absolute[Math.ceil(index)] - absolute[i]) * (index - i);
  };
  return {
    count: values.length,
    meanDifference: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    meanAbsoluteDifference: values.length ? absolute.reduce((a, b) => a + b, 0) / values.length : null,
    medianAbsoluteDifference: quantile(0.5),
    p95AbsoluteDifference: quantile(0.95),
    distinctSiteDays: new Set(rows.map((r) => `${r.site}:${r.localDate}`)).size,
  };
}
export function grouped(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(keys.map((k) => row[k]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ({ ...Object.fromEntries(keys.map((key, i) => [key, JSON.parse(k)[i]])), ...summarize(v) }));
}
export function events(hours, predicate) {
  const available = hours
    .filter((h) => predicate(h) !== null)
    .sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt));
  const positive = available.filter(predicate);
  return {
    available: available.length,
    present: positive.length,
    firstValidAt: positive[0]?.validAt ?? null,
    lastValidAt: positive.at(-1)?.validAt ?? null,
  };
}
