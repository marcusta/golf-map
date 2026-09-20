// Move NM Tree Leaves Metalic materials onto the private no-specular copy built by
// prepare-leaves-nospec-shader.mjs, and switch the specular off on them.
//
// Oak and maple both went white at grazing angles on the stock shader: with a dark leaf albedo,
// Fresnel pushes the 0.04 dielectric reflectance toward 1 edge-on, and that light is not
// multiplied by albedo, so no tint can remove it. Two changes per material:
//   _SPECULARHIGHLIGHTS_OFF  zeroes the direct lobe (the copy compiles the variant; stock NM doesn't)
//   _SmoothnessPower 0       shrinks the unguarded indirect term, grazingTerm 0.04 instead of
//                            smoothness + 0.04
// The copy has the same property block as the stock shader, so every value on the material
// carries over unchanged. Only materials already on the stock Metalic leaf shader are accepted.
//
// Usage: bun unity/prepare-leaves-nospec-apply.mjs UNITY_ROOT NEW_STAGE MATERIAL.mat [...]
// RETIRED. VSP resolves a shader controller by shader NAME, and GSPro's Vegetation Studio build has
// no DefaultShaderController fallback: an unknown name such as "GolfMap/Tree Leaves No Spec"
// null-refs in VegetationItemModelInfo.SetShaderControllers and stops every tree in the package
// loading, silently (the planter's Plant check rejects it). Materials must stay on a stock shader
// name. Kept for the record of what was tried; do not run it.
import fs from 'node:fs';
import path from 'node:path';
throw Error('Retired: VSP cannot resolve a controller for the no-spec shader name. See the header.');
const [root,stage,...materials]=process.argv.slice(2);
if(!root||!stage||!materials.length||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE MATERIAL [MATERIAL...]');
const STOCK='3ac8f0f969db81d4aab57fe4a28db9c3';    // NatureManufacture Shaders/Trees/Tree Leaves Metalic
const NOSPEC='9318c49b0ee441b72b1aaf5af89bc841';   // GolfMap/Tree Leaves No Spec
const shaderFile='Assets/GolfMap/Vreta/FoliageTrialV2/GolfMap Tree Leaves NoSpec.shader';
if(!fs.existsSync(path.join(root,shaderFile)))throw Error('Build the shader first: prepare-leaves-nospec-shader.mjs');
const report=[];
for(const rel of materials){
 const before=fs.readFileSync(path.join(root,rel),'utf8').replace(/\r\n/g,'\n');
 const guid=/^  m_Shader: \{fileID: \d+, guid: (\w+)/m.exec(before)?.[1];
 if(guid!==STOCK&&guid!==NOSPEC)throw Error(rel+' is not on the NM Tree Leaves Metalic shader ('+guid+')');
 let text=before.replace(/^(  m_Shader: \{fileID: \d+, guid: )\w+/m,(_,p)=>p+NOSPEC);
 text=text.replace(/^(  m_ShaderKeywords:)(.*)$/m,(_,p,list)=>{
  const keys=new Set(list.trim().split(/\s+/).filter(Boolean));keys.add('_SPECULARHIGHLIGHTS_OFF');
  return p+' '+[...keys].sort().join(' ');
 });
 if(!/^    - _SmoothnessPower: [-0-9.]+$/m.test(text))throw Error(rel+' has no _SmoothnessPower');
 const smoothness=+/^    - _SmoothnessPower: ([-0-9.]+)$/m.exec(text)[1];
 text=text.replace(/^(    - _SmoothnessPower: )[-0-9.]+$/m,(_,p)=>p+0);
 const dest=path.join(stage,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,text);
 report.push({material:rel,shader:guid===NOSPEC?'already no-spec':'stock -> no-spec',smoothnessPower:[smoothness,0]});
}
fs.writeFileSync(path.join(stage,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
