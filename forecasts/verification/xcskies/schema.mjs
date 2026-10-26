// Offline PointCast wire boundary. Scaling evidence and scientific limits: README.md.
export const POINTCAST_DECODER = Object.freeze({
  version: 'xcskies-pointcast/1.0.0',
  rendererUrl: 'https://xcskies.com/static/xcv3.5.8.js?v=801af136533db6a7b8399aba1b86c514',
  rendererSha256: 'd2f37acfc5c508fd43a2f978ee3642b613c0d6c19466622c77cb3a20701962ac',
});

const matrixFields = {
  tmps: ['temperatureC', '°C', 'comparable', 'Environmental temperature.'],
  rhs: ['relativeHumidityPct', '%', 'comparable', 'Environmental relative humidity; no inferred dew point.'],
  clds: ['cloudFractionPct', '%', 'qualified', 'Provider cloud layers; overlap and cloud algorithms may differ.'],
  vels: ['parcelVelocityMps', 'm/s', 'not-equivalent', 'Parcel vertical velocity, not convective velocity scale W*.'],
  vvels: [
    'modelVerticalVelocityMps',
    'm/s',
    'qualified',
    'Large-scale model vertical velocity; native representation is not supplied.',
  ],
  dps: [
    'parcelDewPointDepressionIndex',
    'index',
    'not-equivalent',
    'Parcel dew point depression, not environmental dew point or RH.',
  ],
  tis: ['thermalIndex', 'index', 'not-equivalent', 'Parcel thermal index; provider parcel definition.'],
  bs: ['buoyancyShearRatio', '1', 'not-equivalent', 'Level-dependent provider ratio, not our layer aggregate.'],
  turbs: ['turbulenceIndex', 'index', 'not-equivalent', 'Wind shear/turbulence index, not wind shear in m/s.'],
};
const heightFields = {
  vtops: [
    'usableLiftTopM',
    'not-equivalent',
    'Provider help says velocity approaches 1.2 m/s; not our 1 m/s or 225 ft/min (1.143 m/s) ceiling.',
  ],
  bltops: ['thermalTopM', 'qualified', 'Provider parcel-derived boundary-layer top; not native model PBL depth.'],
  dptops: [
    'cloudBaseM',
    'not-equivalent',
    'Provider calls this CCL; not established equivalent to surface or mixed-layer LCL.',
  ],
  cutops: ['cloudTopM', 'qualified', 'Potential convective cloud top; cloud existence is conditional.'],
  sensetops: ['sensitivityTopM', 'not-equivalent', 'Provider surface-heating sensitivity trace.'],
  sensebottoms: ['sensitivityBottomM', 'not-equivalent', 'Provider surface-heating sensitivity trace.'],
};
const surfaceFields = ['u10m', 'v10m', 'wgust10m', 'tmp2m', 'cape', 'precip', 'sun'];
const temporalFields = [
  'u',
  'v',
  ...Object.keys(matrixFields),
  ...Object.keys(heightFields),
  'elevs',
  'elevs2',
  'dalrtops',
  ...surfaceFields,
];
const sentinels = new Set([-99990, -9999, -8888]);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const decoded = (value, scale = 1) => (value === null || sentinels.has(value) ? null : value * scale);

