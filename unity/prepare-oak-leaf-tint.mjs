// Set _GolfMapLeafTint on the private oak leaf material. The shader multiplies it straight into
// albedo (`o.Albedo *= _GolfMapLeafTint.rgb`), so it is both the oak colour dial and a probe:
// run it with 1,0,0 and every tree that turns red is drawn by this material. Anything that stays
// white is either a different asset or is not being drawn with our material at all.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage,rgb='.27,.39,.25']=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE [TINT_RGB]');
const tint=rgb.split(',').map(Number);
if(tint.length!==3||tint.some(n=>!(n>=0&&n<=1)))throw Error('Bad tint '+rgb);
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const file='Assets/GolfMap/Vreta/FoliageTrialV2/Oak Leaves.mat';
const before=read(file);
const re=/^(    - _GolfMapLeafTint: \{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)\}$/m;
if(!re.test(before))throw Error('Oak leaves material carries no _GolfMapLeafTint');
const after=before.replace(re,(_,prefix,a)=>prefix+tint[0]+', g: '+tint[1]+', b: '+tint[2]+', a: '+a+'}');
if(after===before)throw Error('Oak leaves already at this tint');
save(file,after);
const show=t=>re.exec(t)[0].trim().slice(2);
const report={file,before:show(before),after:show(after)};
save('report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
