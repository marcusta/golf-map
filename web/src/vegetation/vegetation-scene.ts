import {
    Camera, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, Texture, Vector3, WebGLRenderer,
} from 'three';
import { LIGHTING_GLSL, SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from '../map/tree-material';
import { TreeRenderer, treeStats, type TreeStats } from '../map/tree-renderer';
import type { TreeLod } from '../map/tree-geometry';
import { GRASS_TILE_M, grassTexture } from './grass-texture';
import { GROUND_SIZE_M, sceneStems, type SceneStem } from './vegetation-stems';

/** Test-scene backdrop: the app page colour. The tree haze is greener than this and must not tint the sky. */
const SCENE_SKY_COLOR = 0xd9d5cb;

/**
 * Plain three.js host for TreeRenderer: no MapLibre, a flat ground plane, an
 * orbit camera. The tree shaders multiply world positions by projectionMatrix
 * alone (MapLibre hands the layer one combined matrix), so the render camera is a
 * bare Camera whose projectionMatrix is projection x view; its matrixWorldInverse
 * stays identity, which keeps the ground shader and the shrubs' Lambert lighting
 * in the same world-space frame.
 */

export type LodMode = 'auto' | 'full' | 'half' | 'impostor';
export const LOD_MODES: readonly LodMode[] = ['auto', 'full', 'half', 'impostor'];
const FORCED_LOD: Record<LodMode, TreeLod | null> = { auto: null, full: 0, half: 1, impostor: 2 };

export type AtlasName = 'none' | 'broadleaf' | 'conifer' | 'bark' | 'bark-normal' | 'shadow' | 'impostor';
export const ATLAS_NAMES: readonly AtlasName[] = ['none', 'broadleaf', 'conifer', 'bark', 'bark-normal', 'shadow', 'impostor'];

export interface SunPreset { label: string; azimuthDeg: number; elevationDeg: number }
/** The first preset is the ortho-matched default the map layer uses. */
export const SUN_PRESETS: readonly SunPreset[] = [
    { label: 'Morning (ortho)', azimuthDeg: SUN_AZIMUTH_DEG, elevationDeg: SUN_ELEVATION_DEG },
    { label: 'Noon', azimuthDeg: 180, elevationDeg: 52 },
    { label: 'Evening', azimuthDeg: 275, elevationDeg: 14 },
];

/** Camera distances from the lineup the presets jump to. */
export const CAMERA_PRESETS_M: readonly number[] = [3, 10, 40, 150, 600];
/** Pitch above the horizon per preset distance. */
function presetPitchDeg(distanceM: number): number {
    return distanceM <= 3 ? 4 : distanceM <= 10 ? 8 : distanceM <= 40 ? 12 : distanceM <= 150 ? 18 : 28;
}
/** The lineup crown centre the presets look at. */
export const LINEUP_TARGET = new Vector3(0, 0, 7);

export interface SceneState {
    yawDeg: number; pitchDeg: number; distanceM: number;
    targetX: number; targetY: number; targetZ: number;
    sunAzimuthDeg: number; sunElevationDeg: number;
    lod: LodMode; sway: boolean; wireframe: boolean; atlas: AtlasName;
    /** Name tags over the lineup and ladder stems (HTML overlay, no draw calls). */
    labels: boolean;
}

export function defaultState(): SceneState {
    return {
        yawDeg: 0, pitchDeg: presetPitchDeg(40), distanceM: 40, targetX: LINEUP_TARGET.x, targetY: LINEUP_TARGET.y, targetZ: LINEUP_TARGET.z,
        sunAzimuthDeg: SUN_AZIMUTH_DEG, sunElevationDeg: SUN_ELEVATION_DEG, lod: 'auto', sway: true, wireframe: false, atlas: 'none', labels: true,
    };
}

/** Camera position for an orbit pose: yaw 0 is south of the target looking north. */
export function orbitEye(state: Pick<SceneState, 'yawDeg' | 'pitchDeg' | 'distanceM' | 'targetX' | 'targetY' | 'targetZ'>): Vector3 {
    const yaw = state.yawDeg * Math.PI / 180, pitch = state.pitchDeg * Math.PI / 180;
    return new Vector3(
        state.targetX + state.distanceM * Math.cos(pitch) * Math.sin(yaw),
        state.targetY - state.distanceM * Math.cos(pitch) * Math.cos(yaw),
        Math.max(0.6, state.targetZ + state.distanceM * Math.sin(pitch)),
    );
}

export function presetState(state: SceneState, distanceM: number): SceneState {
    return { ...state, distanceM, pitchDeg: presetPitchDeg(distanceM), targetX: LINEUP_TARGET.x, targetY: LINEUP_TARGET.y, targetZ: LINEUP_TARGET.z };
}

const GROUND_VERTEX = /* glsl */`
uniform vec3 uCamera;
varying vec2 vUv;
varying float vFog;
${LIGHTING_GLSL}
void main() {
    vUv = uv;
    vFog = fogAmount(distance(position, uCamera));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const GROUND_FRAGMENT = /* glsl */`
uniform sampler2D uGrass;
uniform float uRepeat;
varying vec2 vUv;
varying float vFog;
${LIGHTING_GLSL}
void main() {
    vec3 albedo = texture2D(uGrass, vUv * uRepeat).rgb;
    vec3 color = shadeBark(albedo, vec3(0.0, 0.0, 1.0));
    gl_FragColor = vec4(mix(color, uFogColor, vFog), 1.0);
    #include <colorspace_fragment>
}
`;

export interface FrameStats {
    /** Median rAF interval over the last 60 frames. */
    frameMedianMs: number;
    triangles: number;
    drawCalls: number;
    visible: number;
    distanceM: number;
}

export class VegetationScene {
    readonly renderer: WebGLRenderer;
    readonly core: TreeRenderer;
    readonly stems: SceneStem[];
    readonly stats: TreeStats = treeStats();
    readonly frame: FrameStats = { frameMedianMs: 0, triangles: 0, drawCalls: 0, visible: 0, distanceM: 0 };
    state: SceneState;
    private readonly view = new PerspectiveCamera(55, 1, 0.3, 4000);
    private readonly renderCamera = new Camera();
    private readonly ground: Mesh;
    private readonly grass: Texture;
    private readonly atlasScene = new Scene();
    private readonly atlasCamera = new OrthographicCamera();
    private readonly atlasQuad: Mesh;
    private readonly intervals: number[] = [];
    private lastFrameAt = 0;
    private raf = 0;
    private readonly startedAt = performance.now();

    constructor(readonly canvas: HTMLCanvasElement, state: SceneState) {
        this.state = state;
        this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        this.renderer.autoClear = false;
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.stems = sceneStems();
        this.core = new TreeRenderer(this.renderer, this.stems, this.stats);
        this.view.up.set(0, 0, 1);
        this.grass = grassTexture();
        const groundMaterial = new ShaderMaterial({
            uniforms: { ...this.core.shared, uGrass: { value: this.grass }, uRepeat: { value: GROUND_SIZE_M / GRASS_TILE_M } },
            vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT,
        });
        this.ground = new Mesh(new PlaneGeometry(GROUND_SIZE_M, GROUND_SIZE_M), groundMaterial);
        this.ground.frustumCulled = false;
        this.ground.renderOrder = -2;
        this.core.scene.add(this.ground);
        this.atlasQuad = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
        this.atlasScene.add(this.atlasQuad);
        this.applyState();
    }

    /** Pushes every control into the renderer; call after mutating `state`. */
    applyState(): void {
        const s = this.state;
        this.core.setSun(s.sunAzimuthDeg, s.sunElevationDeg);
        this.core.invalidateImpostors();
        this.core.forcedLod = FORCED_LOD[s.lod];
        this.core.applyLod();
        this.core.sway = s.sway;
        this.core.wireframe = s.wireframe;
    }

    /**
     * Projects a world point to CSS pixels in the canvas; `visible` is false behind
     * the camera or outside the viewport. Uses the pose of the last rendered frame.
     */
    project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
        const point = new Vector3(x, y, z).project(this.view);
        const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
        const visible = point.z < 1 && point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1;
        return { x: (point.x + 1) / 2 * width, y: (1 - point.y) / 2 * height, visible };
    }

    /** Pixel size of the atlas the viewer shows (0 x 0 when none). */
    atlasSize(): { width: number; height: number } {
        const texture = this.atlasTexture();
        if (!texture) return { width: 0, height: 0 };
        if (this.state.atlas === 'impostor') return { width: this.core.impostorAtlas.width, height: this.core.impostorAtlas.height };
        const image = texture.image as { width?: number; height?: number } | undefined;
        return { width: image?.width ?? 0, height: image?.height ?? 0 };
    }

    private atlasTexture(): Texture | undefined {
        if (this.state.atlas === 'none') return undefined;
        if (this.state.atlas === 'impostor') return this.core.impostorAtlas.texture;
        return this.core.texture(this.state.atlas);
    }

    start(): void {
        const tick = () => {
            this.raf = requestAnimationFrame(tick);
            this.renderFrame();
        };
        this.raf = requestAnimationFrame(tick);
    }

    stop(): void { cancelAnimationFrame(this.raf); }

    private resize(): void {
        const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1;
        const dpr = this.renderer.getPixelRatio();
        if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) this.renderer.setSize(width, height, false);
        this.view.aspect = width / height;
        this.view.updateProjectionMatrix();
    }

    renderFrame(): void {
        const now = performance.now();
        if (this.lastFrameAt > 0 && now - this.lastFrameAt < 3000) {
            this.intervals.push(now - this.lastFrameAt);
            if (this.intervals.length > 60) this.intervals.shift();
            const sorted = [...this.intervals].sort((a, b) => a - b);
            this.frame.frameMedianMs = sorted[Math.floor(sorted.length / 2)];
        }
        this.lastFrameAt = now;
        this.resize();
        const s = this.state;
        const eye = orbitEye(s);
        this.view.position.copy(eye);
        this.view.lookAt(s.targetX, s.targetY, s.targetZ);
        this.view.updateMatrixWorld(true);
        this.renderCamera.projectionMatrix.copy(this.view.projectionMatrix).multiply(this.view.matrixWorldInverse);
        this.renderer.setClearColor(SCENE_SKY_COLOR, 1);
        this.renderer.clear(true, true, false);
        this.core.update(this.renderCamera.projectionMatrix, eye, (now - this.startedAt) / 1000);
        this.core.draw(this.renderCamera);
        this.frame.triangles = this.renderer.info.render.triangles;
        this.frame.drawCalls = this.renderer.info.render.calls;
        this.frame.visible = this.stats.visible;
        this.frame.distanceM = eye.distanceTo(new Vector3(s.targetX, s.targetY, s.targetZ));
        this.drawAtlas();
    }

    /** The selected atlas at one texel per device pixel in the canvas's top-left corner. */
    private drawAtlas(): void {
        const texture = this.atlasTexture();
        if (!texture) return;
        const { width, height } = this.atlasSize();
        if (!width || !height) return;
        const dpr = this.renderer.getPixelRatio();
        const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
        this.atlasCamera.left = 0; this.atlasCamera.right = w * dpr; this.atlasCamera.top = 0; this.atlasCamera.bottom = -h * dpr;
        this.atlasCamera.near = -1; this.atlasCamera.far = 1;
        this.atlasCamera.updateProjectionMatrix();
        const material = this.atlasQuad.material as MeshBasicMaterial;
        if (material.map !== texture) { material.map = texture; material.needsUpdate = true; }
        this.atlasQuad.scale.set(width, height, 1);
        this.atlasQuad.position.set(width / 2, -height / 2, 0);
        this.renderer.render(this.atlasScene, this.atlasCamera);
    }

    dispose(): void {
        this.stop();
        this.core.dispose();
        this.ground.geometry.dispose();
        (this.ground.material as ShaderMaterial).dispose();
        this.grass.dispose();
        this.renderer.dispose();
    }
}
