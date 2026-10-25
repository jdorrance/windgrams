/** Refresh attempts are separate from the initialization and age of a forecast. */
export type ProviderRefreshOutcome = 'running' | 'updated' | 'retained' | 'unavailable';
export interface ProviderRefresh {
  /** Lifecycle timestamps are ISO UTC; null means unfinished or no known success. */
  attemptedAt: string;
  completedAt: string | null;
  lastSuccessfulRefreshAt: string | null;
  outcome: ProviderRefreshOutcome;
  /** Operator diagnostics, not user-facing display text. */
  reason: string | null;
}
export interface ProviderHealth {
  schemaVersion: 1;
  group: string;
  models: Record<string, ProviderRefresh>;
}
export interface ProviderHealthOwnership {
  group: string;
  models: readonly string[];
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const outcome = (value: unknown): value is ProviderRefreshOutcome => ['running', 'updated', 'retained', 'unavailable'].some(item => item === value);

/** Null rejects malformed lifecycle data or models outside the caller's provider inventory. */
export function parseProviderHealth(raw: unknown, ownership: ProviderHealthOwnership): ProviderHealth | null {
  if (!object(raw) || raw.schemaVersion !== 1 || raw.group !== ownership.group || !object(raw.models)) return null;
  const parsed: Record<string, ProviderRefresh> = {};
  for (const [model, entry] of Object.entries(raw.models)) {
    if (!ownership.models.includes(model) || !object(entry) || !instant(entry.attemptedAt) || !outcome(entry.outcome)
      || !(entry.reason === null || typeof entry.reason === 'string' && entry.reason.length <= 1000)
      || !(entry.completedAt === null || instant(entry.completedAt))
      || !(entry.lastSuccessfulRefreshAt === null || instant(entry.lastSuccessfulRefreshAt))) return null;
    if ((entry.outcome === 'running') !== (entry.completedAt === null)
      || entry.completedAt !== null && Date.parse(entry.completedAt) < Date.parse(entry.attemptedAt)
      || entry.lastSuccessfulRefreshAt !== null && Date.parse(entry.lastSuccessfulRefreshAt) > Date.parse(entry.completedAt ?? entry.attemptedAt)
      || entry.outcome === 'updated' && entry.lastSuccessfulRefreshAt !== entry.completedAt) return null;
    parsed[model] = { attemptedAt: entry.attemptedAt, completedAt: entry.completedAt, lastSuccessfulRefreshAt: entry.lastSuccessfulRefreshAt,
      outcome: entry.outcome, reason: entry.reason };
  }
  return { schemaVersion: 1, group: ownership.group, models: parsed };
}
