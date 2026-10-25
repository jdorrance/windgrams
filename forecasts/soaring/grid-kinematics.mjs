// Native-grid horizontal convergence on 3 km Lambert grids before display reprojection.

import { projection, storageCoordinates } from './grid.mjs';
import { finite, round2 } from './thermodynamics.mjs';

/**
 * Computes conformal-map convergence -m²[d(U/m)/dx + d(V/m)/dy], in
 * 10^-5 s^-1, before display reprojection. m is projected/ground distance.
 * Earth-relative input winds are rotated to grid axes before differencing.
 * Edges use one-sided differences; missing neighbours remain unavailable.
 * Wind arrays follow cells, whose indices are unique native storage indices.
 *
 * @param {import('@azohra/meteo.grib').LambertGrid} grid
 * @param {readonly { index: number }[]} cells
 * @param {readonly (number | null | undefined)[]} uGridArray
 * @param {readonly (number | null | undefined)[]} vGridArray
 * @returns {(number | null)[]}
 */
export function computeNativeGridConvergence(grid, cells, uGridArray, vGridArray) {
  const p = projection(grid);
  /** @type {Map<string, number>} */
  const byGridIJ = new Map();
  const scales = [], uFlux = [], vFlux = [];
  for (let idx = 0; idx < cells.length; idx++) {
    const [i, j] = storageCoordinates(grid, cells[idx].index);
    byGridIJ.set(`${i},${j}`, idx);
    const [longitude, latitude] = p.point(i, j), scale = p.scaleAt(latitude);
    scales.push(scale);
    let u = uGridArray[idx], v = vGridArray[idx];
    if (!grid.uvRelativeToGrid) {
      if (!finite(u) || !finite(v)) { uFlux.push(null); vFlux.push(null); continue; }
      [u, v] = p.gridWind(longitude, u, v);
    }
    uFlux.push(finite(u) ? u / scale : null); vFlux.push(finite(v) ? v / scale : null);
  }
  const dx = grid.dxM * (grid.iScansNegatively ? -1 : 1);
  const dy = grid.dyM * (grid.jScansPositively ? 1 : -1);
  return cells.map((cell, cIdx) => {
    const [i, j] = storageCoordinates(grid, cell.index);
    const eIdx = byGridIJ.get(`${i + 1},${j}`) ?? cIdx;
    const wIdx = byGridIJ.get(`${i - 1},${j}`) ?? cIdx;
    const nIdx = byGridIJ.get(`${i},${j + 1}`) ?? cIdx;
    const sIdx = byGridIJ.get(`${i},${j - 1}`) ?? cIdx;
    const spanX = (eIdx !== cIdx ? 1 : 0) + (wIdx !== cIdx ? 1 : 0);
    const spanY = (nIdx !== cIdx ? 1 : 0) + (sIdx !== cIdx ? 1 : 0);
    if (!spanX || !spanY) return null;
    const uE = uFlux[eIdx], uW = uFlux[wIdx];
    const vN = vFlux[nIdx], vS = vFlux[sIdx];
    if (!finite(uE) || !finite(uW) || !finite(vN) || !finite(vS)) return null;
    const dudx = (uE - uW) / (spanX * dx);
    const dvdy = (vN - vS) / (spanY * dy);
    const convergencePerSec = -(scales[cIdx] ** 2) * (dudx + dvdy);
    const rounded = round2(convergencePerSec * 1e5);
    return rounded === 0 ? 0 : rounded;
  });
}
