/**
 * YAMIWARD — cel shading + rim light
 * ============================================================================
 * Technique note (this is the bit that matters):
 *
 * Writing a ShaderMaterial from scratch gives you total control and instantly
 * costs you Three.js's entire lighting and shadow pipeline — you would have to
 * re-implement shadow map sampling, light loops, fog and tone mapping by hand.
 * For an anime look that still receives real shadows, the professional move is
 * to start from MeshToonMaterial (which already does banded diffuse + shadows)
 * and INJECT custom GLSL via onBeforeCompile.
 *
 * So: banding comes from a generated gradient map (nearest-filtered, so the
 * steps stay hard), and the rim light is injected into the output stage.
 */

import * as THREE from 'three';

/**
 * Generate a hard-stepped gradient ramp for toon banding.
 * @param {number} steps 2–5 reads as anime; more looks like bad PBR
 */
export function makeToonRamp(steps = 3) {
    const data = new Uint8Array(steps * 4);
    for (let i = 0; i < steps; i++) {
        // Bias the ramp dark so lit areas pop — flat mid-tones look muddy.
        const t = Math.pow((i + 1) / steps, 0.85);
        const v = Math.round(t * 255);
        data[i * 4 + 0] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Cel material with a view-dependent rim light.
 *
 * @param {Object} o
 * @param {number|string} o.color        base albedo
 * @param {number|string} [o.rimColor]   rim tint (use the clan colour)
 * @param {number} [o.rimPower]          falloff exponent; higher = tighter rim
 * @param {number} [o.rimStrength]
 * @param {number} [o.steps]             banding steps
 * @param {THREE.Texture} [o.map]        albedo map from the Meshy/Midjourney pipeline
 * @returns {THREE.MeshToonMaterial}
 */
export function createCelMaterial({
    color = 0xffffff,
    rimColor = 0x9be8e0,
    rimPower = 2.6,
    rimStrength = 0.9,
    steps = 3,
    map = null,
} = {}) {
    const mat = new THREE.MeshToonMaterial({
        color,
        gradientMap: makeToonRamp(steps),
        map,
    });

    // Uniforms have to survive shader recompiles, so hold them outside.
    const uniforms = {
        uRimColor: { value: new THREE.Color(rimColor) },
        uRimPower: { value: rimPower },
        uRimStrength: { value: rimStrength },
        uHitFlash: { value: 0 },     // driven on impact — see setHitFlash()
        uFlashColor: { value: new THREE.Color(0xffffff) },
    };

    mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);

        // We need the view-space normal and position in the fragment stage.
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `
                #include <common>
                varying vec3 vYamiViewNormal;
                varying vec3 vYamiViewPos;
            `)
            .replace('#include <fog_vertex>', `
                #include <fog_vertex>
                vYamiViewNormal = normalize( normalMatrix * objectNormal );
                vYamiViewPos = ( modelViewMatrix * vec4( transformed, 1.0 ) ).xyz;
            `);

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `
                #include <common>
                uniform vec3  uRimColor;
                uniform float uRimPower;
                uniform float uRimStrength;
                uniform float uHitFlash;
                uniform vec3  uFlashColor;
                varying vec3 vYamiViewNormal;
                varying vec3 vYamiViewPos;
            `)
            // Inject after tone mapping so the rim is not crushed by it.
            .replace('#include <dithering_fragment>', `
                #include <dithering_fragment>

                // Fresnel-style rim: bright where the surface turns away from us.
                vec3  V   = normalize( -vYamiViewPos );
                float ndv = clamp( dot( normalize( vYamiViewNormal ), V ), 0.0, 1.0 );
                float rim = pow( 1.0 - ndv, uRimPower ) * uRimStrength;
                gl_FragColor.rgb += uRimColor * rim;

                // Impact flash — the single cheapest trick for making hits read.
                gl_FragColor.rgb = mix( gl_FragColor.rgb, uFlashColor, uHitFlash );
            `);

        mat.userData.shader = shader;
    };

    // Force a distinct program per configuration so materials do not share one.
    mat.customProgramCacheKey = () => `yamiward-cel-${rimPower}-${steps}`;
    mat.userData.uniforms = uniforms;
    return mat;
}

/**
 * Drive the white impact flash. Call with 1 on hit, then decay toward 0.
 * @param {THREE.Material} mat
 * @param {number} v 0..1
 */
export function setHitFlash(mat, v) {
    const u = mat.userData && mat.userData.uniforms;
    if (u) u.uHitFlash.value = v;
}
