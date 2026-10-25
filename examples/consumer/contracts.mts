// Compile-time examples of accepted API calls and expected type errors.
import type { SiteForecast } from '@windgrams/contracts';
import type { Position } from '@windgrams/geography';
import { buildWindgramView, readWindgram, type WindgramOptions, type WindgramView } from '@windgrams/windgram/scene';
import { createForecastClient } from '@windgrams/data-client';
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
