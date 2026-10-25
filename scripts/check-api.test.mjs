import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectApi } from './check-api.mjs';

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'toolkit-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@windgrams/fixture', version: '0.1.0', type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
  const write = (name, text) => writeFileSync(join(root, 'dist', name), text);
  write('index.d.ts', "export { sample, type Sample } from './sample.js';\n");
  write('index.js', 'export const sample = () => {};');
  write('sample.d.ts', 'interface Position { latitude: number; longitude: number }\nexport interface Sample { position: Position; elevationM: number }\nexport declare function sample(position: Position): Sample;\nexport declare function privateHelper(value: string): string;\n');
  return { root, write };
};

test('API check rejects broad barrels and transitively exposed any', t => {
  const { root, write } = fixture(t);
  write('index.d.ts', "export * from './sample.js';\n");
  assert.ok(inspectApi(root).errors.some(error => error.includes('wildcard barrel')));
  write('index.d.ts', "export { sample } from './sample.js';\n");
  write('sample.d.ts', 'interface Sample { value: any }\nexport declare function sample(): Sample;\n');
  assert.ok(inspectApi(root).errors.some(error => error.includes('exposes any')));
});


test('API check rejects unresolved reachable declaration imports', t => {
  const { root, write } = fixture(t);
  write('index.d.ts', "export type Missing = import('./missing.js').Missing;\n");
  assert.ok(inspectApi(root).errors.some(error => error.includes('TS2307') && error.includes('missing.js')));
});

test('API check follows imported namespace types to their public declarations', t => {
  const { root, write } = fixture(t);
  write('index.d.ts', "export type Namespace = typeof import('./sample.js');\n");
  write('sample.d.ts', 'interface Payload { value: any }\nexport declare function sample(): Payload;\n');
  assert.ok(inspectApi(root).errors.some(error => error.includes('sample.d.ts') && error.includes('exposes any')));
});

test('API check accepts valid namespace contracts and ignores unexposed internals', t => {
  const { root, write } = fixture(t);
  write('index.d.ts', "export type Namespace = typeof import('./sample.js');\n");
  write('sample.d.ts', 'interface Internal { ignored: any }\ninterface Position { latitude: number; longitude: number }\nexport declare function sample(): Position;\n');
  assert.deepEqual(inspectApi(root).errors, []);
});
