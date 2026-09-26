import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

/** Small folded leaves up close; a reduced leaf mesh beyond this distance. */
export const SHRUB_DETAIL_M = 45;

/**
 * Multi-stem deciduous shrub. Coordinates use crown radius in XY and measured
 * height in Z. Both detail levels grow the same branches; coarse foliage groups
 * neighbouring leaves into larger folded leaves, without a solid sphere core.
 */
export function shrubGeometry(detailed: boolean): BufferGeometry {
    let seed = 741;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    const vertex = (p: Vector3, color: readonly number[]) => {
        const index = positions.length / 3;
        positions.push(p.x, p.y, p.z);
        colors.push(...color);
        return index;
    };
    const wood = [0.13, 0.086, 0.047];
    const tube = (path: Vector3[], radius: number) => {
        const start = positions.length / 3, sides = 4;
        for (let r = 0; r < path.length; r++) {
            const tangent = path[Math.min(path.length - 1, r + 1)].clone().sub(path[Math.max(0, r - 1)]).normalize();
            const side = new Vector3(-tangent.y, tangent.x, 0).normalize();
            if (side.lengthSq() < 0.01) side.set(1, 0, 0);
            const up = new Vector3().crossVectors(tangent, side);
            const size = radius * (1 - 0.88 * r / (path.length - 1));
            for (let k = 0; k <= sides; k++) {
                const angle = k / sides * Math.PI * 2;
                vertex(path[r].clone().addScaledVector(side, Math.cos(angle) * size).addScaledVector(up, Math.sin(angle) * size), wood);
            }
        }
        for (let r = 0; r < path.length - 1; r++) for (let k = 0; k < sides; k++) {
            const a = start + r * (sides + 1) + k, b = a + sides + 1;
            indices.push(a, a + 1, b + 1, a, b + 1, b);
        }
    };
    let leafIndex = 0;
    const leaf = (root: Vector3, direction: Vector3, size: number, shade: number) => {
        // Consume the same random sequence at both detail levels.
        const roll = random() * Math.PI * 2;
        const hue = random();
        const keep = leafIndex++ % 6 === 0;
        if (!detailed && !keep) return;
        const length = size * (detailed ? 1 : 2.25), width = length * 0.48;
        const axis = direction.clone().normalize();
        const side = new Vector3(-axis.y, axis.x, 0).normalize();
        if (side.lengthSq() < 0.01) side.set(1, 0, 0);
        const normal = new Vector3().crossVectors(axis, side).normalize();
        side.applyAxisAngle(axis, roll);
        normal.applyAxisAngle(axis, roll);
        const mid = root.clone().addScaledVector(axis, length * 0.48);
        const color = [(0.052 + hue * 0.034) * shade, (0.105 + hue * 0.060) * shade, (0.025 + hue * 0.021) * shade];
        const outline = detailed
            ? [[0, 0], [0.28, 0.43], [0.66, 0.48], [1, 0], [0.66, -0.48], [0.28, -0.43]]
            : [[0, 0], [0.48, 0.5], [1, 0], [0.48, -0.5]];
        const rim = outline.map(([along, across]) => vertex(root.clone().addScaledVector(axis, length * along)
            .addScaledVector(side, width * across).addScaledVector(normal, length * 0.06 * along * along),
            color.map(v => v * (0.96 + along * 0.16))));
        const centre = vertex(mid.addScaledVector(normal, width * 0.18), color.map(v => v * 1.05));
        for (let k = 0; k < rim.length; k++) indices.push(rim[k], rim[(k + 1) % rim.length], centre);
    };
    for (let cane = 0; cane < 13; cane++) {
        const angle = cane * 2.399963;
        const reach = cane === 0 ? 0.05 : 0.45 + random() * 0.27;
        const height = cane === 0 ? 0.91 : 0.45 + random() * 0.37;
        const root = new Vector3(Math.cos(angle) * 0.06, Math.sin(angle) * 0.06, 0);
        const elbow = new Vector3(Math.cos(angle) * reach * 0.36, Math.sin(angle) * reach * 0.36, height * 0.5);
        const tip = new Vector3(Math.cos(angle + 0.18) * reach, Math.sin(angle + 0.18) * reach, height);
        tube([root, elbow, tip], 0.009 + random() * 0.004);
        for (let level = 0; level < 5; level++) {
            const t = 0.26 + level * 0.17;
            const joint = t < 0.5 ? root.clone().lerp(elbow, t * 2) : elbow.clone().lerp(tip, (t - 0.5) * 2);
            for (const sign of [-1, 1]) {
                const yaw = angle + sign * (0.65 + random() * 0.65);
                const reach = 0.16 + random() * 0.13;
                const end = joint.clone().add(new Vector3(Math.cos(yaw) * reach, Math.sin(yaw) * reach, 0.06 + random() * 0.08));
                tube([joint, end], 0.0038);
                for (let n = 0; n < 18; n++) {
                    const along = 0.16 + n / 18 * 0.82;
                    const attach = joint.clone().lerp(end, along);
                    const a = yaw + (n % 2 ? 1 : -1) * (0.65 + random() * 0.6);
                    const direction = new Vector3(Math.cos(a), Math.sin(a), (random() - 0.35) * 1.3);
                    const shade = 0.70 + 0.25 * attach.z + random() * 0.18;
                    leaf(attach, direction, 0.065 + random() * 0.035, shade);
                }
            }
        }
    }
    // Fit the measured envelope, including foliage tips, without flattening leaves at its edges.
    let radius = 0, top = 0;
    for (let i = 0; i < positions.length; i += 3) {
        radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1]));
        top = Math.max(top, positions[i + 2]);
    }
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] /= radius;
        positions[i + 1] /= radius;
        positions[i + 2] = Math.max(0, positions[i + 2]) / top;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}
