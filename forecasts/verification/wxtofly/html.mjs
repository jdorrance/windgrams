// Read the published HTML tables without executing any provider JavaScript.
export function text(html) {
  const entities = { nbsp: ' ', deg: '°', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", minus: '-', rarr: '→' };
  return html
    .replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return entities[code] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
export function references(html, base) {
  const refs = [];
  for (const match of html.matchAll(/<(a|img|script|iframe|frame)\b([^>]*)>/gi)) {
    const attr = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2]);
    if (!attr) continue;
    try {
      const url = new URL(text(attr[1] ?? attr[2] ?? attr[3]), base);
      if (['http:', 'https:'].includes(url.protocol)) refs.push({ tag: match[1].toLowerCase(), url: url.href });
    } catch {
      /* Broken publisher links remain in the frozen source. */
    }
  }
  return [...new Map(refs.map((r) => [r.tag + r.url, r])).values()];
}
export function tableRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<t[dh]\b[^>]*>([^]*?)<\/t[dh]>/gi)].map((cell) => text(cell[1])))
    .filter((row) => row.length);
}
export function number(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?(?:\s*°)?$/.test(value.trim())) return null;
  const n = Number(value.replace('°', '').trim());
  return Number.isFinite(n) ? n : null;
}
export function localTimeToUtc(date, hour, abbreviation) {
  // Explicit abbreviations disambiguate the repeated autumn hour. Never use the host zone.
  const offsets = { PDT: 7, PST: 8, MDT: 6, MST: 7, EDT: 4, EST: 5, UTC: 0, GMT: 0 };
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(midnight) ||
    new Date(midnight).toISOString().slice(0, 10) !== date ||
    !Object.hasOwn(offsets, abbreviation) ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 24
  )
    return null;
  return new Date(Date.parse(`${date}T00:00:00Z`) + (hour + offsets[abbreviation]) * 3600000).toISOString();
}
export function parseBlipspot(html, url) {
  const content = text(html);
  const weatherTable = [...html.matchAll(/<table\b[^>]*>([^]*?)<\/table>/gi)].find((m) => m[1].includes('VALID.TIME'));
  const rows = tableRows(weatherTable?.[1] ?? '');
  const dated = /BLIPSPOT:\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/.exec(content);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = dated ? months.indexOf(dated[2]) + 1 : 0;
  const date = month ? `${dated[3]}-${String(month).padStart(2, '0')}-${dated[1].padStart(2, '0')}` : null;
  const coords = rows.find((r) => r[0] === 'Lat,Lon=')?.[1]?.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  const times = rows.find((r) => r[0] === 'VALID.TIME');
  const repeatedLabel = times?.indexOf('VALID.TIME', 1) ?? -1;
  const columns = times?.slice(1, repeatedLabel > 0 ? repeatedLabel : undefined) ?? [];
  const fields = Object.fromEntries(
    rows.filter((r) => r[0] && r.length >= columns.length + 1).map((r) => [r[0], r.slice(1, columns.length + 1)]),
  );
  const terrain = (fields['BL_Top_TI=0'] ?? [])
    .map((v, i) => {
      const top = number(v),
        depth = number(fields.BL_Depth_AGL?.[i] ?? '');
      return top !== null && depth !== null ? (top - depth) * 0.3048 : null;
    })
    .filter((v) => v !== null);
  const consistentTerrain = terrain.length && Math.max(...terrain) - Math.min(...terrain) <= 0.61;
  const hours = columns.map((v, i) => {
    const clock = /^(\d{1,2})\s+(PDT|PST|MDT|MST|EDT|EST|UTC|GMT)$/.exec(v);
    const [, h, zone] = clock ?? [],
      lead = /^(\d+)h$/.exec(fields.ForecastPd?.[i] ?? '');
    const validAt = date && clock ? localTimeToUtc(date, Number(h), zone) : null;
    return {
      validAt,
      localHour: Number(h),
      zone,
      leadHours: lead ? Number(lead[1]) : null,
      raw: Object.fromEntries(Object.entries(fields).map(([k, values]) => [k, values[i]])),
    };
  });
  const inits = [
    ...new Set(
      hours
        .filter((h) => h.validAt && h.leadHours !== null)
        .map((h) => new Date(Date.parse(h.validAt) - h.leadHours * 3600000).toISOString()),
    ),
  ];
  return {
    url,
    date,
    domain: rows.find((r) => r[1] === 'gridpt=')?.[0] ?? null,
    gridPoint: rows.find((r) => r[1] === 'gridpt=')?.[2] ?? null,
    latitude: coords ? Number(coords[1]) : null,
    longitude: coords ? Number(coords[2]) : null,
    modelElevationM: consistentTerrain ? terrain.reduce((a, b) => a + b, 0) / terrain.length : null,
    terrainProvenance: consistentTerrain ? 'inferred: BL_Top_TI=0 minus BL_Depth_AGL; agreement within 2 ft' : null,
    referenceTime: inits.length === 1 ? inits[0] : null,
    initializationCandidates: inits,
    hours,
    fieldNames: Object.keys(fields).filter((k) => !['VALID.TIME', 'ForecastPd'].includes(k)),
    status:
      inits.length > 1
        ? 'ambiguous-run'
        : date &&
            coords &&
            Math.abs(Number(coords[1])) <= 90 &&
            Math.abs(Number(coords[2])) <= 180 &&
            hours.length &&
            hours.every((h) => h.validAt)
          ? 'parsed'
          : 'unparsed',
  };
}

/** Literal menu declarations only; separators are not forecast products. */
export function parseMapMenu(html) {
  const clean = html.replace(/\/\/[^\n]*/g, '');
  const list = (name) =>
    [
      ...(new RegExp(`${name}\\s*=\\s*new Array\\(([^]*?)\\)`).exec(clean)?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
  return {
    parameters: [...new Set([...list('myparamlist'), ...list('presslevels')])].filter((p) => !p.startsWith('nope')),
    times: list('mytimes'),
    grids: list('mygrids'),
    resolutions: Object.fromEntries(
      [...clean.matchAll(/resolution\[['"]([^'"]+)['"]\]\s*=\s*['"]([^'"]+)['"]/g)].map((m) => [m[1], m[2]]),
    ),
  };
}

export function parseSounding(html) {
  const rows = new Map();
  for (const m of html.matchAll(
    /soundrow\[['"](mb|ft|dir|speed|tempC|dewpointC)['"]\]\[['"]([\d]+)['"]\]\s*=\s*(-?[\d.]+)\s*;/g,
  )) {
    if (!rows.has(m[2])) rows.set(m[2], {});
    rows.get(m[2])[m[1]] = Number(m[3]);
  }
  return {
    heading: text(html).split('var soundrow')[0].slice(0, 1200),
    levels: [...rows.values()].map((r) => ({
      pressureHpa: r.mb,
      heightM: r.ft * 0.3048,
      temperatureC: r.tempC,
      dewPointC: r.dewpointC,
      windDirectionDeg: r.dir,
      windSpeedMps: Number.isFinite(r.speed) ? (r.speed * 1852) / 3600 : null,
    })),
    timeStatus:
      'Header requires explicit valid-time and initialization validation; page generation time is not forecast initialization.',
  };
}
