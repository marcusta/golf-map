// Birch Leaves was converted from the CTI shader to NatureManufacture's Tree Leaves Metalic
// without remapping its texture slots: _BumpMap and _MetalicRAOGSmothnessA were left empty, so
// the shader sampled the "bump"/"white" defaults — flat normals, and smoothness pinned at
// 1 x _SmoothnessPower (1.152), which is why only the birches flare white at grazing angles.
// The package textures are already packed the way each shader property expects:
//   [Normal] [Spec]            X in A, Y in G          -> DXT5nm, what UnpackScaleNormal reads
//   [AO] [Trans] [Smoothness]  R 0, G AO, A smoothness -> NM's metallic/AO/smoothness layout
// _BackFaceMirrorNormal flips the normal on back faces; at 0 every leaf card seen from behind
// lights as if it faced away from the sun and renders black.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const slot=key=>new RegExp('^    - '+key+':\\n        m_Texture: \\{([^}]*)\\}','m');
const texture=(t,key,guid)=>{
 const re=slot(key);const found=re.exec(t);
 if(!found)throw Error('Missing texture slot '+key);
 if(found[1]!=='fileID: 0')throw Error(key+' already points at '+found[1]);
 return t.replace(re,m=>m.replace('fileID: 0','fileID: 2800000, guid: '+guid+', type: 3'));
};
const float=(t,key,value)=>{
 const re=new RegExp('(^    - '+key+': )[-0-9.]+$','m');
 if(!re.test(t))throw Error('Missing float '+key);
 return t.replace(re,(_,prefix)=>prefix+value);
};
const file='Assets/GolfMap/Vreta/FoliageTrialV2/Birch Leaves.mat';
const before=read(file);
let after=texture(before,'_BumpMap','7115078643a464249a1af11da27e308b');
after=texture(after,'_MetalicRAOGSmothnessA','3da47e8d364e94e0ebb13a8a683ffe3c');
after=float(after,'_BumpScale',1);
after=float(after,'_MetallicPower',0);
after=float(after,'_SmoothnessPower',0.8);
after=float(after,'_AmbientOcclusionPower',1);
after=float(after,'_BackFaceMirrorNormal',1);
save(file,after);
const show=t=>({
 bumpMap:slot('_BumpMap').exec(t)[1],
 maskMap:slot('_MetalicRAOGSmothnessA').exec(t)[1],
 floats:t.match(/^    - _(?:BumpScale|MetallicPower|SmoothnessPower|AmbientOcclusionPower|BackFaceMirrorNormal): .*$/gm).map(s=>s.trim().slice(2)),
});
const report={file,before:show(before),after:show(after)};
save('report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
