// Pure comparison view-models and safe DOM table builders for regional launch
// and multi-model forecast comparisons.
//
// Converts all externally supplied names and metadata into literal text nodes
// (never interpolated into innerHTML), preserves V2 vs legacy v1 ensemble
// diagnostic family distinction, and matches p10-p90 spread bands to their center value.

import { compassPoint } from './launches.ts';
import { displayMetric, type ReplayHour } from './soaring.ts';
import type {
  LaunchEntry,
  LaunchModelHour,
  MatchedRaobPair,
  PercentileSpread,
} from './soaring-contracts.ts';
import { finiteScalar, formatQuantity, getUnitSystem, type QuantityKind, type UnitSystem } from './units.ts';

/** Regional readouts keep known speed even when direction is unavailable. */
export function formatRegionalWind(speed: number | null | undefined, direction: number | null | undefined,
  { bearing = false, system = getUnitSystem() }: { bearing?: boolean; system?: UnitSystem } = {}): string | null {
  const speedMps = finiteScalar(speed), directionDeg = finiteScalar(direction);
  if (speedMps === null || speedMps < 0) return null;
  if (speedMps === 0) return 'Calm';
  const label = directionDeg === null ? 'Direction unavailable ·'
    : `${compassPoint(directionDeg)}${bearing ? ` (${directionDeg.toFixed(0)}°) @` : ''}`;
  return `${label} ${formatQuantity(speedMps, 'wind', undefined, system)}`;
}

export const MULTIMODEL_DISPLAY_ORDER: readonly (readonly [string, string])[] = [
  ['icon-eu', 'ICON-EU'],
  ['hrrr-conus', 'HRRR'],
  ['rrfs', 'RRFS'],
  ['hrdps-continental', 'HRDPS'],
  ['rdps', 'RDPS'],
  ['gdps', 'GDPS'],
  ['gfs', 'GFS'],
  ['geps', 'GEPS median'],
  ['ecmwf', 'ECMWF'],
  ['nws', 'NWS'],
] as const;

export type DiagnosticFamily = 'v2' | 'v1-legacy' | 'unsupported' | 'unavailable';

export interface ComparisonDiagnosticCell {
  family: DiagnosticFamily;
  value: number | null;
  quantity: QuantityKind;
  primaryText: string;
  spreadText: string | null;
  suffixText: string | null;
  title: string | null;
  muted: boolean;
}

export interface MultimodelComparisonRow {
  modelSlug: string;
  modelLabel: string;
  runLabel: string;
  modelElevationText: string;
  tempDewText: string;
  windText: string;
  wstar: ComparisonDiagnosticCell;
  usableLiftTop: ComparisonDiagnosticCell;
  thermalTop: ComparisonDiagnosticCell;
  cloudSegments: {
    text: string;
    spreadText: string | null;
  }[];
  cloudCoverSuffix: string | null;
}

export interface RegionalLaunchRow {
  slug: string;
  name: string;
  cellIndex: number;
  selected: boolean;
  elevationPairText: string;
  simpleReadings: [string, string, string, string];
  detailCells: {
    wstarText: string;
    usableLiftTopText: string;
    wxtoflyTopText: string;
    resolvedTopText: string;
    /** True when the top is not a measured height (stable-by-evidence or unavailable); rendered muted. */
    resolvedTopMuted: boolean;
    v1TopText: string;
    pblDepthText: string;
    lclText: string;
    cuOdText: string;
    surfaceWindText: string;
    blWindShearText: string;
    convergenceText: string;
  };
}

const formatElev = (m: number | null | undefined, system: UnitSystem) =>
  formatQuantity(m, 'elevation', undefined, system);

const formatSpread = (
  spread: PercentileSpread | null | undefined,
  kind: 'lift' | 'elevation',
  system: UnitSystem,
): string | null =>
  spread && spread.p10 != null && spread.p90 != null && Number.isFinite(spread.p10) && Number.isFinite(spread.p90)
    ? `(${formatQuantity(spread.p10, kind, undefined, system)}–${formatQuantity(spread.p90, kind, undefined, system)})`
    : null;

/**
 * Pure view-model builder for a single model's comparison row at `validAt`.
 */
