// Independent reference equations on frozen columns; do not call the production derivation.
import { scalar } from './fields.mjs';
const finite = Number.isFinite;
export function referenceLcl(temperatureC, dewPointC, terrainM) {
  if (![temperatureC, dewPointC, terrainM].every(finite)) return null;
  if (dewPointC >= temperatureC) return terrainM;
  const t = temperatureC + 273.15,
    d = dewPointC + 273.15;
  return terrainM + (t - (1 / (1 / (d - 56) + Math.log(t / d) / 800) + 56)) / 0.0098;
}
export function referenceWstar(hour, terrainM) {
  const s = hour.surface ?? {},
    top = scalar(hour.soaring?.resolvedThermalTopM);
  if (![s.temperatureC, s.dewPointC, s.sensibleHeatFluxWm2, s.latentHeatFluxWm2, terrainM].every(finite)) return null;
  // A published zero is checked only when the source virtual heating is nonpositive.
  if (top === null)
    return s.sensibleHeatFluxWm2 + 0.000245268 * (s.temperatureC + 273.15) * s.latentHeatFluxWm2 <= 0 ? 0 : null;
  const first = (hour.levels ?? []).filter((l) => l.heightM > terrainM + 20).sort((a, b) => a.heightM - b.heightM)[0];
  let p = s.surfacePressureHpa;
  if (!finite(p) && first && [first.heightM, first.pressureHpa, first.temperatureC].every(finite))
    p =
      first.pressureHpa *
      Math.exp(
        (9.80665 * (first.heightM - terrainM)) / (287.05 * ((s.temperatureC + first.temperatureC) / 2 + 273.15)),
      );
  if (!finite(p) || p <= 0) return null;
  const t = s.temperatureC + 273.15,
    td = Math.min(s.temperatureC, s.dewPointC),
    e = 6.112 * Math.exp((17.67 * td) / (td + 243.5));
  const r = (0.622 * e) / (p - e),
    q = r / (1 + r),
    delta = (1 - 0.622) / 0.622;
  const heat = ((1 + delta * q) * s.sensibleHeatFluxWm2) / 1004 + (delta * t * s.latentHeatFluxWm2) / 2501000;
  return Math.cbrt(Math.max(0, ((9.80665 * Math.max(0, top - terrainM) * 287.05) / (p * 100)) * heat));
}
export function referenceCeiling(terrain, top, wstar, cap, sink) {
  if (![terrain, top, wstar, sink].every(finite) || top <= terrain || wstar <= 0 || sink <= 0) return null;
  const upper = Math.min(top, finite(cap) ? cap : top),
    zcap = (upper - terrain) / (top - terrain);
  if (zcap <= 0) return null;
  // Substitute x = zeta^(1/3): F = 4x - 3.2x^4. Solve the descending root.
  const peak = Math.cbrt(5 / 16),
    f = (x) => 4 * x - 3.2 * x ** 4,
    target = sink / wstar;
  if (target > f(peak)) return null;
  if (zcap <= 5 / 16) return f(Math.cbrt(zcap)) >= target ? upper : null;
  if (target <= f(1)) return upper;
  let lo = peak,
    hi = 1;
  for (let i = 0; i < 70; i++) {
    const x = (lo + hi) / 2;
    if (f(x) > target) lo = x;
    else hi = x;
  }
  return Math.min(upper, terrain + (top - terrain) * ((lo + hi) / 2) ** 3);
}
export function auditProfile(profile) {
  const checks = [],
    terrain = profile.site.modelElevationM;
  for (const hour of profile.hours) {
    const s = hour.soaring;
    if (!s || typeof s.thermalVelocityV2Mps === 'object') continue;
    const base = { model: profile.model, site: profile.site.id, validAt: hour.validAt };
    const add = (field, expected, actual, tolerance) => {
      if (expected === null || !finite(actual)) return;
      checks.push({
        ...base,
        field,
        expected,
        actual,
        tolerance,
        difference: actual - expected,
        pass: Math.abs(actual - expected) <= tolerance,
      });
    };
    add('surfaceLclM', referenceLcl(hour.surface.temperatureC, hour.surface.dewPointC, terrain), s.surfaceLclM, 0.11);
    add('thermalVelocityV2Mps', referenceWstar(hour, terrain), s.thermalVelocityV2Mps, 0.012);
    for (const [key, sink] of [
      ['usableLiftTopV2M', 1],
      ['hcritWxtoflyM', 1.143],
    ]) {
      const top = s.resolvedThermalTopM,
        w = s.thermalVelocityV2Mps,
        cap = s.effectiveCloudLimitM;
      const expected = referenceCeiling(terrain, top, w, cap, sink);
      // Account for published W* rounding before diagnosing a numerical defect.
      const bounds = [
        referenceCeiling(terrain, top, w - 0.0051, cap, sink),
        referenceCeiling(terrain, top, w + 0.0051, cap, sink),
      ].filter(finite);
      if (expected !== null && finite(s[key])) {
        const tolerance = Math.max(0.2, ...bounds.map((v) => Math.abs(v - expected) + 0.2));
        add(key, expected, s[key], tolerance);
      }
      if (finite(s[key]) && finite(top))
        checks.push({
          ...base,
          field: `${key}:physical-bounds`,
          actual: s[key],
          expected: top,
          tolerance: 0.11,
          difference: Math.max(0, s[key] - top, terrain - s[key]),
          pass: s[key] <= top + 0.11 && s[key] >= terrain - 0.11,
        });
    }
    if (finite(s.hcritWxtoflyM) && finite(s.usableLiftTopV2M))
      checks.push({
        ...base,
        field: 'sink-threshold-ordering',
        difference: s.hcritWxtoflyM - s.usableLiftTopV2M,
        pass: s.hcritWxtoflyM <= s.usableLiftTopV2M + 0.11,
        tolerance: 0.11,
      });
  }
  return checks;
}
