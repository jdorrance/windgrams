import { SkewTChart } from '../lib/skewt-chart.ts';
import type { Finding, Tone } from '../lib/skewt.ts';
import { choices as balloonChoices, readChoice, type Choice, type RaobDocument } from '../lib/balloon.ts';
import { parseSrg, type Srg } from '../lib/srg.ts';
import { formatQuantity } from '../lib/units.ts';

const TONE_ICON: Record<Tone, string> = { good: '✓', neutral: '•', caution: '!', warning: '⚠' };

export function renderFindingsList(list: HTMLElement, findings: Finding[]): void {
  list.replaceChildren();
  for (const f of findings) {
    const li = document.createElement('li');
    li.className = `finding finding-${f.tone}`;
    const icon = document.createElement('span');
    icon.className = 'finding-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = TONE_ICON[f.tone];
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = f.title;
    const p = document.createElement('p');
    p.textContent = f.text;
    body.append(title, p);
    li.append(icon, body);
    list.appendChild(li);
  }
}

function legendItem(label: string, swatchClass: string, inlineColor?: string) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.className = swatchClass;
  if (inlineColor) span.style.color = inlineColor;
  li.append(span, document.createTextNode(label));
  return li;
}

function createTabButton(label: string, sub: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  const small = document.createElement('small');
  small.textContent = sub;
  b.appendChild(small);
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', onClick);
  return b;
}

export interface BalloonSectionOptions {
  launchName: string;
  timeZone: string;
  getLaunchElevationM: () => number | null;
}

export function createBalloonSection(options: BalloonSectionOptions) {
  const { launchName, timeZone: tz, getLaunchElevationM } = options;
  let balloonChart: SkewTChart | null = null;
  let refreshCurrent: (() => void) | null = null;
  let disposed = false;

  function render(doc: RaobDocument | null, srgText: string | null) {
    if (disposed) return;
    let srg: Srg | null = null;
    try {
      srg = srgText ? parseSrg(srgText) : null;
    } catch {
      srg = null;
    }
    const list = balloonChoices(doc, srg, tz);
    const root = document.getElementById('balloon')!;
    if (list.length === 0) {
      refreshCurrent = null;
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const station = doc?.station;
    document.getElementById('balloon-title')!.textContent = `Weather balloon sounding · ${station?.name ?? 'nearest station'}${station ? ` (${station.id})` : ''}`;
    const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', timeZoneName: 'short', timeZone: tz });
    const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: tz });
    const tabs = document.getElementById('balloon-tabs')!;

    const show = (choice: Choice) => {
      if (disposed) return;
      refreshCurrent = () => show(choice);
      const launchElevationM = getLaunchElevationM();
      for (const b of tabs.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.dataset.id === choice.id));
      }
      if (!balloonChart) {
        balloonChart = new SkewTChart(document.getElementById('balloon-chart')!, { name: launchName, elevationM: launchElevationM });
      }
      balloonChart.set(choice.sounding, { name: launchName, elevationM: launchElevationM });
      const reading = readChoice(choice, srg, launchElevationM, tz);
      document.getElementById('balloon-headline')!.textContent = reading.headline;
      renderFindingsList(document.getElementById('balloon-findings')!, reading.findings);
      const legend = document.getElementById('balloon-legend')!;
      legend.replaceChildren(
        legendItem('Temperature', 'key-line', 'var(--series-2)'),
        ...(choice.hasDewPoint ? [legendItem('Dew point', 'key-line', 'var(--series-3)')] : []),
        legendItem(choice.start.source === 'forecast-high' ? 'Thermal from the forecast high' : 'Rising thermal', 'key-line key-dash'),
        legendItem('Thermal zone', 'key-swatch skewt-key-zone'),
        legendItem('Inversion (lid)', 'key-swatch skewt-key-lid'),
      );
      const when = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone: tz,
      }).format(new Date(choice.validAt));
      const utc = new Date(choice.validAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      const elevation = choice.sounding.modelElevationM;
      document.getElementById('balloon-meta')!.textContent =
        choice.kind === 'balloon' ? `Sounding valid ${when} · ${utc}` : `NWS model forecast for ${when}`;
      document.getElementById('balloon-note')!.textContent =
        choice.kind === 'balloon'
          ? `${station ? `${station.name} · ${formatQuantity(station.distanceKm, 'distance')} from ${launchName} · ` : ''}${formatQuantity(elevation, 'elevation')} MSL.${choice.hasDewPoint ? '' : ' Humidity unavailable.'}${choice.start.source === 'forecast-high' ? ' The rising parcel starts at the forecast high for the station.' : ''} NWS / Iowa Environmental Mesonet.`
          : 'NWS model temperature and wind at the station, with heights above sea level (MSL). Humidity is unavailable.';
    };

    tabs.replaceChildren(
      ...list.map(choice => {
        const b = createTabButton(
          choice.kind === 'balloon' ? dayFmt.format(new Date(choice.validAt)) : hourFmt.format(new Date(choice.validAt)),
          choice.kind === 'balloon' ? 'balloon' : 'NWS model',
          () => show(choice),
        );
        b.dataset.id = choice.id;
        return b;
      }),
    );
    show(list.findLast(choice => choice.kind === 'balloon') ?? list[list.length - 1]);
  }

  return {
    render,
    refresh() {
      refreshCurrent?.();
    },
    dispose() {
      disposed = true;
      refreshCurrent = null;
    },
  };
}
