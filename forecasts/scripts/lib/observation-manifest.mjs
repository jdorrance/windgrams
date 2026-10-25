// Supplemental feed attempts. Payloads retain their own forecast/observation times.
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const inventory = (rows, key) => Array.isArray(rows) && rows.every(row => identity(row?.[key]))
  && new Set(rows.map(row => row[key])).size === rows.length;

/** RAOB alone permits a successful query with no usable flight (`absent: true`). */
export function parseObservationManifest(raw, product) {
  if (!['nws', 'ecmwf', 'raob'].includes(product) || raw?.schemaVersion !== 1
    || typeof raw.generatedAt !== 'string' || !Number.isFinite(Date.parse(raw.generatedAt))
    || !inventory(raw.sites, 'slug')) return null;
  if (raw.sites.some(site => typeof site.ok !== 'boolean'
    || !site.ok && (typeof site.error !== 'string' || !site.error)
    || site.retained !== undefined && typeof site.retained !== 'boolean'
    || site.absent !== undefined && (product !== 'raob' || !site.ok || typeof site.absent !== 'boolean')
    || product === 'raob' && site.ok && typeof site.absent !== 'boolean')) return null;
  if (product === 'nws' && !inventory(raw.offices, 'office')) return null;
  return raw;
}