export const POINTCAST_FIELDS = Object.freeze([
  {
    field: 'windUMps',
    wire: 'u',
    unit: 'm/s',
    scale: 0.1,
    heightReference: 'MSL',
    comparability: 'comparable',
    qualification: 'Eastward component; compare vectors at matched heights.',
  },
  {
    field: 'windVMps',
    wire: 'v',
    unit: 'm/s',
    scale: 0.1,
    heightReference: 'MSL',
    comparability: 'comparable',
    qualification: 'Northward component; compare vectors at matched heights.',
  },
  ...Object.entries(matrixFields).map(([wire, [field, unit, comparability, qualification]]) => ({
    field,
    wire,
    unit,
    scale: wire === 'rhs' ? 1 : 0.1,
    heightReference: 'MSL',
    comparability,
    qualification,
  })),
  ...Object.entries(heightFields).map(([wire, [field, comparability, qualification]]) => ({
    field,
    wire,
    unit: 'm',
    scale: 10,
    heightReference: 'MSL',
    comparability,
    qualification,
  })),
  {
    field: 'modelElevationM',
    wire: 'elevs',
    unit: 'm',
    scale: 10,
    heightReference: 'MSL',
    comparability: 'qualified',
    qualification: 'XC displayed ground; native-grid versus terrain-adjusted provenance is unresolved.',
  },
  {
    field: 'conservativeTopM',
    wire: 'dalrtops[][0]',
    unit: 'm',
    scale: 1,
    heightReference: 'MSL',
    comparability: 'not-equivalent',
    qualification: 'Provider conservative environmental-lapse-rate height, not a sink-rate ceiling.',
  },
  ...surfaceFields.map((wire) => ({
    field: `rawSurface.${wire}`,
    wire,
    unit: null,
    scale: null,
    heightReference: null,
    comparability: 'unverified',
    qualification:
      'The inspected PointCast renderer does not establish this scalar encoding; retain raw and exclude from scores.',
  })),
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid XC Skies PointCast: ${message}`);
}
function numeric(value, key) {
  requireValue(value === null || finite(value), `${key} must be a finite number or null`);
}
function validate(raw) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'expected an object');
  requireValue(raw.status === 1, `unavailable status ${String(raw.status)}`);
  requireValue(
    Array.isArray(raw.epochs) && raw.epochs.length > 0 && raw.epochs.length <= 5000,
    'epochs must contain 1–5000 timestamps',
  );
  raw.epochs.forEach((epoch, index) => {
    requireValue(
      Number.isSafeInteger(epoch) && epoch >= 0 && Number.isFinite(new Date(epoch * 1000).getTime()),
      `invalid epoch at ${index}`,
    );
    requireValue(index === 0 || epoch > raw.epochs[index - 1], 'epochs must strictly increase');
  });
  for (const key of ['minheight', 'ninterval', 'level_interval'])
    requireValue(finite(raw[key]), `${key} must be finite`);
  requireValue(raw.ninterval > 0 && raw.level_interval > 0, 'height intervals must be positive');
  for (const key of ['u', 'v', 'tmps', 'elevs']) requireValue(Array.isArray(raw[key]), `missing required ${key}`);
  requireValue(
    raw.na === undefined || (Array.isArray(raw.na) && raw.na.length === 0),
    'nonempty na markers have unresolved alignment',
  );
  for (const key of temporalFields) {
    if (raw[key] === undefined) continue;
    requireValue(
      Array.isArray(raw[key]) && raw[key].length === raw.epochs.length,
      `${key} has ${raw[key]?.length ?? 'no'} columns for ${raw.epochs.length} epochs; partial responses are not comparable`,
    );
    const matrix = key === 'u' || key === 'v' || key in matrixFields || key === 'dalrtops';
    if (matrix) {
      const width = raw[key][0]?.length;
      requireValue(Number.isInteger(width) && width > 0 && width <= 5000, `${key} has invalid level count`);
      if (key === 'dalrtops')
        requireValue(width === 3, 'dalrtops must contain height, pressure and temperature triples');
      raw[key].forEach((column, index) => {
        requireValue(Array.isArray(column) && column.length === width, `${key}[${index}] has inconsistent level count`);
        column.forEach((value, level) => numeric(value, `${key}[${index}][${level}]`));
      });
    } else raw[key].forEach((value, index) => numeric(value, `${key}[${index}]`));
  }
  requireValue(raw.u[0].length === raw.v[0].length, 'u and v level counts differ');
}

/** Decode a complete frozen response. Request identity is asserted by the caller, never inferred from the body or URL date. */
export function parsePointcast(raw, { model, latitude, longitude, sourceUrl = null } = {}) {
  validate(raw);
  requireValue(typeof model === 'string' && model.length > 0, 'request model is required');
  requireValue(
    finite(latitude) && Math.abs(latitude) <= 90 && finite(longitude) && Math.abs(longitude) <= 180,
    'valid requested coordinates are required',
  );
  const hours = raw.epochs.map((epoch, rawIndex) => {
    const byHeight = new Map();
    const put = (index, spacing, key, value) => {
      const heightM = raw.minheight + index * spacing;
      if (!byHeight.has(heightM)) byHeight.set(heightM, { heightM });
      byHeight.get(heightM)[key] = value;
    };
    for (const [wire, field] of [
      ['u', 'windUMps'],
      ['v', 'windVMps'],
    ])
      raw[wire][rawIndex].forEach((value, index) => put(index, raw.level_interval, field, decoded(value, 0.1)));
    for (const [wire, [field]] of Object.entries(matrixFields))
      raw[wire]?.[rawIndex].forEach((value, index) =>
        put(index, raw.ninterval, field, decoded(value, wire === 'rhs' ? 1 : 0.1)),
      );
    const levels = [...byHeight.values()]
      .sort((a, b) => a.heightM - b.heightM)
      .map((level) => {
        const u = level.windUMps,
          v = level.windVMps;
        const windSpeedMps = finite(u) && finite(v) ? Math.hypot(u, v) : null;
        const windDirectionDeg = windSpeedMps > 0 ? ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 : null;
        return { ...level, windSpeedMps, windDirectionDeg };
      });
    const diagnostics = Object.fromEntries(
      Object.entries(heightFields).map(([wire, [field]]) => [
        field,
        raw[wire] ? decoded(raw[wire][rawIndex], 10) : null,
      ]),
    );
    diagnostics.conservativeTopM = raw.dalrtops ? decoded(raw.dalrtops[rawIndex][0]) : null;
    return {
      validAt: new Date(epoch * 1000).toISOString(),
      rawIndex,
      modelElevationM: decoded(raw.elevs[rawIndex], 10),
      surface: {},
      rawSurface: Object.fromEntries(surfaceFields.filter((key) => raw[key]).map((key) => [key, raw[key][rawIndex]])),
      diagnostics,
      levels,
    };
  });
  return {
    schemaVersion: 1,
    decoder: POINTCAST_DECODER,
    model,
    requestedCoordinates: { latitude, longitude },
    returnedCoordinates: null,
    sourceUrl,
    referenceTime: null,
    hours,
    fieldDefinitions: POINTCAST_FIELDS,
    verticalGrid: {
      firstHeightM: raw.minheight,
      diagnosticStepM: raw.ninterval,
      windStepM: raw.level_interval,
      reference: 'MSL',
    },
    limitations: [
      'Response does not supply model initialization or returned/native-cell coordinates; the URL date is a request anchor, not a model run.',
      'Exact valid-time comparisons do not establish equal initialization, forecast lead, grid or terrain.',
      'Decoded height traces and parcel diagnostics retain provider meanings; normalization does not establish algorithm equivalence.',
      'Unverified surface scalars remain raw; unavailable sentinels become null, while zero remains zero.',
    ],
  };
}
