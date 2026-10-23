import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchNoteParts } from '../src/lib/launch-notes.ts';
import { formatQuantity } from '../src/lib/units.ts';

test('site-note measurements convert while ratings, directions and access restrictions remain intact', () => {
  const note = 'P3 · 1,700 ft MSL · 0.5 mi walk · 5 mph–10 mph. N launch. Close the gate.';
  const parts = launchNoteParts(note);
  const rendered = (system: 'imperial'|'metric') => parts.map(p => 'text' in p ? p.text : formatQuantity(p.value, p.kind, undefined, system)).join('');
  assert.equal(rendered('imperial'), 'P3 · 1,700 ft MSL · 0.5 mi walk · 5 mph–10 mph. N launch. Close the gate.');
  assert.equal(rendered('metric'), 'P3 · 518 m MSL · 0.8 km walk · 8 km/h–16 km/h. N launch. Close the gate.');
  assert.deepEqual(launchNoteParts('Park clear of logging trucks. P4 required.'), [{text:'Park clear of logging trucks. P4 required.'}]);
});
