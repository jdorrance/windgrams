import type { QuantityKind } from './units.ts';

export type NotePart = { text: string } | { kind: QuantityKind; value: number };

/** Catalogue prose keeps editable units; rendering converts each measurement. */
export function launchNoteParts(note: string): NotePart[] {
  const parts: NotePart[] = [];
  const measurements = /\b(\d[\d,]*(?:\.\d+)?)\s*(ft|mi|mph|m)\b/g;
  let end = 0;
  for (const match of note.matchAll(measurements)) {
    if (match.index > end) parts.push({ text: note.slice(end, match.index) });
    const value = Number(match[1].replaceAll(',', ''));
    const unit = match[2];
    parts.push(unit === 'mph' ? { kind: 'wind', value: value * .44704 }
      : unit === 'mi' ? { kind: 'distance', value: value * 1.609344 }
      : { kind: 'elevation', value: value * (unit === 'ft' ? .3048 : 1) });
    end = match.index + match[0].length;
  }
  if (end < note.length) parts.push({ text: note.slice(end) });
  return parts;
}
