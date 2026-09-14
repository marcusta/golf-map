// Refresh an existing report without Unity or regenerating preview images.
// node unity/rebuild-catalogue-gallery.mjs <catalogue-directory>
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.resolve(process.argv[2]||'');
if(!process.argv[2]) throw Error('Provide a catalogue directory');
const report=JSON.parse(fs.readFileSync(path.join(directory,'catalogue.json'),'utf8').replace(/^\uFEFF/,''));
if(report.format!=='golfmap-asset-catalogue-v1'||!Array.isArray(report.assets))throw Error('Unsupported catalogue');
const template=fs.readFileSync(new URL('./Editor/GolfMap/GolfMapCatalogueGallery.html',import.meta.url),'utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
for(const asset of report.assets)if(!/^[a-f0-9]{32}$/i.test(asset.guid))throw Error('Invalid asset GUID');
fs.mkdirSync(path.join(directory,'details'),{recursive:true});
const assets=report.assets.map(a=>{
 const {guid,name,path:assetPath,preview,heightM,crownWidthM}=a;
 fs.writeFileSync(path.join(directory,'details',guid+'.html'),`<!doctype html><meta charset="utf-8"><title>${escape(name)}</title><style>body{font:16px system-ui;background:#202427;color:#eee;margin:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#b9daf7}</style><a href="../index.html">Catalogue</a><h1>${escape(name)}</h1><pre>${escape(JSON.stringify(a,null,2))}</pre>`);
 return {guid,name,path:assetPath,preview,heightM,crownWidthM};
});
const data=JSON.stringify({unityVersion:report.unityVersion,complete:report.complete,assets}).replace(/&/g,'\\u0026').replace(/</g,'\\u003c').replace(/>/g,'\\u003e');
const target=path.join(directory,'index.html');
const backup=path.join(directory,'index-before-pagination.html');
if(fs.existsSync(target)&&!fs.existsSync(backup))fs.copyFileSync(target,backup);
fs.writeFileSync(target,template.replace('__GOLFMAP_DATA__',()=>data));
console.log(JSON.stringify({assets:assets.length,indexBytes:fs.statSync(target).size,backup}));
