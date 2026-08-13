/**
 * YAMIWARD — baked mocap clip playback
 * ============================================================================
 * Loads the .ywa bundle produced by tools/retarget.html and drives a VRM's
 * NORMALISED humanoid bones from it.
 *
 * Normalised bones, not raw: their rest pose is identity, which is what the
 * bake targeted, and it keeps clip playback in a different hierarchy from the
 * per-fighter BUILD (which scales raw bones). The two never fight.
 *
 * The format is deliberately tiny and dumb — a header plus one Int16Array — so
 * that decoding is a subtraction and a multiply, with no per-frame allocation.
 * At 30fps sampled and 60fps rendered, every displayed frame is an interpolation
 * between two stored ones, which is also what smooths the 30fps source.
 */
import * as THREE from 'three';

const INV = 1 / 32767;

/** Parse a YWA1 bundle. */
export async function loadClipBundle(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const u8 = new Uint8Array(buf);
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== 'YWA1') throw new Error(`not a clip bundle (${magic})`);
    const jsonLen = new DataView(buf).getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jsonLen)).replace(/\0+$/, ''));
    const payload = new Int16Array(buf, 8 + jsonLen);
    const clips = new Map();
    for (const c of head.clips) clips.set(c.name, c);
    return { fps: head.fps, bones: head.bones, clips, payload };
}

/**
 * Plays bundle clips on one VRM.
 *
 * Crossfading is done against a SNAPSHOT of the pose that was actually being
 * displayed when the switch happened — not against the outgoing clip's current
 * time. Blending two moving clips makes feet slide; blending from a frozen pose
 * to a moving one is what reads as a transition.
 */
export class ClipPlayer {
    constructor(vrm, bundle) {
        this.vrm = vrm;
        this.bundle = bundle;
        this.nodes = bundle.bones.map((b) => vrm.humanoid.getNormalizedBoneNode(b) || null);
        this.hips = vrm.humanoid.getNormalizedBoneNode('hips');
        this.hipsRestY = this.hips ? this.hips.position.y : 0;

        this.current = null;
        this.time = 0;
        this.loop = true;
        this.rate = 1;
        this.done = false;

        // scratch — no allocation in the update path
        this._qa = new THREE.Quaternion();
        this._qb = new THREE.Quaternion();
        this._out = new THREE.Quaternion();
        // fade state
        this._fadeT = 0; this._fadeDur = 0;
        this._from = new Float32Array(bundle.bones.length * 4);
        this._fromY = 0;
    }

    has(name) { return this.bundle.clips.has(name); }

    /**
     * @param {string} name
     * @param {{loop?:boolean, fade?:number, rate?:number, restart?:boolean}} opt
     */
    play(name, { loop = true, fade = 0.12, rate = 1, restart = false } = {}) {
        const clip = this.bundle.clips.get(name);
        if (!clip) return false;
        if (this.current === clip && !restart) { this.loop = loop; this.rate = rate; return true; }
        if (this.current && fade > 0) { this._snapshot(); this._fadeDur = fade; this._fadeT = 0; }
        else { this._fadeDur = 0; }
        this.current = clip;
        this.time = 0;
        this.loop = loop;
        this.rate = rate;
        this.done = false;
        return true;
    }

    /** Freeze the pose currently on the bones as the crossfade source. */
    _snapshot() {
        for (let i = 0; i < this.nodes.length; i++) {
            const n = this.nodes[i];
            const o = i * 4;
            if (n) { this._from[o] = n.quaternion.x; this._from[o + 1] = n.quaternion.y; this._from[o + 2] = n.quaternion.z; this._from[o + 3] = n.quaternion.w; }
            else { this._from[o] = 0; this._from[o + 1] = 0; this._from[o + 2] = 0; this._from[o + 3] = 1; }
        }
        this._fromY = this.hips ? this.hips.position.y : 0;
    }

    /**
     * Drive the clip from an EXPLICIT normalised time rather than the clock.
     * The combat bridge uses this so an attack's visual progress is locked to
     * the engine's startup/active/recovery frames.
     */
    scrub(name, u, { fade = 0.08 } = {}) {
        if (this.current?.name !== name) this.play(name, { loop: false, fade });
        this.time = THREE.MathUtils.clamp(u, 0, 1) * this.current.dur;
        this._apply();
    }

    update(dt) {
        if (!this.current) return;
        this.time += dt * this.rate;
        if (this.time >= this.current.dur) {
            if (this.loop) this.time %= this.current.dur;
            else { this.time = this.current.dur; this.done = true; }
        }
        if (this._fadeDur > 0) {
            this._fadeT += dt;
            if (this._fadeT >= this._fadeDur) this._fadeDur = 0;
        }
        this._apply();
    }

    _apply() {
        const c = this.current;
        const { payload, bones } = this.bundle;
        const nb = bones.length;
        // frame pair + fraction
        const ft = (c.frames - 1) * (c.dur > 0 ? this.time / c.dur : 0);
        const f0 = Math.min(c.frames - 1, Math.floor(ft));
        const f1 = Math.min(c.frames - 1, f0 + 1);
        const u = ft - f0;

        const base0 = c.offset + f0 * nb * 4;
        const base1 = c.offset + f1 * nb * 4;
        const fade = this._fadeDur > 0 ? Math.min(1, this._fadeT / this._fadeDur) : 1;
        // smoothstep the blend — a linear crossfade starts and stops abruptly
        const k = fade * fade * (3 - 2 * fade);

        for (let i = 0; i < nb; i++) {
            const n = this.nodes[i];
            if (!n) continue;
            const o0 = base0 + i * 4, o1 = base1 + i * 4;
            this._qa.set(payload[o0] * INV, payload[o0 + 1] * INV, payload[o0 + 2] * INV, payload[o0 + 3] * INV).normalize();
            this._qb.set(payload[o1] * INV, payload[o1 + 1] * INV, payload[o1 + 2] * INV, payload[o1 + 3] * INV).normalize();
            this._out.copy(this._qa).slerp(this._qb, u);
            if (k < 1) {
                const p = i * 4;
                this._qa.set(this._from[p], this._from[p + 1], this._from[p + 2], this._from[p + 3]);
                this._out.copy(this._qa).slerp(this._out, k);
            }
            n.quaternion.copy(this._out);
        }

        // hips vertical — stored as millimetre-ish ints relative to frame 0
        if (this.hips) {
            const yBase = c.offset + c.frames * nb * 4;
            const y0 = payload[yBase + f0] / 10000, y1 = payload[yBase + f1] / 10000;
            let y = this.hipsRestY + (y0 + (y1 - y0) * u);
            if (k < 1) y = this._fromY + (y - this._fromY) * k;
            this.hips.position.y = y;
        }
    }
}
