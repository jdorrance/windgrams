import { nearestGridpoint } from '@azohra/meteo.grib';
import { selectGridCells } from '@windgrams/providers/noaa';
export { projection, storageIndex, storageCoordinates, wind } from '@windgrams/providers/noaa';

export function regionalGrid(grid, c) {
  const cells = selectGridCells(grid, { bounds: c.bbox });
  const nearest = nearestGridpoint(grid, c.site.latitude, c.site.longitude);
  const siteCell = cells.findIndex(cell => cell.index === nearest.index);
  if (siteCell < 0 || nearest.distanceKm > 5) throw new Error('Blanchard is outside the replay grid or >5 km from its sample');
  return { cells, siteCell, nearest };
}