export function buildMultimodelComparisonRow(
  modelSlug: string,
  modelLabel: string,
  referenceTime: string | null | undefined,
  modelElevationM: number | null | undefined,
  mh: LaunchModelHour,
  system: UnitSystem = getUnitSystem(),
): MultimodelComparisonRow {
  const isSparseAdapter = modelSlug === 'ecmwf' || modelSlug === 'nws';
  const isLegacyOnlyEnsemble =
    modelSlug === 'geps' &&
    mh.wstarV2Mps == null &&
    mh.usableLiftTopV2M == null &&
    mh.resolvedThermalTopM == null;

  const hasExplicitV2 = Object.hasOwn(mh, 'wstarV2Mps') || Object.hasOwn(mh, 'usableLiftTopV2M') || Object.hasOwn(mh, 'resolvedThermalTopM');
  const wstarVal = isSparseAdapter ? null : (hasExplicitV2 ? (mh.wstarV2Mps ?? null) : (isLegacyOnlyEnsemble ? null : (mh.wstarMps ?? null)));
  const uTopVal = isSparseAdapter ? null : (hasExplicitV2 ? (mh.usableLiftTopV2M ?? null) : (isLegacyOnlyEnsemble ? null : (mh.usableLiftTopM ?? null)));
  const blTopVal = isSparseAdapter ? (mh.blTopM ?? null) : (hasExplicitV2 ? (mh.resolvedThermalTopM ?? null) : (isLegacyOnlyEnsemble ? null : (mh.blTopM ?? null)));
  const surfaceLclVal = Object.hasOwn(mh, 'surfaceLclM') ? (mh.surfaceLclM ?? null) : (isSparseAdapter ? (mh.cloudBaseM ?? null) : null);
  const effCloudLimitVal = isSparseAdapter ? null : (Object.hasOwn(mh, 'effectiveCloudLimitM') ? (mh.effectiveCloudLimitM ?? null) : (mh.cloudBaseM ?? null));

  let wstar: ComparisonDiagnosticCell;
  if (isSparseAdapter) {
    wstar = {
      family: 'unsupported',
      value: null,
      quantity: 'lift',
      primaryText: 'Unavailable',
      spreadText: null,
      suffixText: null,
      title: 'Surface forecast · thermal profile unavailable',
      muted: true,
    };
  } else if (wstarVal != null && Number.isFinite(wstarVal)) {
    wstar = {
      family: 'v2',
      value: wstarVal,
      quantity: 'lift',
      primaryText: formatQuantity(wstarVal, 'lift', undefined, system),
      spreadText: formatSpread(mh.wstarSpreadMps, 'lift', system),
      suffixText: null,
      title: null,
      muted: false,
    };
  } else if (isLegacyOnlyEnsemble && mh.wstarMps != null && Number.isFinite(mh.wstarMps)) {
    wstar = {
      family: 'v1-legacy',
      value: mh.wstarMps,
      quantity: 'lift',
      primaryText: `v1: ${formatQuantity(mh.wstarMps, 'lift', undefined, system)}`,
      spreadText: formatSpread(mh.wstarLegacySpreadMps, 'lift', system),
      suffixText: null,
      title: 'Earlier ensemble estimate (v1); the current method is unavailable.',
      muted: true,
    };
  } else {
    wstar = {
      family: 'unavailable',
      value: null,
      quantity: 'lift',
      primaryText: '–',
      spreadText: null,
      suffixText: null,
      title: null,
      muted: false,
    };
  }

  let usableLiftTop: ComparisonDiagnosticCell;
  if (isSparseAdapter) {
    usableLiftTop = {
      family: 'unsupported',
      value: null,
      quantity: 'elevation',
      primaryText: 'Unavailable',
      spreadText: null,
      suffixText: null,
      title: 'Surface forecast · thermal profile unavailable',
      muted: true,
    };
  } else if (uTopVal != null && Number.isFinite(uTopVal)) {
    usableLiftTop = {
      family: 'v2',
      value: uTopVal,
      quantity: 'elevation',
      primaryText: formatElev(uTopVal, system),
      spreadText: formatSpread(mh.usableLiftSpreadM, 'elevation', system),
      suffixText: null,
      title: null,
      muted: false,
    };
  } else if (isLegacyOnlyEnsemble && mh.usableLiftTopM != null && Number.isFinite(mh.usableLiftTopM)) {
    usableLiftTop = {
      family: 'v1-legacy',
      value: mh.usableLiftTopM,
      quantity: 'elevation',
      primaryText: `v1: ${formatElev(mh.usableLiftTopM, system)}`,
      spreadText: formatSpread(mh.usableLiftLegacySpreadM, 'elevation', system),
      suffixText: null,
      title: 'Earlier ensemble estimate (v1); the current method is unavailable.',
      muted: true,
    };
  } else {
    usableLiftTop = {
      family: 'unavailable',
      value: null,
      quantity: 'elevation',
      primaryText: '–',
      spreadText: null,
      suffixText: null,
      title: null,
      muted: false,
    };
  }

  let thermalTop: ComparisonDiagnosticCell;
  if (blTopVal != null && Number.isFinite(blTopVal)) {
    thermalTop = {
      family: 'v2',
      value: blTopVal,
      quantity: 'elevation',
      primaryText: formatElev(blTopVal, system),
      spreadText: formatSpread(mh.thermalTopSpreadM, 'elevation', system),
      suffixText: mh.pblHeightM != null && Number.isFinite(mh.pblHeightM)
        ? ` (${formatQuantity(mh.pblHeightM, 'elevation', undefined, system)} AGL)`
        : null,
      title: null,
      muted: false,
    };
  } else if (isLegacyOnlyEnsemble && mh.blTopM != null && Number.isFinite(mh.blTopM)) {
    thermalTop = {
      family: 'v1-legacy',
      value: mh.blTopM,
      quantity: 'elevation',
      primaryText: `v1: ${formatElev(mh.blTopM, system)}`,
      spreadText: formatSpread(mh.blTopLegacySpreadM, 'elevation', system),
      suffixText: null,
      title: 'Earlier ensemble parcel top (v1); the current method is unavailable.',
      muted: true,
    };
  } else {
    thermalTop = {
      family: 'unavailable',
      value: null,
      quantity: 'elevation',
      primaryText: '–',
      spreadText: null,
      suffixText: null,
      title: null,
      muted: false,
    };
  }

  const cloudSegments: { text: string; spreadText: string | null }[] = [];
  if (surfaceLclVal != null && Number.isFinite(surfaceLclVal)) {
    cloudSegments.push({ text: `LCL ${formatElev(surfaceLclVal, system)}`, spreadText: null });
  }
  if (
    effCloudLimitVal != null &&
    Number.isFinite(effCloudLimitVal) &&
    (surfaceLclVal == null || Math.abs(effCloudLimitVal - surfaceLclVal) > 1)
  ) {
    cloudSegments.push({
      text: `${isLegacyOnlyEnsemble ? 'v1 ' : ''}limit ${formatElev(effCloudLimitVal, system)}`,
      spreadText: formatSpread(mh.cloudLimitSpreadM, 'elevation', system),
    });
  }

  const runLabel =
    referenceTime && referenceTime.length >= 16
      ? `${referenceTime.slice(5, 16).replace('T', ' ')}Z`
      : '–';
  const modelElevationText =
    modelElevationM != null && Number.isFinite(modelElevationM)
      ? formatQuantity(modelElevationM, 'elevation', undefined, system)
      : '–';
  const tempDewText =
    (mh.tempC != null && Number.isFinite(mh.tempC) ? formatQuantity(mh.tempC, 'temperature', 1, system) : '–') +
    (mh.dewPointC != null && Number.isFinite(mh.dewPointC) ? ` / ${formatQuantity(mh.dewPointC, 'temperature', 1, system)}` : '');
  const windText =
    (formatRegionalWind(mh.windSpeedMps, mh.windDirectionDeg, { system }) ?? '–') +
    (mh.windGustMps != null && Number.isFinite(mh.windGustMps) ? ` (g ${formatQuantity(mh.windGustMps, 'wind', undefined, system)})` : '');

  return {
    modelSlug,
    modelLabel,
    runLabel,
    modelElevationText,
    tempDewText,
    windText,
    wstar,
    usableLiftTop,
    thermalTop,
    cloudSegments,
    cloudCoverSuffix: mh.cloudCoverPct != null && Number.isFinite(mh.cloudCoverPct) ? ` (${Math.round(mh.cloudCoverPct)}%)` : null,
  };
}

