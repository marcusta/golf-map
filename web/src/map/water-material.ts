import { DoubleSide, ShaderMaterial, Vector3 } from 'three';

/** Procedural freshwater, in local metres with Z up. No downloaded textures. */
export function waterMaterial(creek = false): ShaderMaterial {
    return new ShaderMaterial({
        side: DoubleSide,
        uniforms: {
            uTime: { value: 0 },
            uEye: { value: new Vector3() },
            uCreek: { value: creek ? 1 : 0 },
            uFade: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        vertexShader: `
            attribute float shore;
            varying vec3 vPosition;
            varying float vShore;
            void main() {
                vPosition = position;
                vShore = shore;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform float uCreek;
            uniform float uFade;
            uniform vec3 uEye;
            varying vec3 vPosition;
            varying float vShore;
            vec3 sky(vec3 r) {
                float h = max(r.z, 0.0);
                vec3 color = mix(vec3(0.66, 0.74, 0.77), vec3(0.19, 0.39, 0.60), pow(h, 0.45));
                float cloud = sin(r.x * 12.0 + r.y * 4.0) * sin(r.y * 17.0 - r.x * 3.0);
                return mix(color, vec3(0.83, 0.85, 0.84), smoothstep(0.32, 0.85, cloud) * 0.35);
            }
            void main() {
                vec2 p = vPosition.xy;
                float t = uTime * mix(0.65, 1.35, uCreek);
                // Several wind-driven wavelengths; attenuate subpixel ripples at distance.
                float footprint = max(length(dFdx(p)), length(dFdy(p)));
                vec2 slope = vec2(0.0);
                for (int i = 0; i < 7; i++) {
                    float f = float(i);
                    vec2 direction = vec2(cos(0.55 + f * 1.27), sin(0.55 + f * 1.27));
                    float frequency = 1.4 * pow(2.05, f);
                    float weight = 0.032 * exp(-footprint * frequency * 0.65);
                    // Vary phase and strength across the surface to break up parallel bands.
                    float phase = 2.2 * sin(dot(p, vec2(0.17, 0.31)) + f * 2.4)
                        + 1.4 * sin(dot(p, vec2(-0.29, 0.13)) - f);
                    float gust = 0.7 + 0.3 * sin(dot(p, vec2(0.23, -0.19)) + f * 1.9);
                    slope += direction * cos(dot(p, direction) * frequency + phase - t * (1.1 + f * 0.43)) * weight * gust;
                }
                vec3 normal = normalize(vec3(-slope, 1.0));
                vec3 view = normalize(uEye - vPosition);
                float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
                float depth = 1.0 - exp(-max(vShore, 0.0) / mix(3.5, 0.7, uCreek));
                vec3 body = mix(vec3(0.12, 0.19, 0.13), vec3(0.025, 0.085, 0.075), depth);
                vec3 reflection = sky(reflect(-view, normal));
                vec3 sun = normalize(vec3(-0.65, -0.45, 0.62));
                vec3 halfVector = normalize(sun + view);
                float glint = pow(max(dot(normal, halfVector), 0.0), 550.0);
                vec3 color = mix(body, reflection, fresnel) + vec3(1.0, 0.88, 0.65) * glint * 0.8;
                gl_FragColor = vec4(color, uFade * mix(0.55, 1.0, smoothstep(0.0, 0.65, vShore)));
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
    });
}
