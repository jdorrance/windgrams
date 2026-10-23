import test from 'node:test';
import assert from 'node:assert/strict';
import { displayMetric, historicalLabel, replayLocation, selectedState, type ReplayManifest, type ReplayHour } from '../src/lib/soaring.ts';

test('replay links preserve the project base and reject unknown cases', () => {
  assert.equal(replayLocation('?hour=27','/windgrams/data').root,'/windgrams/data/soaring/v1/north-sound-20261021-00z');
  assert.equal(replayLocation('?hour=27','/data').hour,27);
  assert.equal(replayLocation('?hour=NaN','/data').hour,20);
  assert.throws(()=>replayLocation('?case=../bad','/data'),/Unknown/);
  assert.match(historicalLabel('2026-10-21T00:00:00Z'),/Historical forecast.*HRRR.*2026-10-21.*00:00 UTC/);
});
test('zero, unavailable, insufficient levels, and no usable lift have distinct labels for v1 and v2 layers', () => {
  assert.equal(displayMetric(0,'thermalVelocityMps'),'0.00 m/s');
  assert.equal(displayMetric(0.85,'thermalVelocityV2Mps'),'0.85 m/s');
  assert.equal(displayMetric(null,'thermalVelocityMps'),'Unavailable');
  assert.equal(displayMetric(null,'thermalVelocityV2Mps'),'Unavailable');
  assert.equal(displayMetric(null,'thermalVelocityMps','insufficient-levels'),'Insufficient vertical coverage');
  assert.match(displayMetric(null,'usableLiftTopM'),/No lift.*1.0/);
  assert.match(displayMetric(null,'usableLiftTopV2M'),/No lift.*1.0/);
  assert.equal(displayMetric(724.5,'usableLiftTopM'),'2,377 ft MSL');
  assert.equal(displayMetric(465.5,'usableLiftTopV2M'),'1,527 ft MSL');
});
test('one selected hour drives map, site cards, windgram, and sounding time with both v1 and v2 metrics', () => {
  const hours=[14,20,27].map((f,i)=>({
    forecastHour:f,
    validAt:new Date(Date.UTC(2026,9,21,f)).toISOString(),
    status:['valid'],
    thermalVelocityMps:[i],
    usableLiftTopM:[i?724.5:null],
    thermalVelocityV2Mps:[i?0.85:0],
    usableLiftTopV2M:[i?465.5:null],
  })) as ReplayHour[];
  const manifest={hours,siteCell:0,case:{site:{timeZone:'America/Los_Angeles'}}} as unknown as ReplayManifest;
  for(let i=0;i<hours.length;i++) {
    const state=selectedState(manifest,hours,hours[i].forecastHour);
    assert.equal(state.index,i);assert.equal(state.hour,hours[i]);
    assert.equal(state.siteStrength,`${i.toFixed(2)} m/s`);
  }
  assert.equal(selectedState(manifest,hours,20).siteStrengthV2,'0.85 m/s');
  assert.equal(selectedState(manifest,hours,20).siteTopV2,'1,527 ft MSL');
  assert.match(selectedState(manifest,hours,20).validLabel,/1:00 PM PDT/);
  assert.throws(()=>selectedState(manifest,[],20),/does not match/);
});
