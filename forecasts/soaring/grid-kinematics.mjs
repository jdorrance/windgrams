// Native-grid horizontal convergence on 3 km Lambert grids before display reprojection.

import { storageCoordinates } from './grid.mjs';
import { finite, round2 } from './thermodynamics.mjs';

/**
 * Computes horizontal convergence (-du/dx - dv/dy) in units of 10^-5 s^-1
 * on the native 3 km Lambert grid before display reprojection.
 *
 * @param {{ ni: number; nj: number; dxM: number; dyM: number; jPointsAreConsecutive?: boolean; alternativeRowScanning?: boolean; iScansNegatively?: boolean; jScansPositively?: boolean }} grid
 * @param {readonly { index: number }[]} cells
 * @param {readonly (number | null | undefined)[]} uGridArray
 * @param {readonly (number | null | undefined)[]} vGridArray
 * @returns {(number | null)[]}
 */
export function computeNativeGridConvergence(grid, cells, uGridArray, vGridArray) {
  const byGridIJ = new Map();
  for (let idx = 0; idx < cells.length; idx++) {
    const [i, j] = storageCoordinates(grid, cells[idx].index);
    byGridIJ.set(`${i},${j}`, idx);
  }
  const dx = grid.dxM * (grid.iScansNegatively ? -1 : 1);
  const dy = grid.dyM * (grid.jScansPositively ? 1 : -1);
  return cells.map(cell => {
    const [i, j] = storageCoordinates(grid, cell.index);
    const cIdx = byGridIJ.get(`${i},${j}`);
    const eIdx = byGridIJ.get(`${i + 1},${j}`) ?? cIdx;
    const wIdx = byGridIJ.get(`${i - 1},${j}`) ?? cIdx;
    const nIdx = byGridIJ.get(`${i},${j + 1}`) ?? cIdx;
    const sIdx = byGridIJ.get(`${i},${j - 1}`) ?? cIdx;
    const spanX = (eIdx !== cIdx ? 1 : 0) + (wIdx !== cIdx ? 1 : 0);
    const spanY = (nIdx !== cIdx ? 1 : 0) + (sIdx !== cIdx ? 1 : 0);
    if (!spanX || !spanY) return null;
    const uE = uGridArray[eIdx], uW = uGridArray[wIdx];
    const vN = vGridArray[nIdx], vS = vGridArray[sIdx];
    if (![uE, uW, vN, vS].every(finite)) return null;
    const dudx = (/** @type {number} */ (uE) - /** @type {number} */ (uW)) / (spanX * dx);
    const dvdy = (/** @type {number} */ (vN) - /** @type {number} */ (vS)) / (spanY * dy);
    const convergencePerSec = -(dudx + dvdy);
    const rounded = round2(convergencePerSec * 1e5);
    return rounded === 0 ? 0 : rounded;
  });
}
