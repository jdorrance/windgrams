import { LAUNCH_COUNTRIES } from '../lib/forecast-capabilities.ts';
import type { MarkerSpec, mountLaunchMap } from './map.ts';

export function mountLaunchCountries(mount: typeof mountLaunchMap) {
  const selector = document.getElementById('launch-country') as HTMLSelectElement;
  const element = document.getElementById('launch-map')!;
  const markers = JSON.parse(document.getElementById('launch-markers')?.textContent ?? '[]') as (MarkerSpec & {country: string})[];
  const valid = (country: string | null): country is string => LAUNCH_COUNTRIES.some(c => c.code === country);
  let saved: string | null = null;
  try { saved = sessionStorage.getItem('windgrams-country'); } catch { /* Storage is optional. */ }
  const requested = new URL(location.href).searchParams.get('country');
  selector.value = valid(requested) ? requested : valid(saved) ? saved : 'US';
  let map: ReturnType<typeof mount> | null = null;
  const show = () => {
    const country = selector.value;
    for (const group of document.querySelectorAll<HTMLElement>('.state-group[data-country]')) group.hidden = group.dataset.country !== country;
    map?.remove();
    map = mount(element, markers.filter(marker => marker.country === country));
    const url = new URL(location.href);
    url.searchParams.set('country', country);
    history.replaceState(null, '', url);
    const soaring = document.getElementById('soaring-nav-link') as HTMLAnchorElement | null;
    if (soaring) { const target = new URL(soaring.href); country === 'AM' ? target.searchParams.set('region', 'armenia') : target.searchParams.delete('region'); soaring.href = target.toString(); }
    try { sessionStorage.setItem('windgrams-country', country); } catch { /* Storage is optional. */ }
  };
  selector.addEventListener('change', show);
  show();
}
