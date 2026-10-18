// Acceptance A4 (matching half): every Vreta stem gets the same model, scale, rotation, look and lean
// as before the model library, read through the course's palette as the planter now reads it
// (palette + model library). The golden was recorded from the matcher before the change
// (2026-10-18, commit 461e428 + the working tree of that day) on Vreta's exported trees files.
// Machine data (the export folder D:/gspro_courses/vreta-opcd) is required, not optional.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadCoursePalette} from '../tree-models.mjs';
import {matchingDigest,readJson} from './matching-digest.mjs';

const golden=readJson(new URL('./vreta-matching.golden.json',import.meta.url));
const config=loadCoursePalette('docs/gspro/vreta');

for(const terrain of ['inner','outer']){
 test(`Vreta's ${terrain} trees match exactly as before`,()=>{
  const now=matchingDigest(`D:/gspro_courses/vreta-opcd/vreta-${terrain}-trees.json`,config);
  assert.equal(now.count,golden[terrain].count);
  assert.deepEqual(now.sample,golden[terrain].sample);
  assert.equal(now.sha256,golden[terrain].sha256);
 });
}
