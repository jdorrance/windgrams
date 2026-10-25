import type { ModelCatalogue, SiteForecast } from '@azohra/meteo.briefing/contract';
import { EcmwfChart, type EcmwfSiteDocument } from '../lib/ecmwf-chart.ts';
import { NwsChart, type NwsHour } from '../lib/nws-chart.ts';
import { compassPoint, type DirectionArc, type Launch } from '../lib/launches.ts';
import { finiteScalar, formatQuantity, relativeTime } from '../lib/units.ts';
import type { CloudSeries } from './sunlight.ts';

export interface NwsSiteDocument {
  updateTime: string | null;
  generatedAt: string;
  grid: { office: string; x: number; y: number; elevationM: number | null };
  pageUrl: string;
  hours: NwsHour[];
  periods: { name: string; startTime: string; isDaytime: boolean; shortForecast: string; detailedForecast: string }[];
}

export interface NwsOfficeDocument {
  office: string;
  products: {
    afd: { issuanceTime: string; text: string } | null;
    srg: { issuanceTime: string; text: string } | null;
  };
}

export interface NwsEcmwfControllerOptions {
  launch: Launch;
  arc: DirectionArc | null;
  timeZone: string;
  nwsEnabled: boolean;
  inDay: (validAt: string, dateKey: string) => boolean;
}

export function createNwsEcmwfSections(options: NwsEcmwfControllerOptions) {
  const { launch, arc, timeZone: tz, nwsEnabled, inDay } = options;
  let nwsChart: NwsChart | null = null;
  let ecmwfChart: EcmwfChart | null = null;
  let disposed = false;

  const chartLaunch = () => ({
    windMinMph: launch.windMinMph,
    windMaxMph: launch.windMaxMph,
    gustMaxMph: launch.gustMaxMph,
    window: arc,
    windowLabel: arc ? `${compassPoint(launch.facingDeg!)} ±${launch.windArcHalfWidthDeg}°` : 'unknown',
  });

  function renderNws(nws: NwsSiteDocument | null, day: string) {
    if (disposed || !nwsEnabled) return;
    const meta = document.getElementById('nws-meta')!;
    const link = document.getElementById('nws-link') as HTMLAnchorElement;
    const chartsHost = document.getElementById('nws-charts')!;
    if (!nws) {
      meta.textContent = '';
      link.hidden = true;
      const p = document.createElement('p');
      p.className = 'chart-status';
      p.textContent = 'NWS forecast unavailable.';
      chartsHost.replaceChildren(p);
      return;
    }
    meta.textContent = `Grid ${nws.grid.office} ${nws.grid.x},${nws.grid.y}${
      nws.grid.elevationM != null ? ` (grid elevation ${formatQuantity(nws.grid.elevationM, 'elevation')})` : ''
    } · updated ${nws.updateTime ? relativeTime(nws.updateTime) : '–'}`;
    link.href = nws.pageUrl;
    link.hidden = false;
    if (!nwsChart) {
      nwsChart = new NwsChart(chartsHost, chartLaunch(), tz);
    }
    nwsChart.setHours(nws.hours.filter(h => inDay(h.validAt, day)));
  }

  function renderEcmwf(ecmwf: EcmwfSiteDocument | null, day: string) {
    if (disposed) return;
    const meta = document.getElementById('ecmwf-meta')!;
    const chartsHost = document.getElementById('ecmwf-charts')!;
    if (!ecmwf) {
      meta.textContent = '';
      const p = document.createElement('p');
      p.className = 'chart-status';
      p.textContent = 'ECMWF forecast unavailable.';
      chartsHost.replaceChildren(p);
      return;
    }
    const run = ecmwf.models.surface.run ? `Run ${String(new Date(ecmwf.models.surface.run).getUTCHours()).padStart(2, '0')}Z · ` : '';
    const grid = ecmwf.site.gridElevationM != null ? ` · grid point at ${formatQuantity(ecmwf.site.gridElevationM, 'elevation')}` : '';
    meta.textContent = `IFS ${formatQuantity(9, 'resolution')} · ${run}fetched ${relativeTime(ecmwf.generatedAt)}${grid}`;
    if (!ecmwfChart) ecmwfChart = new EcmwfChart(chartsHost, chartLaunch(), tz);
    ecmwfChart.setHours(ecmwf.hours.filter(h => inDay(h.validAt, day)));
  }

  function renderText(nws: NwsSiteDocument | null, office: NwsOfficeDocument | null) {
    if (disposed) return;
    const list = document.getElementById('nws-periods')!;
    list.replaceChildren();
    for (const period of nws?.periods ?? []) {
      const li = document.createElement('li');
      const h = document.createElement('h3');
      h.textContent = period.name;
      const p = document.createElement('p');
      p.textContent = period.detailedForecast;
      li.append(h, p);
      list.appendChild(li);
    }
    if (!nws?.periods.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Text forecast unavailable.';
      list.appendChild(li);
    }

    const products = document.getElementById('nws-products')!;
    products.replaceChildren();
    const add = (label: string, product: { issuanceTime: string; text: string } | null | undefined) => {
      if (!product) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${label} · issued ${relativeTime(product.issuanceTime)}`;
      const pre = document.createElement('pre');
      pre.className = 'product';
      pre.textContent = product.text;
      details.append(summary, pre);
      products.appendChild(details);
    };
    add('Soaring Forecast', office?.products.srg);
    add(`Area Forecast Discussion (NWS ${office?.office ?? ''})`, office?.products.afd);
  }

  return { renderNws, renderEcmwf, renderText, dispose() { disposed = true; nwsChart?.dispose(); ecmwfChart?.dispose(); } };
}

/** The selected model's total cloud cover (ensemble median), for dimming the sunlight map. */
export function buildCloudSeriesForSunlight(
  slug: string | null,
  loaded: { profile: SiteForecast } | null | undefined,
  entry: ModelCatalogue['models'][number] | null,
  labelText: string,
): CloudSeries | null {
  if (!slug || !loaded) return null;
  const points: CloudSeries['points'] = [];
  for (const hour of loaded.profile.hours) {
    const percent = finiteScalar(hour.surface.cloudCoverPercent);
    if (percent != null) points.push({ ms: Date.parse(hour.validAt), fraction: percent / 100 });
  }
  return points.length
    ? { label: `${labelText}${entry ? ` ${formatQuantity(entry.gridKm, 'resolution')}` : ''}`, points }
    : null;
}
