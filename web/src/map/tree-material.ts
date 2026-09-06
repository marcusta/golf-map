import { Color, DoubleSide, NormalBlending, ShaderMaterial, Vector2, Vector3, type Texture } from 'three';
import { IMPOSTOR_COLUMNS, IMPOSTOR_ROWS, LOD_FULL_M, LOD_MID_FRACTION } from './tree-geometry';

/**
 * Sun direction matched to the Landeryd orthophoto. In the ortho every bush and
 * tree casts its shadow to the south-west with a length close to its height
 * (hole 5 bush crop and the clubhouse tiles), so the flight was a morning one
 * with the sun in the north-east: azimuth ~50 degrees, elevation ~42 degrees.
 * A Swedish summer afternoon (azimuth 210 to 240) would put the shadows on the
 * opposite side of the photographed ones, so the morning value wins.
 */
export const SUN_AZIMUTH_DEG = 50;
export const SUN_ELEVATION_DEG = 42;

/** Unit vector toward the sun in the layer's east/north/up metres. */
export function sunDirection(azimuthDeg = SUN_AZIMUTH_DEG, elevationDeg = SUN_ELEVATION_DEG): Vector3 {
    const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
    return new Vector3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)).normalize();
}

/** Horizontal shadow offset per metre of tree height, away from the sun. */
export function shadowOffsetPerMetre(azimuthDeg = SUN_AZIMUTH_DEG, elevationDeg = SUN_ELEVATION_DEG): Vector2 {
    const az = azimuthDeg * Math.PI / 180, cot = 1 / Math.tan(elevationDeg * Math.PI / 180);
    return new Vector2(-Math.sin(az), -Math.cos(az)).multiplyScalar(cot * 0.5);
}

export interface TreeLighting {
    sunDir: Vector3;
    sunColor: Color;
    skyColor: Color;
    groundColor: Color;
    fogColor: Color;
    /** near (m), far (m), maximum blend toward fogColor */
    fog: Vector3;
}

export function defaultLighting(): TreeLighting {
    return {
        sunDir: sunDirection(),
        sunColor: new Color(0xfff1d6).multiplyScalar(1.9),
        skyColor: new Color(0xb9cde0).multiplyScalar(0.95),
        groundColor: new Color(0x4d5a3a).multiplyScalar(0.7),
        // Distant trees sit against terrain, not sky, so the haze pulls toward a muted
        // green-grey close to the far orthophoto. A page-grey haze made far stands read as
        // white and pop when they crossed into the unfogged band.
        fogColor: new Color(0x86987e),
        fog: new Vector3(250, 1300, 0.45),
    };
}

/** Uniform block every tree material shares (the layer updates the values in place each frame). */
export function sharedUniforms(lighting: TreeLighting) {
    return {
        uCamera: { value: new Vector3() },
        uTime: { value: 0 },
        uSway: { value: 1 },
        uWind: { value: new Vector2(0.8, 0.6).normalize() },
        uSunDir: { value: lighting.sunDir },
        uSunColor: { value: lighting.sunColor },
        uSkyColor: { value: lighting.skyColor },
        uGroundColor: { value: lighting.groundColor },
        uFogColor: { value: lighting.fogColor },
        uFog: { value: lighting.fog },
    };
}
export type SharedUniforms = ReturnType<typeof sharedUniforms>;

