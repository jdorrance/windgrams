import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPolygon } from '@windgrams/geography';

test('native cell polygons include boundary points and exclude hole interiors', () => {
  const polygon=[[[0,0],[2,0],[2,2],[0,2],[0,0]],[[.5,.5],[1.5,.5],[1.5,1.5],[.5,1.5],[.5,.5]]];
  assert.equal(containsPolygon(polygon,{latitude:.25,longitude:.25}),true);
  assert.equal(containsPolygon(polygon,{latitude:1,longitude:0}),true);
  assert.equal(containsPolygon(polygon,{latitude:1,longitude:1}),false);
  assert.equal(containsPolygon(polygon,{latitude:1,longitude:.5}),true);
  assert.equal(containsPolygon(polygon,{latitude:1,longitude:3}),false);
  assert.equal(containsPolygon([], {latitude:1,longitude:1}),false);
});

test('date-line cells cover both representations of 180 without covering Greenwich', () => {
  const polygon=[[[179,-44],[-179,-44],[-179,-42],[179,-42],[179,-44]]];
  for(const longitude of [179.5,-179.5,180,-180]) assert.equal(containsPolygon(polygon,{latitude:-43,longitude}),true);
  for(const longitude of [0,178,-178]) assert.equal(containsPolygon(polygon,{latitude:-43,longitude}),false);
  assert.equal(containsPolygon(polygon,{latitude:-41,longitude:180}),false);
});
