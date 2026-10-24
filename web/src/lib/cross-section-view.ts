// Pure cross-section transect geometry and interactive SVG renderer.

import {
  buildCrossSectionLinePath,
  crossSectionHeightScale,
  type ReplayHour,
} from './soaring.ts';
import type { CrossSectionDoc } from './soaring-contracts.ts';
import { formatQuantity, getUnitSystem, type UnitSystem } from './units.ts';

export interface CrossSectionColumnGeometry {
  cellIndex: number;
  x: number;
  prevX: number;
  colW: number;
  terrainY: number;
  thermalRect: {
    y: number;
    height: number;
    fill: string;
    fillOpacity: number;
  } | null;
  selected: boolean;
}

export interface CrossSectionScene {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotW: number;
  plotH: number;
  ticks: { heightM: number; y: number; label: string }[];
  columns: CrossSectionColumnGeometry[];
  seriesPaths: {
    surfaceLclPath: string;
    thermalTopPath: string;
    usableLiftTopPath: string;
  };
  terrainPolygonPoints: string;
  waypoints: {
    x: number;
    label: string;
    launchDotY: number | null;
  }[];
}

/**
 * Pure geometry builder for a regional transect cross-section at `hour`.
 */
export function buildCrossSectionScene(
  doc: CrossSectionDoc,
  hour: ReplayHour,
  heightScale: ReturnType<typeof crossSectionHeightScale>,
  selectedCell: number,
  system: UnitSystem = getUnitSystem(),
): CrossSectionScene {
  const width = 980, height = 300, left = 56, right = 24, top = 26, bottom = 46;
  const plotW = width - left - right, plotH = height - top - bottom;
  const { maxAltM, ticksM } = heightScale;
  const xOf = (km: number) => left + (km / Math.max(1, doc.totalDistanceKm)) * plotW;
  const yOf = (m: number) => top + plotH - Math.min(1, Math.max(0, m / maxAltM)) * plotH;

  const ticks = ticksM.map(mVal => ({
    heightM: mVal,
    y: yOf(mVal),
    label: formatQuantity(mVal, 'elevation', undefined, system),
  }));

  const nodes = doc.nodes;
  const columns: CrossSectionColumnGeometry[] = nodes.map((n, idx) => {
    const ci = n.cellIndex;
    const x = xOf(n.distanceKm);
    const prevX = idx === 0 ? left : (xOf(nodes[idx - 1].distanceKm) + x) / 2;
    const nextX = idx === nodes.length - 1 ? width - right : (x + xOf(nodes[idx + 1].distanceKm)) / 2;
    const colW = Math.max(6, nextX - prevX);
    const terrM = n.modelElevationM ?? 0;
    const resTop = (hour.resolvedThermalTopM ?? hour.boundaryLayerTopM)[ci];
    const wstar = (hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci] ?? 0;

    const thermalRect =
      resTop != null && resTop > terrM && wstar > 0
        ? {
            y: yOf(resTop),
            height: Math.max(0, yOf(terrM) - yOf(resTop)),
            fill: wstar >= 1.5 ? '#e8bc52' : '#289b9c',
            fillOpacity: Math.min(0.42, 0.12 + wstar * 0.16),
          }
        : null;

    return {
      cellIndex: ci,
      x,
      prevX,
      colW,
      terrainY: yOf(terrM),
      thermalRect,
      selected: ci === selectedCell,
    };
  });

  const surfaceLclPath = buildCrossSectionLinePath(
    nodes,
    nodes.map(n => (hour.surfaceLclM ?? hour.cloudBaseM)[n.cellIndex]),
    xOf,
    yOf,
  );
  const thermalTopPath = buildCrossSectionLinePath(
    nodes,
    nodes.map(n => hour.resolvedThermalTopM?.[n.cellIndex]),
    xOf,
    yOf,
  );
  const usableLiftTopPath = buildCrossSectionLinePath(
    nodes,
    nodes.map(n => (hour.usableLiftTopV2M ?? hour.usableLiftTopM)[n.cellIndex]),
    xOf,
    yOf,
  );

  const terrainPolygonPoints = [
    `${left},${top + plotH}`,
    ...nodes.map(n => `${xOf(n.distanceKm).toFixed(1)},${yOf(n.modelElevationM ?? 0).toFixed(1)}`),
    `${width - right},${top + plotH}`,
  ].join(' ');

  const waypoints = nodes
    .filter(n => Boolean(n.waypointLabel))
    .map(n => ({
      x: xOf(n.distanceKm),
      label: `${n.waypointLabel} (${formatQuantity(n.distanceKm, 'distance', undefined, system)})`,
      launchDotY: n.launchElevationM != null ? yOf(n.launchElevationM) : null,
    }));

  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    plotW,
    plotH,
    ticks,
    columns,
    seriesPaths: {
      surfaceLclPath,
      thermalTopPath,
      usableLiftTopPath,
    },
    terrainPolygonPoints,
    waypoints,
  };
}

