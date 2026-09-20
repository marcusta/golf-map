// Stage a reversible oak reflection diagnostic using a stock, VSP-supported shader.
// Metallic=0 still has dielectric specular; Smoothness=0 only broadens that lobe.
// NM StandardSpecular with SpecularPower=0 and SmoothnessPower=0 removes both
// direct and indirect specular in Unity 2018's desktop BRDF1. No shader copies.
// Usage: bun unity/prepare-oak-specular.mjs UNITY_ROOT NEW_STAGE
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [root, stage] = process.argv.slice(2);
if (!root || !stage || fs.existsSync(stage)) throw Error('Provide UNITY_ROOT NEW_STAGE');
const file = 'Assets/GolfMap/Vreta/FoliageTrialV2/Oak Leaves.mat';
const shaderFolder = 'Assets/NatureManufacture Assets/Foliage Shaders/';
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const shaderGuid = name => /^guid: (\w+)$/m.exec(read(shaderFolder + name + '.shader.meta'))[1];
const metallic = shaderGuid('Tree_Leaves_Metalic');
const specular = shaderGuid('Tree_Leaves_Specular');
const source = fs.readFileSync(path.join(root, file));
const before = source.toString('utf8').replace(/\r\n/g, '\n');
assert.match(before, new RegExp('m_Shader: \\{fileID: 4800000, guid: ' + metallic + ','));
assert.match(before, /^    - _BumpScale: 1$/m, 'Specular shader has no bump-scale control');
assert.match(before, /^    - _BackFaceMirrorNormal: 0$/m);
const shader = read(shaderFolder + 'Tree_Leaves_Specular.shader');
assert.match(shader, /Shader "NatureManufacture Shaders\/Trees\/Tree_Leaves_Specular"/);
assert.match(shader, /o\.Specular = \( temp_output_35_0 \* _SpecularPower \)\.rgb;/);
const maskPattern = /^    - _MetalicRAOGSmothnessA:\n(?:        .*\n)+/m;
const mask = before.match(maskPattern)?.[0];
assert.ok(mask && mask.includes('guid:'), 'Oak must have its existing AO mask');
assert.ok(!before.includes('    - _AmbientOcclusionGSmoothnessA:'), 'Already has a specular AO slot');
let after = before.replace('guid: ' + metallic + ',', 'guid: ' + specular + ',');
after = after.replace(maskPattern, mask + mask.replace('_MetalicRAOGSmothnessA:', '_AmbientOcclusionGSmoothnessA:'));
// Keep the obsolete metallic slot for reversibility; both shaders read AO in G.
assert.match(after, /^    - _SmoothnessPower: [0-9.]+$/m);
after = after.replace(/^    - _SmoothnessPower: [0-9.]+$/m, '    - _SmoothnessPower: 0');
assert.ok(!after.includes('    - _SpecularPower:'));
after = after.replace('    m_Floats:\n', '    m_Floats:\n    - _SpecularPower: 0\n');
// The old flag is unsupported by both stock shaders; use the actual property above.
after = after.replace(/^  m_ShaderKeywords:.*(?:\n    [^\n]+)*\n/m, block =>
  block.replace(/\b_SPECULARHIGHLIGHTS_OFF\b/g, '').replace(/ +\n/g, '\n'));

// Verify against the real material: maps, colour, clipping, normals and wind survive.
for (const key of ['_MainTex', '_BumpMap']) {
  const re = new RegExp('^    - ' + key + ':\\n(?:        .*\\n)+', 'm');
  assert.equal(after.match(re)?.[0], before.match(re)?.[0]);
}
assert.equal(after.split('    m_Colors:\n')[1], before.split('    m_Colors:\n')[1]);
for (const line of before.match(/^    - _\w+: [-0-9.]+$/gm)) {
  if (!line.startsWith('    - _SmoothnessPower:')) assert.ok(after.includes(line + '\n'), line);
}
const save = (rel, data) => {
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.writeFileSync(dest, data);
};
save('before/' + file, source);
save(file, after);
save('report.json', JSON.stringify({material: file, shader: 'NatureManufacture Shaders/Trees/Tree_Leaves_Specular',
  specularPower: 0, smoothnessPower: 0, visualVerification: 'pending',
  next: 'Refresh vegetation from materials, compare the same oak from both angles; rebake billboards before export.'}, null, 2) + '\n');
console.log('Staged oak material and exact original backup at ' + path.resolve(stage));
