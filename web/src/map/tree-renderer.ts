import {
    Camera, Color, DirectionalLight, DynamicDrawUsage, Frustum, HalfFloatType, HemisphereLight,
    InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, LinearFilter, LinearMipmapLinearFilter,
    LinearSRGBColorSpace, Matrix4, Mesh, MeshLambertMaterial, NoColorSpace, RepeatWrapping, Scene,
    ShaderMaterial, Sphere, SRGBColorSpace, Texture, TextureLoader, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import {
    IMPOSTOR_COLUMNS, IMPOSTOR_HALF_WIDTH, IMPOSTOR_ROWS, impostorBakeHeight, impostorCell, impostorGeometry,
    isShrubHeight, leanFor, LOD_FULL_M, LOD_HALF_M, lodFor, midFractionFor, renderCrownRadius, SPECIES, shadowGeometry, shrubGeometry, speciesFor,
    STAND_SHADOW_DISTANCE_M, stemHash, treeGeometry, VARIANTS, variantFor, type StandStem, type TreeLod,
} from './tree-geometry';
import { defaultLighting, impostorMaterial, shadowMaterial, shadowOffsetPerMetre, sharedUniforms, sunDirection, treeMaterial, type SharedUniforms, type TreeLighting } from './tree-material';

/**
 * The three.js side of the individual-tree renderer, shared by the MapLibre
 * custom layer (trees-layer.ts) and the vegetation test scene
 * (src/vegetation). Owns the geometry, materials, textures, impostor bake,
 * per-frame instance buffers and stats; knows nothing about MapLibre. The host
 * supplies a WebGLRenderer, the eye position and the frustum in scene metres
 * (x east, y north, z up) and a camera whose projectionMatrix is the full
 * view-projection (the shaders multiply world positions by projectionMatrix only).
 */

export const TREE_DRAW_DISTANCE_M = 1200;

/** Texture files produced by `bun scripts/gen-tree-textures.ts`, served from public/trees. */
export const TREE_TEXTURE_FILES = ['broadleaf.png', 'conifer.png', 'bark.png', 'bark-normal.png', 'shadow.png'] as const;

/** `radius` is the render crown radius (renderCrownRadius, then adjustStand), not the asset's watershed radius. */
export interface RenderStem extends StandStem {
    ground: number;
    species: number; variant: number; yaw: number; scaleX: number; scaleY: number; phase: number;
    /** tan of the whole-tree lean angle, applied along the instance's local x before the yaw. */
    lean: number;
    tintR: number; tintG: number; tintB: number; color: Color;
}

export interface StemSource {
    /** Scene metres. */
    x: number; y: number; ground: number;
    heightM: number; crownRadiusM: number;
    /** Asset schema v2 `kind`: 0 broadleaf, 1 conifer, 2 unknown; v1 has none. */
    kind: number | undefined;
    /** Coordinates the look hashes come from (EPSG:3006 metres for assets), so a stem keeps its look across loads. */
    hashX: number; hashY: number;
}

const tintScratch = new Color();

/** The per-stem look (species, variant, yaw, scale, tint, lean) derived from the stem's hash coordinates. */
export function describeStem(source: StemSource): RenderStem {
    const { hashX: hx, hashY: hy } = source;
    const species = speciesFor(source.kind ?? 2, stemHash(hx, hy, 1));
    const h = stemHash(hx, hy, 4), l = stemHash(hx, hy, 5);
    // Hue +-4 degrees and lightness +-8 percent around a neutral near-white tint.
    tintScratch.setHSL(0.27 + (h - 0.5) * (8 / 360), 0.12, 0.5 + (l - 0.5) * 0.16).multiplyScalar(2);
    const shrub = isShrubHeight(source.heightM);
    return {
        x: source.x, y: source.y, ground: source.ground, height: source.heightM, shrub,
        radius: shrub ? source.crownRadiusM : renderCrownRadius(species, source.heightM, source.crownRadiusM),
        baseRaise: 0, nearestM: Infinity,
        species: SPECIES.indexOf(species), variant: variantFor(stemHash(hx, hy, 2)),
        yaw: stemHash(hx, hy, 3) * Math.PI * 2,
        scaleX: 0.85 + 0.30 * stemHash(hx, hy, 6), scaleY: 0.85 + 0.30 * stemHash(hx, hy, 7),
        phase: stemHash(hx, hy, 8),
        lean: leanFor(stemHash(hx, hy, 9)),
        tintR: tintScratch.r, tintG: tintScratch.g, tintB: tintScratch.b,
        color: new Color().setHSL(0.235 + h * 0.03, 0.35 + l * 0.12, 0.20 + h * 0.07),
    };
}

/** Instance buffers for one instanced mesh; `count` is rebuilt every frame. */
export class InstanceSet {
    readonly pos: InstancedBufferAttribute;
    readonly params: InstancedBufferAttribute;
    readonly extra: InstancedBufferAttribute;
    readonly tint: InstancedBufferAttribute;
    count = 0;
    constructor(readonly geometry: InstancedBufferGeometry, capacity: number) {
        const n = Math.max(1, capacity);
        this.pos = attribute(new Float32Array(n * 3), 3);
        this.params = attribute(new Float32Array(n * 4), 4);
        this.extra = attribute(new Float32Array(n * 4), 4);
        this.tint = attribute(new Float32Array(n * 4), 4);
        geometry.setAttribute('iPos', this.pos);
        geometry.setAttribute('iParams', this.params);
        geometry.setAttribute('iExtra', this.extra);
        geometry.setAttribute('iTint', this.tint);
        geometry.instanceCount = 0;
    }
    push(tree: RenderStem, w: number): void {
        const i = this.count++;
        const p = this.pos.array as Float32Array, q = this.params.array as Float32Array;
        const e = this.extra.array as Float32Array, t = this.tint.array as Float32Array;
        p[i * 3] = tree.x; p[i * 3 + 1] = tree.y; p[i * 3 + 2] = tree.ground;
        q[i * 4] = tree.radius; q[i * 4 + 1] = tree.height; q[i * 4 + 2] = tree.yaw; q[i * 4 + 3] = w;
        e[i * 4] = tree.scaleX; e[i * 4 + 1] = tree.scaleY; e[i * 4 + 2] = tree.phase; e[i * 4 + 3] = tree.baseRaise;
        t[i * 4] = tree.tintR; t[i * 4 + 1] = tree.tintG; t[i * 4 + 2] = tree.tintB; t[i * 4 + 3] = tree.lean;
    }
    commit(): void {
        this.geometry.instanceCount = this.count;
        for (const [a, size] of [[this.pos, 3], [this.params, 4], [this.extra, 4], [this.tint, 4]] as const) {
            a.clearUpdateRanges();
            if (this.count > 0) a.addUpdateRange(0, this.count * size);
            a.needsUpdate = this.count > 0;
        }
    }
}

function attribute(array: Float32Array, size: number): InstancedBufferAttribute {
    const a = new InstancedBufferAttribute(array, size);
    a.setUsage(DynamicDrawUsage);
    return a;
}

export interface TreeStats {
    total: number; shrubs: number; visible: number; visibleShrubs: number; detailed: number; half: number; impostors: number;
    triangles: number; drawCalls: number; cpuMs: number; frames: number;
    movingSamples: number; frameMedianMs: number; frameP95Ms: number; medianFps: number; gpu: string; texturesReady: boolean;
}

export function treeStats(): TreeStats {
    return { total: 0, shrubs: 0, visible: 0, visibleShrubs: 0, detailed: 0, half: 0, impostors: 0, triangles: 0, drawCalls: 0, cpuMs: 0, frames: 0,
        movingSamples: 0, frameMedianMs: 0, frameP95Ms: 0, medianFps: 0, gpu: '', texturesReady: false };
}

export interface TreeRendererOptions {
    /** Distance under which every card is drawn; default LOD_FULL_M. The e2e harness lowers it for software GPUs. */
    lodFullM?: number;
    /** Distance beyond which trees are crossed impostors; default LOD_HALF_M. */
    lodHalfM?: number;
    /** Called when a texture arrives (the host repaints). */
    onTextureLoaded?: () => void;
}

export class TreeRenderer {
    readonly scene = new Scene();
    readonly lighting: TreeLighting = defaultLighting();
    readonly shared: SharedUniforms;
    /** Wind sway on/off; the host decides whether that needs continuous frames. */
    sway = true;
    /** null: distance-driven; otherwise every tree renders in this band. */
    forcedLod: TreeLod | null = null;
    lodFullM: number;
    lodHalfM: number;
    private readonly frustum = new Frustum();
    private readonly sphere = new Sphere();
    private readonly matrix = new Matrix4();
    private readonly scale = new Vector3();
    private readonly species: InstanceSet[] = [];
    private readonly speciesMeshes: Mesh[] = [];
    private readonly impostors: InstanceSet;
    private readonly impostorMesh: Mesh;
    private readonly shadows: InstanceSet;
    private readonly shadowMesh: Mesh;
    private readonly shrubs: InstancedMesh;
    private readonly sun: DirectionalLight;
    private readonly textures: Record<string, Texture> = {};
    private texturesLoaded = 0;
    readonly impostorAtlas: WebGLRenderTarget;
    private impostorBaked = false;
    private readonly startedAt = performance.now();

    constructor(private readonly renderer: WebGLRenderer, readonly trees: readonly RenderStem[], readonly stats: TreeStats, options: TreeRendererOptions = {}) {
        this.lodFullM = options.lodFullM ?? LOD_FULL_M;
        this.lodHalfM = options.lodHalfM ?? LOD_HALF_M;
        this.stats.total = trees.length;
        this.stats.shrubs = trees.filter(tree => tree.shrub).length;
        this.loadTextures(options.onTextureLoaded);
        this.shared = sharedUniforms(this.lighting);
        // Shrubs keep the lit Lambert mesh from the first renderer.
        const sky = new HemisphereLight(0xdfe9f1, 0x55523a, 2.1);
        sky.position.set(0, 0, 1);
        this.sun = new DirectionalLight(0xffedca, 2.2);
        this.sun.position.copy(this.lighting.sunDir).multiplyScalar(200);
        this.scene.add(sky, this.sun);

        const counts = SPECIES.map((_, s) => trees.filter(tree => !tree.shrub && tree.species === s).length);
        const treeCount = counts.reduce((a, b) => a + b, 0);
        const foliage = { broadleaf: this.textures.broadleaf, spruce: this.textures.conifer, pine: this.textures.conifer };
        SPECIES.forEach((species, s) => {
            const geometry = toInstanced(treeGeometry(species).geometry);
            const set = new InstanceSet(geometry, counts[s]);
            const mesh = new Mesh(geometry, treeMaterial(this.shared, { foliage: foliage[species], bark: this.textures.bark, barkNormal: this.textures['bark-normal'] },
                { needle: species !== 'broadleaf', midFraction: midFractionFor(species) }));
            mesh.frustumCulled = false;
            this.species.push(set);
            this.speciesMeshes.push(mesh);
            this.scene.add(mesh);
        });

        this.impostorAtlas = new WebGLRenderTarget(IMPOSTOR_COLUMNS * 256, IMPOSTOR_ROWS * 512, {
            type: HalfFloatType, depthBuffer: true, generateMipmaps: true,
            minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, colorSpace: LinearSRGBColorSpace,
        });
        const impostorGeo = toInstanced(impostorGeometry());
        this.impostors = new InstanceSet(impostorGeo, treeCount);
        this.impostorMesh = new Mesh(impostorGeo, impostorMaterial(this.shared, this.impostorAtlas.texture));
        this.impostorMesh.frustumCulled = false;
        this.scene.add(this.impostorMesh);

        const shadowGeo = toInstanced(shadowGeometry());
        this.shadows = new InstanceSet(shadowGeo, treeCount);
        this.shadowMesh = new Mesh(shadowGeo, shadowMaterial(this.shared, this.textures.shadow));
        this.shadowMesh.frustumCulled = false;
        this.shadowMesh.renderOrder = -1;
        this.scene.add(this.shadowMesh);

        this.shrubs = new InstancedMesh(shrubGeometry(false), new MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
            Math.max(1, this.stats.shrubs));
        this.shrubs.instanceMatrix.setUsage(DynamicDrawUsage);
        this.shrubs.frustumCulled = false;
        this.shrubs.count = 0;
        this.scene.add(this.shrubs);
        this.applyLod();
    }

    get texturesReady(): boolean { return this.texturesLoaded === TREE_TEXTURE_FILES.length; }

    /** Number of instanced draw calls the last update produced (species, impostors, shadows, shrubs). */
    get drawCalls(): number {
        return this.drawSets().filter(set => set.count > 0).length + (this.shrubs.count > 0 ? 1 : 0);
    }

    /** Every tree and impostor mesh in outline form (the shrubs stay solid). */
    set wireframe(on: boolean) {
        for (const mesh of [...this.speciesMeshes, this.impostorMesh]) (mesh.material as ShaderMaterial).wireframe = on;
    }

    /** Moves the sun for the foliage shaders, the shadow decals and the shrub light. */
    setSun(azimuthDeg: number, elevationDeg: number): void {
        this.lighting.sunDir.copy(sunDirection(azimuthDeg, elevationDeg));
        this.sun.position.copy(this.lighting.sunDir).multiplyScalar(200);
        (this.shadowMesh.material as ShaderMaterial).uniforms.uShadowOffset.value.copy(shadowOffsetPerMetre(azimuthDeg, elevationDeg));
    }

    /** Pushes the LOD thresholds (and a forced band) into the card-selection uniform. */
    applyLod(): void {
        const full = this.forcedLod === null ? this.lodFullM : this.forcedLod === 0 ? 1e9 : 0;
        for (const mesh of this.speciesMeshes) (mesh.material as ShaderMaterial).uniforms.uLodFull.value = full;
    }

    private loadTextures(onLoaded?: () => void): void {
        const base = import.meta.env.BASE_URL ?? '/';
        const loader = new TextureLoader();
        for (const file of TREE_TEXTURE_FILES) {
            const name = file.replace('.png', '');
            const texture = loader.load(`${base}trees/${file}`, () => {
                this.texturesLoaded++;
                this.stats.texturesReady = this.texturesReady;
                onLoaded?.();
            });
            texture.colorSpace = name === 'bark-normal' ? NoColorSpace : SRGBColorSpace;
            texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
            texture.minFilter = LinearMipmapLinearFilter;
            texture.magFilter = LinearFilter;
            if (name.startsWith('bark')) texture.wrapS = texture.wrapT = RepeatWrapping;
            this.textures[name] = texture;
        }
    }

    /** Loaded atlas textures by name (broadleaf, conifer, bark, bark-normal, shadow). */
    texture(name: string): Texture | undefined { return this.textures[name]; }

    /**
     * Renders every species/variant once into the impostor atlas: an orthographic side
     * view of a canonical tree (radius 1, species bake height) with the lighting baked in.
     * Runs once, after the textures have arrived, inside a render call so the shared
     * context is current; framebuffer and viewport are restored afterwards.
     */
    private bakeImpostors(): void {
        const gl = this.renderer.getContext();
        const atlas = this.impostorAtlas;
        const savedFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        const bakeScene = new Scene();
        const bakeCamera = new Camera();
        const ortho = new Matrix4(), view = new Camera();
        view.up.set(0, 0, 1);
        const savedFog = this.shared.uFog.value.z, savedSway = this.shared.uSway.value;
        this.shared.uFog.value.z = 0;
        this.shared.uSway.value = 0;
        this.shared.uCamera.value.set(0, -1e6, 0);
        this.renderer.setRenderTarget(atlas);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear(true, true, false);
        const cellW = atlas.width / IMPOSTOR_COLUMNS, cellH = atlas.height / IMPOSTOR_ROWS;
        this.renderer.setScissorTest(true);
        SPECIES.forEach((species, s) => {
            const height = impostorBakeHeight(species);
            const geometry = toInstanced(treeGeometry(species).geometry);
            const set = new InstanceSet(geometry, 1);
            const material = (this.speciesMeshes[s].material as ShaderMaterial).clone();
            // Shared uniform objects stay shared so the fog and sway overrides above apply.
            material.uniforms = { ...this.shared, ...pick(this.speciesMeshes[s].material as ShaderMaterial) };
            material.wireframe = false;
            const mesh = new Mesh(geometry, material);
            mesh.frustumCulled = false;
            bakeScene.add(mesh);
            for (let variant = 0; variant < VARIANTS; variant++) {
                set.count = 0;
                set.push({ x: 0, y: 0, ground: 0, height, radius: 1, shrub: false, baseRaise: 0, nearestM: Infinity, species: s, variant, yaw: 0,
                    scaleX: 1, scaleY: 1, phase: 0, lean: 0, tintR: 1, tintG: 1, tintB: 1, color: new Color() }, variant);
                set.commit();
                view.position.set(0, -50, height / 2);
                view.lookAt(0, 0, height / 2);
                view.updateMatrixWorld(true);
                ortho.makeOrthographic(-IMPOSTOR_HALF_WIDTH, IMPOSTOR_HALF_WIDTH, height, 0, 1, 100);
                bakeCamera.projectionMatrix.copy(ortho).multiply(view.matrixWorldInverse);
                const cell = impostorCell(species, variant);
                const cx = (cell % IMPOSTOR_COLUMNS) * cellW, cy = Math.floor(cell / IMPOSTOR_COLUMNS) * cellH;
                this.renderer.setViewport(cx, cy, cellW, cellH);
                this.renderer.setScissor(cx, cy, cellW, cellH);
                this.renderer.render(bakeScene, bakeCamera);
            }
            bakeScene.remove(mesh);
            geometry.dispose();
            material.dispose();
        });
        this.renderer.setScissorTest(false);
        this.renderer.setRenderTarget(null);
        this.shared.uFog.value.z = savedFog;
        this.shared.uSway.value = savedSway;
        gl.bindFramebuffer(gl.FRAMEBUFFER, savedFramebuffer);
        gl.viewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
        this.impostorBaked = true;
    }

    /** Re-bakes the impostor atlas on the next frame (after a sun change, say). */
    invalidateImpostors(): void { this.impostorBaked = false; }

    private drawSets(): InstanceSet[] {
        return [...this.species, this.impostors, this.shadows];
    }

    /**
     * Culls and buckets the stems for one frame and sets the per-frame uniforms.
     * `viewProjection` is the full view-projection matrix in scene metres; `eye`
     * the camera position in the same space. Bakes the impostors first when the
     * textures have just arrived. The caller then calls `draw`.
     */
    update(viewProjection: Matrix4, eye: Vector3, timeS = (performance.now() - this.startedAt) / 1000): void {
        this.frustum.setFromProjectionMatrix(viewProjection);
        const treesReady = this.texturesReady;
        if (treesReady && !this.impostorBaked) this.bakeImpostors();
        for (const set of this.drawSets()) set.count = 0;
        const shrubs = this.shrubs;
        shrubs.count = 0;
        const lodCounts = [0, 0, 0];
        for (const tree of this.trees) {
            const dx = tree.x - eye.x, dy = tree.y - eye.y;
            if (dx * dx + dy * dy > (TREE_DRAW_DISTANCE_M + tree.radius) ** 2) continue;
            this.sphere.center.set(tree.x, tree.y, tree.ground + tree.height / 2);
            this.sphere.radius = Math.hypot(tree.height / 2, tree.radius * 1.4);
            if (!this.frustum.intersectsSphere(this.sphere)) continue;
            if (tree.shrub) {
                this.matrix.makeRotationZ(tree.yaw).scale(this.scale.set(tree.radius, tree.radius, tree.height))
                    .setPosition(tree.x, tree.y, tree.ground);
                shrubs.setMatrixAt(shrubs.count, this.matrix);
                shrubs.setColorAt(shrubs.count++, tree.color);
                continue;
            }
            if (!treesReady) continue;
            const dz = tree.ground - eye.z;
            const lod: TreeLod = this.forcedLod ?? lodFor(Math.sqrt(dx * dx + dy * dy + dz * dz), this.lodFullM, this.lodHalfM);
            lodCounts[lod]++;
            if (lod === 2) this.impostors.push(tree, impostorCell(SPECIES[tree.species], tree.variant));
            else this.species[tree.species].push(tree, tree.variant);
            this.shadows.push(tree, tree.nearestM < STAND_SHADOW_DISTANCE_M ? 1 : 0);
        }
        for (const set of this.drawSets()) set.commit();
        shrubs.instanceMatrix.clearUpdateRanges();
        if (shrubs.count > 0) shrubs.instanceMatrix.addUpdateRange(0, shrubs.count * 16);
        shrubs.instanceMatrix.needsUpdate = shrubs.count > 0;
        if (shrubs.instanceColor) {
            shrubs.instanceColor.clearUpdateRanges();
            if (shrubs.count > 0) shrubs.instanceColor.addUpdateRange(0, shrubs.count * 3);
            shrubs.instanceColor.needsUpdate = shrubs.count > 0;
        }
        this.shared.uCamera.value.copy(eye);
        this.shared.uTime.value = timeS;
        this.shared.uSway.value = this.sway ? 1 : 0;
        this.stats.visibleShrubs = shrubs.count;
        this.stats.detailed = lodCounts[0];
        this.stats.half = lodCounts[1];
        this.stats.impostors = lodCounts[2];
        this.stats.visible = lodCounts[0] + lodCounts[1] + lodCounts[2] + shrubs.count;
        this.stats.drawCalls = this.drawCalls;
    }

    /** Draws the scene with a camera whose projectionMatrix is the view-projection used in `update`. */
    draw(camera: Camera): void {
        this.renderer.resetState();
        this.renderer.render(this.scene, camera);
        this.stats.triangles = this.renderer.info.render.triangles;
        this.stats.frames++;
    }

    /** True when trees (not only shrubs) are on screen, so sway needs animation frames. */
    get swaying(): boolean { return this.sway && this.stats.visible - this.stats.visibleShrubs > 0; }

    dispose(): void {
        for (const mesh of [...this.speciesMeshes, this.impostorMesh, this.shadowMesh, this.shrubs]) {
            mesh.geometry.dispose();
            (mesh.material as ShaderMaterial | MeshLambertMaterial).dispose();
            if (mesh instanceof InstancedMesh) mesh.dispose();
        }
        for (const texture of Object.values(this.textures)) texture.dispose();
        this.impostorAtlas.dispose();
        this.species.length = 0;
        this.speciesMeshes.length = 0;
    }
}

/** Copies a plain BufferGeometry's attributes and index into an InstancedBufferGeometry. */
export function toInstanced(source: { attributes: Record<string, any>; index: any; dispose(): void }): InstancedBufferGeometry {
    const geometry = new InstancedBufferGeometry();
    for (const [name, attr] of Object.entries(source.attributes)) geometry.setAttribute(name, attr);
    if (source.index) geometry.setIndex(source.index);
    return geometry;
}

function pick(material: ShaderMaterial) {
    const { uFoliage, uBark, uBarkNormal, uLodFull, uMidFraction, uNeedle, uNearFade } = material.uniforms;
    return { uFoliage, uBark, uBarkNormal, uLodFull, uMidFraction, uNeedle, uNearFade, uCardFraction: { value: 1 }, uEdgeCutoff: { value: 0.0 } };
}
