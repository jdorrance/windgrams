/** Static launch and route geography; AV resolves model cells and model terrain at runtime. */
import armenia from '../../../forecasts/soaring/regions/armenia.json';
import northSound from '../../../forecasts/soaring/regions/north-sound.json';
import shenandoah from '../../../forecasts/soaring/regions/shenandoah-blue-ridge.json';
import type { AvModel } from '@windgrams/data-client/av';

type Geography = typeof armenia;
export const AV_REGIONS: {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  primarySite: string;
  models: AvModel[];
  geography: Geography;
}[] = [
  {
    id: 'armenia',
    name: 'Armenia',
    bbox: [43.3, 38.7, 46.8, 41.5],
    primarySite: 'am-hatis-500',
    models: ['icon-eu', 'gfs'],
    geography: armenia,
  },
  {
    id: 'north-sound',
    name: 'North Sound',
    bbox: [-123.5, 47.8, -121.5, 49],
    primarySite: 'wa-blanchard',
    models: ['rrfs', 'gfs'],
    geography: northSound,
  },
  {
    id: 'shenandoah-blue-ridge',
    name: 'Shenandoah / Blue Ridge',
    bbox: [-79.2, 37.7, -77.5, 39.4],
    primarySite: 'va-woodstock',
    models: ['rrfs', 'gfs'],
    geography: shenandoah,
  },
];
