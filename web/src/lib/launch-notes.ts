import type { QuantityKind } from './units.ts';

export type NotePart = { text: string; href?: string } | { kind: QuantityKind; value: number };

function noteLink(raw: string): { text: string; href: string } | null {
  let text = raw.replace(/[.,;:!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1);
  }
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? { text, href: url.href } : null;
  } catch { return null; }
}

/** Plain text, HTTP(S) links and measurements; the page escapes text and attributes. */
export function launchNoteParts(note: string): NotePart[] {
  const parts: NotePart[] = [];
  const tokens = /https?:\/\/[^\s<>"'`]+|\b(\d[\d,]*(?:\.\d+)?)\s*(ft|mi|mph|m)\b/gi;
  let end = 0;
  for (const match of note.matchAll(tokens)) {
    if (match.index > end) parts.push({ text: note.slice(end, match.index) });
    if (match[1]) {
      const value = Number(match[1].replaceAll(',', ''));
      const unit = match[2].toLowerCase();
      parts.push(unit === 'mph' ? { kind: 'wind', value: value * .44704 }
        : unit === 'mi' ? { kind: 'distance', value: value * 1.609344 }
        : { kind: 'elevation', value: value * (unit === 'ft' ? .3048 : 1) });
    } else {
      const link = noteLink(match[0]);
      parts.push(link ?? { text: match[0] });
      if (link && link.text.length < match[0].length) parts.push({ text: match[0].slice(link.text.length) });
    }
    end = match.index + match[0].length;
  }
  if (end < note.length) parts.push({ text: note.slice(end) });
  return parts;
}
