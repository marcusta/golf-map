// CTI's translucent lighting adds `Albedo * 4 * Translucency * lightScattering` on top of the
// normal BRDF, where lightScattering peaks when you look along the sun direction. That is the one
// view-dependent bright term in the oak leaf shader (smoothness is hard-clamped to 0.15 and
// specular to 0.02 in surf), so it is the only thing that can make an oak read white from one
// angle and green from the opposite one.
// Run with 0 0 as a diagnostic: if the white survives translucency being switched off, the scene
// is not drawing our material at all and the next place to look is VSP's shader substitution.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage,strength='0',ambient='0']=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE [TRANSLUCENCY_STRENGTH] [AMBIENT_TRANSLUCENCY]');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const float=(t,key,value)=>{
 const re=new RegExp('(^    - '+key+': )[-0-9.]+$','m');
 if(!re.test(t))throw Error('Missing float '+key);
 return t.replace(re,(_,prefix)=>prefix+value);
};
const file='Assets/GolfMap/Vreta/FoliageTrialV2/Oak Leaves.mat';
const before=read(file);
const after=float(float(before,'_TranslucencyStrength',Number(strength)),'_AmbientTranslucency',Number(ambient));
if(after===before)throw Error('Oak leaves already at these values');
save(file,after);
const show=t=>t.match(/^    - _(?:TranslucencyStrength|AmbientTranslucency|ViewDependency): .*$/gm).map(s=>s.trim().slice(2));
const report={file,before:show(before),after:show(after)};
save('report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
