/**
 * YAMIWARD — hand-drawn hit sparks (sprite-sheet VFX in 3D)
 * ============================================================================
 * Why sprite sheets and not particles:
 *
 * GPU particle systems produce *physical* impacts — dust, embers, smoke. Anime
 * impacts are not physical, they are DRAWN: a hard white star that exists for
 * three frames, jagged ink spikes with deliberate asymmetry, radiating speed
 * lines. No particle simulation converges on that, because the look comes from
 * an artist's line, not from physics.
 *
 * So each spark is one billboarded quad playing a short frame sequence. The
 * whole system is a single InstancedMesh: 256 simultaneous sparks cost ONE draw
 * call, and the CPU only writes a few floats per spawn.
 *
 * The sheet is generated procedurally at boot (Canvas2D) rather than shipped as
 * a PNG — it costs ~3ms, adds zero download, stays crisp at any resolution, and
 * the shapes are parameterised so hit types can be retuned without an artist.
 * When real hand-drawn frames exist, drop them in via `sheet:` and nothing else
 * changes.
 *
 * TIMING CONTRACT: sparks are driven by ENGINE FRAMES, not wall-clock seconds.
 * The combat engine is fixed 60Hz and deterministic; if VFX advanced on real
 * time they would desync from hitstop and from rollback re-simulation. Call
 * `update(frameCount)` with the engine's frame counter.
 */

import * as THREE from 'three';

/** Draw one anime impact frame onto a 2D context in a cell of the atlas. */
function drawImpactFrame(ctx, x, y, size, t, rng) {
    const cx = x + size / 2;
    const cy = y + size / 2;
    const R = size * 0.5;

    ctx.save();
    ctx.translate(cx, cy);

    // t: 0 → 1 over the life of the effect
    const grow = Math.pow(t, 0.45);          // fast out, slow settle
    const fade = t < 0.15 ? 1 : Math.pow(1 - (t - 0.15) / 0.85, 0.9);

    // --- radiating spikes: the core of the anime impact read ----------------
    // Deliberately uneven lengths — evenly spaced spikes read as a cartoon sun.
    const spikes = 11;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2;
        const isTip = i % 2 === 0;
        const jitter = 0.55 + rng(i) * 0.75;
        const r = isTip
            ? R * (0.30 + 0.70 * grow) * jitter
            : R * (0.10 + 0.16 * grow);
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${0.95 * fade})`;
    ctx.fill();

    // --- hot core -----------------------------------------------------------
    const coreR = R * (0.26 - 0.18 * t);
    if (coreR > 0) {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(coreR, 0.001));
        g.addColorStop(0, `rgba(255,255,255,${fade})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.arc(0, 0, coreR, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
    }

    // --- expanding ink ring, thinning as it grows ---------------------------
    if (t > 0.12) {
        const rr = R * (0.30 + 0.66 * grow);
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.55 * fade})`;
        ctx.lineWidth = Math.max(1, size * 0.030 * (1 - t));
        ctx.stroke();
    }

    // --- flung shards: sell the "drawn on 3s" staccato ----------------------
    if (t > 0.25) {
        const shards = 7;
        for (let i = 0; i < shards; i++) {
            const a = rng(100 + i) * Math.PI * 2;
            const d = R * (0.45 + 0.55 * grow) * (0.7 + rng(200 + i) * 0.6);
            const len = size * 0.10 * (1 - t) * (0.6 + rng(300 + i));
            const w = Math.max(1, size * 0.016 * (1 - t));
            ctx.save();
            ctx.rotate(a);
            ctx.beginPath();
            ctx.moveTo(d, 0);
            ctx.lineTo(d + len, -w);
            ctx.lineTo(d + len, w);
            ctx.closePath();
            ctx.fillStyle = `rgba(255,255,255,${0.8 * fade})`;
            ctx.fill();
            ctx.restore();
        }
    }
    ctx.restore();
}

/**
 * Build the frame atlas.
 * @returns {{texture: THREE.Texture, cols: number, rows: number, frames: number}}
 */
export function makeSparkSheet({ frames = 8, cell = 256, seed = 1337 } = {}) {
    const cols = 4;
    const rows = Math.ceil(frames / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * cell;
    cv.height = rows * cell;
    const ctx = cv.getContext('2d');

    // Deterministic pseudo-random so the sheet is identical every boot — the
    // engine is deterministic and its art should be too.
    let s = seed;
    const rngFor = (frame) => (i) => {
        let x = Math.sin((s + frame * 131 + i * 977)) * 43758.5453;
        return x - Math.floor(x);
    };

    for (let f = 0; f < frames; f++) {
        const cx = (f % cols) * cell;
        const cy = Math.floor(f / cols) * cell;
        drawImpactFrame(ctx, cx, cy, cell, (f + 0.5) / frames, rngFor(f));
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return { texture: tex, cols, rows, frames };
}

const VERT = /* glsl */`
    attribute vec3  iPos;
    attribute vec4  iData;    // x: spawn frame, y: scale, z: rotation, w: life in frames
    attribute vec3  iColor;

    uniform float uFrame;     // engine frame counter
    uniform float uCols;
    uniform float uRows;
    uniform float uFrames;

    varying vec2 vUv;
    varying vec3 vColor;
    varying float vAlpha;

    void main() {
        float age  = uFrame - iData.x;
        float life = iData.w;
        float t    = age / life;

        // Dead or not yet born: collapse to a degenerate point offscreen.
        if (age < 0.0 || t >= 1.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vAlpha = 0.0;
            vUv = vec2(0.0);
            vColor = vec3(0.0);
            return;
        }

        // Pick the atlas cell for this age.
        float f  = floor(t * uFrames);
        float fx = mod(f, uCols);
        float fy = floor(f / uCols);
        vUv = (uv + vec2(fx, fy)) / vec2(uCols, uRows);

        // Billboard: build the quad in VIEW space so it always faces camera.
        float c = cos(iData.z), s = sin(iData.z);
        vec2 corner = position.xy;
        corner = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);

        // Anime impacts pop hard then hold — scale mostly in the first 25%.
        float pop = 0.55 + 0.45 * smoothstep(0.0, 0.25, t);
        corner *= iData.y * pop;

        vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
        mv.xy += corner;
        gl_Position = projectionMatrix * mv;

        vColor = iColor;
        vAlpha = 1.0;
    }
