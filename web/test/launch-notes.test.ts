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

test('club-guide links preserve their URLs while nearby measurements convert', () => {
  const parts = launchNoteParts('Walk 0.5 mi. Guide (https://club.nz/sites/5m?wind=10mph&day=1).');
  assert.deepEqual(parts, [
    { text: 'Walk ' }, { kind: 'distance', value: .804672 }, { text: '. Guide (' },
    { text: 'https://club.nz/sites/5m?wind=10mph&day=1', href: 'https://club.nz/sites/5m?wind=10mph&day=1' },
    { text: ').' },
  ]);
  assert.deepEqual(launchNoteParts('http://club.nz/site_(south).'), [
    { text: 'http://club.nz/site_(south)', href: 'http://club.nz/site_(south)' }, { text: '.' },
  ]);
});

test('note links accept only valid HTTP(S) URLs and leave markup as text', () => {
  const input = '<img src=x onerror=alert(1)> javascript:alert(1) https:// https://user:pass@club.nz/';
  const parts = launchNoteParts(input);
  assert.equal(parts.map(part => 'text' in part ? part.text : '').join(''), input);
  assert.ok(parts.every(part => !('href' in part)));
  assert.deepEqual(launchNoteParts('https://club.nz/" onclick="alert(1)'), [
    { text: 'https://club.nz/', href: 'https://club.nz/' }, { text: '" onclick="alert(1)' },
  ]);
});
