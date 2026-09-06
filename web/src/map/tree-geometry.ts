import { BufferGeometry, Color, Float32BufferAttribute, SphereGeometry, Uint16BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clusterCell, CONIFER_CELLS, rectUv, type ConiferSpecies } from './conifer-atlas';

/** Stems below this height render as shrubs (no trunk, crown on the ground); taller ones as trees. */
export const SHRUB_MAX_HEIGHT_M = 4;

/** Height-only split; the asset carries no species or form field. */
export function isShrubHeight(heightM: number): boolean {
    return heightM < SHRUB_MAX_HEIGHT_M;
}

// ---------------------------------------------------------------------------
// Species, variants, level of detail
// ---------------------------------------------------------------------------

export type Species = 'broadleaf' | 'spruce' | 'pine';
export const SPECIES: readonly Species[] = ['broadleaf', 'spruce', 'pine'];
/** Distinct card layouts per species; the layout is picked per stem from a position hash. */
export const VARIANTS = 4;

/** Asset `kind`: 0 broadleaf, 1 conifer, 2 unknown (absent in schema v1). Unknown renders as broadleaf. */
export function speciesFor(kind: number | undefined, hash: number): Species {
    if (kind === 1) return hash < 0.6 ? 'spruce' : 'pine';
    return 'broadleaf';
}

