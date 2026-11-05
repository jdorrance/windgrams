import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync}from 'node:fs';
import {gunzipSync}from 'node:zlib';
import {parsePublishedProfileJson}from '@windgrams/contracts/published-lift';
const source=JSON.parse(gunzipSync(readFileSync(new URL('../../../web/test/fixtures/windgram-visual/dog-gfs.json.gz',import.meta.url))));
test('published point profiles retain every independently missing atmospheric measurement',()=>{
 const input=structuredClone(source);input.hours[0].surface.temperatureC=null;input.hours[0].derived.thermalVelocityMps=null;
 input.hours[0].levels[0].temperatureC=null;input.hours[0].levels[1].heightM=null;input.hours[0].levels[2].pressureHpa=null;
 const parsed=parsePublishedProfileJson(JSON.stringify(input));assert.ok(parsed);assert.equal(parsed.hours.length,input.hours.length);assert.equal(parsed.hours[0].levels.length,input.hours[0].levels.length);
 for(const [index,key]of[[0,'temperatureC'],[1,'heightM'],[2,'pressureHpa']])assert.equal(parsed.hours[0].levels[index][key],null);
 assert.equal(parsed.hours[0].levels[0].windSpeedMps,input.hours[0].levels[0].windSpeedMps);assert.equal(parsed.hours[0].surface.temperatureC,null);
});
test('nullable measurements still reject malformed core values and preserve complete historical profiles',()=>{
 const baseline=parsePublishedProfileJson(JSON.stringify(source));assert.ok(baseline);assert.deepEqual(baseline.hours.map(h=>h.levels),source.hours.map(h=>h.levels));
 for(const key of['pressureHpa','heightM','temperatureC']){const bad=structuredClone(source);bad.hours[0].levels[0][key]='bad';assert.equal(parsePublishedProfileJson(JSON.stringify(bad)),null);}
});
