// Add a tint to a private copy of the installed CTI shader; no package edits.
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2],stage=process.argv[3];
const source='Assets/Birch Trees Package/Birches Version 3.0/CTI Runtime Components/Shaders/CTI_LOD_Leaves_301.shader';
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
let shader=fs.readFileSync(path.join(root,source),'utf8');
shader=shader.replace('Shader "CTI/LOD Leaves 301"','Shader "GolfMap/CTI Oak Leaves Trial"')
 .replace('Properties {','Properties {\n    _GolfMapLeafTint ("Leaf tint", Color) = (0.5, 0.65, 0.4, 1)')
 .replaceAll('#include "Includes/','#include "'+path.posix.dirname(source)+'/Includes/')
 .replaceAll('sampler2D _MainTex;','sampler2D _MainTex;\n        fixed4 _GolfMapLeafTint;');
const expression='o.Albedo = lerp(c.rgb, (c.rgb + _HueVariation.rgb) * 0.5, IN.color.r * _HueVariation.a);';
if(!shader.includes(expression))throw Error('Unexpected CTI shader source');
shader=shader.replace(expression,expression+'\n            o.Albedo *= _GolfMapLeafTint.rgb;');
shader=shader.replace('o.Specular = norspc.b;', 'o.Specular = min(norspc.b, 0.02);').replace('o.Smoothness = trngls.a', 'o.Smoothness = min(trngls.a, 0.15)');
const dest=path.join(stage,folder);fs.mkdirSync(dest,{recursive:true});
// CTI's default deferred pass encodes Lux translucency into specular G/B.
// Vreta uses Unity's ordinary deferred lighting, which reads those as colour.
const includeSource=path.posix.dirname(source)+'/Includes/CTI_TranslucentLighting_301.cginc';
let lighting=fs.readFileSync(path.join(root,includeSource),'utf8');
lighting=lighting.replace('outSpecSmoothness = half4(s.Specular.r, s.ScatteringPower, s.Translucency, s.Smoothness);','outSpecSmoothness = half4(s.Specular, s.Smoothness);')
 .replace('outNormal = half4(s.Normal * 0.5 + 0.5, 0.66);','outNormal = half4(s.Normal * 0.5 + 0.5, 1);');
shader=shader.replace('#include "'+includeSource+'"','#include "GolfMap_OakLighting.cginc"');
fs.writeFileSync(path.join(dest,'GolfMap_OakLighting.cginc'),lighting);
fs.writeFileSync(path.join(dest,'Oak Leaves Tinted.shader'),shader);
fs.writeFileSync(path.join(dest,'Oak Leaves Tinted.shader.meta'),'fileFormatVersion: 2\nguid: d180f5e456084207b7d92dc56b02b951\nShaderImporter:\n  externalObjects: {}\n  defaultTextures: []\n  nonModifiableTextures: []\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n');
let material=fs.readFileSync(path.join(root,folder,'Oak Leaves.mat'),'utf8');
material=material.replace('guid: 6ae32366f15a64fc19f245f040af8f21','guid: d180f5e456084207b7d92dc56b02b951');
material=material.replace(/_AmbientTranslucency: [^\r\n]+/,'_AmbientTranslucency: 1').replace(/_TranslucencyStrength: [^\r\n]+/,'_TranslucencyStrength: 0.45');
const tint='    - _GolfMapLeafTint: {r: 0.5, g: 0.65, b: 0.4, a: 1}';
material=material.includes('_GolfMapLeafTint:')?material.replace(/    - _GolfMapLeafTint:[^\r\n]+/,tint):material.replace('    m_Colors:','    m_Colors:\n'+tint);
fs.writeFileSync(path.join(dest,'Oak Leaves.mat'),material);