/** Deterministic [0,1) from EPSG:3006 coordinates; the same stem always gets the same look. */
export function stemHash(x: number, y: number, salt = 0): number {
    let h = (Math.imul(Math.round(x * 2) | 0, 374761393) + Math.imul(Math.round(y * 2) | 0, 668265263) + Math.imul(salt + 1, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function variantFor(hash: number): number {
    return Math.min(VARIANTS - 1, Math.floor(hash * VARIANTS));
}

/** 0: every card; 1: three quarters of the cards and a coarser atlas mip; 2: crossed impostor billboards. */
export type TreeLod = 0 | 1 | 2;
export const LOD_FULL_M = 150;
export const LOD_HALF_M = 600;
/** Broadleaf card fraction kept between LOD_FULL_M and LOD_HALF_M. Half left mid-distance crowns with holes. */
export const LOD_MID_FRACTION = 0.75;
/** Conifer fraction at the same distances: half the cluster cards go. */
export const CONIFER_LOD_MID_FRACTION = 0.5;

export function midFractionFor(species: Species): number {
    return species === 'broadleaf' ? LOD_MID_FRACTION : CONIFER_LOD_MID_FRACTION;
}

export function lodFor(distanceM: number, fullM = LOD_FULL_M, halfM = LOD_HALF_M): TreeLod {
    return distanceM < fullM ? 0 : distanceM < halfM ? 1 : 2;
}

/**
 * Fraction of the total height where the crown starts. Visual choice, not measured:
 * broadleaf 35 to 45 percent (stand trees carry a crown ratio near one half),
 * spruce from 15 percent, pine bare to 40 to 50 percent.
 */
export function crownBaseFraction(species: Species, variant: number): number {
    const t = variant / Math.max(1, VARIANTS - 1);
    if (species === 'broadleaf') return 0.35 + 0.10 * t;
    if (species === 'spruce') return 0.15;
    return 0.40 + 0.10 * t;
}

/**
 * The pipeline caps a crown radius at this fraction of height unless it measured a
 * flat, compact crown (trees_stems.py, is_flat_crown). A data radius above it is
 * therefore a measured wide crown, such as a willow, and is drawn as given.
 */
export const PIPELINE_CROWN_RADIUS_PER_HEIGHT = 0.35;
export const MEASURED_CROWN_MAX_RADIUS_M = 10;

/**
 * Crown radius used for rendering. The lidar watershed radius in a closed stand
 * is the stem's share of the canopy, not its crown, so trees came out as poles
 * with a tuft. Crown width follows height instead, with the data radius as a
 * floor and a cap so isolated wide watersheds do not balloon. A data radius above
 * the pipeline's own cap is a measured flat crown and wins over the cap.
 */
export function renderCrownRadius(species: Species, heightM: number, dataRadiusM: number): number {
    if (dataRadiusM > PIPELINE_CROWN_RADIUS_PER_HEIGHT * heightM + 0.05) return Math.min(dataRadiusM, MEASURED_CROWN_MAX_RADIUS_M);
    const [floor, cap] = species === 'broadleaf' ? [0.25, 0.45] : species === 'spruce' ? [0.14, 0.30] : [0.18, 0.35];
    return Math.min(cap * heightM, Math.max(dataRadiusM, floor * heightM));
}

/** Trunk radius at the ground in metres; the rings taper to TRUNK_TOP_TAPER of this at the trunk top. */
export function trunkBaseRadius(heightM: number): number {
    return 0.012 * heightM + 0.1;
}
export const TRUNK_TOP_TAPER = 0.3;

/** Per-instance trunk lean as tan(angle); 2 to 4 degrees from a [0,1) hash. */
export function leanFor(hash: number): number {
    return Math.tan((2 + 2 * hash) * Math.PI / 180);
}

// ---------------------------------------------------------------------------
// Stand adjustment: stems in closed stands sit 2 to 4 m apart, and once every
// crown is widened to a fraction of its height neighbours would merge into one
// blob. A spatial hash finds close pairs; the smaller crown shrinks and its
// base rises. The nearest-neighbour distance also drives the darker, wider
// shadow decal under stands.
// ---------------------------------------------------------------------------
export const STAND_MERGE_DISTANCE_M = 2.5;
export const STAND_SHADOW_DISTANCE_M = 8;
const STAND_SHRINK = 0.65;
const STAND_MIN_SHRINK = 0.45;
const STAND_BASE_RAISE = 0.12;

export interface StandStem {
    x: number; y: number; height: number; radius: number; shrub: boolean;
    /** Crown base raise as a fraction of the crown span (0 for free-standing trees). */
    baseRaise: number;
    /** Horizontal distance to the nearest other tree in metres (Infinity when none within the hash reach). */
    nearestM: number;
}

export function adjustStand(stems: StandStem[]): void {
    const cell = STAND_SHADOW_DISTANCE_M;
    const grid = new Map<string, number[]>();
    const key = (cx: number, cy: number) => `${cx},${cy}`;
    stems.forEach((stem, i) => {
        stem.nearestM = Infinity;
        stem.baseRaise = 0;
        if (stem.shrub) return;
        const k = key(Math.floor(stem.x / cell), Math.floor(stem.y / cell));
        const bucket = grid.get(k);
        if (bucket) bucket.push(i); else grid.set(k, [i]);
    });
    const original = stems.map(stem => stem.radius);
    stems.forEach((stem, i) => {
        if (stem.shrub) return;
        const cx = Math.floor(stem.x / cell), cy = Math.floor(stem.y / cell);
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
            const bucket = grid.get(key(cx + ox, cy + oy));
            if (!bucket) continue;
            for (const j of bucket) {
                if (j === i) continue;
                const other = stems[j];
                const d = Math.hypot(other.x - stem.x, other.y - stem.y);
                if (d < stem.nearestM) stem.nearestM = d;
                // Each close pair is handled once, from the lower index.
                if (j < i || d >= STAND_MERGE_DISTANCE_M) continue;
                const smaller = other.radius < stem.radius || (other.radius === stem.radius && other.height <= stem.height) ? j : i;
                const target = stems[smaller];
                target.radius = Math.max(original[smaller] * STAND_MIN_SHRINK, target.radius * STAND_SHRINK);
                target.baseRaise = Math.max(target.baseRaise, STAND_BASE_RAISE);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tree geometry: one buffer per species holding all variants.
//
// Vertex attributes (consumed by tree-material.ts):
//   aCenter  vec3  xy in crown-radius units (or unit-circle * taper for trunks), z as a height fraction
//   aCorner  vec3  isotropic offset from the centre in crown-radius units (cards keep their aspect)
//   uv       vec2  atlas coordinates
//   normal   vec3  shading normal (ellipsoid/cone normals for cards, radial for trunks)
//   aInfo    vec4  variant, lodRank, part (0 trunk, 1 foliage), sway weight
//   aCardNormal vec3 geometric plane normal of a card (zero for trunks); edge-on cards are dropped
//   aDepth   float 0 at the trunk axis, 1 at the crown edge; conifer needle shading darkens the interior (broadleaf: 1)
// The vertex shader collapses cards whose variant differs from the instance
// or whose lodRank exceeds the distance-driven fraction.
// ---------------------------------------------------------------------------

function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class TreeBuilder {
    readonly centers: number[] = [];
    readonly corners: number[] = [];
    readonly uvs: number[] = [];
    readonly normals: number[] = [];
    readonly infos: number[] = [];
    readonly cardNormals: number[] = [];
    readonly depths: number[] = [];
    readonly indices: number[] = [];
    cards = 0;
    private vertexCount = 0;

    vertex(center: readonly number[], corner: readonly number[], uv: readonly number[], normal: readonly number[], info: readonly number[],
        cardNormal: readonly number[] = [0, 0, 0], depth = 1): number {
        this.cardNormals.push(cardNormal[0], cardNormal[1], cardNormal[2]);
        this.depths.push(depth);
        this.centers.push(center[0], center[1], center[2]);
        this.corners.push(corner[0], corner[1], corner[2]);
        this.uvs.push(uv[0], uv[1]);
        const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
        this.normals.push(normal[0] / len, normal[1] / len, normal[2] / len);
        this.infos.push(info[0], info[1], info[2], info[3]);
        return this.vertexCount++;
    }

    quad(a: number, b: number, c: number, d: number): void {
        this.indices.push(a, b, c, a, c, d);
    }

    build(): BufferGeometry {
        const geometry = new BufferGeometry();
        geometry.setAttribute('aCenter', new Float32BufferAttribute(this.centers, 3));
        geometry.setAttribute('aCorner', new Float32BufferAttribute(this.corners, 3));
        geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
        geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
        geometry.setAttribute('aInfo', new Float32BufferAttribute(this.infos, 4));
        geometry.setAttribute('aCardNormal', new Float32BufferAttribute(this.cardNormals, 3));
        geometry.setAttribute('aDepth', new Float32BufferAttribute(this.depths, 1));
        geometry.setIndex(new Uint16BufferAttribute(this.indices, 1));
        // The shader positions vertices itself; keep a placeholder position so three.js is happy.
        geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(this.vertexCount * 3), 3));
        return geometry;
    }
}

/** Rank cards so that a fixed fraction of any variant survives the mid-detail level. */
function lodRanks(count: number, random: () => number): number[] {
    const ranks = Array.from({ length: count }, (_, i) => (i + 0.5) / count);
    for (let i = ranks.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
    }
    return ranks;
}

const TRUNK_SEGMENTS = 8;
const BARK_REPEAT_V = 3;

/**
 * Tapered trunk. `top` is the height fraction where the trunk ends; `barkHalf` picks the light (0)
 * or dark (1) bark column. xy is in trunk-base-radius units: a small root flare at the ground,
 * then a taper to TRUNK_TOP_TAPER at the top.
 */
function addTrunk(builder: TreeBuilder, variant: number, top: number, barkHalf: number, swayTop: number): void {
    const rings = [0, 0.25, 0.5, 0.75, 1].map(f => f * top);
    const tapers = [1.12, 0.9, 0.7, 0.5, TRUNK_TOP_TAPER];
    const ringStart: number[] = [];
    for (let r = 0; r < rings.length; r++) {
        ringStart.push(builder.centers.length / 3);
        for (let s = 0; s <= TRUNK_SEGMENTS; s++) {
            const angle = (s / TRUNK_SEGMENTS) * Math.PI * 2;
            builder.vertex([Math.cos(angle) * tapers[r], Math.sin(angle) * tapers[r], rings[r]], [0, 0, 0],
                [barkHalf * 0.5 + (s / TRUNK_SEGMENTS) * 0.5, rings[r] * BARK_REPEAT_V],
                [Math.cos(angle), Math.sin(angle), 0], [variant, 0, 0, swayTop * rings[r] * rings[r]]);
        }
    }
    for (let r = 0; r < rings.length - 1; r++) for (let s = 0; s < TRUNK_SEGMENTS; s++) {
        const a = ringStart[r] + s, b = ringStart[r] + s + 1, c = ringStart[r + 1] + s + 1, d = ringStart[r + 1] + s;
        builder.quad(a, b, c, d);
    }
}

/**
 * Dead branch stubs low on the trunk: thin bark-textured quads in the vertical plane
 * through the axis, from inside the trunk out to `reach` trunk radii, tilted up a little.
 */
function addBranchStubs(builder: TreeBuilder, variant: number, random: () => number, count: number, zLow: number, zHigh: number, barkHalf: number): void {
    for (let k = 0; k < count; k++) {
        const angle = random() * Math.PI * 2, z0 = zLow + random() * (zHigh - zLow);
        const reach = 1.7 + random() * 0.9, lift = 0.02 + random() * 0.025, thick = 0.003 + random() * 0.002;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        const normal = [dx * 0.3, dy * 0.3, 1];
        const u0 = barkHalf * 0.5, u1 = barkHalf * 0.5 + 0.2;
        const a = builder.vertex([dx * 0.7, dy * 0.7, z0 - thick], [0, 0, 0], [u0, 0], normal, [variant, 0, 0, 0]);
        const b = builder.vertex([dx * reach, dy * reach, z0 + lift - thick * 0.4], [0, 0, 0], [u1, 0], normal, [variant, 0, 0, 0]);
        const c = builder.vertex([dx * reach, dy * reach, z0 + lift + thick * 0.4], [0, 0, 0], [u1, 0.15], normal, [variant, 0, 0, 0]);
        const d = builder.vertex([dx * 0.7, dy * 0.7, z0 + thick], [0, 0, 0], [u0, 0.15], normal, [variant, 0, 0, 0]);
        builder.quad(a, b, c, d);
    }
}

/** Rotation of a card: returns two orthonormal in-plane axes and the normal, from random Euler angles. */
function randomFrame(random: () => number): { u: number[]; v: number[]; n: number[] } {
    const yaw = random() * Math.PI * 2, pitch = (random() - 0.5) * Math.PI * 0.9, roll = random() * Math.PI * 2;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // Rz(yaw) * Ry(pitch) * Rx(roll) applied to the basis vectors.
    const rotate = (x: number, y: number, z: number): number[] => {
        const y1 = y * cr - z * sr, z1 = y * sr + z * cr;
        const x2 = x * cp + z1 * sp, z2 = -x * sp + z1 * cp;
        return [x2 * cy - y1 * sy, x2 * sy + y1 * cy, z2];
    };
    return { u: rotate(1, 0, 0), v: rotate(0, 1, 0), n: rotate(0, 0, 1) };
}

/** Variants that carry low sparse foliage (epicormic sprouts) and dead branch stubs on the trunk. */
export const BROADLEAF_LOW_FOLIAGE_VARIANTS: readonly number[] = [1];
export const BROADLEAF_STUB_VARIANTS: readonly number[] = [1, 2];
/** Card count range per broadleaf variant, the low foliage cards included. */
export const BROADLEAF_CARDS_MIN = 22;
export const BROADLEAF_CARDS_MAX = 30;

/** Crown half-width profile at crown fraction u (0 base, 1 top): widest at 40 percent, ragged wide base, rounded top. */
function broadleafProfile(u: number): number {
    return Math.sqrt(Math.max(0.1, 1 - ((u - 0.42) / 0.62) ** 2));
}

/** One randomly rotated square foliage card at crown-radius-unit position (nx, ny) and height fraction centerZ. */
function addFoliageCard(builder: TreeBuilder, variant: number, random: () => number, nx: number, ny: number, nz: number, centerZ: number,
    half: number, rank: number, sway: number): void {
    const frame = randomFrame(random);
    const cell = Math.floor(random() * 4);
    const cellU = (cell % 2) * 0.5, cellV = Math.floor(cell / 2) * 0.5;
    const flip = random() < 0.5;
    const corners: number[] = [];
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const offset = [
            (frame.u[0] * cu + frame.v[0] * cv) * half,
            (frame.u[1] * cu + frame.v[1] * cv) * half,
            (frame.u[2] * cu + frame.v[2] * cv) * half,
        ];
        // Ellipsoid normal: the direction of this corner from the crown centre, blended with the card normal.
        const normal = [nx * 1.2 + offset[0] * 0.8, ny * 1.2 + offset[1] * 0.8, nz * 0.9 + offset[2] * 0.4 + 0.25];
        const u = cellU + ((flip ? -cu : cu) * 0.5 + 0.5) * 0.5, v = cellV + (cv * 0.5 + 0.5) * 0.5;
        corners.push(builder.vertex([nx, ny, centerZ], offset, [u, v], normal, [variant, rank, 1, sway], frame.n));
    }
    builder.quad(corners[0], corners[1], corners[2], corners[3]);
    builder.cards++;
}

/**
 * Broadleaf: 22 to 30 randomly rotated cards filling the crown volume from base to
 * top. Cards are placed by crown fraction (with a guaranteed share in the lowest
 * quarter) inside a profile that is widest at 40 percent of the crown, so the lower
 * crown is as full as the top. Cards are square in metres (42 to 70 percent of the
 * crown radius as half-size), so a tall narrow crown gets more overlap, not stretched
 * cards. Some variants add low sparse foliage near the trunk and dead branch stubs.
 */
function addBroadleafVariant(builder: TreeBuilder, variant: number): void {
    const random = seeded(1000 + variant);
    const base = crownBaseFraction('broadleaf', variant);
    const cardCount = 22 + Math.floor(random() * 6);
    const sprouts = BROADLEAF_LOW_FOLIAGE_VARIANTS.includes(variant) ? 3 : 0;
    const ranks = lodRanks(cardCount + sprouts, random);
    addTrunk(builder, variant, base + (1 - base) * 0.55, 0, 0.3);
    if (BROADLEAF_STUB_VARIANTS.includes(variant)) addBranchStubs(builder, variant, random, 2, 0.18, base * 0.8, 0);
    const lowCards = 6;
    for (let i = 0; i < cardCount; i++) {
        // Crown fraction: the first cards fill the lowest quarter, the rest spread with a slight downward bias.
        const u = i < lowCards ? random() * 0.25 : Math.pow(random(), 0.9);
        const reach = broadleafProfile(u);
        const angle = random() * Math.PI * 2, rho = reach * (0.15 + 0.7 * Math.sqrt(random()));
        const nx = Math.cos(angle) * rho, ny = Math.sin(angle) * rho, nz = (u - 0.45) * 1.6;
        const half = 0.42 + random() * 0.28;
        const centerZ = base + u * (1 - base);
        const sway = 0.35 + 0.65 * u;
        addFoliageCard(builder, variant, random, nx, ny, nz, centerZ, half, ranks[i], sway);
    }
    // Sparse sprouts on the lower trunk at eye level.
    for (let k = 0; k < sprouts; k++) {
        const angle = random() * Math.PI * 2, rho = 0.10 + random() * 0.12;
        const centerZ = 0.20 + random() * 0.14;
        addFoliageCard(builder, variant, random, Math.cos(angle) * rho, Math.sin(angle) * rho, -0.4, centerZ, 0.13 + random() * 0.07, ranks[cardCount + k], 0.15);
    }
}

// ---------------------------------------------------------------------------
// Conifer: a volume fill of small needle-cluster cards, the same principle as
// the broadleaf crown. No card spans a tier or the crown height; every card is a
// roughly square quad, 18 to 28 percent of the local crown diameter, at a random
// azimuth and height inside the cone (spruce: spire from 15 percent of the
// height; pine: bare trunk, then a deep irregular umbrella). Seventy percent of
// the cards sit at the cone surface and thirty percent inside it to hide the
// trunk. Each card faces outward with a species droop plus yaw and roll jitter,
// so no two cards share a plane and the crown reads as a mass of clusters.
// ---------------------------------------------------------------------------
export const CONIFER_CARDS_MIN = 60;
export const CONIFER_CARDS_MAX = 84;
/** Card side as a fraction of the local crown diameter (radius floored at CONIFER_SIZE_RADIUS_FLOOR). */
export const CONIFER_CARD_SIZE: readonly [number, number] = [0.26, 0.4];
/** Local crown radius floor used to size cards near the spire, crown-radius units. */
export const CONIFER_SIZE_RADIUS_FLOOR = 0.5;
/** Share of the cards placed inside the cone rather than at its surface. */
export const CONIFER_INTERIOR_FRACTION = 0.3;
/** Interior cards sit inside this fraction of the local radius; surface cards outside CONIFER_SURFACE_MIN. */
export const CONIFER_INTERIOR_MAX = 0.6;
export const CONIFER_SURFACE_MIN = 0.78;
/** Card normal elevation above horizontal, degrees: the plane droops outward and down (spruce more than pine). */
export const CONIFER_DROOP_DEG: Record<ConiferSpecies, readonly [number, number]> = { spruce: [25, 50], pine: [5, 25] };
/** Random yaw (about the vertical) and roll (about the normal) either way, degrees. */
export const CONIFER_JITTER_DEG = 35;

/** Crown radius profile at crown fraction f (0 base, 1 top), crown-radius units. */
export function coniferProfile(species: ConiferSpecies, f: number): number {
    if (species === 'spruce') return Math.max(0.12, (1 - f) ** 0.85);
    // Pine umbrella: widest at 40 percent of the crown, still broad at the top, narrower under the dome.
    return Math.max(0.3, Math.sqrt(Math.max(0, 1 - ((f - 0.4) / 0.65) ** 2)));
}

function cross(a: readonly number[], b: readonly number[]): number[] {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Rotates vector p about unit axis k by angle a (Rodrigues). */
function rotateAbout(p: readonly number[], k: readonly number[], a: number): number[] {
    const c = Math.cos(a), s = Math.sin(a), d = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
    return [
        p[0] * c + (k[1] * p[2] - k[2] * p[1]) * s + k[0] * d * (1 - c),
        p[1] * c + (k[2] * p[0] - k[0] * p[2]) * s + k[1] * d * (1 - c),
        p[2] * c + (k[0] * p[1] - k[1] * p[0]) * s + k[2] * d * (1 - c),
    ];
}

function addClusterCard(builder: TreeBuilder, species: ConiferSpecies, variant: number, random: () => number,
    azimuth: number, rho: number, localRadius: number, centerZ: number, half: number, rank: number, sway: number): void {
    const [droopMin, droopMax] = CONIFER_DROOP_DEG[species];
    const droop = (droopMin + random() * (droopMax - droopMin)) * Math.PI / 180;
    const yawJitter = (random() * 2 - 1) * CONIFER_JITTER_DEG * Math.PI / 180;
    const roll = (random() * 2 - 1) * CONIFER_JITTER_DEG * Math.PI / 180;
    const a = azimuth + yawJitter;
    // Normal: outward and up by the droop; the plane hangs outward and down like a branch end.
    const n0 = [Math.cos(a) * Math.cos(droop), Math.sin(a) * Math.cos(droop), Math.sin(droop)];
    const side0 = [-Math.sin(a), Math.cos(a), 0];
    const u = rotateAbout(side0, n0, roll);
    const v = cross(n0, u); // in-plane up, outward-leaning
    const uv = rectUv(clusterCell(species, Math.floor(random() * CONIFER_CELLS)));
    const flip = random() < 0.5;
    const nx = Math.cos(azimuth) * rho, ny = Math.sin(azimuth) * rho;
    const depth = Math.min(1, rho / Math.max(1e-6, localRadius));
    const corners: number[] = [];
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const offset = [(u[0] * cu + v[0] * cv) * half, (u[1] * cu + v[1] * cv) * half, (u[2] * cu + v[2] * cv) * half];
        // Cone normal at the card, blended with the corner offset so the card shades across its face.
        const lift = species === 'spruce' ? 0.45 : 0.6;
        const normal = [Math.cos(azimuth) + offset[0] * 0.8, Math.sin(azimuth) + offset[1] * 0.8, lift + offset[2] * 0.5];
        const tu = flip ? uv.u1 - (cu * 0.5 + 0.5) * (uv.u1 - uv.u0) : uv.u0 + (cu * 0.5 + 0.5) * (uv.u1 - uv.u0);
        const tv = uv.vBottom + (cv * 0.5 + 0.5) * (uv.vTop - uv.vBottom);
        corners.push(builder.vertex([nx, ny, centerZ], offset, [tu, tv], normal, [variant, rank, 1, sway], n0, depth));
    }
    builder.quad(corners[0], corners[1], corners[2], corners[3]);
    builder.cards++;
}

function addConiferVariant(builder: TreeBuilder, species: ConiferSpecies, variant: number): void {
    const random = seeded((species === 'spruce' ? 2000 : 3000) + variant);
    const base = crownBaseFraction(species, variant);
    const span = 1 - base;
    const spruce = species === 'spruce';
    addTrunk(builder, variant, 0.97, spruce ? 1 : 0, 0.15);
    const cardCount = CONIFER_CARDS_MIN + Math.floor(random() * (CONIFER_CARDS_MAX - CONIFER_CARDS_MIN + 1));
    const ranks = lodRanks(cardCount, random);
    const interior = Math.round(cardCount * CONIFER_INTERIOR_FRACTION);
    const [sizeMin, sizeMax] = CONIFER_CARD_SIZE;
    for (let i = 0; i < cardCount; i++) {
        // Height: denser in the lower tiers (spruce) or through the dome (pine).
        const f = spruce ? Math.pow(random(), 1.3) : 0.05 + 0.95 * Math.pow(random(), 0.9);
        const localRadius = coniferProfile(species, f);
        const rho = i < interior
            ? localRadius * (0.1 + random() * (CONIFER_INTERIOR_MAX - 0.1))
            : localRadius * (CONIFER_SURFACE_MIN + random() * (1 - CONIFER_SURFACE_MIN));
        const azimuth = random() * Math.PI * 2;
        const side = (sizeMin + random() * (sizeMax - sizeMin)) * 2 * Math.max(localRadius, CONIFER_SIZE_RADIUS_FLOOR);
        addClusterCard(builder, species, variant, random, azimuth, rho, localRadius, base + span * f, side / 2, ranks[i], 0.25 + 0.75 * f);
    }
}

export interface TreeGeometryInfo { geometry: BufferGeometry; cards: number; vertices: number }

/** All variants of one species in a single indexed geometry (instanced by the layer). */
export function treeGeometry(species: Species): TreeGeometryInfo {
    const builder = new TreeBuilder();
    for (let variant = 0; variant < VARIANTS; variant++) {
        if (species === 'broadleaf') addBroadleafVariant(builder, variant);
        else addConiferVariant(builder, species, variant);
    }
    return { geometry: builder.build(), cards: builder.cards, vertices: builder.centers.length / 3 };
}

/** Fraction of a variant's foliage cards the vertex shader keeps at a level of detail. */
export function cardFractionAtLod(lod: TreeLod, species: Species = 'broadleaf'): number {
    return lod === 0 ? 1 : lod === 1 ? midFractionFor(species) : 0;
}

// ---------------------------------------------------------------------------
// Impostor (LOD 2): two crossed vertical quads. aCorner.xy in radius units,
// aCorner.z is a height fraction; uv is the cell-local [0,1] square and the
// instance picks the cell.
// ---------------------------------------------------------------------------
export const IMPOSTOR_HALF_WIDTH = 1.35;
export const IMPOSTOR_COLUMNS = VARIANTS;
export const IMPOSTOR_ROWS = SPECIES.length;

export function impostorGeometry(): BufferGeometry {
    const corners: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let k = 0; k < 2; k++) {
        const angle = k * Math.PI / 2;
        const dx = Math.cos(angle) * IMPOSTOR_HALF_WIDTH, dy = Math.sin(angle) * IMPOSTOR_HALF_WIDTH;
        const start = corners.length / 3;
        corners.push(-dx, -dy, 0, dx, dy, 0, dx, dy, 1, -dx, -dy, 1);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('aCorner', new Float32BufferAttribute(corners, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(corners.length), 3));
    geometry.setIndex(indices);
    return geometry;
}

export function impostorCell(species: Species, variant: number): number {
    return SPECIES.indexOf(species) * IMPOSTOR_COLUMNS + variant;
}

/** Canonical height (metres) at radius 1 used when baking each species' impostor; matches the renderCrownRadius floors. */
export function impostorBakeHeight(species: Species): number {
    return species === 'broadleaf' ? 3.5 : species === 'spruce' ? 6.5 : 5;
}

// ---------------------------------------------------------------------------
// Ground shadow decal: a unit quad in XY (corner in [-1,1]) instanced per tree.
// ---------------------------------------------------------------------------
export function shadowGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('aCorner', new Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(12), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    return geometry;
}

// ---------------------------------------------------------------------------
// Shrub: a flattened, lumpy ellipsoid resting on the ground. Unit XY radius
// is the measured crown radius; Z spans 0..1 and scales to measured height.
// Kept from the first renderer; stems under 4 m still use it.
// ---------------------------------------------------------------------------
export function shrubGeometry(detailed: boolean): BufferGeometry {
    const pieces: BufferGeometry[] = [];
    const count = detailed ? 9 : 5;
    const color = new Color();
    for (let n = 0; n < count; n++) {
        const angle = n * 2.399963;
        const offset = n === 0 ? 0 : 0.42;
        const radius = n === 0 ? 0.72 : 0.56;
        const geometry = new SphereGeometry(1, detailed ? 9 : 7, detailed ? 6 : 5);
        const positions = geometry.getAttribute('position');
        const colors: number[] = [];
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
            const ripple = 0.92 + 0.08 * Math.sin(x * 9 + n) * Math.sin(y * 8 + z * 7);
            // The sphere's polar axis (y) becomes up, so the pole vertices land exactly
            // at 0 (ground) and 1 (measured height); side lumps stay lower.
            const zUnit = (0.5 + y * 0.5) * (n === 0 ? 1 : 0.85);
            positions.setXYZ(i, Math.cos(angle) * offset + x * radius * ripple,
                Math.sin(angle) * offset + z * radius * ripple, zUnit);
            const light = 0.56 + 0.16 * (y + 1) / 2 + 0.08 * Math.sin(x * 15 + z * 19 + n) ** 2;
            color.setRGB(light * 0.88, light, light * 0.78);
            colors.push(color.r, color.g, color.b);
        }
        geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
        geometry.computeVertexNormals();
        pieces.push(geometry);
    }
    const merged = mergeGeometries(pieces)!;
    pieces.forEach(piece => piece.dispose());
    return merged;
}
