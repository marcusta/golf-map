// Exercise saved choices through the same matcher used by the CLI; no browser resources.
import {Window} from '../web/node_modules/happy-dom/lib/index.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {matchTree} from './tree-matching.mjs';
const w=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
w.document.write(fs.readFileSync('tree-export/vreta-hole1-review.html','utf8'));
w.eval([...w.document.querySelectorAll('script')].find(s=>!s.type).textContent+';window.readChoices=()=>JSON.stringify(choices);');
const d=w.document,data=JSON.parse(d.getElementById('data').textContent);
assert.equal(d.querySelectorAll('circle').length,data.assignments.length);
d.querySelector('circle').dispatchEvent(new w.Event('click'));
const stem=data.assignments[0];
assert.equal(d.getElementById('name').textContent,stem.stemId);
d.getElementById('scale').value='1.15';d.getElementById('save').click();
assert.match(d.getElementById('count').textContent,/1 saved/);
const choices=JSON.parse(w.readChoices());
assert.equal(choices[stem.stemId].scale,1.15);
const config=JSON.parse(fs.readFileSync('docs/gspro/vreta/palette.json','utf8').replace(/^\uFEFF/,''));
const authored=matchTree({id:stem.stemId,x:stem.position.x,z:stem.position.z,h:10,r:2.5,k:0},config,choices[stem.stemId]);
assert.equal(authored.status,'authored');assert.equal(authored.scale,1.15);
d.getElementById('exclude').click();assert.equal(JSON.parse(w.readChoices())[stem.stemId].exclude,true);
const excluded=matchTree({id:stem.stemId,x:stem.position.x,z:stem.position.z,h:10,r:2.5,k:0},config,{exclude:true});
assert.deepEqual(excluded.position,stem.position); // Keep removals inside spatial sample selection.
assert.equal(d.querySelectorAll('img').length,1);
console.log('Hole review: selection, override, exclusion and matcher round trip passed.');
await w.happyDOM.close();

