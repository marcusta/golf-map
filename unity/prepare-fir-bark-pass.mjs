// Fir models share these bark materials. Stage fixed tints, never cumulative edits.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const folder='Assets/NatureManufacture Assets/Dynamic Nature - Mountain Tree Pack/Models/Materials';
for(const name of ['M_Fir_Bark_01.mat','M_Fir_Bark_02.mat']){
 const relative=folder+'/'+name;
 let material=fs.readFileSync(path.join(root,relative),'utf8');
 const tint=/    - _Color: \{r: [^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}/;
 if(!tint.test(material))throw Error('Missing bark tint: '+name);
 material=material.replace(tint,(_,alpha)=>`    - _Color: {r: 0.65, g: 0.65, b: 0.65, a: ${alpha}}`);
 const dest=path.join(stage,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,material);
 console.log(name+': RGB tint 0.65; other properties unchanged');
}
