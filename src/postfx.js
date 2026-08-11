import * as THREE from 'three';

export function createInkNoirFX(renderer, scene, camera, opts = {}) {
    // Default options
    const options = {
        bloomThreshold: opts.bloomThreshold ?? 0.7,
        bloomStrength: opts.bloomStrength ?? 0.55,
        toneScale: opts.toneScale ?? 1.0,
        vignette: opts.vignette ?? 0.35,
        crush: opts.crush ?? 0.2
    };

    // Whether FX is enabled
    let enabled = true;

    // Impact state
    let impactValue = 0;

    // Render targets
    let rt0 = null;  // Scene pass (full res)
    let rtb0 = null; // Bloom pass (half res)
    let rtb1 = null; // Bloom blur temp (half res)

    // Geometry and cameras for fullscreen passes
    const fsQuad = new THREE.PlaneGeometry(2, 2);
    const fsOrthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Determine texture type based on support
    const textureType = renderer.capabilities.isWebGL2 ?
        THREE.HalfFloatType :
        THREE.UnsignedByteType;

    // Materials for each pass
    let sceneMaterial = null;      // Pass-through for when disabled
    let brightPassMaterial = null;
    let blurHMaterial = null;
    let blurVMaterial = null;
    let compositeMaterial = null;

    // Uniforms shared across materials
    const commonUniforms = {
        tScene: { value: null },
        tBloom: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        halfRes: { value: new THREE.Vector2(0.5, 0.5) },
        impact: { value: 0 },
        bloomThreshold: { value: options.bloomThreshold },
        bloomStrength: { value: options.bloomStrength },
        toneScale: { value: options.toneScale },
        vignette: { value: options.vignette },
        crush: { value: options.crush }
    };

    // Create materials
    function createMaterials() {
        // Bright pass material
        brightPassMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                threshold: { value: options.bloomThreshold }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float threshold;
                varying vec2 vUv;
                void main() {
                    vec4 texel = texture2D(tDiffuse, vUv);
                    float luma = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
                    float factor = max(0.0, luma - threshold) / (1.0 - threshold);
                    factor = pow(factor, 2.0);
                    gl_FragColor = texel * factor;
                }
            `,
            depthTest: false,
            depthWrite: false
        });

        // Horizontal blur material
        blurHMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                resolution: { value: new THREE.Vector2(1, 1) }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform vec2 resolution;
                varying vec2 vUv;
                void main() {
                    vec4 sum = vec4(0.0);
                    float h = 1.3846153846 * 2.0 / resolution.x;
                    sum += texture2D(tDiffuse, vec2(vUv.x - 4.0 * h, vUv.y)) * 0.0162162162;
                    sum += texture2D(tDiffuse, vec2(vUv.x - 3.0 * h, vUv.y)) * 0.0540540541;
                    sum += texture2D(tDiffuse, vec2(vUv.x - 2.0 * h, vUv.y)) * 0.1216216216;
                    sum += texture2D(tDiffuse, vec2(vUv.x - 1.0 * h, vUv.y)) * 0.1945945946;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y)) * 0.2270270270;
                    sum += texture2D(tDiffuse, vec2(vUv.x + 1.0 * h, vUv.y)) * 0.1945945946;
                    sum += texture2D(tDiffuse, vec2(vUv.x + 2.0 * h, vUv.y)) * 0.1216216216;
                    sum += texture2D(tDiffuse, vec2(vUv.x + 3.0 * h, vUv.y)) * 0.0540540541;
                    sum += texture2D(tDiffuse, vec2(vUv.x + 4.0 * h, vUv.y)) * 0.0162162162;
                    gl_FragColor = sum;
                }
            `,
            depthTest: false,
            depthWrite: false
        });

        // Vertical blur material
        blurVMaterial = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                resolution: { value: new THREE.Vector2(1, 1) }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform vec2 resolution;
                varying vec2 vUv;
                void main() {
                    vec4 sum = vec4(0.0);
                    float v = 1.3846153846 * 2.0 / resolution.y;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 4.0 * v)) * 0.0162162162;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 3.0 * v)) * 0.0540540541;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 2.0 * v)) * 0.1216216216;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 1.0 * v)) * 0.1945945946;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y)) * 0.2270270270;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 1.0 * v)) * 0.1945945946;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 2.0 * v)) * 0.1216216216;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 3.0 * v)) * 0.0540540541;
                    sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 4.0 * v)) * 0.0162162162;
                    gl_FragColor = sum;
                }
            `,
            depthTest: false,
            depthWrite: false
        });

        // Composite/grade material
        compositeMaterial = new THREE.ShaderMaterial({
            uniforms: { ...commonUniforms },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tScene;
                uniform sampler2D tBloom;
                uniform vec2 resolution;
                uniform float impact;
                uniform float bloomStrength;
                uniform float toneScale;
                uniform float vignette;
                uniform float crush;
                varying vec2 vUv;

                // ACES filmic approximation (Narkowicz) — matches the plain
                // renderer path's ACESFilmicToneMapping closely enough for grade.
                vec3 acesApprox(vec3 x) {
                    x *= 1.05; // renderer.toneMappingExposure
                    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
                }
                // Explicit sRGB OETF — three's colorspace_fragment include
                // compiles to a no-op for this material (measured: output was
                // raw linear), so the encode is done by hand.
                vec3 toSRGB(vec3 c) {
                    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
                               step(vec3(0.0031308), c));
                }

                // Screentone pattern function
                float screentone(vec2 uv) {
                    // Rotate grid by ~26.57 degrees
                    float angle = 0.463647609; // atan(0.5)
                    float s = sin(angle);
                    float c = cos(angle);
                    mat2 rot = mat2(c, -s, s, c);
                    vec2 p = rot * (uv * resolution);
                    // Size = toneScale * 4px * (resY / 1080)
                    float scale = toneScale * 4.0 * (resolution.y / 1080.0);
                    p /= scale;
                    // Dot pattern
                    float dist = length(fract(p) - 0.5);
                    return 1.0 - smoothstep(0.0, 0.5, dist * 2.0);
                }

                void main() {
                    vec2 uv = vUv;

                    // ORDER IS LOAD-BEARING (found the hard way):
                    // RT0 holds raw LINEAR light, where this night
                    // game's whole frame lives under 0.02 luma — ANY perceptual
                    // grade applied there zeroes the image. So: HDR ops (bloom)
                    // in linear, then tone-map + encode to display space, THEN
                    // the perceptual grade (crush/screentone/vignette), whose
                    // constants are display-space numbers.

                    // -- linear-space: scene + bloom (impact boosts bloom)
                    vec4 color = texture2D(tScene, uv);
                    vec4 bloom = texture2D(tBloom, uv); // half-res texture, 1:1 UV
                    float impactBoost = 1.0 + impact * 0.5;
                    vec3 hdr = color.rgb + bloom.rgb * bloomStrength * impactBoost;

                    // -- to display space
                    vec3 finalColor = toSRGB(acesApprox(hdr));

                    // -- chromatic aberration on impact (shifted taps get the
                    //    same transform so channels match). Keep the split radial
                    //    and cap it at ~6 screen px so wide aspects don't tear at
                    //    the frame edges.
                    if (impact > 0.0) {
                        vec2 px = uv * resolution;
                        vec2 center = resolution * 0.5;
                        vec2 dir = px - center;
                        float pxDist = length(dir);
                        float shiftPx = min(impact * 0.004 * pxDist, 6.0);
                        vec2 shiftUV = pxDist > 0.0 ? (dir * (shiftPx / pxDist)) / resolution : vec2(0.0);
                        float r = toSRGB(acesApprox(texture2D(tScene, uv + shiftUV).rgb)).r;
                        float bl = toSRGB(acesApprox(texture2D(tScene, uv - shiftUV).rgb)).b;
                        finalColor = mix(finalColor, vec3(r, finalColor.g, bl), impact * 0.3);
                    }

                    // -- black-point crush (display space: floor the bottom ~2%)
                    float luma = dot(finalColor, vec3(0.299, 0.587, 0.114));
                    float b = crush * 0.06;
                    float crushedLuma = max(luma - b, 0.0) / (1.0 - b);
                    float ratio = luma > 0.001 ? crushedLuma / luma : 0.0;
                    finalColor *= ratio;

                    // -- screentone in shadows
                    float tone = screentone(uv);
                    float shadowMask = 1.0 - smoothstep(0.15, 0.25, luma);
                    finalColor = mix(finalColor, finalColor * mix(1.0, tone, 0.12), shadowMask);

                    // -- vignette (radial + gentle top emphasis)
                    vec2 centerDist = (uv - 0.5) * 2.0;
                    float vignetteFactor = 1.0 - dot(centerDist, centerDist) * vignette * 0.6;
                    vignetteFactor *= mix(1.0, 1.0 - (uv.y * 0.25), 0.35);
                    finalColor *= vignetteFactor;

                    // -- impact brightness pop
                    finalColor *= 1.0 + impact * 0.4;

                    gl_FragColor = vec4(finalColor, color.a);
                }
            `,
            depthTest: false,
            depthWrite: false
        });
    }

    // Resize render targets to match drawing buffer size
    function resizeTargets(width, height) {
        if (width === 0 || height === 0) return;

        // Dispose of existing targets
        if (rt0) rt0.dispose();
        if (rtb0) rtb0.dispose();
        if (rtb1) rtb1.dispose();

        // Full-res target for scene
        rt0 = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: textureType,
            stencilBuffer: false,
            depthBuffer: true,
            samples: 4
        });

        // Half-res targets for bloom
        const halfWidth = Math.max(1, Math.floor(width / 2));
        const halfHeight = Math.max(1, Math.floor(height / 2));

        rtb0 = new THREE.WebGLRenderTarget(halfWidth, halfHeight, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: textureType,
            stencilBuffer: false,
            depthBuffer: false
        });

        rtb1 = new THREE.WebGLRenderTarget(halfWidth, halfHeight, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: textureType,
            stencilBuffer: false,
            depthBuffer: false
        });

        // Update uniforms
        commonUniforms.resolution.value.set(width, height);
        commonUniforms.halfRes.value.set(halfWidth, halfHeight);
        blurHMaterial.uniforms.resolution.value.set(width, height);
        blurVMaterial.uniforms.resolution.value.set(width, height);
    }

    // Initialize everything
    createMaterials();
    const initialSize = renderer.getSize(new THREE.Vector2());
    resizeTargets(initialSize.width, initialSize.height);

    // Fullscreen quad mesh for passes
    const fullScreenQuad = new THREE.Mesh(fsQuad, null);
    fullScreenQuad.frustumCulled = false;

    // Render function
    function render(dt) {
        if (!enabled) {
            renderer.render(scene, camera);
            return;
        }

        // Decay impact
        impactValue = Math.max(0, impactValue - dt * 4.0);
        commonUniforms.impact.value = impactValue;

        // PASS 1: Render scene to RT0
        renderer.setRenderTarget(rt0);
        renderer.clear();
        renderer.render(scene, camera);

        // PASS 2: Bright pass (luminance threshold) to RTb0 (half-res)
        renderer.setRenderTarget(rtb0);
        renderer.clear();
        fullScreenQuad.material = brightPassMaterial;
        brightPassMaterial.uniforms.tDiffuse.value = rt0.texture;
        renderer.render(fullScreenQuad, fsOrthoCam);

        // PASS 3: Blur H to RTb1
        renderer.setRenderTarget(rtb1);
        renderer.clear();
        fullScreenQuad.material = blurHMaterial;
        blurHMaterial.uniforms.tDiffuse.value = rtb0.texture;
        blurHMaterial.uniforms.resolution.value.set(rtb0.width, rtb0.height);
        renderer.render(fullScreenQuad, fsOrthoCam);

        // PASS 4: Blur V back to RTb0
        renderer.setRenderTarget(rtb0);
        renderer.clear();
        fullScreenQuad.material = blurVMaterial;
        blurVMaterial.uniforms.tDiffuse.value = rtb1.texture;
        blurVMaterial.uniforms.resolution.value.set(rtb1.width, rtb1.height);
        renderer.render(fullScreenQuad, fsOrthoCam);

        // PASS 5: Composite/grade to screen
        renderer.setRenderTarget(null);
        fullScreenQuad.material = compositeMaterial;
        commonUniforms.tScene.value = rt0.texture;
        commonUniforms.tBloom.value = rtb0.texture;
        renderer.render(fullScreenQuad, fsOrthoCam);
    }

    // Impact function
    function impact(strength) {
        impactValue = Math.max(impactValue, Math.min(strength, 1.0));
    }

    // Resize function
    function resize(w, h) {
        resizeTargets(w, h);
    }

    // Enable/disable function
    function setEnabled(flag) {
        enabled = flag;
    }

    // Dispose function
    function dispose() {
        if (rt0) rt0.dispose();
        if (rtb0) rtb0.dispose();
        if (rtb1) rtb1.dispose();
        
        if (brightPassMaterial) brightPassMaterial.dispose();
        if (blurHMaterial) blurHMaterial.dispose();
        if (blurVMaterial) blurVMaterial.dispose();
        if (compositeMaterial) compositeMaterial.dispose();
    }

    return {
        render,
        impact,
        resize,
        setEnabled,
        dispose
    };
}
