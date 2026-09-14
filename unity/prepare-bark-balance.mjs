// Stage private bark materials and remap every mesh LOD of the biome prefabs.
// Always derive tints from package originals, so reruns never compound darkening.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [root, stage] = process.argv.slice(2);
if (!root || !stage || fs.existsSync(stage)) throw Error('Provide UNITY_ROOT and a NEW staging directory');
const folder = 'Assets/GolfMap/Vreta/FoliageTrialV2';
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const save = (p, text) => { const dest = path.join(stage, p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); };
const guid = p => crypto.createHash('md5').update('golfmap-bark-balance:' + p).digest('hex');
const shaderSource = 'Assets/Birch Trees Package/Birches Version 3.0/CTI Runtime Components/Shaders/CTI_LOD_Bark_301.shader';
const shaderTarget = folder + '/Oak Bark Tinted.shader';
let shader = read(shaderSource);
const expression = 'o.Albedo = lerp(c.rgb, (c.rgb + _HueVariation.rgb) * 0.5, IN.color.r * _HueVariation.a);';
if (!shader.includes(expression) || !shader.includes('sampler2D _MainTex;')) throw Error('Unexpected oak bark shader');
shader = shader.replace('Shader "CTI/LOD Bark 301"', 'Shader "GolfMap/CTI Oak Bark Tinted"')
  .replace('Properties {', 'Properties {\n    _Color ("Bark tint", Color) = (1,1,1,1)')
  .replaceAll('#include "Includes/', '#include "' + path.posix.dirname(shaderSource) + '/Includes/')
  .replace('sampler2D _MainTex;', 'sampler2D _MainTex;\n        fixed4 _Color;')
  .replace(expression, expression + '\n            o.Albedo *= _Color.rgb;');
save(shaderTarget, shader);
save(shaderTarget + '.meta', read(shaderSource + '.meta').replace(/^guid: \w+/m, 'guid: ' + guid(shaderTarget)));
const palette = JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
const specs = [
  { species: 'oak', source: 'Assets/Oak Trees Package/Oak Trees Version 2.0/Sources/Shared Materials/M_Oak_Bark.mat', name: 'Oak Bark', factor: 0.85 },
  { species: 'birch', source: 'Assets/Birch Trees Package/Birches Version 3.0/Sources/Shared Materials/Birch Bark Array.mat', name: 'Birch Bark', factor: 0.95 }
];
const report = [];
for (const spec of specs) {
  const target = folder + '/' + spec.name + '.mat';
  const meta = read(spec.source + '.meta'), oldGuid = meta.match(/^guid: (\w+)/m)[1], newGuid = guid(target);
  let mat = read(spec.source);
  const colour = /    - _Color: \{r: ([\d.]+), g: ([\d.]+), b: ([\d.]+), a: ([\d.]+)}/;
  if (!colour.test(mat)) throw Error('Missing bark colour: ' + spec.source);
  mat = mat.replace(colour, (_, r, g, b, a) => `    - _Color: {r: ${Number(r)*spec.factor}, g: ${Number(g)*spec.factor}, b: ${Number(b)*spec.factor}, a: ${a}}`);
  mat = mat.replace(/^  m_Name: .+$/m, '  m_Name: ' + spec.name);
  if (spec.species === 'oak') mat = mat.replace(/(m_Shader: \{fileID: 4800000, guid: )\w+/, '$1' + guid(shaderTarget));
  save(target, mat); save(target + '.meta', meta.replace(/^guid: \w+/m, 'guid: ' + newGuid));
  for (const asset of palette.assets.filter(a => a.enabled && a.species === spec.species)) {
    if (!asset.path.startsWith(folder + '/')) throw Error('Expected private biome prefab: ' + asset.path);
    let prefab = read(asset.path);
    const references = prefab.split(oldGuid).length - 1;
    const existing = prefab.split(newGuid).length - 1;
    if (!references && !existing) throw Error('No expected bark material: ' + asset.name);
    prefab = prefab.replaceAll(oldGuid, newGuid);
    save(asset.path, prefab);
    report.push({ prefab: asset.name, barkReferences: references + existing, tintMultiplier: spec.factor });
  }
}
save('bark-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
