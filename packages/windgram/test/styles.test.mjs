import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_STYLESHEET } from '@azohra/meteo.briefing/meteogram';
import { buildWindgramView } from '@windgrams/windgram/scene';
import * as portable from '@windgrams/windgram/svg';
import * as external from '@windgrams/windgram/svg/external';
import { WINDGRAM_PRESENTATION } from '../dist/windgram-presentation.js';
import { WINDGRAM_STABILITY } from '../dist/windgram-stability.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const chartCss = read('../src/styles/windgram.css');
const diagnosticsCss = DEFAULT_STYLESHEET + read('../src/styles/diagnostics.css');
const profile = JSON.parse(gunzipSync(readFileSync(new URL('../../../web/test/fixtures/windgram-visual/dog-gfs.json.gz', import.meta.url))));
const view = buildWindgramView(profile, { unitSystem: 'metric', timeZone: 'America/Los_Angeles', widthPx: 356, compact: true });

test('external and self-contained SVG share geometry and one canonical stylesheet', () => {
  assert.equal(read('../dist/generated/styles.css'), `${chartCss}\n${diagnosticsCss}\n`);
  for (const method of ['renderWindgramSvg', 'renderWindgramHeightAxisSvg', 'renderWindgramDiagnosticsSvg']) {
    const embedded = portable[method](view, { idPrefix: 'same' });
    const detached = external[method](view, { idPrefix: 'same' });
    assert.equal(detached, embedded.replace(/<style>[\s\S]*?<\/style>/, ''));
    assert.equal(embedded.match(/<style>([\s\S]*?)<\/style>/)[1], method === 'renderWindgramDiagnosticsSvg' ? diagnosticsCss : chartCss);
    assert.doesNotMatch(detached, /<style>/);
  }
});

test('chart text carries a dark halo legible on every stability fill', () => {
  const rule = selector => chartCss.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]+)\\}'))?.[1] ?? '';
  const text = rule('.windgram text');
  assert.match(text, /paint-order: stroke;/);
  assert.match(text, /stroke: #1a142e;/);
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  assert.ok(contrast('#ffffff', '#1a142e') >= 4.5, 'label fill against its halo');
  for (const { className, color } of WINDGRAM_STABILITY) {
    assert.ok(contrast('#1a142e', color) >= 4.5, `halo against ${className} fill ${color}: ${contrast('#1a142e', color).toFixed(2)}:1`);
  }
});

test('canonical CSS matches geometry font, stroke and physical category assumptions', () => {
  const { fonts, strokes } = WINDGRAM_PRESENTATION;
  const rule = selector => chartCss.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]+)\\}'))?.[1] ?? '';
  assert.match(rule('.windgram'), new RegExp(`font-family: ${fonts.family}`));
  for (const [selector, size] of [['.windgram text', fonts.primary], ['.windgram .wg-axis-unit', fonts.secondary], ['.windgram .wg-lift', fonts.lift]]) {
    assert.ok(rule(selector).includes(`font-size: ${size}px;`), selector);
  }
  for (const [selector, width] of [['wg-grid', strokes.grid], ['wg-isotherm', strokes.isotherm], ['wg-isotherm-freezing', strokes.freezing], ['wg-barb', strokes.barb], ['wg-barb-rim', strokes.barbRim], ['wg-cloud-potential', strokes.cloud], ['wg-wing', strokes.wing], ['wg-freezing-mark', strokes.freezingMark]]) {
    assert.ok(rule(`.windgram .${selector}`).includes(`stroke-width: ${width};`), selector);
  }
  for (const { className, color } of WINDGRAM_STABILITY) assert.ok(rule(`.windgram .meteo-gram-stab-${className}`).includes(`fill: ${color};`));
});
