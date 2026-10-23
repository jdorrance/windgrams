// Test-only GRIB transport: original section metadata, a 4×4 synthetic grid,
// and constant simple-packed values taken from the real Blanchard column.
// This is deliberately distinct from the original archived byte-range cache.
import { readJson, fileUrl } from './common.mjs';
import { fields } from './fields.mjs';

const section = (number, size) => { const b = Buffer.alloc(size); b.writeUInt32BE(size); b[4] = number; return b; };
export async function fixtureTransport(c) {
  const headers = await readJson(new URL('./fixtures/grib-headers.json', import.meta.url));
  const real = await readJson(new URL('./fixtures/blanchard-raw.json', import.meta.url));
  const files = new Map();
  for (const hour of [c.terrainForecastHour, ...c.forecastHours]) {
    const messages = [], lines = []; let offset = 0;
    for (const spec of fields(c,hour)) {
      const header = headers.sources[hour][spec.key];
      const s1 = Buffer.from(header.section1,'base64'), s3 = Buffer.from(header.section3,'base64'), s4 = Buffer.from(header.section4,'base64');
      s3.writeUInt32BE(16,6); s3.writeUInt32BE(4,30); s3.writeUInt32BE(4,34);
      s3.writeUInt32BE(48_570_000,38); s3.writeUInt32BE(237_560_000,42);
      const value = spec.key === 'terrain' ? real.terrain : real.hours.find(h => h.forecastHour === hour).raw[spec.key];
      const s5 = section(5,21); s5.writeUInt32BE(16,5); s5.writeUInt16BE(0,9); s5.writeFloatBE(value,11);
      const s6 = section(6,6); s6[5] = 255;
      const s7 = section(7,5), end = Buffer.from('7777');
      const start = Buffer.alloc(16); start.write('GRIB'); start[7] = 2;
      start.writeBigUInt64BE(BigInt(16+s1.length+s3.length+s4.length+s5.length+s6.length+s7.length+4),8);
      const message = Buffer.concat([start,s1,s3,s4,s5,s6,s7,end]);
      lines.push(`${lines.length+1}:${offset}:d=2026102100:${spec.variable}:${spec.level}:${hour} hour fcst:`);
      messages.push(message); offset += message.length;
    }
    // Sentinel makes the last selected record's byte length explicit.
    lines.push(`${lines.length+1}:${offset}:d=2026102100:IGNORED:surface:${hour} hour fcst:`);
    files.set(fileUrl(c,hour),Buffer.concat(messages));
    files.set(fileUrl(c,hour)+'.idx',Buffer.from(lines.join('\n')+'\n'));
  }
  return async (url, init) => {
    const bytes = files.get(url); if (!bytes) throw new Error(`Unexpected fixture fetch: ${url}`);
    const match = init.headers.Range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(bytes);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(bytes.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
  };
}

// Real RRFS headers and decoded values; only the transport packing and grid
// dimensions are synthetic. Keeps split-file selection and PDT 4.8 timing real.
export async function rrfsFixtureTransport(c) {
  const fixture = await readJson(new URL('./fixtures/rrfs-native-column.json', import.meta.url));
  const files = new Map();
  for (const hour of [c.terrainForecastHour, ...c.forecastHours]) {
    for (const product of [...new Set(fields(c, hour).map(s => s.product))]) {
      const messages = [], lines = []; let offset = 0;
      for (const spec of fields(c, hour).filter(s => s.product === product)) {
        const header = fixture.sources[hour][spec.key];
        if (!header) continue;
        const s1 = Buffer.from(header.section1, 'base64'), s3 = Buffer.from(header.section3, 'base64'), s4 = Buffer.from(header.section4, 'base64');
        s3.writeUInt32BE(16, 6); s3.writeUInt32BE(4, 30); s3.writeUInt32BE(4, 34);
        s3.writeUInt32BE(48_570_000, 38); s3.writeUInt32BE(237_560_000, 42);
        const value = spec.key === 'terrain' ? fixture.terrain : fixture.raw[spec.key];
        const s5 = section(5, 21); s5.writeUInt32BE(16, 5); s5.writeUInt16BE(0, 9); s5.writeFloatBE(value, 11);
        const s6 = section(6, 6); s6[5] = 255;
        const s7 = section(7, 5), end = Buffer.from('7777');
        const start = Buffer.alloc(16); start.write('GRIB'); start[7] = 2;
        start.writeBigUInt64BE(BigInt(16 + s1.length + s3.length + s4.length + s5.length + s6.length + s7.length + 4), 8);
        const message = Buffer.concat([start, s1, s3, s4, s5, s6, s7, end]);
        const stamp = c.referenceTime.slice(0, 13).replace(/[-T:]/g, '');
        lines.push(`${lines.length + 1}:${offset}:d=${stamp}:${spec.variable}:${spec.level}:${spec.forecast ?? `${hour} hour fcst`}:`);
        messages.push(message); offset += message.length;
      }
      lines.push(`${lines.length + 1}:${offset}:d=${c.referenceTime.slice(0, 13).replace(/[-T:]/g, '')}:IGNORED:surface:${hour} hour fcst:`);
      files.set(fileUrl(c, hour, product), Buffer.concat(messages));
      files.set(`${fileUrl(c, hour, product)}.idx`, Buffer.from(`${lines.join('\n')}\n`));
    }
  }
  return async (url, init) => {
    const bytes = files.get(url); if (!bytes) throw new Error(`Unexpected RRFS fixture fetch: ${url}`);
    const match = init.headers.Range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(bytes);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  };
}
