// Prove the current AV publication through the same consumer boundary before retiring its builders.
import { parseArgs } from 'node:util';
import { sunPosition } from '@windgrams/meteorology/sun';
import { writeFileSync } from 'node:fs';
import { createAvClient, avProfileToPublishedSiteForecast } from '@windgrams/data-client/av';
const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'https://windy-av-api-production.jdorrance.workers.dev' },
    output: { type: 'string' },
  },
});
const sites = [
  {
    model: 'gfs',
    endHour: 384,
    slug: 'wa-blanchard',
    name: 'Blanchard',
    lat: 48.6097,
    lon: -122.426,
    timeZone: 'America/Los_Angeles',
  },
  {
    model: 'rrfs',
    endHour: 48,
    slug: 'wa-blanchard',
    name: 'Blanchard',
    lat: 48.6097,
    lon: -122.426,
    timeZone: 'America/Los_Angeles',
  },
  {
    model: 'icon-eu',
    endHour: 48,
    slug: 'am-aparan',
    name: 'Aparan',
    lat: 40.5913,
    lon: 44.4741,
    timeZone: 'Asia/Yerevan',
  },
];
const digests = [];
const client = createAvClient({
    apiBaseUrl: values.api,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (response.ok && /\/(profile|samples)\?/.test(String(url))) {
        const query = new URL(url).searchParams;
        digests.push({
          model: String(url).split('/models/')[1].split('/')[0],
          endpoint: String(url).includes('/profile?') ? 'profile' : 'samples',
          frames: query.get('frame').split(','),
          sha256: response.headers.get('etag')?.replace(/^"|"$/g, ''),
        });
      }
      return response;
    },
  }),
  models = [];
for (const site of sites) {
  const build = await client.pin(site.model),
    m = build.manifest,
    native = m.surfaces.find((surface) => surface.kind === 'native'),
    fine = m.surfaces.find((surface) => surface.kind === 'fine');
  if (m.layers.length !== 20 || native.layers.length !== 18 || fine?.layers.length !== 2 || !native.profiles)
    throw new Error(`${site.model}: expected current 18 native + 2 fine fields and raw profiles`);
  const endHour = (Date.parse(m.frames.at(-1).validTime) - Date.parse(m.cycle)) / 3600000;
  if (endHour !== site.endHour) throw new Error(`${site.model}: incomplete native horizon ${endHour}`);
  const profile = await client.profile(build, site),
    published = avProfileToPublishedSiteForecast(profile, site),
    frame = profile.frames[0];
  if (published.hours.length !== m.frames.length || !profile.cell)
    throw new Error(`${site.model}: point axis or native cell missing`);
  const [sample] = await client.samples(
    build,
    [{ lat: profile.cell.lat, lon: profile.cell.lon }],
    [frame.id],
    native.layers,
  );
  for (const layer of native.layers) {
    const a = frame.layers[layer],
      b = sample.frames[0].layers[layer];
    if (
      a.status !== b.status ||
      (a.value === null ? b.value !== null : b.value === null || Math.abs(a.value - b.value) > 1e-7)
    )
      throw new Error(`${site.model}: native point/sample disagreement for ${layer}`);
  }
  const afterMap = m.frames[m.mapFrameCount ?? m.frames.length];
  if (!afterMap) throw new Error(`${site.model}: expected native frames beyond the raster prefix`);
  const [future] = await client.samples(
    build,
    [site],
    [afterMap.id],
    ['usable-lift-msl', 'usable-lift-agl', 'sfc-temp-c', 'precip-rate'],
  );
  for (const layer of fine.layers)
    if (future.frames[0].layers[layer].status !== 'unavailable' || future.frames[0].layers[layer].value !== null)
      throw new Error(`${site.model}: fine data leaked past map prefix`);
  for (const layer of ['sfc-temp-c', 'precip-rate'])
    if (future.frames[0].layers[layer].status !== 'valid')
      throw new Error(`${site.model}: native forecast missing beyond map prefix`);
  const night = profile.frames.find(
    (frame) => sunPosition(Date.parse(frame.validTime), site.lat, site.lon).elevationDeg < -6,
  );
  if (
    !night ||
    !night.profile.levels.length ||
    ['sfc-temp-c', 'precip-rate'].some((layer) => night.layers[layer].status !== 'valid')
  )
    throw new Error(`${site.model}: missing all-hour native data`);
  let delta = { gfs: 0.25, rrfs: 0.03, 'icon-eu': 0.0625 }[site.model],
    adjacent;
  const row = Math.floor(profile.cell.index / native.grid.width),
    column = profile.cell.index % native.grid.width;
  for (let attempt = 0; attempt < 8; attempt++) {
    const point = { lat: profile.cell.lat, lon: profile.cell.lon + delta },
      candidate = await client.profile(build, point, [night.id]);
    if (!candidate.cell) throw new Error(`${site.model}: adjacent profile outside coverage`);
    const distance = Math.max(
      Math.abs(Math.floor(candidate.cell.index / native.grid.width) - row),
      Math.abs((candidate.cell.index % native.grid.width) - column),
    );
    if (distance === 1) {
      if (!candidate.frames[0].profile.levels.length)
        throw new Error(`${site.model}: adjacent native profile missing`);
      adjacent = { point, cell: candidate.cell, rows: candidate.frames[0].profile.levels.length, frame: night.id };
      break;
    }
    delta *= distance === 0 ? 2 : 0.5;
  }
  if (!adjacent) throw new Error(`${site.model}: could not verify an adjacent native cell`);
  const tiles = [];
  for (const layer of Object.keys(build.templates)) {
    const z = Math.min(6, m.surfaces.find((surface) => surface.layers.includes(layer)).coverage.maxZoom),
      scale = 2 ** z,
      x = Math.floor(((site.lon + 180) / 360) * scale),
      rad = (site.lat * Math.PI) / 180,
      y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * scale);
    const url = build.templates[layer]
      .replace('{frame}', frame.id)
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('image/webp'))
      throw new Error(`${site.model}: tile unavailable ${response.status}`);
    let bytes = 0,
      offset = 0;
    const header = new Uint8Array(12);
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error(`${site.model}: tile byte budget`);
      const take = Math.min(12 - offset, chunk.length);
      header.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    if (
      offset < 12 ||
      new TextDecoder().decode(header.subarray(0, 4)) !== 'RIFF' ||
      new TextDecoder().decode(header.subarray(8)) !== 'WEBP' ||
      new DataView(header.buffer).getUint32(4, true) + 8 !== bytes
    )
      throw new Error(`${site.model}: invalid WebP container`);
    tiles.push({ layer, frame: frame.id, bytes });
  }
  models.push({
    model: site.model,
    buildId: m.buildId,
    cycle: m.cycle,
    method: m.method,
    source: m.source,
    frames: m.frames.length,
    mapFrames: m.mapFrameCount ?? m.frames.length,
    endHour,
    site: { slug: site.slug, lat: site.lat, lon: site.lon },
    cell: profile.cell,
    rows: profile.frames.map((frame) => frame.profile.levels.length),
    samplesMatched: native.layers.length,
    afterMap: afterMap.id,
    night: night.id,
    adjacent,
    tiles,
  });
}
const proof = { version: 1, verifiedAt: new Date().toISOString(), api: values.api, digests, models };
const json = JSON.stringify(proof, null, 2) + '\n';
if (values.output) writeFileSync(values.output, json);
else process.stdout.write(json);
