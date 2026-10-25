import type { ForecastSite, RequestOptions, SparseMetadata, SparseSoaring } from '../supplemental.ts';
export type NwsNumericField = 'temperatureC' | 'dewpointC' | 'relativeHumidityPct' | 'skyCoverPct'
  | 'windDirectionDeg' | 'windSpeedMps' | 'windGustMps' | 'precipitationProbabilityPct' | 'thunderProbabilityPct'
  | 'lightningActivityLevel' | 'mixingHeightM' | 'transportWindDirectionDeg' | 'transportWindSpeedMps' | 'ceilingHeightM' | 'visibilityM';
export type NwsHour = Record<NwsNumericField, number | null> & { validAt: string; weather: string | null; shortForecast: string | null; soaring: SparseSoaring };
export interface NwsPeriod { name: string; startTime: string; endTime: string; isDaytime: boolean; shortForecast: string; detailedForecast: string }
export interface NwsPointResponse { properties: { gridId: string; gridX: number; gridY: number; forecastGridData: string; forecastHourly: string; forecast: string } }
export interface NwsLayer<T> { uom?: string | null; values: { validTime: string; value: T | null }[] }
export interface NwsWeather { coverage?: string | null; intensity?: string | null; weather?: string | null }
export type NwsGridLayer = 'temperature' | 'dewpoint' | 'relativeHumidity' | 'skyCover' | 'windDirection' | 'windSpeed' | 'windGust'
  | 'probabilityOfPrecipitation' | 'probabilityOfThunder' | 'lightningActivityLevel' | 'mixingHeight' | 'transportWindDirection' | 'transportWindSpeed' | 'ceilingHeight' | 'visibility';
export interface NwsGridResponse { properties: Partial<Record<NwsGridLayer, NwsLayer<number>>> & {
  updateTime?: string | null; elevation?: { unitCode: string; value: number | null }; weather?: NwsLayer<NwsWeather[]>;
} }
export interface NwsPeriodsResponse { properties: { updateTime?: string | null; periods: NwsPeriod[] } }
export interface NwsHourlyResponse { properties: { updateTime?: string | null; periods: { startTime: string; shortForecast?: string | null }[] } }
export interface NwsDocument {
  schemaVersion: 1; source: string; generatedAt: string; updateTime: string | null; hourlyUpdateTime: string | null; periodsUpdateTime: string | null;
  soaringMeta: SparseMetadata; site: ForecastSite; grid: { office: string; x: number; y: number; elevationM: number | null };
  pageUrl: string; units: Record<NwsNumericField | 'weather' | 'shortForecast', string>; hours: NwsHour[]; periods: NwsPeriod[];
}
export interface NwsBuildOptions extends RequestOptions { site: ForecastSite; point: { properties: Pick<NwsPointResponse['properties'], 'gridId' | 'gridX' | 'gridY'> }; grid: NwsGridResponse; hourly: NwsHourlyResponse | null; forecast: NwsPeriodsResponse | null }
export interface NwsProduct { id: string; productCode: string; productName: string | null; issuanceTime: string; text: string }
export interface NwsOfficeDocument { schemaVersion: 1; source: string; generatedAt: string; office: string; products: { afd: NwsProduct | null; srg: NwsProduct | null } }
export type NwsSiteStatus = { slug: string; ok: true; office: string; updateTime: string | null } | { slug: string; ok: false; error: string };
export interface NwsOfficeStatus { office: string; afdIssuanceTime: string | null; srgIssuanceTime: string | null }
export interface NwsManifest { schemaVersion: 1; source: string; generatedAt: string; sites: NwsSiteStatus[]; offices: NwsOfficeStatus[] }

