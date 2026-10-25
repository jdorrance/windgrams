export interface CycleCandidate { referenceTime: string; cycleHourUtc: number; elapsedMinutes: number; expectedAvailableAtMinutes: number; probeUrl: string; probeUrls: string[] }
export interface CycleSelection { model: string; evaluatedAt: string; completeRunAvailabilityMinutes: number; primaryCandidate: CycleCandidate | null; fallbackCandidate: CycleCandidate | null }
export type Readiness = { ready: true; model: string; selectedCycle: CycleCandidate; attempts: number; fallback: boolean }
  | { ready: false; model: string; selectedCycle: null; attempts: number };
export interface ReadinessOptions { nowMs?: number; now?: () => number; maxAttempts?: number; retryDelayMs?: number; fetchImpl?: typeof fetch; sleep?: (delay: number) => Promise<void>; env?: Record<string, string | undefined> }
export interface FeedAvailabilitySpec { readonly slug: string; readonly provider: string; readonly cyclesUtc: readonly number[]; readonly horizonHours: number; readonly completeRunAvailabilityMinutes: number; readonly typicalMaxLagMinutes: number; readonly completionProbeTemplate?: string; readonly completionProbeTemplates?: readonly string[] }
