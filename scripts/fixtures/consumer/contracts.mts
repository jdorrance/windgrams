// Compile-time checks against installed package declarations.
import type { SiteForecast } from '@windgrams/contracts';
import { fieldDefinition, heightAboveGround, type FieldValue } from '@windgrams/contracts/fields';
import type { ReplayHour } from '@windgrams/contracts/regional';
import type { Position } from '@windgrams/geography';
import { buildWindgramView, readWindgram, type WindgramOptions, type WindgramView } from '@windgrams/windgram/scene';
import { createForecastClient } from '@windgrams/data-client';
import { openRegionalDataset, type RegionalSampleRequest } from '@windgrams/data-client/dataset';
import { createSnapshotRepository, type SnapshotObjectStore } from '@windgrams/data-client/offline';
import { createBrowserSnapshotStore } from '@windgrams/data-client/offline-browser';
import { modelDescriptor } from '@windgrams/providers/registry';
import { createLegacyAdapter, type ProcessedProfileResult } from '@windgrams/providers';

type LegacyResult = Awaited<ReturnType<ReturnType<typeof createLegacyAdapter>['acquire']>>;
declare const legacy: LegacyResult;
const legacyPackage: '@azohra/meteo.forecast' = legacy.derivation.package;
const legacyVersion: '0.6.0' = legacy.derivation.version;
const customDerivation: ProcessedProfileResult['derivation'] = { package: '@example/provider', version: '1.0.0' };
// @ts-expect-error The legacy bridge retains its exact pinned implementation identity.
const invalidLegacy: LegacyResult['derivation'] = customDerivation;
void [legacyPackage, legacyVersion, invalidLegacy];

declare const profile: SiteForecast;
const position: Position = { latitude: 40.6, longitude: 44.5 };
const options: WindgramOptions = { timeZone: 'Asia/Yerevan', unitSystem: 'metric', widthPx: 356 };
const scene = buildWindgramView(profile, options);
const elevationM: number = readWindgram(scene, 0, 3000).heightM;
const client = createForecastClient({ baseUrl: 'https://data.example/weather' });
const count: Promise<number | null> = client.readJson('count.json', raw => typeof raw === 'number' ? raw : null);
void [position, elevationM, count];
// @ts-expect-error Unvalidated regional JSON cannot become a caller-selected domain type.
const assertedRegion: Promise<{ cells: number[] }> = client.readRegional('region.json');
// @ts-expect-error A caller cannot change the shared provider registry.
modelDescriptor('gfs').horizonHours = 10;

// @ts-expect-error Position uses latitude and longitude.
const hostPosition: Position = { lat: 40.6, lon: 44.5 };
// @ts-expect-error unitSystem accepts 'metric' or 'imperial'.
buildWindgramView(profile, { ...options, unitSystem: 'knots' });
// @ts-expect-error Scene geometry is private to the renderer.
scene.sampling;
declare const hostFields: Pick<WindgramView, Extract<keyof WindgramView, string>>;
// @ts-expect-error Create a scene with buildWindgramView.
const fabricatedScene: WindgramView = hostFields;
// @ts-expect-error Internal source paths are outside the package contract.
await import('@windgrams/windgram/dist/windgram-geometry.js');
// @ts-expect-error This package has no /compat entry.
await import('@windgrams/windgram/compat');
void [hostPosition, fabricatedScene, assertedRegion];

declare const hour: ReplayHour;
const request: RegionalSampleRequest = { position, validAt: hour.validAt, fields: ['usableLiftTopM'] };
const dataset = await openRegionalDataset({ baseUrl: '/data', caseId: 'test-region' });
const sample = await dataset.sample(request);
const value: FieldValue | undefined = sample.values.usableLiftTopM;
const definition = fieldDefinition('usableLiftTopM');
const height = heightAboveGround(2500, 'EGM96', {
  kind: 'terrain', elevationM: 1600, verticalDatum: 'EGM96', source: 'test-dem',
});
// @ts-expect-error Regional queries accept published fields only.
dataset.sample({ ...request, fields: ['windyLayer'] });
// @ts-expect-error Height conversion requires a compatible ground datum.
heightAboveGround(2500, 'EGM96', { kind: 'terrain', elevationM: 1600, source: 'test-dem' });
declare const store: SnapshotObjectStore;
const saved = await createSnapshotRepository({ store }).open('flight');
const browserStore: SnapshotObjectStore & { close(): Promise<void> } = createBrowserSnapshotStore('test');
void [value, definition, height, saved, browserStore];
