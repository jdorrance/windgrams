// Interactive Windgram readout and pointer/keyboard inspector controller.

import { componentsToWind } from "@azohra/meteo.briefing/derive";
import {
  celsiusToFahrenheit,
  legacyMpsToKnots,
} from "./windgram-format.ts";
import { sampleHeight } from "./windgram-sampling.ts";
import type { WindgramView } from "./windgram-view.ts";

import type { WindgramReading } from './scene-types.ts';
export type { WindgramReading } from './scene-types.ts';

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  const index = clamp(Math.round(hourIndex), 0, view.hours.length - 1);
  const sample = view.sampling[index];
  const z = clamp(heightM, view.floorM, view.topM);
  const t = sample ? sampleHeight(sample.temperatureC, z) : null;
  const u = sample ? sampleHeight(sample.windU, z) : null, v = sample ? sampleHeight(sample.windV, z) : null;
  const wind = u !== null && v !== null ? componentsToWind(u, v) : null;
  const cloud = view.clouds.find(
    (c) => c.hourIndex === index && (c.kind === "potential" ? Math.abs(z - c.baseM) < 25 : z >= c.baseM && z <= c.topM),
  );
  return {
    hourIndex: index,
    validAt: view.hours[index]?.validAt ?? "",
    heightM: z,
    heightAglM: z - view.ground.elevationM,
    temperatureF: t === null ? null : celsiusToFahrenheit(t),
    speedKt: wind === null ? null : legacyMpsToKnots(wind.speedMps),
    directionDeg: wind?.directionDeg ?? null,
    interpolated: !sample?.temperatureC.some((n) => Math.abs(n.altitudeM - z) < 5),
    gustKt: view.hours[index]?.gustKt ?? null,
    cloud: cloud?.kind ?? null,
  };
}