/** Sun, hemisphere and fog terms shared by every tree shader (and the test scene's ground). */
export const LIGHTING_GLSL = /* glsl */`
uniform vec3 uSunDir, uSunColor, uSkyColor, uGroundColor, uFogColor;
uniform vec3 uFog;
vec3 shadeFoliage(vec3 albedo, vec3 n) {
    // Wrapped diffuse: leaves transmit light, so the shadow side never goes black.
    float ndl = dot(n, uSunDir);
    float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);
    float diffuse = wrap * wrap * (0.55 + 0.45 * wrap);
    vec3 hemi = mix(uGroundColor, uSkyColor, n.z * 0.5 + 0.5);
    vec3 lit = albedo * (hemi + uSunColor * diffuse);
    // Pull saturation in a little; the atlas leaves are drawn at full chroma.
    return mix(vec3(dot(lit, vec3(0.30, 0.59, 0.11))), lit, 0.86);
}
vec3 shadeBark(vec3 albedo, vec3 n) {
    float diffuse = max(dot(n, uSunDir), 0.0);
    vec3 hemi = mix(uGroundColor, uSkyColor, n.z * 0.5 + 0.5);
    return albedo * (hemi * 0.9 + uSunColor * diffuse * 0.85);
}
float fogAmount(float dist) {
    return smoothstep(uFog.x, uFog.y, dist) * uFog.z;
}
`;

const SWAY_GLSL = /* glsl */`
uniform float uTime, uSway;
uniform vec2 uWind;
// Two out-of-phase sine terms at 0.3 to 0.6 Hz; amplitude grows with height and sway weight.
vec2 swayOffset(float weight, float phase, float heightM) {
    float hz = 0.3 + 0.3 * fract(phase * 0.618);
    float t = uTime * hz * 6.2831853 + phase * 6.2831853;
    float wave = sin(t) * 0.7 + sin(t * 2.17 + 1.3) * 0.3;
    return uWind * wave * weight * uSway * (0.012 * heightM + 0.05);
}
`;