/**
 * Renders a `CrossSectionDoc` scene as an interactive SVG element with cell click selection.
 */
export function renderCrossSectionSvg(
  doc: CrossSectionDoc,
  hour: ReplayHour,
  heightScale: ReturnType<typeof crossSectionHeightScale>,
  selectedCell: number,
  onSelectCell: (cellIndex: number) => void,
  system: UnitSystem = getUnitSystem(),
): SVGSVGElement {
  const scene = buildCrossSectionScene(doc, hour, heightScale, selectedCell, system);
  const { width, height, left, right, top, plotH } = scene;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.cssText = 'width:100%;min-width:680px;height:auto;border:1px solid var(--rule);border-radius:6px;background:var(--surface)';

  for (const tick of scene.ticks) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(left));
    line.setAttribute('x2', String(width - right));
    line.setAttribute('y1', String(tick.y));
    line.setAttribute('y2', String(tick.y));
    line.setAttribute('stroke', '#888');
    line.setAttribute('stroke-opacity', '0.2');
    svg.append(line);

    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', String(left - 6));
    lbl.setAttribute('y', String(tick.y + 4));
    lbl.setAttribute('text-anchor', 'end');
    lbl.setAttribute('font-size', '10');
    lbl.setAttribute('fill', 'currentColor');
    lbl.textContent = tick.label;
    svg.append(lbl);
  }

  for (const col of scene.columns) {
    if (col.thermalRect) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(col.prevX));
      rect.setAttribute('y', String(col.thermalRect.y));
      rect.setAttribute('width', String(col.colW));
      rect.setAttribute('height', String(col.thermalRect.height));
      rect.setAttribute('fill', col.thermalRect.fill);
      rect.setAttribute('fill-opacity', String(col.thermalRect.fillOpacity));
      svg.append(rect);
    }

    if (col.selected) {
      const sel = document.createElementNS(ns, 'rect');
      sel.setAttribute('x', String(col.prevX));
      sel.setAttribute('y', String(top));
      sel.setAttribute('width', String(col.colW));
      sel.setAttribute('height', String(plotH));
      sel.setAttribute('fill', '#237e81');
      sel.setAttribute('fill-opacity', '0.12');
      sel.setAttribute('stroke', '#237e81');
      sel.setAttribute('stroke-width', '1.5');
      svg.append(sel);
    }

    const hit = document.createElementNS(ns, 'rect');
    hit.setAttribute('x', String(col.prevX));
    hit.setAttribute('y', String(top));
    hit.setAttribute('width', String(col.colW));
    hit.setAttribute('height', String(plotH));
    hit.setAttribute('fill', 'transparent');
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => onSelectCell(col.cellIndex));
    svg.append(hit);
  }

  const appendPath = (d: string, color: string, dash = '', widthPx = 2) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', String(widthPx));
    if (dash) path.setAttribute('stroke-dasharray', dash);
    path.setAttribute('d', d);
    path.setAttribute('pointer-events', 'none');
    svg.append(path);
  };

  appendPath(scene.seriesPaths.surfaceLclPath, '#7c689c', '5,3', 1.8);
  appendPath(scene.seriesPaths.thermalTopPath, '#237e81', '', 2.4);
  appendPath(scene.seriesPaths.usableLiftTopPath, '#d99b26', '', 2.2);

  const poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('points', scene.terrainPolygonPoints);
  poly.setAttribute('fill', '#4b5563');
  poly.setAttribute('fill-opacity', '0.45');
  poly.setAttribute('stroke', '#374151');
  poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('pointer-events', 'none');
  svg.append(poly);

  for (const wp of scene.waypoints) {
    if (wp.launchDotY != null) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(wp.x));
      dot.setAttribute('cy', String(wp.launchDotY));
      dot.setAttribute('r', '4');
      dot.setAttribute('fill', '#111');
      dot.setAttribute('stroke', '#fff');
      dot.setAttribute('stroke-width', '1.5');
      dot.setAttribute('pointer-events', 'none');
      svg.append(dot);
    }
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(wp.x));
    txt.setAttribute('y', String(height - 16));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-size', '10.5');
    txt.setAttribute('font-weight', '600');
    txt.setAttribute('fill', 'currentColor');
    txt.textContent = wp.label;
    svg.append(txt);
  }

  const leg = document.createElementNS(ns, 'text');
  leg.setAttribute('x', String(left + 6));
  leg.setAttribute('y', '16');
  leg.setAttribute('font-size', '10.5');
  leg.setAttribute('fill', 'currentColor');
  leg.textContent = 'Teal: thermal top · Gold: usable lift top · Purple: potential cloud base · Dots: launches · MSL';
  svg.append(leg);

  return svg;
}
