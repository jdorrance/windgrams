import { z } from 'zod';

export const finite = z.number().finite();
export const text = z.string().min(1);
export const index = finite.int().nonnegative();
export const timestamp = text.refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
export const timezone = text.refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid time zone');
export const latitude = finite.min(-90).max(90);
export const longitude = finite.min(-180).max(180);
export const bbox = z.tuple([longitude, latitude, longitude, latitude]);
export const relativeFile = text.regex(/^[a-zA-Z0-9._/-]+$/)
  .refine(value => value.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid bundle path');

/** Check without replacing the caller's objects, native arrays or extra metadata. */
export function checked<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | null {
  return schema.safeParse(value).success ? value as z.output<S> : null;
}