// ---------------------------------------------------------------------------
// Full tree: cards + trunk, variant and LOD selection per vertex.
// ---------------------------------------------------------------------------
const TREE_VERTEX = /* glsl */`
attribute vec3 aCenter;
attribute vec3 aCorner;
attribute vec4 aInfo;    // variant, lodRank, part, sway weight
attribute vec3 aCardNormal; // card plane normal, zero for trunk vertices
attribute float aDepth;  // 0 at the trunk axis, 1 at the crown edge
attribute vec3 iPos;     // x, y, ground (layer metres)
attribute vec4 iParams;  // radius, height, yaw, variant
attribute vec4 iExtra;   // scaleX, scaleY, phase, crown base raise (fraction of the crown span)
attribute vec4 iTint;    // foliage tint rgb, trunk lean tan(angle)
uniform vec3 uCamera;
uniform float uLodFull;
uniform float uMidFraction;  // card fraction kept beyond uLodFull
uniform float uCardFraction; // 0 normally; the impostor bake forces every card on
uniform float uEdgeCutoff;   // |cos| below which a card is edge-on
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vTint;
varying float vPart;
varying float vFog;
varying float vLodBias;
varying float vDepth;
varying vec3 vView;
${SWAY_GLSL}
${LIGHTING_GLSL}
void main() {
    float variant = iParams.w;
    float dist = distance(iPos, uCamera);
    float keep = dist < uLodFull ? 1.0 : uMidFraction;
    keep = max(keep, uCardFraction);
    if (abs(aInfo.x - variant) > 0.5 || aInfo.y > keep) {
        // Collapse the whole card to one off-screen point: zero area, no fragments.
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vUv = vec2(0.0); vNormal = vec3(0.0, 0.0, 1.0); vTint = vec3(1.0); vPart = 1.0; vFog = 0.0; vLodBias = 0.0; vDepth = 1.0; vView = vec3(0.0, 0.0, 1.0);
        return;
    }
    float radius = iParams.x, height = iParams.y, yaw = iParams.z;
    float c = cos(yaw), s = sin(yaw);
    vec3 local;
    if (aInfo.z < 0.5) {
        float trunkRadius = 0.012 * height + 0.1;
        local = vec3(aCenter.xy * trunkRadius, aCenter.z * height);
    } else {
        // Stand trees raise their crown base; the top stays put.
        float z = aCenter.z + iExtra.w * (1.0 - aCenter.z);
        local = vec3(aCenter.xy * radius * iExtra.xy + aCorner.xy * radius, z * height + aCorner.z * radius);
    }
    // Whole-tree lean along the instance's local x axis (random per stem through the yaw).
    local.x += local.z * iTint.w;
    vec3 rotated = vec3(c * local.x - s * local.y, s * local.x + c * local.y, local.z);
    rotated.xy += swayOffset(aInfo.w, iExtra.z, height);
    vec3 world = iPos + rotated;
    // Cards seen nearly edge-on show as thin slivers with straight edges; drop them. The test uses
    // the card's own centre (shared by its four vertices, so the quad is kept or dropped whole),
    // not the trunk axis: for a tree within a couple of metres of the eye the two differ a lot.
    vec3 cardN = vec3(c * aCardNormal.x - s * aCardNormal.y, s * aCardNormal.x + c * aCardNormal.y, aCardNormal.z);
    vec3 cardCentre = vec3(aCenter.xy * radius * iExtra.xy, (aCenter.z + iExtra.w * (1.0 - aCenter.z)) * height);
    cardCentre.x += cardCentre.z * iTint.w;
    vec3 toEye = normalize(uCamera - (iPos + vec3(c * cardCentre.x - s * cardCentre.y, s * cardCentre.x + c * cardCentre.y, cardCentre.z)));
    if (aInfo.z > 0.5 && dot(cardN, cardN) > 0.5 && abs(dot(cardN, toEye)) < uEdgeCutoff) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vUv = vec2(0.0); vNormal = vec3(0.0, 0.0, 1.0); vTint = vec3(1.0); vPart = 1.0; vFog = 0.0; vLodBias = 0.0; vDepth = 1.0; vView = vec3(0.0, 0.0, 1.0);
        return;
    }
    gl_Position = projectionMatrix * vec4(world, 1.0);
    vNormal = vec3(c * normal.x - s * normal.y, s * normal.x + c * normal.y, normal.z);
    vUv = uv;
    // Bark tint jitter per stem: brightness and a warm/grey shift from the phase hash.
    float j1 = fract(iExtra.z * 13.37), j2 = fract(iExtra.z * 7.13);
    vec3 barkTint = vec3(0.78 + 0.44 * j1, (0.78 + 0.44 * j1) * (0.92 + 0.12 * j2), (0.78 + 0.44 * j1) * (0.84 + 0.22 * j2));
    vTint = aInfo.z < 0.5 ? barkTint : iTint.rgb;
    vPart = aInfo.z;
    vFog = fogAmount(dist);
    vLodBias = keep < 0.999 ? 1.0 : 0.0;
    vDepth = aDepth;
    vView = uCamera - world;
}
`;

const TREE_FRAGMENT = /* glsl */`
uniform sampler2D uFoliage, uBark, uBarkNormal;
uniform float uNeedle; // 1 for conifer needle cards: darker interior, back-light and rim terms
uniform vec2 uNearFade; // eye distance (m) where foliage alpha reaches 0, and where it is back to 1
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vTint;
varying float vPart;
varying float vFog;
varying float vLodBias;
varying float vDepth;
varying vec3 vView;
${LIGHTING_GLSL}
void main() {
    vec3 n = normalize(vNormal);
    // Foliage cards are two-sided: shade the face the eye sees, never the back of the card.
    if (vPart > 0.5 && dot(n, vView) < 0.0) n = -n;
    vec3 color;
    if (vPart < 0.5) {
        vec3 albedo = texture2D(uBark, vUv).rgb;
        vec3 nm = texture2D(uBarkNormal, vUv).xyz * 2.0 - 1.0;
        vec3 tangent = normalize(vec3(-n.y, n.x, 0.0));
        vec3 bitangent = vec3(0.0, 0.0, 1.0);
        n = normalize(tangent * nm.x + bitangent * nm.y + n * nm.z);
        color = shadeBark(albedo * vTint, n);
    } else {
        vec4 tex = texture2D(uFoliage, vUv, vLodBias);
        // Near fade: foliage within arm's reach of the eye thins out and vanishes, so a card
        // crossing the near plane never paints a band of stretched needles across the view.
        float fade = smoothstep(uNearFade.x, uNearFade.y, length(vView));
        if (tex.a * fade < 0.4) discard;
        // Needle cards: the crown interior sits in its own shadow, the edge catches sun through the needles and sky at the rim.
        vec3 albedo = tex.rgb * vTint * mix(1.0, mix(0.5, 1.0, vDepth), uNeedle);
        color = shadeFoliage(albedo, n);
        if (uNeedle > 0.5) {
            vec3 v = normalize(vView);
            float back = pow(max(dot(-v, uSunDir), 0.0), 3.0);
            float rim = pow(1.0 - abs(dot(n, v)), 3.0);
            color += (albedo * uSunColor * back * 0.2 + uSkyColor * rim * 0.04) * vDepth;
        }
    }
    gl_FragColor = vec4(mix(color, uFogColor, vFog), 1.0);
    #include <colorspace_fragment>
}
`;

