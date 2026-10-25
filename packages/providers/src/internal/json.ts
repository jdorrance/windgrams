/** External JSON stays unknown until an adapter checks its required fields. */
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Map every own field while retaining the source record's keys and insertion order. */
export function mapRecord<K extends string, T, U>(record: Readonly<Record<K, T>>, map: (key: K, value: T) => U): Record<K, U> {
  return Object.fromEntries((Object.entries(record) as [K, T][]).map(([key, value]) => [key, map(key, value)])) as Record<K, U>;
}
