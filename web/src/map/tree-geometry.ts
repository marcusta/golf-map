import { BufferGeometry, Float32BufferAttribute } from 'three';
export { shrubGeometry } from './shrub-geometry';
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
/** Distinct crown forms per species, picked per stem from a position hash. */
export const VARIANTS = 4;

/** Asset `kind`: 0 broadleaf, 1 conifer, 2 unknown (absent in schema v1). Unknown renders as broadleaf. */
export function speciesFor(kind: number | undefined, hash: number): Species {
    if (kind === 1) return hash < 0.3 ? 'spruce' : 'pine';
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
/** Keep the two crossed main surfaces of every conifer spray; omit its third surface. */
export const CONIFER_LOD_MID_FRACTION = 2 / 3;

export function midFractionFor(species: Species): number {
    return species === 'broadleaf' ? LOD_MID_FRACTION : CONIFER_LOD_MID_FRACTION;
}

export function lodFor(distanceM: number, fullM = LOD_FULL_M, halfM = LOD_HALF_M): TreeLod {
    return distanceM < fullM ? 0 : distanceM < halfM ? 1 : 2;
}

/**
 * Fraction of the total height where the crown starts. Visual choice, not measured:
 * broadleaf 35 to 45 percent (stand trees carry a crown ratio near one half),
 * spruce from 12 to 30 percent, pine bare to 46 to 68 percent.
 */
export function crownBaseFraction(species: Species, variant: number): number {
    const t = variant / Math.max(1, VARIANTS - 1);
    if (species === 'broadleaf') return 0.35 + 0.10 * t;
    if (species === 'spruce') return [0.12, 0.30, 0.20, 0.16][variant];
    return [0.46, 0.68, 0.61, 0.58][variant];
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
//   aInfo    vec4  variant, lodRank, part (0 trunk, 1 foliage, 2 crown-scaled branch), sway weight
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
        geometry.setIndex(this.indices);
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
function addTrunk(builder: TreeBuilder, variant: number, top: number, barkHalf: number, swayTop: number, topTaper = TRUNK_TOP_TAPER): void {
    const rings = [0, 0.25, 0.5, 0.75, 1].map(f => f * top);
    const tapers = topTaper === TRUNK_TOP_TAPER ? [1.12, 0.9, 0.7, 0.5, topTaper] : [1.12, 0.82, 0.56, 0.28, topTaper];
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
// Conifers grow from connected woody branches. Needle sprays follow the branches,
// with three folded surfaces per spray. Medium detail retains two crossed surfaces
// at EVERY attachment, preserving the crown instead of removing random clusters.
// ---------------------------------------------------------------------------
export const CONIFER_FORM_NAMES: Record<ConiferSpecies, readonly string[]> = {
    spruce: ['full crown', 'forest spire', 'old irregular', 'slender crown'],
    pine: ['young crown', 'high spreading', 'asymmetric', 'broad crown'],
};
export const CONIFER_TOP_TAPER = 0.025;
type Point = readonly [number, number, number];
const mixPoint = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Branch envelope, not a surface to scatter foliage over. */
export function coniferProfile(species: ConiferSpecies, f: number): number {
    if (species === 'spruce') return Math.max(0.035, (1 - f) ** 0.8);
    return Math.max(0.12, Math.sin(Math.PI * (0.10 + 0.86 * f)) ** 0.65);
}

/** Five-sided tapered tube. Centres use crown XY / height Z, offsets use crown units. */
function addBranch(builder: TreeBuilder, variant: number, species: ConiferSpecies, points: readonly Point[], thickness: number): void {
    const aspect = impostorBakeHeight(species);
    const first = builder.centers.length / 3;
    const sides = 5;
    for (let r = 0; r < points.length; r++) {
        const p = points[r], before = points[Math.max(0, r - 1)], after = points[Math.min(points.length - 1, r + 1)];
        const dx = after[0] - before[0], dy = after[1] - before[1], dz = (after[2] - before[2]) * aspect;
        const length = Math.hypot(dx, dy, dz) || 1, horizontal = Math.hypot(dx, dy) || 1;
        const u = [-dy / horizontal, dx / horizontal, 0];
        const v = [-dz * u[1] / length, dz * u[0] / length, (dx * u[1] - dy * u[0]) / length];
        const radius = thickness * (1 - 0.92 * r / (points.length - 1));
        for (let k = 0; k <= sides; k++) {
            const angle = k / sides * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
            const n = [u[0] * c + v[0] * s, u[1] * c + v[1] * s, v[2] * s];
            builder.vertex(p, n.map(x => x * radius), [(species === 'spruce' ? 0.5 : 0) + k / sides * 0.5, r * 0.7], n, [variant, 0, 2, 0]);
        }
    }
    for (let r = 0; r < points.length - 1; r++) for (let k = 0; k < sides; k++) {
        const a = first + r * (sides + 1) + k, b = a + sides + 1;
        builder.quad(a, a + 1, b + 1, b);
    }
}

/** A needle spray centred on wood, with a bent midrib and three non-coplanar surfaces. */
function addNeedleSpray(builder: TreeBuilder, species: ConiferSpecies, variant: number, random: () => number,
    centre: Point, azimuth: number, length: number, width: number): void {
    const uv = rectUv(clusterCell(species, Math.floor(random() * CONIFER_CELLS)));
    const pitch = species === 'spruce' ? -0.55 - random() * 0.30 : 0.15 + random() * 0.45;
    const axis = [Math.cos(azimuth) * Math.cos(pitch), Math.sin(azimuth) * Math.cos(pitch), Math.sin(pitch)];
    const side = [-Math.sin(azimuth), Math.cos(azimuth), 0];
    const up = [-axis[2] * side[1], axis[2] * side[0], Math.cos(pitch)];
    const twist = random() * 0.6;
    for (let face = 0; face < 3; face++) {
        const angle = twist + face * Math.PI / 3;
        const across = side.map((x, i) => x * Math.cos(angle) + up[i] * Math.sin(angle));
        const normal = side.map((x, i) => -x * Math.sin(angle) + up[i] * Math.cos(angle));
        const start = builder.centers.length / 3;
        // Two panels share a raised midrib: the spray has depth even at medium detail.
        for (let row = 0; row < 3; row++) for (let col = 0; col < 2; col++) {
            const x = (col * 2 - 1) * length * 0.5, y = (row - 1) * width * 0.5;
            const fold = row === 1 ? width * 0.18 : 0;
            const offset = axis.map((v, i) => v * x + across[i] * y + normal[i] * fold);
            // Rounded spray normals, independent of the plane orientation.
            const n = [Math.cos(azimuth) * 0.55 + normal[0] * 0.25, Math.sin(azimuth) * 0.55 + normal[1] * 0.25, 0.65 + (row - 1) * 0.15];
            builder.vertex(centre, offset, [uv.u0 + col * (uv.u1 - uv.u0), uv.vBottom + row / 2 * (uv.vTop - uv.vBottom)],
                n, [variant, (face + 0.5) / 3, 1, 0], [0, 0, 0], 0.65 + 0.35 * Math.min(1, Math.hypot(centre[0], centre[1])));
        }
        builder.quad(start, start + 1, start + 3, start + 2);
        builder.quad(start + 2, start + 3, start + 5, start + 4);
        builder.cards++;
    }
}

function addConiferVariant(builder: TreeBuilder, species: ConiferSpecies, variant: number): void {
    const random = seeded((species === 'spruce' ? 2000 : 3000) + variant);
    const spruce = species === 'spruce', base = crownBaseFraction(species, variant);
    const tiers = spruce ? [13, 12, 11, 14][variant] : [8, 7, 8, 9][variant];
    const width = spruce ? [1, 0.80, 1, 0.73][variant] : [0.78, 1, 0.94, 1][variant];
    addTrunk(builder, variant, 0.985, spruce ? 1 : 0, 0.15, CONIFER_TOP_TAPER);
    for (let tier = 0; tier < tiers; tier++) {
        const progress = tier / (tiers - 1);
        const f = spruce ? 1 - (1 - progress) ** 1.25 : progress;
        const z = base + (0.98 - base) * f;
        const count = spruce ? 6 + (tier % 2) : 4 + (tier % 3);
        const rotation = tier * 2.39996 + random() * 0.5;
        for (let b = 0; b < count; b++) {
            const angle = rotation + b / count * Math.PI * 2 + (random() - 0.5) * 0.35;
            const asymmetry = variant === 2 ? 0.76 + 0.24 * Math.cos(angle - 0.7) : 1;
            const reach = coniferProfile(species, f) * width * asymmetry * (0.82 + random() * 0.18);
            const dz = spruce ? -0.015 - (1 - f) * 0.022 : 0.045 + random() * 0.065;
            const root: Point = [0, 0, z + (random() - 0.5) * 0.03];
            const elbow: Point = [Math.cos(angle) * reach * 0.48, Math.sin(angle) * reach * 0.48, root[2] + dz * 0.7];
            const tip: Point = [Math.cos(angle + 0.12) * reach, Math.sin(angle + 0.12) * reach, Math.min(0.985, root[2] + dz)];
            addBranch(builder, variant, species, [root, elbow, tip], (spruce ? 0.022 : 0.035) * (1 - f * 0.75));
            // Short lateral shoots overlap from the inner branch out to its tip.
            const shoots = spruce ? 5 : 4;
            for (let shoot = 0; shoot < shoots; shoot++) {
                const t = (spruce ? 0.24 : 0.44) + shoot / (shoots - 1) * (spruce ? 0.70 : 0.50);
                const joint = t < 0.48 ? mixPoint(root, elbow, t / 0.48) : mixPoint(elbow, tip, (t - 0.48) / 0.52);
                const sign = shoot % 2 ? 1 : -1;
                const shootAngle = angle + sign * (0.55 + random() * 0.35);
                const shootLength = (spruce ? 0.18 : 0.22) * (0.5 + reach) * (1 - t * 0.3);
                const end: Point = [joint[0] + Math.cos(shootAngle) * shootLength, joint[1] + Math.sin(shootAngle) * shootLength,
                    Math.min(0.99, joint[2] + (spruce ? -0.022 : 0.025))];
                addBranch(builder, variant, species, [joint, end], 0.007 * (1 - f * 0.65));
                const size = (spruce ? 0.40 : 0.34) * (0.40 + reach * 0.7) * (0.9 + random() * 0.2);
                addNeedleSpray(builder, species, variant, random, mixPoint(joint, end, 0.55), shootAngle, size * (spruce ? 1.7 : 1.15), size);
                if (!spruce) addNeedleSpray(builder, species, variant, random, end, shootAngle + 0.7, size, size * 0.85);
            }
        }
    }
    // A continuous needled leader hides the tapered trunk tip.
    for (let k = 0; k < 4; k++) addNeedleSpray(builder, species, variant, random, [0, 0, 0.94 + k * 0.015], k * 2.4,
        (spruce ? 0.20 : 0.30) * (1 - k * 0.17), (spruce ? 0.13 : 0.22) * (1 - k * 0.17));
}

export interface TreeGeometryInfo { geometry: BufferGeometry; cards: number; vertices: number }

/** One form for instanced drawing, or all forms for the impostor bake. */
export function treeGeometry(species: Species, onlyVariant?: number): TreeGeometryInfo {
    const builder = new TreeBuilder();
    for (let variant = 0; variant < VARIANTS; variant++) {
        if (onlyVariant !== undefined && variant !== onlyVariant) continue;
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
