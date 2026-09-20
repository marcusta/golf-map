// DO NOT ASSIGN THIS SHADER TO A PLANTED MATERIAL. VSP picks shader controllers by shader name and
// GSPro's build has no fallback, so "GolfMap/Tree Leaves No Spec" stops the whole vegetation package
// loading (see prepare-leaves-nospec-apply.mjs, now retired). It also did not cure the oak's pale
// leaves, which turned out to be albedo, not specular.
//
// A private copy of NatureManufacture's Tree Leaves Metalic that can switch specular off.
//
// Unity's BRDF drives specular toward white at grazing angles - FresnelTerm reaches 1 and
// FresnelLerp reaches grazingTerm however small the base reflectance is - and that term is NOT
// multiplied by albedo. Set a leaf material's albedo to pure black and the canopy still shows
// white where it is seen edge-on against the sky. It is a lighting term, so no tint or texture
// work can touch it; the oak needed the same fix in its own shader.
//
// BRDF1_Unity_PBS honours _SPECULARHIGHLIGHTS_OFF for the direct lobe, but the stock NM shader
// never declares the keyword, so setting it on a material does nothing - the variant is not
// compiled. This copy declares it. The indirect term is not keyword-guarded at all and shrinks
// with smoothness instead (grazingTerm = smoothness + reflectivity), so the caller should also
// drop _SmoothnessPower to 0: that takes grazingTerm from 0.192 to 0.04 at the grazing angles
// where this shows up.
//
// Relative includes are rewritten to absolute paths because the copy does not live beside the
// originals.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const SOURCE='Assets/NatureManufacture Assets/Foliage Shaders/Tree_Leaves_Metalic.shader';
const TARGET='Assets/GolfMap/Vreta/FoliageTrialV2/GolfMap Tree Leaves NoSpec.shader';
const source=path.posix.dirname(SOURCE);
let shader=read(SOURCE);
const before=shader;
shader=shader.replace('Shader "NatureManufacture Shaders/Trees/Tree Leaves Metalic"','Shader "GolfMap/Tree Leaves No Spec"');
if(shader===before)throw Error('Unexpected shader name');
// Compile the variant the material asks for; without this the keyword is inert.
shader=shader.replace('#pragma shader_feature _TOUCHREACTACTIVE_ON',
 '#pragma shader_feature _TOUCHREACTACTIVE_ON\n\t\t#pragma shader_feature _SPECULARHIGHLIGHTS_OFF');
if(!shader.includes('_SPECULARHIGHLIGHTS_OFF'))throw Error('Could not add the keyword pragma');
shader=shader.replace(/#include "((?!Unity)[^"\/]+\.cginc)"/g,(_,file)=>'#include "'+source+'/'+file+'"');
const guid=crypto.createHash('md5').update('golfmap-leaves-nospec:'+TARGET).digest('hex');
save(TARGET,shader);
save(TARGET+'.meta','fileFormatVersion: 2\nguid: '+guid+'\nShaderImporter:\n  externalObjects: {}\n  defaultTextures: []\n  nonModifiableTextures: []\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n');
const includes=[...shader.matchAll(/#include "([^"]+)"/g)].map(m=>m[1]).filter(f=>!f.startsWith('Unity'));
for(const file of includes)if(!fs.existsSync(path.join(root,file)))throw Error('Rewritten include is missing: '+file);
const report={shader:TARGET,guid,includes,keyword:'_SPECULARHIGHLIGHTS_OFF'};
save('report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