/**
 * Builds all matching model comparison rows for a launch at `validAt`.
 */
export function buildLaunchComparisonRows(
  launch: LaunchEntry,
  validAt: string,
  system: UnitSystem = getUnitSystem(),
): MultimodelComparisonRow[] {
  const rows: MultimodelComparisonRow[] = [];
  for (const [mslug, mlabel] of MULTIMODEL_DISPLAY_ORDER) {
    const mdata = launch.models[mslug];
    if (!mdata) continue;
    const mh = mdata.hours.find(h => h.validAt === validAt);
    if (!mh) continue;
    rows.push(buildMultimodelComparisonRow(mslug, mlabel, mdata.referenceTime, mdata.modelElevationM, mh, system));
  }
  return rows;
}

/**
 * Builds pure row models for the regional launches summary and detailed tables.
 */
export function buildRegionalLaunchTableRows(
  launches: readonly LaunchEntry[],
  hour: ReplayHour,
  selectedCell: number,
  system: UnitSystem = getUnitSystem(),
): RegionalLaunchRow[] {
  return launches.map(l => {
    const ci = l.cellIndex;
    const wstar = (hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci];
    const uTop = (hour.usableLiftTopV2M ?? hour.usableLiftTopM)[ci];
    const wxTop = hour.hcritWxtoflyM?.[ci];
    const rTop = hour.resolvedThermalTopM?.[ci];
    const v1Top = hour.boundaryLayerTopM[ci];
    const hpbl = hour.pblHeightM[ci];
    const lcl = (hour.surfaceLclM ?? hour.cloudBaseM)[ci];
    const cu = hour.cuPotentialM?.[ci];
    const od = hour.odPotentialM?.[ci];
    const ws = hour.wind10mSpeedMps?.[ci];
    const wd = hour.wind10mDirDeg?.[ci];
    const blw = hour.blMeanWindSpeedMps?.[ci];
    const bls = hour.blWindShearMps?.[ci];
    const conv = hour.convergence10mX1e5?.[ci];

    const launchElevText = l.launchElevationM != null ? formatElev(l.launchElevationM, system) : '–';
    const modelElevText = l.modelElevationM != null ? formatElev(l.modelElevationM, system) : '–';
    const surfaceWind = formatRegionalWind(ws, wd, { system });

    return {
      slug: l.slug,
      name: l.name,
      cellIndex: ci,
      selected: ci === selectedCell,
      elevationPairText: `(${launchElevText} / ${modelElevText})`,
      simpleReadings: [
        displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci], 'thermalVelocityV2Mps', hour.status[ci], system),
        displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[ci], 'usableLiftTopV2M', hour.status[ci], system),
        formatElev(lcl, system),
        surfaceWind ?? 'Unavailable',
      ],
      detailCells: {
        wstarText: wstar != null ? formatQuantity(wstar, 'lift', undefined, system) : '–',
        usableLiftTopText: formatElev(uTop, system),
        wxtoflyTopText: formatElev(wxTop, system),
        // A null top means the parcel depth was unavailable, not stable: parcel-depth
        // returns 0 (non-convective) for stability and null for missing inputs, and
        // diagnostics collapses both to a null top. Claim "Stable" only when a valid
        // hour's thermal velocity is exactly zero; otherwise name the limitation.
        resolvedTopText: rTop != null ? formatElev(rTop, system)
          : hour.status[ci] === 'valid' && wstar === 0 ? 'Stable'
          : hour.status[ci] === 'insufficient-levels' ? 'Insufficient vertical coverage'
          : 'Unavailable',
        resolvedTopMuted: rTop == null,
        v1TopText: formatElev(v1Top, system),
        pblDepthText: hpbl != null ? formatElev(hpbl, system) : '–',
        lclText: formatElev(lcl, system),
        cuOdText: `${cu != null ? `${cu >= 0 ? '+' : ''}${formatElev(cu, system)}` : '–'} / ${od != null ? `${od >= 0 ? '+' : ''}${formatElev(od, system)}` : '–'}`,
        surfaceWindText: surfaceWind ?? '–',
        blWindShearText: `${blw != null ? formatQuantity(blw, 'wind', undefined, system) : '–'} / ${bls != null ? formatQuantity(bls, 'wind', undefined, system) : '–'}`,
        convergenceText: conv != null ? `${conv >= 0 ? '+' : ''}${conv.toFixed(0)}` : '–',
      },
    };
  });
}

