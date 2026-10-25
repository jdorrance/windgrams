import { coversPoint } from '@windgrams/geography';
import type { Position, Bounds } from '@windgrams/geography';
export type { Bounds } from '@windgrams/geography';
import type { SourceCapabilities } from '@windgrams/contracts';
import { parseModelCatalogue } from '@azohra/meteo.briefing/contract';
import type { ModelEntry, ModelCatalogue } from '@azohra/meteo.briefing/contract';
import upstreamCatalogue from './catalogue-0.6.0.json' with { type: 'json' };
import forecastSchedules from './forecast-hours-0.6.0.json' with { type: 'json' };

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
function immutable<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

export const ICON_MODEL: Immutable<ModelEntry> = immutable({
  slug: 'icon-eu', label: 'ICON-EU', provider: 'DWD', gridKm: 6.5, stepHours: 1, horizonHours: 78,
  runIntervalHours: 6, typicalPublicationLagHours: 4, kind: 'deterministic', experimental: true,
  capabilities: { levels: true, pressureLevels: [], verticalVelocity: false, heatFluxes: true,
    gust: 'hourMax', precipitation: 'windowMeanRate', cape: true, cin: true, pblHeight: true,
    cloudLayers: true, cloudProfile: false, smoke: false },
});

export type ProductKind = 'processed-profile' | 'normalized-columns';
export interface SiteLocation extends Position { slug: string; name?: string; timeZone?: string }
export interface ModelDescriptor {
  readonly producer: string; readonly deliverySource: string; readonly sourceProducts: readonly string[]; readonly sourceCapabilities: Immutable<SourceCapabilities>;
  readonly catalogue: Immutable<ModelEntry>;
  readonly forecastHours: readonly number[];
  readonly publication: { readonly attribution: string; readonly license: string | null; readonly permission: 'operator-policy-required'; readonly termsUrl: string | null };
  readonly id: string; readonly provider: string; readonly jobGroup: string; readonly product: ProductKind;
  readonly coverage: Bounds | 'global'; readonly nativeGrid: boolean; readonly ensemble: boolean;
  readonly cyclesUtc: readonly number[]; readonly horizonHours: number; readonly expectedLagMinutes: number;
  readonly terrainRequired: boolean;
}
const sixHourly = [0, 6, 12, 18] as const;
const conus = [-126, 21, -60, 53] as const;
const canada = [-170, 20, -40, 85] as const;
type ModelConfiguration = Omit<ModelDescriptor, 'producer' | 'deliverySource' | 'sourceProducts' | 'sourceCapabilities' | 'catalogue' | 'publication' | 'forecastHours'>;
const configurations: readonly ModelConfiguration[] = [
  { id: 'hrrr-conus', provider: 'NOAA', jobGroup: 'noaa-cloud', product: 'processed-profile', coverage: conus, nativeGrid: true, ensemble: false, cyclesUtc: sixHourly, horizonHours: 48, expectedLagMinutes: 107, terrainRequired: true },
  { id: 'gfs', provider: 'NOAA', jobGroup: 'noaa-cloud', product: 'processed-profile', coverage: 'global', nativeGrid: false, ensemble: false, cyclesUtc: sixHourly, horizonHours: 384, expectedLagMinutes: 315, terrainRequired: true },
  { id: 'rrfs', provider: 'NOAA', jobGroup: 'rrfs', product: 'processed-profile', coverage: conus, nativeGrid: true, ensemble: false, cyclesUtc: sixHourly, horizonHours: 84, expectedLagMinutes: 185, terrainRequired: true },
  { id: 'icon-eu', provider: 'DWD', jobGroup: 'dwd', product: 'normalized-columns', coverage: [-23.5, 29.5, 62.5, 70.5], nativeGrid: true, ensemble: false, cyclesUtc: sixHourly, horizonHours: 78, expectedLagMinutes: 240, terrainRequired: true },
  { id: 'hrdps-continental', provider: 'ECCC', jobGroup: 'eccc', product: 'processed-profile', coverage: canada, nativeGrid: false, ensemble: false, cyclesUtc: sixHourly, horizonHours: 48, expectedLagMinutes: 250, terrainRequired: true },
  { id: 'rdps', provider: 'ECCC', jobGroup: 'eccc', product: 'processed-profile', coverage: canada, nativeGrid: false, ensemble: false, cyclesUtc: sixHourly, horizonHours: 84, expectedLagMinutes: 220, terrainRequired: true },
  { id: 'gdps', provider: 'ECCC', jobGroup: 'eccc', product: 'processed-profile', coverage: 'global', nativeGrid: false, ensemble: false, cyclesUtc: [0, 12], horizonHours: 240, expectedLagMinutes: 345, terrainRequired: true },
  { id: 'geps', provider: 'ECCC', jobGroup: 'eccc', product: 'processed-profile', coverage: 'global', nativeGrid: false, ensemble: true, cyclesUtc: [0, 12], horizonHours: 384, expectedLagMinutes: 375, terrainRequired: true },
];
const delivery = {
  'hrrr-conus': ['NOAA Open Data on AWS', 'hrrr/conus/wrfprs'],
  gfs: ['NOAA Open Data on AWS', 'gfs/atmos/pgrb2.0p25'],
  rrfs: ['NOAA operational RRFS Open Data on AWS', 'rrfs/prslev.3km.conus', 'rrfs/2dfld.3km.conus'],
  'icon-eu': ['DWD Open Data', 'icon-eu/native-model-levels'],
  'hrdps-continental': ['ECCC MSC Datamart', 'model_hrdps/continental/2.5km'],
  rdps: ['ECCC MSC Datamart', 'model_rdps/10km'],
  gdps: ['ECCC MSC Datamart', 'model_gdps/15km'],
  geps: ['ECCC MSC Datamart', 'ensemble/geps/grib2/raw'],
} satisfies Record<string, string[]>;
function checkedCatalogue(): ModelCatalogue {
  const catalogue = parseModelCatalogue({ ...upstreamCatalogue, models: [...upstreamCatalogue.models, ICON_MODEL] });
  if (!catalogue) throw new Error('Packaged model catalogue does not match the pinned contract');
  return catalogue;
}
export const PACKAGED_MODEL_CATALOGUE: Immutable<ModelCatalogue> = immutable(checkedCatalogue());
export const MODELS: readonly ModelDescriptor[] = immutable(configurations.map(config => {
  const catalogue = PACKAGED_MODEL_CATALOGUE.models.find(model => model.slug === config.id);
  if (!catalogue) throw new Error(`Missing model catalogue entry: ${config.id}`);
  const capabilities = catalogue.capabilities;
  const available = (value: unknown) => value === false || value === undefined ? 'unsupported' as const : 'available' as const;
  const [deliverySource, ...sourceProducts] = delivery[config.id as keyof typeof delivery];
  return { ...config, producer: config.provider, deliverySource, sourceProducts, catalogue,
    forecastHours: forecastSchedules[config.id as keyof typeof forecastSchedules],
    sourceCapabilities: { verticalCoordinates: config.id === 'icon-eu' ? 'model-levels' as const : 'pressure-levels' as const,
      ensemble: config.ensemble ? 'percentiles' as const : 'deterministic' as const,
      fields: Object.fromEntries(['levels', 'verticalVelocity', 'heatFluxes', 'gust', 'precipitation', 'cape', 'cin', 'pblHeight', 'cloudLayers', 'cloudProfile', 'smoke'].map(key => [key, available(capabilities[key as keyof typeof capabilities])])) },
    publication: { attribution: config.provider === 'ECCC' ? 'Environment and Climate Change Canada' : config.provider,
      license: config.provider === 'DWD' ? 'CC BY 4.0' : null,
      permission: 'operator-policy-required' as const,
      termsUrl: config.provider === 'DWD' ? 'https://opendata.dwd.de/' : config.provider === 'ECCC' ? 'https://dd.weather.gc.ca/' : null },
  };
}));
/** Report whether the model supplies every requested field; unlisted fields are unknown. */
export function diagnosticCapability(id: string, requiredFields: readonly string[]): 'available' | 'unsupported' | 'unknown' {
  const fields = modelDescriptor(id).sourceCapabilities.fields;
  if (requiredFields.some(field => fields[field] === 'unsupported')) return 'unsupported';
  return requiredFields.every(field => fields[field] === 'available') ? 'available' : 'unknown';
}
export function modelDescriptor(id: string): ModelDescriptor {
  const model = MODELS.find(model => model.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}
export function selectModels(capabilities: { nativeGrid?: boolean; ensemble?: boolean; jobGroup?: string; product?: ProductKind } = {}): ModelDescriptor[] {
  return MODELS.filter(model => Object.entries(capabilities).every(([key, value]) => model[key as keyof ModelDescriptor] === value));
}
export function modelCoversSite(id: string, site: Pick<SiteLocation, 'latitude' | 'longitude'>): boolean {
  // The retained western HRDPS helper is not a scheduled publication product.
  const bounds = id === 'hrdps-west' ? canada : modelDescriptor(id).coverage;
  return coversPoint(bounds === 'global' ? { kind: 'global' } : { kind: 'bounds', bounds }, site);
}
export const PROVIDER_GROUPS: Readonly<Record<string, readonly string[]>> = immutable(Object.fromEntries(
  [...new Set(MODELS.map(model => model.jobGroup))].map(group => [group, MODELS.filter(model => model.jobGroup === group).map(model => model.id)]),
));
