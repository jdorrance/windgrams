/** Own the selected point request, native time axis and cached windgram/sounding presentation. */
import type { AvRegionalDataset, AvSite } from '@windgrams/data-client/av';
import type { PublishedSiteForecast } from '@windgrams/contracts/published-lift';
import { localDateKey } from '@azohra/meteo.briefing/derive';
import { localTime } from '../lib/soaring.ts';
import { formatQuantity } from '../lib/units.ts';
import { windgramDayHours } from '../lib/windgram-view.ts';
import { buildSounding, readSounding } from '../lib/skewt.ts';
import { SkewTChart } from '../lib/skewt-chart.ts';
import { createWindgramController } from './windgram-controller.ts';
import type { createPageLifecycle } from './page-lifecycle.ts';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => {
  const node = el(id);
  if (node) node.textContent = text;
};
export function createAvPointView(options: {
  dataset: AvRegionalDataset;
  initialSite: AvSite;
  initialTime?:string;
  lifetime: ReturnType<typeof createPageLifecycle>;
  mapTime: () => string;
  selectMapTime: (time: string) => boolean;
  onPoint: (site: AvSite) => void;
  launchElevation: (site: AvSite) => number | null;
}) {
  const { dataset, lifetime } = options,
    events = { signal: lifetime.signal };
  let site = options.initialSite,
    validAt = options.initialTime??options.mapTime(),
    profile: PublishedSiteForecast | null = null,
    request: AbortController | null = null,
    token = 0,
    full = false;
  const chart = new SkewTChart(el('replay-sounding'), {
    name: site.name,
    elevationM: options.launchElevation(site),
  });
  const windgram = createWindgramController({
    host: el('replay-windgram'),
    axisHost: el('replay-height-axis'),
    keyHost: el('windgram-key'),
    fullProfileButton: el('windgram-full-profile'),
  });
  const select = document.createElement('select'),
    label = document.createElement('label');
  label.textContent = 'Point forecast ';
  label.append(select);
  el('windgram-subtitle').after(label);
  for (const frame of dataset.build.manifest.frames) {
    const option = document.createElement('option');
    option.value = frame.validTime;
    option.textContent = localTime(frame.validTime, site.timeZone);
    select.append(option);
  }
  function chooseTime(time: string) {
    validAt = time;
    if (!options.selectMapTime(time)) render();
  }
  select.addEventListener('change', () => chooseTime(select.value), events);
  el('windgram-full-profile').addEventListener(
    'click',
    () => {
      full = !full;
      render();
    },
    events,
  );
  lifetime.onDispose(() => {
    request?.abort();
    chart.dispose();
    windgram.dispose();
  });
  async function choose(next: AvSite) {
    if (lifetime.disposed) return;
    site = next;
    profile = null;
    options.onPoint(site);
    request?.abort();
    request = new AbortController();
    const current = ++token;
    set('cell-title', site.name);
    windgram.clear();
    set('replay-windgram', 'Loading native profile…');
    chart.set(null);
    el('cell-values').replaceChildren();
    set('cell-location', `Requested ${site.lat}, ${site.lon}`);
    try {
      const loaded = await dataset.loadPublishedProfile(site, request.signal);
      if (lifetime.disposed || current !== token) return;
      profile = loaded;
      render();
    } catch (error) {
      if (lifetime.disposed || current !== token) return;
      set('replay-windgram', error instanceof Error ? error.message : 'Profile unavailable');
    }
  }
  function render() {
    if (!profile || lifetime.disposed) return;
    const hour = profile.hours.find((hour) => hour.validAt === validAt);
    if (!hour) return;
    const elevation = options.launchElevation(site);
    select.value = validAt;
    set('cell-title', site.name);
    set(
      'cell-location',
      `Requested ${site.lat.toFixed(5)}, ${site.lon.toFixed(5)} · Native cell ${profile.site.latitude.toFixed(5)}, ${profile.site.longitude.toFixed(5)} · Model terrain ${formatQuantity(profile.site.modelElevationM, 'elevation')} MSL${elevation === null ? '' : ` · Launch ${formatQuantity(elevation, 'elevation')} MSL`}`,
    );
    const values = el('cell-values');
    values.replaceChildren();
    for (const [label, value, kind] of [
      ['Thermal strength', hour.soaring?.thermalVelocityV2Mps, 'lift'],
      ['Usable lift · 1 m/s', hour.soaring?.usableLiftTopV2M, 'elevation'],
      ['Potential cloud base', hour.soaring?.surfaceLclM, 'elevation'],
    ] as const) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = formatQuantity(typeof value === 'number' ? value : null, kind);
      values.append(dt, dd);
    }
    set(
      'cell-quality',
      [
        ['Cu', hour.soaring?.cumulus],
        ['OD', hour.soaring?.overdeveloped],
        ['capped', hour.soaring?.cloudCapped],
      ]
        .map(([label, value]) => `${label} ${value === true ? 'yes' : value === false ? 'no' : 'unknown'}`)
        .join(' · '),
    );
    set('sounding-valid', localTime(validAt, site.timeZone));
    set(
      'windgram-subtitle',
      `Native V2 · ${localTime(validAt, site.timeZone)} · Map: ${localTime(options.mapTime(), site.timeZone)}`,
    );
    windgram.render({
      cacheKey: `${site.lat},${site.lon}`,
      profile,
      timeZone: site.timeZone,
      hours: windgramDayHours(profile, validAt, site.timeZone),
      dateKey: localDateKey(validAt, site.timeZone),
      selectedValidAt: validAt,
      fullProfile: full,
      idPrefix: 'av',
      launch: elevation === null ? null : { name: site.name, elevationM: elevation },
      onSelectHour: chooseTime,
    });
    const sounding = buildSounding(profile, hour);
    chart.set(sounding, { name: site.name, elevationM: elevation });
    set('sounding-headline', sounding ? readSounding(sounding, elevation).headline : 'Sounding unavailable');
  }
  return {
    select: choose,
    render,
    site: () => site,
    time:()=>validAt,
    setTime(time: string) {
      validAt = time;
      render();
    },
  };
}