/** Foliage alpha is 0 within NEAR_FADE_ZERO_M of the eye and back to full at NEAR_FADE_FULL_M. */
export const NEAR_FADE_ZERO_M = 1.5;
export const NEAR_FADE_FULL_M = 3.0;

export interface TreeTextures { foliage: Texture; bark: Texture; barkNormal: Texture }

export interface TreeMaterialOptions {
    /** Conifer needle shading (interior darkening, back-light, rim). */
    needle?: boolean;
    /** Card fraction kept beyond LOD_FULL_M; species-specific, see midFractionFor. */
    midFraction?: number;
}

export function treeMaterial(shared: SharedUniforms, textures: TreeTextures, options: TreeMaterialOptions = {}): ShaderMaterial {
    return new ShaderMaterial({
        uniforms: {
            ...shared,
            uLodFull: { value: LOD_FULL_M },
            uMidFraction: { value: options.midFraction ?? LOD_MID_FRACTION },
            uNeedle: { value: options.needle ? 1 : 0 },
            uCardFraction: { value: 0 },
            uEdgeCutoff: { value: 0.3 },
            uNearFade: { value: new Vector2(NEAR_FADE_ZERO_M, NEAR_FADE_FULL_M) },
            uFoliage: { value: textures.foliage },
            uBark: { value: textures.bark },
            uBarkNormal: { value: textures.barkNormal },
        },
        vertexShader: TREE_VERTEX,
        fragmentShader: TREE_FRAGMENT,
        side: DoubleSide,
        transparent: false,
        depthWrite: true,
        depthTest: true,
    });
}

// ---------------------------------------------------------------------------
// Impostor: crossed billboards with a baked whole-tree cell.
// ---------------------------------------------------------------------------
const IMPOSTOR_VERTEX = /* glsl */`
attribute vec3 aCorner;   // xy radius units, z height fraction
attribute vec3 iPos;
attribute vec4 iParams;   // radius, height, yaw, cell
attribute vec4 iExtra;    // scaleX, scaleY, phase, crown base raise (unused here)
attribute vec4 iTint;     // foliage tint rgb, lean
uniform vec3 uCamera;
uniform vec2 uCells;      // columns, rows
varying vec2 vUv;
varying vec3 vTint;
varying float vFog;
${SWAY_GLSL}
${LIGHTING_GLSL}
void main() {
    float radius = iParams.x, height = iParams.y, yaw = iParams.z, cell = iParams.w;
    float c = cos(yaw), s = sin(yaw);
    vec2 xy = aCorner.xy * radius * iExtra.xy;
    xy.x += aCorner.z * height * iTint.w;
    vec3 rotated = vec3(c * xy.x - s * xy.y, s * xy.x + c * xy.y, aCorner.z * height);
    rotated.xy += swayOffset(aCorner.z, iExtra.z, height) * 0.5;
    vec3 world = iPos + rotated;
    gl_Position = projectionMatrix * vec4(world, 1.0);
    float column = mod(cell, uCells.x), row = floor(cell / uCells.x);
    vUv = vec2((column + uv.x) / uCells.x, (row + uv.y) / uCells.y);
    vTint = iTint.rgb;
    vFog = fogAmount(distance(iPos, uCamera));
}
`;

