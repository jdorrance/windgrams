import { z } from 'zod';
import { finite, index } from './schema.js';

const bracket = z.tuple([finite, finite])
  .refine(([lower, upper]) => lower <= upper, 'Bracket must be ordered').nullable();
/** Native upper-air geometry; no surface or synthesized nodes are counted. */
const sampling = z.object({
  firstLevelAglM: finite.positive().nullable(),
  levelsInLowest1000M: index,
  /** Full native interval intersecting the lowest kilometre, including its upper bounding node. */
  maxGapInLowest1000M: finite.positive().nullable(),
});
export const verticalResolutionSchema = z.object({
  nativeLevelCount: index,
  /** Legacy name: count admitted to diagnostics, strictly above 20 m AGL. */
  aboveGroundLevelCount: index,
  isSparseProfile: z.boolean(),
  hasSub925Levels: z.boolean(),
  hasUpperAirAbove600Levels: z.boolean(),
  has80mWind: z.boolean(),
  synthesizedLevels: z.literal(0),
  sampling: z.object({ temperature: sampling, moisture: sampling, wind: sampling }).optional(),
}).refine(value => value.aboveGroundLevelCount <= value.nativeLevelCount, 'Above-ground count exceeds native count');
const thermalDepth = z.object({
  branch: z.enum(['unavailable', 'non-convective', 'model-pbl-fallback', 'heat-flux-fallback', 'parcel-crossing', 'profile-top']),
  bracketMslM: bracket,
  topLimited: z.boolean(),
}).refine(value => value.topLimited === (value.branch === 'profile-top'), 'Profile-top branch and limit flag must agree');
export const diagnosticSupportSchema = z.object({
  thermalDepth,
  cloudLimit: z.object({ source: z.enum(['baseline-cloud-base', 'surface-lcl', 'unavailable']) }),
  surfacePressure: z.object({ source: z.enum(['model', 'hypsometric']), valueHpa: finite.positive().nullable() }),
});
export type VerticalSampling = z.infer<typeof sampling>;
export type VerticalResolution = z.infer<typeof verticalResolutionSchema>;
export type ThermalDepthSupport = z.infer<typeof thermalDepth>;
export type DiagnosticSupport = z.infer<typeof diagnosticSupportSchema>;
