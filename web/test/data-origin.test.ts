import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataBase } from '../src/lib/site.ts';

test('dataset origin is independent of the Pages project prefix', () => {
  assert.equal(resolveDataBase(undefined, '/windgrams/'), '/windgrams/data');
  assert.equal(resolveDataBase('https://weather.example/datasets/', '/windgrams/'), 'https://weather.example/datasets');
  assert.equal(resolveDataBase('/forecast/', '/windgrams/'), '/forecast');
  assert.throws(() => resolveDataBase('https://user:secret@example/data', '/'));
  assert.throws(() => resolveDataBase('https://example/data?key=hidden', '/'));
  assert.throws(() => resolveDataBase('javascript:alert(1)', '/'));
});


test('root-relative datasets reject URL suffixes and support the origin root', () => {
  assert.equal(resolveDataBase('/', '/windgrams/'), '');
  for (const path of ['/data?token=x', '/data#current', '//elsewhere.example/data', '/\\elsewhere.example/data']) {
    assert.throws(() => resolveDataBase(path, '/windgrams/'), /Data origin/);
  }
});


test('absolute data URLs reject empty suffixes and backslashes consistently with publication', () => {
  for (const url of ['https://weather.example/data?', 'https://weather.example/data#', 'https://weather.example/data\\file']) {
    assert.throws(() => resolveDataBase(url, '/windgrams/'), /Data origin/);
  }
});