const IMPOSTOR_FRAGMENT = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vTint;
varying float vFog;
${LIGHTING_GLSL}
void main() {
    vec4 tex = texture2D(uAtlas, vUv);
    if (tex.a < 0.4) discard;
    gl_FragColor = vec4(mix(tex.rgb * vTint, uFogColor, vFog), 1.0);
    #include <colorspace_fragment>
}
`;

export function impostorMaterial(shared: SharedUniforms, atlas: Texture): ShaderMaterial {
    return new ShaderMaterial({
        uniforms: { ...shared, uAtlas: { value: atlas }, uCells: { value: new Vector2(IMPOSTOR_COLUMNS, IMPOSTOR_ROWS) } },
        vertexShader: IMPOSTOR_VERTEX,
        fragmentShader: IMPOSTOR_FRAGMENT,
        side: DoubleSide,
        transparent: false,
        depthWrite: true,
    });
}

// ---------------------------------------------------------------------------
// Ground shadow decal: dark ellipse displaced away from the sun.
// ---------------------------------------------------------------------------
const SHADOW_VERTEX = /* glsl */`
attribute vec2 aCorner;   // [-1,1] quad
attribute vec3 iPos;      // x, y, ground
attribute vec4 iParams;   // radius, height, unused, stand (1 when the nearest neighbour is under STAND_SHADOW_DISTANCE_M)
uniform vec2 uShadowOffset; // metres of offset per metre of height
uniform vec3 uCamera;
varying vec2 vUv;
varying float vFade;
${LIGHTING_GLSL}
void main() {
    float radius = iParams.x, height = iParams.y, stand = iParams.w;
    vec2 dir = normalize(uShadowOffset + vec2(1e-5, 0.0));
    vec2 side = vec2(-dir.y, dir.x);
    // Ellipse: crown width across the sun, stretched along it by the height.
    // Stand trees get a 1.3x wider, darker decal so the floor under a stand darkens like the ortho undergrowth.
    float grow = 1.0 + 0.3 * stand;
    float across = radius * 1.15 * grow;
    float along = (radius * 1.15 + height * length(uShadowOffset) * 0.6) * grow;
    vec2 centre = iPos.xy + uShadowOffset * height;
    vec2 xy = centre + side * aCorner.x * across + dir * aCorner.y * along;
    // Sit just above the terrain so the decal does not z-fight with it.
    vec3 world = vec3(xy, iPos.z + 0.35);
    gl_Position = projectionMatrix * vec4(world, 1.0);
    vUv = uv;
    vFade = (1.0 - fogAmount(distance(iPos, uCamera)) * 1.4) * (1.0 + 0.5 * stand);
}
`;

const SHADOW_FRAGMENT = /* glsl */`
uniform sampler2D uDecal;
uniform float uStrength;
varying vec2 vUv;
varying float vFade;
void main() {
    vec4 tex = texture2D(uDecal, vUv);
    gl_FragColor = vec4(tex.rgb, tex.a * uStrength * clamp(vFade, 0.0, 1.5));
}
`;

export function shadowMaterial(shared: SharedUniforms, decal: Texture): ShaderMaterial {
    return new ShaderMaterial({
        uniforms: { ...shared, uDecal: { value: decal }, uShadowOffset: { value: shadowOffsetPerMetre() }, uStrength: { value: 0.55 } },
        vertexShader: SHADOW_VERTEX,
        fragmentShader: SHADOW_FRAGMENT,
        transparent: true,
        blending: NormalBlending,
        depthWrite: false,
        depthTest: true,
    });
}