`;

const FRAG = /* glsl */`
    varying vec2 vUv;
    varying vec3 vColor;
    varying float vAlpha;
    uniform sampler2D uSheet;

    void main() {
        vec4 tex = texture2D(uSheet, vUv);
        float a = tex.a * vAlpha;
        if (a < 0.01) discard;
        // Additive: sparks are LIGHT, they must never darken what is behind them.
        gl_FragColor = vec4(tex.rgb * vColor * a, a);
    }
`;

/**
 * Pooled billboard spark system. One draw call for the whole pool.
 */
export class HitSparks {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [o]
     * @param {number} [o.capacity]  max simultaneous sparks
     */
    constructor(scene, { capacity = 192, sheet = null } = {}) {
        const s = sheet || makeSparkSheet();
        this.capacity = capacity;
        this.cursor = 0;
        this.frame = 0;

        const geo = new THREE.InstancedBufferGeometry();
        const quad = new THREE.PlaneGeometry(1, 1);
        geo.index = quad.index;
        geo.attributes.position = quad.attributes.position;
        geo.attributes.uv = quad.attributes.uv;

        this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        this.iData = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        this.iPos.setUsage(THREE.DynamicDrawUsage);
        this.iData.setUsage(THREE.DynamicDrawUsage);
        this.iColor.setUsage(THREE.DynamicDrawUsage);

        // life = 0 means "never drawn" until something spawns here
        for (let i = 0; i < capacity; i++) this.iData.array[i * 4 + 3] = 1;

        geo.setAttribute('iPos', this.iPos);
        geo.setAttribute('iData', this.iData);
        geo.setAttribute('iColor', this.iColor);
        geo.instanceCount = capacity;

        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: {
                uSheet: { value: s.texture },
                uFrame: { value: 0 },
                uCols: { value: s.cols },
                uRows: { value: s.rows },
                uFrames: { value: s.frames },
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,      // additive + depth write = black boxes
            depthTest: true,
            side: THREE.DoubleSide,
        });

        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;     // instances move; the base geo does not
        this.mesh.renderOrder = 10;
        this.mesh.name = 'hitsparks';
        scene.add(this.mesh);
    }

    /**
     * Spawn one spark.
     * @param {THREE.Vector3|{x,y,z}} p world position
     * @param {Object} [o]
     * @param {number} [o.scale]   world size
     * @param {number} [o.life]    lifetime in ENGINE FRAMES (60 = 1s)
     * @param {THREE.Color|number} [o.color]
     * @param {number} [o.rotation] radians; random if omitted
     */
    spawn(p, { scale = 0.9, life = 12, color = 0xffffff, rotation = null } = {}) {
        const i = this.cursor;
        this.cursor = (this.cursor + 1) % this.capacity;

        this.iPos.array[i * 3 + 0] = p.x;
        this.iPos.array[i * 3 + 1] = p.y;
        this.iPos.array[i * 3 + 2] = p.z;

        this.iData.array[i * 4 + 0] = this.frame;
        this.iData.array[i * 4 + 1] = scale;
        this.iData.array[i * 4 + 2] = rotation === null ? Math.random() * Math.PI * 2 : rotation;
        this.iData.array[i * 4 + 3] = Math.max(1, life);

        const c = color instanceof THREE.Color ? color : new THREE.Color(color);
        this.iColor.array[i * 3 + 0] = c.r;
        this.iColor.array[i * 3 + 1] = c.g;
        this.iColor.array[i * 3 + 2] = c.b;

        this.iPos.needsUpdate = true;
        this.iData.needsUpdate = true;
        this.iColor.needsUpdate = true;
        return i;
    }

    /**
     * A full impact: one big flash plus a scatter of smaller ones.
     * This "one hero + several supporting" arrangement is what makes a hit read
     * as a single event rather than as confetti.
     *
     * @param {THREE.Vector3} p
     * @param {'light'|'heavy'|'launcher'|'block'} kind
     * @param {number|THREE.Color} [tint] clan colour for the supporting sparks
     */
    burst(p, kind = 'light', tint = 0xffffff) {
        // Scales are in world units against a ~1.8-unit-tall fighter. Sparks that
        // read fine in isolation swamp the character at anything above ~0.6 —
        // the effect should punctuate the hit, not replace the fighter.
        const presets = {
            light:    { n: 3, scale: 0.30, life: 9,  spread: 0.13 },
            heavy:    { n: 6, scale: 0.52, life: 14, spread: 0.24 },
            launcher: { n: 8, scale: 0.68, life: 18, spread: 0.34 },
            block:    { n: 4, scale: 0.34, life: 11, spread: 0.16 },
        };
        const k = presets[kind] || presets.light;

        // Hero spark: white, centred, biggest. Reads as the moment of contact.
        this.spawn(p, { scale: k.scale, life: k.life, color: 0xffffff });

        // Supporting sparks: offset, smaller, tinted to the attacker's colour.
        for (let i = 1; i < k.n; i++) {
            this.spawn({
                x: p.x + (Math.random() - 0.5) * k.spread * 2,
                y: p.y + (Math.random() - 0.5) * k.spread * 2,
                z: p.z + (Math.random() - 0.5) * k.spread,
            }, {
                scale: k.scale * (0.35 + Math.random() * 0.45),
                life: Math.round(k.life * (0.6 + Math.random() * 0.5)),
                color: kind === 'block' ? 0x9be8e0 : tint,
            });
        }
    }

    /**
     * Advance. Pass the ENGINE frame counter — not delta time.
     * @param {number} engineFrame
     */
    update(engineFrame) {
        this.frame = engineFrame;
        this.material.uniforms.uFrame.value = engineFrame;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.uniforms.uSheet.value.dispose();
        this.material.dispose();
        this.mesh.removeFromParent();
    }
}
