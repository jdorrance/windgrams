import { parseAtmosphericColumn } from '@windgrams/contracts';
import { object } from './json.ts';
import type { IconAcquisition, IconExtract, IconExtractBase, IconExtractRecord, IconFieldMetadata, IconObjectSource, IconSourceObject } from './icon-types.ts';
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const index = (value: unknown): value is number => number(value) && Number.isInteger(value) && value >= 0;
const optional = (value: unknown, guard: (value: unknown) => boolean) => value === undefined || guard(value);
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every(number);
const source = (value: unknown): value is IconObjectSource => object(value) && text(value.url) && number(value.bytes)
  && text(value.sha256) && (value.lastModified === null || text(value.lastModified))
  && (value.range === null || numbers(value.range) && value.range.length === 2);
const metadata = (value: unknown): value is IconFieldMetadata => object(value) && text(value.units) && text(value.stepType)
  && number(value.startHour) && number(value.endHour) && optional(value.packingError, number);
const recordMetadata = (value: unknown): value is Omit<IconExtractRecord, 'values'> & Record<string, unknown> => object(value) && text(value.field)
  && number(value.hour) && (value.level === null || number(value.level)) && metadata(value.metadata) && source(value.source);
const sourceObject = (value: unknown): value is IconSourceObject => source(value) && metadata(value) && object(value)
  && text(value.field) && number(value.forecastHour) && (value.modelLevel === null || number(value.modelLevel));
const mapping = (value: unknown, guard: (value: unknown) => boolean) => object(value) && Object.values(value).every(guard);

function base(value: unknown): value is Omit<IconExtractBase, 'forecastHours'> & Record<string, unknown> {
  if (!object(value) || value.model !== 'icon-eu' || !timestamp(value.referenceTime) || !object(value.grid)
    || !Array.isArray(value.cells) || !object(value.siteCells) || !mapping(value.siteCells, number) || !numbers(value.levels) || !object(value.provenance)) return false;
  const g = value.grid, p = value.provenance;
  if (g.type !== 'icon-native-triangular' || !text(g.uuid) || !number(g.number) || !number(g.pointCount) || !object(g.geometrySource)
    || !['url', 'uuid', 'registrySha256', 'headerSha256'].every(key => text(g.geometrySource && object(g.geometrySource) ? g.geometrySource[key] : undefined))
    || !optional(g.geometrySource.records, records => Array.isArray(records) && records.every(source))
    || !optional(g.coordinateSources, value => mapping(value, source))) return false;
  if (!value.cells.every(cell => object(cell) && text(cell.id) && ['index', 'cellIndex', 'terrainM', 'latitude', 'longitude'].every(key => number(cell[key]))
    && Array.isArray(cell.corners) && cell.corners.every(corner => numbers(corner) && corner.length === 2))) return false;
  const cellCount = value.cells.length;
  if (!Object.values(value.siteCells).every(cell => index(cell) && cell < cellCount)) return false;
  return p.provider === 'DWD' && ['accessProduct', 'attribution', 'capturedAt'].every(key => text(p[key]))
    && number(p.downloadedBytes) && number(p.elapsedSeconds) && optional(p.downloads, number) && optional(p.retries, number)
    && optional(p.fixtureDescription, text) && object(p.decoder) && text(p.decoder.eccodes) && text(p.decoder.numpy);
}

/** The local decoder boundary is validated before numeric normalization. */
export function parseIconRecord(raw: unknown, expectedCellCount?: number): IconExtractRecord {
  if (!recordMetadata(raw) || !object(raw) || !Array.isArray(raw.values) || !raw.values.every(value => value === null || number(value))
    || expectedCellCount !== undefined && raw.values.length !== expectedCellCount) throw new Error('Invalid ICON field record');
  return raw as unknown as IconExtractRecord;
}
export function parseIconExtract(raw: unknown): IconExtract {
  if (!base(raw) || !object(raw) || !numbers(raw.forecastHours)) throw new Error('Invalid ICON extract metadata');
  if (raw.records !== undefined) {
    if (!object(raw.records)) throw new Error('Invalid ICON extract records');
    for (const record of Object.values(raw.records)) parseIconRecord(record, raw.cells.length);
  } else if (!mapping(raw.recordManifest, recordMetadata) || !mapping(raw.recordFiles, text)) throw new Error('Invalid ICON extract record manifest');
  return raw as unknown as IconExtract;
}
export function parseIconHour(raw: unknown, context?: { referenceTime: string; cellCount: number }): IconAcquisition['hours'][number] {
  if (!object(raw) || !index(raw.forecastHour) || !timestamp(raw.validAt) || !Array.isArray(raw.sources)
    || !raw.sources.every(column => column === null || parseAtmosphericColumn(column)
      && object(column) && timestamp(column.validAt) && Date.parse(column.validAt) === Date.parse(String(raw.validAt)))) throw new Error('Invalid ICON acquisition hour');
  if (context && (raw.sources.length !== context.cellCount
    || Date.parse(raw.validAt) !== Date.parse(context.referenceTime) + raw.forecastHour * 3_600_000)) throw new Error('ICON hour differs from its acquisition manifest');
  return raw as unknown as IconAcquisition['hours'][number];
}
function acquisitionBase(raw: unknown): raw is Omit<IconAcquisition, 'hours'> & Record<string, unknown> {
  return base(raw) && object(raw.provenance) && Array.isArray(raw.provenance.sourceObjects) && raw.provenance.sourceObjects.every(sourceObject);
}
export function parseIconAcquisition(raw: unknown): IconAcquisition {
  if (!acquisitionBase(raw) || !object(raw) || !Array.isArray(raw.hours) || !raw.hours.length) throw new Error('Invalid ICON acquisition');
  const hours = raw.hours.map(hour => parseIconHour(hour, { referenceTime: raw.referenceTime, cellCount: raw.cells.length }));
  if (hours.some((hour, i) => i > 0 && hour.forecastHour <= hours[i - 1].forecastHour)) throw new Error('ICON acquisition hours must be unique and increasing');
  return raw as unknown as IconAcquisition;
}
interface IconArchive extends Omit<IconAcquisition, 'hours'> {
  acquisitionFormat: 'icon-hours-v1';
  hourFiles: { forecastHour: number; validAt: string; file: string; sha256: string }[];
}
export function parseIconArchive(raw: unknown): IconArchive {
  if (!acquisitionBase(raw) || !object(raw) || raw.acquisitionFormat !== 'icon-hours-v1' || !Array.isArray(raw.hourFiles) || !raw.hourFiles.length
    || !raw.hourFiles.every(hour => object(hour) && index(hour.forecastHour) && timestamp(hour.validAt) && ['file', 'sha256'].every(key => text(hour[key]))
      && Date.parse(hour.validAt) === Date.parse(raw.referenceTime) + hour.forecastHour * 3_600_000)) throw new Error('Invalid ICON acquisition manifest');
  const hourFiles = raw.hourFiles;
  if (hourFiles.some((hour, i) => i > 0 && object(hour) && object(hourFiles[i - 1])
    && Number(hour.forecastHour) <= Number(hourFiles[i - 1].forecastHour))) throw new Error('ICON acquisition hours must be unique and increasing');
  return raw as unknown as IconArchive;
}
