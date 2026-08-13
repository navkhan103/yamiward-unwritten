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
    // Speed lines decay smoothly (they are a sustained rush); the impact frame
    // is COUNTED IN FRAMES and cut, because a fading impact frame is a flash
    // and a flash is what everyone else's game does.
    let speedValue = 0;
    let flashFramesLeft = 0;

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
        speedLines: { value: 0 },
        flashFrame: { value: 0 },
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
                uniform float speedLines;
                uniform float flashFrame;
                uniform float bloomStrength;
                uniform float toneScale;
                uniform float vignette;
                uniform float crush;
                varying vec2 vUv;

                // FXAA (Lottes' console variant, trimmed).
                //
                // Works on LINEAR light here, which is unusual — FXAA normally
                // wants perceptual values. It is deliberate: rt0 holds raw linear
                // light and everything downstream in this shader assumes that,
                // so anti-aliasing after the grade would mean a second full-frame
                // sample. Luma is taken with a sqrt to approximate a perceptual
                // response, which is enough for edge DETECTION even though it is
                // not a true luminance.
                float fxaaLuma(vec3 c) { return sqrt(dot(c, vec3(0.299, 0.587, 0.114))); }

                vec4 fxaa(sampler2D tex, vec2 uv, vec2 res) {
                    vec2 px = 1.0 / res;
                    vec3 rgbM = texture2D(tex, uv).rgb;
                    float lM  = fxaaLuma(rgbM);
                    float lNW = fxaaLuma(texture2D(tex, uv + vec2(-1.0, -1.0) * px).rgb);
                    float lNE = fxaaLuma(texture2D(tex, uv + vec2( 1.0, -1.0) * px).rgb);
                    float lSW = fxaaLuma(texture2D(tex, uv + vec2(-1.0,  1.0) * px).rgb);
                    float lSE = fxaaLuma(texture2D(tex, uv + vec2( 1.0,  1.0) * px).rgb);

                    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
                    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

                    // Flat area: leave it alone. Skipping the blur here is what
                    // keeps FXAA from softening the whole image.
                    float range = lMax - lMin;
                    if (range < max(0.0312, lMax * 0.125)) return vec4(rgbM, 1.0);

                    vec2 dir = vec2(
                        -((lNW + lNE) - (lSW + lSE)),
                          ((lNW + lSW) - (lNE + lSE))
                    );
                    float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
                    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
                    dir = clamp(dir * rcpDirMin, -8.0, 8.0) * px;

                    vec3 rgbA = 0.5 * (
                        texture2D(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                        texture2D(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
                    vec3 rgbB = rgbA * 0.5 + 0.25 * (
                        texture2D(tex, uv + dir * -0.5).rgb +
                        texture2D(tex, uv + dir *  0.5).rgb);

                    float lB = fxaaLuma(rgbB);
                    return vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
                }

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
                    // FXAA first. MSAA is the better tool but it is held back as
                    // GPU-unproven on the player's hardware, and jagged edges are
                    // one of the loudest "cheap" signals a game gives off — worst
                    // of all on a cel-shaded fighter, whose whole look is hard
                    // colour boundaries and a black ink line. This runs inside the
                    // composite instead of as its own pass, so it costs no extra
                    // render target: sample the scene through an edge-aware blur
                    // rather than sampling it flat.
                    vec4 color = fxaa(tScene, uv, resolution);
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

                    // -- speed lines: radial streaks that rush the eye toward
                    //    the centre of the action. Screen-space and procedural,
                    //    so they cost one noise lookup and no assets. Held off
                    //    the middle of the frame (the fighters live there) and
                    //    ramped in toward the edges, which is exactly how they
                    //    are drawn on an animation cel.
                    if (speedLines > 0.0) {
                        vec2 d = uv - 0.5;
                        d.x *= resolution.x / resolution.y;   // round, not elliptical
                        float ang = atan(d.y, d.x);
                        float rad = length(d);
                        // QUANTISE the angle into spoke slots before hashing.
                        // Hashing the continuous angle instead produces
                        // per-pixel noise that looks like film grain, not
                        // speed lines — the streaks have to be coherent along
                        // a ray, which means every pixel on that ray must get
                        // the same random number.
                        const float SPOKES = 110.0;
                        float a01 = ang * 0.15915494 + 0.5;    // 1/(2pi)
                        float idx = floor(a01 * SPOKES);
                        float within = fract(a01 * SPOKES);
                        float h = fract(sin(idx * 78.233) * 43758.5453);
                        // Only some slots carry a line, and each has its own
                        // width and start radius — evenly spaced lines read as
                        // a grating.
                        float exists = step(0.52, h);
                        // Thin. Tuned against a render: at 0.10-0.30 half-width
                        // these read as grey BANDS across the stage rather than
                        // drawn lines, and they swamp the fighters.
                        float w = 0.04 + h * 0.09;
                        float line = exists * (1.0 - smoothstep(w, w + 0.09, abs(within - 0.5)));
                        float r0 = 0.24 + h * 0.20;
                        float edge = smoothstep(r0, r0 + 0.30, rad);
                        finalColor = mix(finalColor, vec3(1.0), line * edge * speedLines * 0.5);
                    }

                    // -- IMPACT FRAME. Not a fade: a hard 1-2 frame cut to a
                    //    high-contrast stamp of the silhouette, which is the
                    //    single most recognisable device in an anime fight. It
                    //    lands last so nothing downstream can soften it.
                    if (flashFrame > 0.0) {
                        float fl = dot(finalColor, vec3(0.299, 0.587, 0.114));
                        vec3 stamp = fl > 0.16 ? vec3(1.0) : vec3(0.02, 0.02, 0.04);
                        finalColor = mix(finalColor, stamp, flashFrame);
                    }

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
            // Depth is REQUIRED now that solid 3D (VRM) fighters render through
            // this target — without it their own geometry can't depth-sort.
            // (MSAA/samples was held back: it's GPU-driver-variable and unproven
            // on the player's hardware; revisit once the 3D path is confirmed.)
            depthBuffer: true
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

        speedValue = Math.max(0, speedValue - dt * 2.2);
        commonUniforms.speedLines.value = speedValue;

        // Frame-counted, never time-decayed. At 60fps two frames is 33ms — long
        // enough to register, short enough that the eye reads it as a stamp
        // rather than a strobe. Counted in RENDERED frames on purpose: during
        // hitstop the world is frozen and the stamp should hold with it.
        commonUniforms.flashFrame.value = flashFramesLeft > 0 ? 1 : 0;
        if (flashFramesLeft > 0) flashFramesLeft--;

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

    /** Rush lines toward the centre. `strength` 0..1, decays over ~0.5s. */
    function speed(strength) {
        speedValue = Math.max(speedValue, Math.min(strength, 1.0));
    }

    /** Hard impact frame for `frames` rendered frames (2 is the anime default). */
    function flash(frames = 2) {
        flashFramesLeft = Math.max(flashFramesLeft, frames);
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
        speed,
        flash,
        resize,
        setEnabled,
        dispose
    };
}
