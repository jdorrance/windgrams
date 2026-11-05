import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
export const fixture = JSON.parse(
  gunzipSync(readFileSync(new URL('../../../web/test/fixtures/windgram-visual/dog-gfs.json.gz', import.meta.url))),
);
export const point = { lat: fixture.site.latitude, lon: fixture.site.longitude };
export const layers = [
  'precip-rate',
  'thermal-velocity',
  'thermal-top-msl',
  'pbl-height-agl',
  'sensible-heat-flux',
  'latent-heat-flux',
  'surface-lcl-msl',
  'cape-jkg',
  'cloud-cover-total',
  'cloud-cover-low',
  'sfc-temp-c',
  'sfc-dewpoint-c',
  'mslp-hpa',
  'wind-10m-u',
  'wind-10m-v',
  'wind-gust-10m',
  'bl-mean-wind-u',
  'bl-mean-wind-v',
];
const hash = 'a'.repeat(64);
export function createAvFixture(frameCount = 24, source = fixture) {
  const fixture = source,
    point = { lat: source.site.latitude, lon: source.site.longitude };
  const hours = Array.from({ length: frameCount }, (_, i) => ({
    ...fixture.hours[i % fixture.hours.length],
    validAt: new Date(Date.parse(fixture.hours[0].validAt) + i * 3600000).toISOString(),
  }));
  const frames = hours.map((hour, i) => ({
    id: `f${String(i + 1).padStart(3, '0')}`,
    validTime: hour.validAt,
    intervalStart: new Date(Date.parse(hour.validAt) - 3600000).toISOString(),
    intervalEnd: hour.validAt,
  }));
  const m = {
    version: 5,
    model: fixture.model,
    buildId: 'test-build',
    cycle: fixture.run.referenceTime,
    createdAt: fixture.run.generatedAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
    method: { id: 'dry-lenschow-1p2-v2', hash },
    source: {
      provider: 'noaa',
      provenanceKey: `builds/${fixture.model}/test-build/provenance.json`,
      provenanceSha256: hash,
    },
    frames,
    mapFrameCount: Math.min(12, frames.length),
    layers: [...layers, 'usable-lift-msl', 'usable-lift-agl'],
    surfaces: [
      {
        id: 'native',
        kind: 'native',
        layers,
        coverage: { maxZoom: 8 },
        grid: { width: 1, height: 1 },
        profiles: { levelCount: hours[0].levels.length },
      },
      {
        id: 'fine',
        kind: 'fine',
        layers: ['usable-lift-msl', 'usable-lift-agl'],
        coverage: { maxZoom: 9 },
        grid: { width: 1, height: 1 },
      },
    ],
    descriptors: {
      maxSampleValues: 256,
      layers: Object.fromEntries(
        [...layers, 'usable-lift-msl', 'usable-lift-agl'].map((id) => [
          id,
          {
            units: 'test',
            verticalReference: 'surface',
            ...(id === 'precip-rate' || id.startsWith('usable-') ? {} : { delivery: 'samples-only' }),
          },
        ]),
      ),
    },
  };
  const cell = (value) => ({
    value: typeof value === 'number' ? value : null,
    status: typeof value === 'number' ? 'valid' : 'unavailable',
    support: 0,
    interpolated: false,
    surfaceId: 'native',
  });
  const profile = {
    version: 1,
    model: m.model,
    buildId: m.buildId,
    cycle: m.cycle,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    lat: point.lat,
    lon: point.lon,
    method: m.method,
    source: m.source,
    cell: { index: 0, ...point, surfaceId: 'native' },
    frames: frames.map((frame, i) => {
      const h = hours[i],
        s = h.surface,
        d = h.soaring ?? {},
        dir = ((s.windDirectionDeg ?? 0) * Math.PI) / 180;
      const values = [
        s.precipitationMmHr,
        d.thermalVelocityV2Mps ?? h.derived.thermalVelocityMps,
        d.resolvedThermalTopM ?? h.derived.boundaryLayerTopM,
        s.pblHeightM ?? 1000,
        s.sensibleHeatFluxWm2,
        s.latentHeatFluxWm2,
        d.surfaceLclM ?? h.derived.cloudBaseM,
        s.capeJkg ?? 0,
        s.cloudCoverPercent,
        s.lowCloudPercent ?? 0,
        s.temperatureC,
        s.dewPointC,
        s.seaLevelPressureHpa,
        -s.windSpeedMps * Math.sin(dir),
        -s.windSpeedMps * Math.cos(dir),
        s.windGustMps ?? null,
        1,
        2,
      ];
      const derived = {
        cumulus: null,
        overdeveloped: null,
        cloudCapped: null,
        usableLiftTopV2M: d.usableLiftTopV2M ?? h.derived.usableLiftTopM,
        hcritWxtoflyM: d.hcritWxtoflyM ?? null,
        dryHcritM: null,
        cuPotentialM: null,
        odPotentialM: null,
        wind10mSpeedMps: s.windSpeedMps,
        wind10mDirDeg: s.windDirectionDeg,
        blMeanWindSpeedMps: Math.sqrt(5),
        blMeanWindDirDeg: 206.565,
        blTopWindSpeedMps: null,
        blTopWindDirDeg: null,
        blWindShearMps: null,
        buoyancyShearRatio: null,
        mixedLayerLclM: d.mixedLayerLclM ?? null,
        effectiveCloudLimitM: d.effectiveCloudLimitM ?? h.derived.cloudBaseM,
      };
      return {
        ...frame,
        layers: Object.fromEntries(layers.map((id, j) => [id, cell(values[j])])),
        derived,
        profile: {
          modelTerrainM: fixture.site.modelElevationM,
          surfacePressureHpa: 1000,
          status: 'valid',
          levels: h.levels.map((l) => {
            const a = (l.windDirectionDeg * Math.PI) / 180;
            return {
              pressureHpa: l.pressureHpa,
              heightM: l.heightM,
              temperatureC: l.temperatureC,
              dewPointC: l.dewPointC,
              uWindMps: -l.windSpeedMps * Math.sin(a),
              vWindMps: -l.windSpeedMps * Math.cos(a),
              omegaPaS: l.verticalVelocityPaS ?? null,
            };
          }),
        },
      };
    }),
  };
  const latest = {
    pointer: {
      model: fixture.model,
      latestBuildId: m.buildId,
      retained: [
        {
          buildId: m.buildId,
          cycle: m.cycle,
          expiresAt: m.expiresAt,
          manifestKey: `builds/${fixture.model}/test-build/manifest.json`,
        },
      ],
    },
    manifest: m,
    templates: Object.fromEntries(
      ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'].map((layer) => [
        layer,
        `https://av.test/${layer}/{frame}/{z}/{x}/{y}.webp`,
      ]),
    ),
  };
  return { latest, profile };
}
export function verifiedJson(body) {
  const raw = JSON.stringify(body);
  return new Response(raw, { headers: { etag: `"${createHash('sha256').update(raw).digest('hex')}"` } });
}
export function avFetch(data = createAvFixture(), mutate = (value) => value) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url, 'https://av.test');
    if (parsed.pathname.endsWith('/latest')) return Response.json(data.latest);
    const frames = parsed.searchParams.get('frame').split(','),
      selected = data.profile.frames.filter((f) => frames.includes(f.id));
    if (parsed.pathname.endsWith('/samples')) {
      const requested = parsed.searchParams.get('layers').split(',');
      return verifiedJson({
        version: 1,
        model: data.profile.model,
        buildId: data.profile.buildId,
        expiresAt: data.profile.expiresAt,
        points: parsed.searchParams
          .get('points')
          .split(';')
          .map((coordinate, index) => {
            const [lat, lon] = coordinate.split(',').map(Number);
            return {
              index,
              sample: {
                version: 5,
                model: data.profile.model,
                buildId: data.profile.buildId,
                expiresAt: data.profile.expiresAt,
                method: data.profile.method,
                source: data.profile.source,
                lat,
                lon,
                frames: selected.map(({ profile: _p, derived: _d, ...frame }) => ({
                  ...frame,
                  layers: Object.fromEntries(
                    requested.map((id) => [
                      id,
                      frame.layers[id] ?? {
                        value: id === 'usable-lift-agl' ? 200 : 1000,
                        status: 'valid',
                        support: 0,
                        interpolated: true,
                        surfaceId: 'fine',
                      },
                    ]),
                  ),
                })),
              },
            };
          }),
      });
    }
    return verifiedJson(
      mutate({
        ...data.profile,
        lat: Number(parsed.searchParams.get('lat')),
        lon: Number(parsed.searchParams.get('lon')),
        frames: selected,
      }),
    );
  };
  return { fetch, calls, data };
}
