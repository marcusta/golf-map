// Move the maple leaves off the Arboreum shader onto NatureManufacture's Tree Leaves Metalic,
// the shader every other broadleaf here uses.
//
// Arboreum is not broken - it supports VSP's procedural:setup like NM does - but it is the only
// leaf shader in the palette that tints with a plain _Color instead of _HealthyColor/_DryColor,
// which puts maple outside every tool we have: the luma solve, the gloss clamp, and VSP's own
// "Nature Manufacture tree" shader controller (maple's controller is empty, so the planter cannot
// sync its colour the way it does for the others).
//
// The material keeps its path and .meta, so its guid is unchanged and the shared Maple prefab,
// the palette and the planted catalogue all still resolve - no replant. An existing NM leaf
// material is used as the template so every property the shader expects exists with sane values.
//
// Maple's normal map is already textureType 1 (a real Unity normal map), so it drops into
// _BumpMap directly - unlike the birch, whose CTI-packed map had to be re-encoded first.
// _MetalicRAOGSmothnessA is left empty deliberately: there is no NM-format mask for this tree, and
// the shader then samples white, so _SmoothnessPower alone sets smoothness. It is clamped low for
// the reason the birches flared - an unmasked leaf material at full smoothness goes white at
// grazing angles.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
// Normalise line endings: the Python passes rewrite materials as CRLF on Windows, and the
// multi-line texture-slot patterns below only match LF.
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const TEMPLATE='Assets/GolfMap/Vreta/FoliageTrialV2/Expanded Foliage/Elm_Leaves_3_17-35b4c09b.mat';
const TARGET='Assets/TreeShare/Maple/MapleBranch.mat';
const ALBEDO='cfa3b0e8665a642b6b9aee897885748a';   // private rolled-off Branch.png
const NORMAL='7c3be69d26bc1514495ae7e368e061ec';   // Assets/TreeShare/Maple/Branch_Normal.png
const before=read(TARGET);
const keep=key=>{
 const found=new RegExp('^    - '+key+': \\{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\\}$','m').exec(before);
 return found?found.slice(1,5).map(Number):null;
};
const tint=keep('_Color')||[1,1,1,1];   // carry the current tint over; re-solve afterwards
let text=read(TEMPLATE);
const texture=(t,key,guid)=>{
 const re=new RegExp('(^    - '+key+':\\n        m_Texture: \\{)[^}]*\\}','m');
 if(!re.test(t))throw Error('Template has no '+key+' slot');
 return t.replace(re,(_,p)=>p+(guid?'fileID: 2800000, guid: '+guid+', type: 3}':'fileID: 0}'));
};
const float=(t,key,value)=>{
 const re=new RegExp('(^    - '+key+': )[-0-9.]+$','m');
 if(!re.test(t))throw Error('Template has no float '+key);
 return t.replace(re,(_,p)=>p+value);
};
const colour=(t,key,v)=>{
 const re=new RegExp('(^    - '+key+': \\{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)\\}$','m');
 if(!re.test(t))throw Error('Template has no colour '+key);
 return t.replace(re,(_,p,a)=>p+v[0]+', g: '+v[1]+', b: '+v[2]+', a: '+a+'}');
};
text=text.replace(/^  m_Name: .*$/m,'  m_Name: MapleBranch');
text=texture(text,'_MainTex',ALBEDO);
text=texture(text,'_BumpMap',NORMAL);
text=texture(text,'_MetalicRAOGSmothnessA',null);
text=float(text,'_Cutoff',0.5);
text=float(text,'_BumpScale',1);
text=float(text,'_MetallicPower',0);
text=float(text,'_SmoothnessPower',0.152);
text=float(text,'_AmbientOcclusionPower',1);
text=float(text,'_BackFaceMirrorNormal',0);
text=colour(text,'_HealthyColor',tint);
text=colour(text,'_DryColor',tint);
save(TARGET,text);
const shader=t=>/m_Shader: \{fileID: \d+, guid: (\w+)/.exec(t)[1];
const report={
 material:TARGET,
 shader:{before:shader(before),after:shader(text)},
 carriedTint:tint.slice(0,3),
 note:'Run prepare-foliage-luma.py maple next to solve _HealthyColor/_DryColor properly.',
};
save('report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