function appendDiagnosticCell(tr: HTMLTableRowElement, cell: ComparisonDiagnosticCell, doc: Document) {
  const td = doc.createElement('td');
  if (cell.muted) {
    const span = doc.createElement('span');
    span.className = 'muted';
    if (cell.title) span.title = cell.title;
    span.append(doc.createTextNode(cell.primaryText));
    if (cell.spreadText) {
      span.append(doc.createTextNode(' '));
      const spreadSpan = doc.createElement('span');
      spreadSpan.className = 'muted';
      spreadSpan.title = 'Ensemble p10–p90 range';
      spreadSpan.textContent = cell.spreadText;
      span.append(spreadSpan);
    }
    td.append(span);
  } else {
    td.append(doc.createTextNode(cell.primaryText));
    if (cell.spreadText) {
      td.append(doc.createTextNode(' '));
      const spreadSpan = doc.createElement('span');
      spreadSpan.className = 'muted';
      spreadSpan.title = 'Ensemble p10–p90 range';
      spreadSpan.textContent = cell.spreadText;
      td.append(spreadSpan);
    }
    if (cell.suffixText) {
      td.append(doc.createTextNode(cell.suffixText));
    }
  }
  tr.append(td);
}

/**
 * Safely renders `MultimodelComparisonRow[]` into `tbody` using text nodes only.
 */
