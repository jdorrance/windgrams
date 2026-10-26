// Real GFS headers/values with compact constant-packed cells. Source hashes live in the fixture.
import { readFile } from 'node:fs/promises';
import { fileUrl } from '../dist/internal/noaa/transport.js';
const section = (number, size) => { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(size); bytes[4] = number; return bytes; };
export async function gfsFixtureTransport() {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/noaa-gfs.json', import.meta.url), 'utf8'));
  const files = new Map();
  for (const [lead, records] of Object.entries(fixture.sources)) {
    const lines = [], messages = []; let offset = 0;
    for (const record of Object.values(records)) {
      const s1 = Buffer.from(record.section1, 'base64'), s3 = Buffer.from(record.section3, 'base64'), s4 = Buffer.from(record.section4, 'base64');
      s3.writeUInt32BE(16, 6); s3.writeUInt32BE(4, 30); s3.writeUInt32BE(4, 34);
      s3.writeUInt32BE(48_750_000, 46); s3.writeUInt32BE(237_500_000, 50);
      s3.writeUInt32BE(48_000_000, 55); s3.writeUInt32BE(238_250_000, 59);
      const s5 = section(5, 21); s5.writeUInt32BE(16, 5); s5.writeUInt16BE(0, 9); s5.writeFloatBE(record.value ?? NaN, 11);
      const s6 = section(6, 6); s6[5] = 255;
      const s7 = section(7, 5), start = Buffer.alloc(16); start.write('GRIB'); start[7] = 2;
      start.writeBigUInt64BE(BigInt(16 + s1.length + s3.length + s4.length + s5.length + s6.length + s7.length + 4), 8);
      const message = Buffer.concat([start, s1, s3, s4, s5, s6, s7, Buffer.from('7777')]);
      lines.push(`${lines.length + 1}:${offset}:d=2026102600:${record.variable}:${record.level}:${record.forecast}:`);
      messages.push(message); offset += message.length;
    }
    lines.push(`${lines.length + 1}:${offset}:d=2026102600:IGNORED:surface:${lead} hour fcst:`);
    const url = fileUrl({ model: 'gfs', referenceTime: fixture.referenceTime }, Number(lead));
    files.set(url, Buffer.concat(messages)); files.set(`${url}.idx`, Buffer.from(`${lines.join('\n')}\n`));
  }
  return { fixture, fetchImpl: async (url, init) => {
    const bytes = files.get(url); if (!bytes) throw new Error(`Unexpected GFS fixture URL ${url}`);
    const match = init.headers.Range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(bytes);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  } };
}