export function renderMultimodelComparisonBody(
  tbody: HTMLElement,
  rows: readonly MultimodelComparisonRow[],
) {
  const doc = tbody.ownerDocument;
  tbody.replaceChildren();
  for (const row of rows) {
    const tr = doc.createElement('tr');

    const modelTd = doc.createElement('td');
    const strong = doc.createElement('strong');
    strong.textContent = row.modelLabel;
    modelTd.append(strong);
    tr.append(modelTd);

    for (const textValue of [row.runLabel, row.modelElevationText, row.tempDewText, row.windText]) {
      const td = doc.createElement('td');
      td.textContent = textValue;
      tr.append(td);
    }

    appendDiagnosticCell(tr, row.wstar, doc);
    appendDiagnosticCell(tr, row.usableLiftTop, doc);
    appendDiagnosticCell(tr, row.thermalTop, doc);

    const cloudTd = doc.createElement('td');
    if (row.cloudSegments.length === 0) {
      cloudTd.append(doc.createTextNode('–'));
    } else {
      row.cloudSegments.forEach((seg, idx) => {
        if (idx > 0) cloudTd.append(doc.createTextNode(' · '));
        cloudTd.append(doc.createTextNode(seg.text));
        if (seg.spreadText) {
          cloudTd.append(doc.createTextNode(' '));
          const spreadSpan = doc.createElement('span');
          spreadSpan.className = 'muted';
          spreadSpan.title = 'Ensemble p10–p90 range';
          spreadSpan.textContent = seg.spreadText;
          cloudTd.append(spreadSpan);
        }
      });
    }
    if (row.cloudCoverSuffix) {
      cloudTd.append(doc.createTextNode(row.cloudCoverSuffix));
    }
    tr.append(cloudTd);
    tbody.append(tr);
  }
}

/**
 * Safely renders regional launch comparison rows into both the summary and detailed tables.
 */
export function renderRegionalLaunchesTables(
  simpleBody: HTMLElement,
  detailBody: HTMLElement | null,
  rows: readonly RegionalLaunchRow[],
  onSelectLaunch: (cellIndex: number, slug: string) => void,
) {
  const doc = simpleBody.ownerDocument;
  simpleBody.replaceChildren();
  detailBody?.replaceChildren();

  for (const row of rows) {
    if (detailBody) {
      const detailTr = doc.createElement('tr');
      if (row.selected) detailTr.className = 'is-selected';

      const nameTd = doc.createElement('td');
      const strong = doc.createElement('strong');
      strong.textContent = row.name;
      const elevSpan = doc.createElement('span');
      elevSpan.className = 'muted';
      elevSpan.textContent = row.elevationPairText;
      nameTd.append(strong, doc.createTextNode(' '), elevSpan);
      detailTr.append(nameTd);

      const d = row.detailCells;
      const appendTextTd = (val: string) => {
        const td = doc.createElement('td');
        td.textContent = val;
        detailTr.append(td);
      };
      appendTextTd(d.wstarText);
      appendTextTd(d.usableLiftTopText);
      appendTextTd(d.wxtoflyTopText);

      const rTopTd = doc.createElement('td');
      if (d.resolvedTopMuted) {
        const muted = doc.createElement('span');
        muted.className = 'muted';
        muted.textContent = d.resolvedTopText;
        rTopTd.append(muted);
      } else {
        rTopTd.textContent = d.resolvedTopText;
      }
      detailTr.append(rTopTd);

      appendTextTd(d.v1TopText);
      appendTextTd(d.pblDepthText);
      appendTextTd(d.lclText);
      appendTextTd(d.cuOdText);
      appendTextTd(d.surfaceWindText);
      appendTextTd(d.blWindShearText);
      appendTextTd(d.convergenceText);

      detailTr.addEventListener('click', () => onSelectLaunch(row.cellIndex, row.slug));
      detailBody.append(detailTr);
    }

    const simpleRow = doc.createElement('tr');
    if (row.selected) simpleRow.className = 'is-selected';
    const launchCell = doc.createElement('td');
    const launchButton = doc.createElement('button');
    launchButton.type = 'button';
    launchButton.className = 'launch-link';
    launchButton.textContent = row.name;
    launchButton.addEventListener('click', () => onSelectLaunch(row.cellIndex, row.slug));
    launchCell.append(launchButton);
    simpleRow.append(launchCell);

    for (const reading of row.simpleReadings) {
      const td = doc.createElement('td');
      td.textContent = reading;
      simpleRow.append(td);
    }
    simpleRow.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('button')) onSelectLaunch(row.cellIndex, row.slug);
    });
    simpleBody.append(simpleRow);
  }
}

/**
 * Safely renders matched RAOB verification pairs into `tbody` using text nodes only.
 */
export function renderRaobVerificationTable(
  tbody: HTMLElement,
  pairs: readonly MatchedRaobPair[],
  system: UnitSystem = getUnitSystem(),
) {
  const doc = tbody.ownerDocument;
  tbody.replaceChildren();
  for (const pair of pairs) {
    const tr = doc.createElement('tr');

    const stationTd = doc.createElement('td');
    const strong = doc.createElement('strong');
    strong.textContent = `${pair.station.id} \u2192 ${pair.siteName}`;
    const distSpan = doc.createElement('span');
    distSpan.className = 'muted';
    distSpan.textContent = `(${formatQuantity(pair.station.distanceKm, 'distance', undefined, system)})`;
    stationTd.append(strong, doc.createTextNode(' '), distSpan);
    tr.append(stationTd);

    const modelTd = doc.createElement('td');
    const code = doc.createElement('code');
    code.textContent = pair.model;
    modelTd.append(code);
    tr.append(modelTd);

    const regimeTd = doc.createElement('td');
    regimeTd.textContent = `${pair.regime} (${pair.leadTimeBucket})`;
    tr.append(regimeTd);

    const tempTd = doc.createElement('td');
    const biasPrefix = pair.metrics.temperatureBiasC != null && pair.metrics.temperatureBiasC >= 0 ? '+' : '';
    tempTd.textContent = `${formatQuantity(pair.metrics.temperatureMaeC, 'temperatureDelta', 2, system)} (${biasPrefix}${formatQuantity(pair.metrics.temperatureBiasC, 'temperatureDelta', 2, system)})`;
    tr.append(tempTd);

    const dewTd = doc.createElement('td');
    dewTd.textContent = formatQuantity(pair.metrics.dewPointMaeC, 'temperatureDelta', 2, system);
    tr.append(dewTd);

    const windTd = doc.createElement('td');
    windTd.textContent = formatQuantity(pair.metrics.windVectorRmseMps, 'wind', 2, system);
    tr.append(windTd);

    tbody.append(tr);
  }
}
