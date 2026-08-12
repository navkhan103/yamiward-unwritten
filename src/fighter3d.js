/**
 * YAMIWARD — 3D fighter (VRM) loader + procedural animation
 * ============================================================================
 * The paper-dolls were always the placeholder; this is the real thing. A VRoid
 * VRM is a rigged humanoid (standard bone set), so we load it with the shared
 * three-vrm plugin and drive the humanoid bones ourselves.
 *
 * Animation is PROCEDURAL keyframes (poses over time) rather than Mixamo clips,
 * for two reasons: it needs no external assets or downloads, and it stays fully
 * in our control so the fight engine can drive it frame-exactly. The clip player
 * is authored so a Mixamo/glTF clip can be swapped in per move later without
 * touching the combat bridge.
 *
 * Everything imports the SAME vendored three (via the import map) as the rest of
 * the game — a second three instance is the classic cause of "VRM loads but
 * every class check fails" breakage, so we never bundle our own.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName as B } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Model bytes cache
// ---------------------------------------------------------------------------
// A match needs TWO fighters from (currently) the same 16MB file. Calling
// loader.loadAsync(url) per fighter downloads it twice — the requests fire in
// parallel, so the browser's HTTP cache does not reliably coalesce them, and on
// a static host that is 32MB across the wire before anyone throws a punch.
//
// So: fetch the bytes ONCE per URL (memoised promise), then parse per fighter.
// Parsing twice is deliberate and required — it is what gives each fighter its
// OWN materials, which is what lets the two of them wear different clan
// palettes. Verified: re-parsing the same ArrayBuffer is safe (it is only ever
// read) and the resulting materials are distinct objects, so a tint applied to
// one fighter cannot leak into the other.
const _bytes = new Map();   // url -> Promise<ArrayBuffer>

function vrmBytes(url) {
    let p = _bytes.get(url);
    if (!p) {
        p = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
            return r.arrayBuffer();
        }).catch((e) => { _bytes.delete(url); throw e; });   // don't cache a failure
        _bytes.set(url, p);
    }
    return p;
}

/**
 * Warm the cache before the model is needed. Called while the player is still
 * on the character-select screen, so the download overlaps the time they spend
 * choosing instead of stalling the match start.
 */
export function prefetchVRM(url) { vrmBytes(url).catch(() => { /* surfaced at load */ }); }

/** Load a .vrm and return the VRM object (has .scene, .humanoid, .update(dt)). */
export async function loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const buf = await vrmBytes(url);
    // parseAsync needs a path for resolving external resources; a VRM is a
    // self-contained GLB, so '' is correct here.
    const gltf = await loader.parseAsync(buf, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('file is not a VRM (no userData.vrm)');

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);   // VRM0 faces -Z; normalise to +Z like VRM1

    vrm.scene.traverse((o) => {
        o.frustumCulled = false;
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return vrm;
}

// ---------------------------------------------------------------------------
// Per-fighter appearance
// ---------------------------------------------------------------------------
// One VRM body, eight fighters. VRoid names its materials by convention
// (`..._SKIN`, `..._HAIR`, `..._CLOTH_01`, `Onepiece`, `Shoes`, `_EYE`, plus a
// matching `(Outline)` for each), which gives a reliable seam to retint without
// authoring eight models. Each palette is built from the character's canon clan
// colour so the roster reads at a glance — the yokai each fighter descends from
// is the design brief.
//
// This is a STAND-IN strategy, not the destination: real per-fighter models
// replace these one at a time, and dropping assets/models/<key>.vrm in is all
// that takes (see resolveModelUrl).

const PALETTES = {
    tetsuki:  { skin: 0xc9b6ad, hair: 0x241a1c, cloth1: 0x8e2018, cloth2: 0x2a1a18, shoes: 0x1a1214, eye: 0xe51e25 }, // oni: ash skin, forge red
    // Yukiwari is the snow fighter, but a near-white palette blew out to a
    // featureless blob once bloom hit it (roster QA). Pulled down into pale
    // blue-greys: still unmistakably "snow", still has readable form.
    yukiwari: { skin: 0xdccfc9, hair: 0xa9c4d4, cloth1: 0x9fc0c6, cloth2: 0x63879a, shoes: 0x546f7e, eye: 0x9be8e0 }, // yukionna
    raiga:    { skin: 0xd9b89a, hair: 0x1c2b4a, cloth1: 0x2a4f8f, cloth2: 0x14203a, shoes: 0x0f1626, eye: 0x4a8fe8 }, // raiju: storm blue
    mayoi:    { skin: 0xf0d9c2, hair: 0x3b2a34, cloth1: 0x2f6f63, cloth2: 0x7a2a52, shoes: 0x241a22, eye: 0x5be0c8 }, // kitsune: jade + fox rose
    shigure:  { skin: 0xe3d6d0, hair: 0x2b2540, cloth1: 0x4a3f78, cloth2: 0x241f38, shoes: 0x191527, eye: 0x7c6fd4 }, // ameonna: rain violet
    tsukimi:  { skin: 0xf6ecea, hair: 0xe8dcf5, cloth1: 0xbfb0d8, cloth2: 0x6f6390, shoes: 0x4a4266, eye: 0xd8c9f0 }, // tsukiusagi: moon pale
    kazakiri: { skin: 0xdcc3b4, hair: 0x2a1420, cloth1: 0x6e2a5e, cloth2: 0x2a1626, shoes: 0x1d1019, eye: 0xa0468c }, // tengu: plum + shadow
    yumihari: { skin: 0xe8c9a0, hair: 0x30240f, cloth1: 0x9c6a1c, cloth2: 0x2e2413, shoes: 0x1f1a10, eye: 0xe0a83c }, // ryu: gold scale
};

/** Multiply a hex by a factor, for deriving a shade/outline tone. */
function darken(hex, f) {
    return new THREE.Color(hex).multiplyScalar(f);
}

/**
 * Retint a loaded VRM to a fighter's palette.
 *
 * MToon carries several colour slots and they must move together or the model
 * looks wrong under stage light: `color` is the lit tone, `shadeColorFactor` is
 * what the shaded side becomes (leaving it white makes a dark outfit glow in
 * shadow), and `outlineColorFactor` is the ink line. `parametricRimColorFactor`
 * gets the clan colour, which is what actually separates eight silhouettes in a
 * dark arena.
 */
export function applyFighterLook(vrm, key, rim) {
    const p = PALETTES[key];
    if (!p) return;
    const rimColor = new THREE.Color(rim ?? 0xffffff);

    vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if (!m || !m.name) continue;
            const n = m.name;
            let tint = null;
            if (/_SKIN/.test(n)) tint = p.skin;
            else if (/_HAIR/.test(n)) tint = p.hair;
            else if (/Tops_01/.test(n)) tint = p.cloth1;
            else if (/Tops_02|Onepiece/.test(n)) tint = p.cloth2;
            else if (/Shoes/.test(n)) tint = p.shoes;
            else if (/EyeIris/.test(n)) tint = p.eye;
            if (tint === null) continue;   // face lines, eye whites, highlights: leave alone

            if (m.color) m.color.set(tint);
            // Shade tone must follow the lit tone or the dark side goes pale.
            if (m.shadeColorFactor) m.shadeColorFactor.copy(darken(tint, 0.55));
            if (m.outlineColorFactor) m.outlineColorFactor.copy(darken(tint, 0.18));
            // Clan colour as the rim — the cheapest way to tell eight fighters
            // apart at a glance in a night stage.
            if (m.parametricRimColorFactor && !/_EYE|Eyeline|Brow|Mouth/.test(n)) {
                m.parametricRimColorFactor.copy(rimColor).multiplyScalar(0.35);
            }
            m.needsUpdate = true;
        }
    });
}

/**
 * Where a fighter's model lives. A real per-fighter export wins if present;
 * otherwise everyone shares the stand-in and is told apart by palette.
 */
export function resolveModelUrl(key, available) {
    // base.vrm is the SHARED stand-in and must stay generic — it is what the
    // seven fighters without their own export are wearing. Keeping it separate
    // from tetsuki.vrm is deliberate: it means a real, oni-specific Tetsuki can
    // be dropped in without turning the whole roster into Tetsuki.
    return (available && available.has(key)) ? `./assets/models/${key}.vrm` : './assets/models/base.vrm';
}

// ---------------------------------------------------------------------------
// Pose library
// ---------------------------------------------------------------------------
// A POSE is a partial map { boneName: [x,y,z] } of Euler radians applied to the
// NORMALIZED humanoid bones. Anything not named falls back to REST. Axis signs
// were verified against renders (e.g. lowering an arm needs left z<0, right z>0).

const BONES = [
    B.Spine, B.Chest, B.Neck, B.Head,
    B.LeftShoulder, B.LeftUpperArm, B.LeftLowerArm, B.LeftHand,
    B.RightShoulder, B.RightUpperArm, B.RightLowerArm, B.RightHand,
    B.LeftUpperLeg, B.LeftLowerLeg, B.RightUpperLeg, B.RightLowerLeg,
];

// Neutral rest: arms down at the sides, everything else at bind pose.
const REST = {
    [B.LeftUpperArm]: [0, 0, -1.28], [B.RightUpperArm]: [0, 0, 1.28],
    [B.LeftLowerArm]: [0, 0, -0.12], [B.RightLowerArm]: [0, 0, 0.12],
};

// A bladed fighting guard: weight low, lead shoulder in, fists up.
// Upper-arm z was -0.85/0.80 in the first pass, which left the arms SPLAYED
// out from the body like an A-pose (visible immediately on the roster line-up).
// A real guard keeps the elbows in against the ribs — z near -1.15 — and does
// the work with the forearms.
const GUARD = {
    [B.Spine]: [0.10, 0.20, 0], [B.Chest]: [0.05, 0.12, 0],
    [B.LeftUpperArm]: [-0.62, 0.18, -1.16], [B.LeftLowerArm]: [-1.45, -0.25, -0.30],
    [B.RightUpperArm]: [-0.52, -0.18, 1.12], [B.RightLowerArm]: [-1.62, 0.25, 0.30],
    [B.LeftUpperLeg]: [-0.12, 0, 0.10], [B.LeftLowerLeg]: [0.22, 0, 0],
    [B.RightUpperLeg]: [-0.10, 0, -0.12], [B.RightLowerLeg]: [0.26, 0, 0],
    [B.Head]: [0.06, 0.10, 0],
};

const g = (over) => ({ ...GUARD, ...over });   // pose built on top of the guard

// NOTE ON EXAGGERATION: these are deliberately larger than life. A punch tuned
// to look "anatomically correct" reads as a twitch at gameplay camera distance —
// fighting games push the extremes so the SILHOUETTE tells you what happened in
// a single frame. First pass here was naturalistic and was unreadable on a
// contact sheet; every attack now commits the whole body.

// Jab: lead (left) arm fires straight out, shoulder and chest drive behind it.
const JAB_OUT = g({
    [B.Spine]: [0.08, -0.28, 0], [B.Chest]: [0.04, -0.30, 0],
    [B.LeftShoulder]: [0, -0.25, 0],
    [B.LeftUpperArm]: [-1.62, -0.30, -0.10], [B.LeftLowerArm]: [-0.06, 0, -0.02],
    [B.RightUpperArm]: [-0.55, -0.15, 0.95], [B.RightLowerArm]: [-1.7, 0.2, 0.3],
});
// Cross / heavy: rear (right) arm drives through, hips rotate fully over.
const CROSS_WIND = g({
    [B.Spine]: [0.14, 0.62, 0], [B.Chest]: [0.06, 0.40, 0],
    [B.RightShoulder]: [0, 0.30, 0],
    [B.RightUpperArm]: [-0.25, -0.55, 1.15], [B.RightLowerArm]: [-2.0, 0.3, 0.35],
    [B.LeftUpperArm]: [-0.85, 0.25, -0.75],
});
const CROSS_OUT = g({
    [B.Spine]: [0.10, -0.62, 0], [B.Chest]: [0.05, -0.45, 0],
    [B.RightShoulder]: [0, -0.32, 0],
    [B.RightUpperArm]: [-1.68, 0.28, 0.08], [B.RightLowerArm]: [-0.05, 0, 0.02],
    [B.LeftUpperArm]: [-0.35, 0.30, -1.05], [B.LeftLowerArm]: [-1.5, -0.2, -0.25],
    [B.LeftUpperLeg]: [-0.2, 0, 0.12], [B.RightUpperLeg]: [0.12, 0, -0.12],
});
// Low kick: rear leg chambers then whips through at shin height.
const KICK_WIND = g({
    [B.Spine]: [0.16, 0.25, 0],
    [B.RightUpperLeg]: [-0.85, 0, -0.20], [B.RightLowerLeg]: [1.35, 0, 0],
    [B.LeftUpperLeg]: [-0.15, 0, 0.10], [B.LeftLowerLeg]: [0.30, 0, 0],
});
const KICK_OUT = g({
    [B.Spine]: [0.05, -0.35, 0.18], [B.Chest]: [0.02, -0.25, 0.10],
    [B.RightUpperLeg]: [-1.15, 0, -0.35], [B.RightLowerLeg]: [0.12, 0, 0],
    [B.LeftUpperLeg]: [-0.10, 0, 0.12], [B.LeftLowerLeg]: [0.28, 0, 0],
    [B.LeftUpperArm]: [-0.30, 0.2, -1.15], [B.RightUpperArm]: [-0.5, 0, 1.0],
});
// Hurt: flinch back, head snaps, arms break guard.
const HURT = {
    [B.Spine]: [-0.28, 0.05, 0], [B.Chest]: [-0.15, 0, 0], [B.Head]: [-0.30, -0.15, 0.1],
    [B.LeftUpperArm]: [-0.15, 0, -1.05], [B.RightUpperArm]: [-0.15, 0, 1.0],
    [B.LeftLowerArm]: [-0.6, 0, -0.2], [B.RightLowerArm]: [-0.6, 0, 0.2],
    [B.LeftUpperLeg]: [-0.1, 0, 0.08], [B.RightUpperLeg]: [-0.15, 0, -0.1], [B.RightLowerLeg]: [0.3, 0, 0],
};
// Knockdown: collapse backward onto the ground (root drop handled separately).
const FALL = {
    [B.Spine]: [-0.5, 0, 0], [B.Chest]: [-0.35, 0, 0], [B.Head]: [-0.5, 0, 0],
    [B.LeftUpperArm]: [-0.2, 0, -1.4], [B.RightUpperArm]: [-0.2, 0, 1.4],
    [B.LeftUpperLeg]: [-0.6, 0, 0.1], [B.RightUpperLeg]: [-0.5, 0, -0.1],
    [B.LeftLowerLeg]: [0.7, 0, 0], [B.RightLowerLeg]: [0.6, 0, 0],
};
// Win: arms open, chest up.
const WIN = {
    [B.Spine]: [-0.08, 0, 0], [B.Chest]: [-0.06, 0, 0], [B.Head]: [-0.05, 0, 0],
    [B.LeftUpperArm]: [-0.2, 0, -0.7], [B.RightUpperArm]: [-0.2, 0, 0.7],
    [B.LeftLowerArm]: [-0.5, 0, -0.3], [B.RightLowerArm]: [-0.5, 0, 0.3],
};

// A CLIP is { loop, dur (s), keys:[{t:0..1, pose}] }. One-shots end on the last
// key and the state machine returns to idle; loops wrap.
const CLIPS = {
    idle:  { loop: true, dur: 2.4, keys: [{ t: 0, pose: GUARD }, { t: 1, pose: GUARD }] },
    walk:  { loop: true, dur: 0.7, keys: [
        { t: 0.0, pose: g({ [B.LeftUpperLeg]: [-0.35, 0, 0.1], [B.RightUpperLeg]: [0.2, 0, -0.1], [B.LeftLowerLeg]: [0.3, 0, 0] }) },
        { t: 0.5, pose: g({ [B.LeftUpperLeg]: [0.2, 0, 0.1], [B.RightUpperLeg]: [-0.35, 0, -0.1], [B.RightLowerLeg]: [0.3, 0, 0] }) },
        { t: 1.0, pose: g({ [B.LeftUpperLeg]: [-0.35, 0, 0.1], [B.RightUpperLeg]: [0.2, 0, -0.1], [B.LeftLowerLeg]: [0.3, 0, 0] }) },
    ] },
    crouch:{ loop: true, dur: 1, keys: [{ t: 0, pose: g({ [B.LeftUpperLeg]: [-0.6, 0, 0.12], [B.RightUpperLeg]: [-0.6, 0, -0.12], [B.LeftLowerLeg]: [0.9, 0, 0], [B.RightLowerLeg]: [0.9, 0, 0], [B.Spine]: [0.25, 0.1, 0] }) }] },
    light: { loop: false, dur: 0.34, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.28, pose: JAB_OUT }, { t: 0.5, pose: JAB_OUT }, { t: 1.0, pose: GUARD } ] },
    heavy: { loop: false, dur: 0.6, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.35, pose: CROSS_WIND }, { t: 0.55, pose: CROSS_OUT }, { t: 0.7, pose: CROSS_OUT }, { t: 1.0, pose: GUARD } ] },
    low:   { loop: false, dur: 0.5, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.35, pose: KICK_WIND }, { t: 0.55, pose: KICK_OUT }, { t: 0.7, pose: KICK_OUT }, { t: 1.0, pose: GUARD } ] },
    special:{ loop: false, dur: 0.55, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.3, pose: CROSS_WIND }, { t: 0.5, pose: CROSS_OUT }, { t: 1.0, pose: GUARD } ] },
    hurt:  { loop: false, dur: 0.4, keys: [{ t: 0, pose: HURT }, { t: 0.4, pose: HURT }, { t: 1, pose: GUARD }] },
    block: { loop: true, dur: 1, keys: [{ t: 0, pose: g({ [B.LeftUpperArm]: [-0.9, 0.2, -0.7], [B.LeftLowerArm]: [-1.7, -0.2, -0.2], [B.RightUpperArm]: [-0.9, -0.2, 0.7], [B.RightLowerArm]: [-1.8, 0.2, 0.2], [B.Spine]: [0.14, 0.12, 0] }) }] },
    ko:    { loop: false, dur: 0.7, keys: [{ t: 0, pose: HURT }, { t: 1, pose: FALL }] },
    win:   { loop: true, dur: 2, keys: [{ t: 0, pose: WIN }, { t: 1, pose: WIN }] },
};

function lerpPose(a, b, u, out) {
    for (const bone of BONES) {
        const pa = a[bone] || REST[bone] || ZERO;
        const pb = b[bone] || REST[bone] || ZERO;
        out[bone] = [
            pa[0] + (pb[0] - pa[0]) * u,
            pa[1] + (pb[1] - pa[1]) * u,
            pa[2] + (pb[2] - pa[2]) * u,
        ];
    }
    return out;
}
const ZERO = [0, 0, 0];

/**
 * Controller wrapping a loaded VRM. Plays procedural clips, blends between them,
 * and exposes setState() for the combat bridge to call each frame.
 */
export class Fighter3D {
    constructor(vrm) {
        this.vrm = vrm;
        this.root = vrm.scene;
        this._node = {};
        for (const b of BONES) this._node[b] = vrm.humanoid?.getNormalizedBoneNode(b) || null;

        this._clip = CLIPS.idle;
        this._name = 'idle';
        this._t = 0;             // seconds into the current clip
        this._blend = 0;         // 0..1 crossfade progress into the new clip
        this._blendDur = 0.12;
        this._from = {};         // frozen applied pose at the last switch
        this._cur = {};          // scratch sampled pose
        this._breath = 0;
        this._applied = {};      // last applied euler per bone (blend source)
        for (const b of BONES) this._applied[b] = (GUARD[b] || REST[b] || ZERO).slice();
    }

    get object3d() { return this.root; }
    setPosition(x, y, z) { this.root.position.set(x, y, z); }
    setYaw(y) { this.root.rotation.y = y; }
    setScale(s) { this.root.scale.setScalar(s); }

    /** Switch to a named clip. One-shots restart on request; loops don't re-trigger. */
    play(name, { restart = false } = {}) {
        if (!CLIPS[name]) return;
        if (name === this._name && !restart) return;
        // Freeze whatever is currently applied as the crossfade source.
        for (const b of BONES) this._from[b] = this._applied[b].slice();
        this._clip = CLIPS[name];
        this._name = name;
        this._t = 0;
        this._blend = 0;
    }

    /**
     * Play a clip at an EXPLICIT normalized time instead of on the wall clock.
     * The combat bridge uses this so an attack's visual progress is locked to
     * the engine's startup/active/recovery frames — the fist and the hitbox
     * must arrive on the same frame.
     * @param {string} name
     * @param {number} u 0..1 through the clip
     */
    scrub(name, u) {
        if (!CLIPS[name]) return;
        if (name !== this._name) {
            for (const b of BONES) this._from[b] = this._applied[b].slice();
            this._clip = CLIPS[name];
            this._name = name;
            this._blend = 0;
        }
        this._t = THREE.MathUtils.clamp(u, 0, 1) * this._clip.dur;
        this._scrubbed = true;
    }

    /** True once a one-shot clip has finished (state machine returns to idle). */
    get done() { return !this._clip.loop && this._t >= this._clip.dur; }
    get current() { return this._name; }

    _sample(out) {
        const keys = this._clip.keys;
        const u = this._clip.loop ? (this._t % this._clip.dur) / this._clip.dur
            : Math.min(1, this._t / this._clip.dur);
        let k0 = keys[0], k1 = keys[keys.length - 1];
        for (let i = 0; i < keys.length - 1; i++) {
            if (u >= keys[i].t && u <= keys[i + 1].t) { k0 = keys[i]; k1 = keys[i + 1]; break; }
        }
        const span = (k1.t - k0.t) || 1;
        const lu = THREE.MathUtils.clamp((u - k0.t) / span, 0, 1);
        // smootherstep for weight
        const s = lu * lu * lu * (lu * (lu * 6 - 15) + 10);
        return lerpPose(k0.pose, k1.pose, s, out);
    }

    update(dt) {
        // A scrubbed frame already set _t from engine frame data — advancing it
        // again here would double-speed the attack.
        if (this._scrubbed) this._scrubbed = false;
        else this._t += dt;
        this._breath += dt;
        if (this._blend < 1) this._blend = Math.min(1, this._blend + dt / this._blendDur);

        const sampled = this._sample(this._cur);
        const bw = this._blend;
        // Idle/guard breathing so a held pose isn't a mannequin.
        const breath = Math.sin(this._breath * 1.7) * 0.02;

        for (const bone of BONES) {
            const node = this._node[bone];
            if (!node) continue;
            const s = sampled[bone];
            const f = this._from[bone] || s;
            let x = f[0] + (s[0] - f[0]) * bw;
            let y = f[1] + (s[1] - f[1]) * bw;
            let z = f[2] + (s[2] - f[2]) * bw;
            if (bone === B.Spine) x += breath;
            this._applied[bone] = [x, y, z];
            node.rotation.set(x, y, z);
        }

        this.vrm.update(dt);   // spring bones (hair/cloth) + look-at
    }

    dispose() { VRMUtils.deepDispose(this.root); }
}

/**
 * Combat bridge: drive a Fighter3D from an engine fighter, every frame.
 *
 * The critical rule is that ATTACK animation time is slaved to the engine's own
 * frame data (startup / active / recovery), NOT to the clip's authored duration.
 * If the clip ran on its own clock, the fist would arrive on a different frame
 * than the hitbox — the exact desync that makes a fighting game feel wrong. So
 * for attacks we compute normalized progress from f.stateFrame and scrub the
 * clip to it; everything else plays on wall-clock.
 *
 * @param {Fighter3D} f3d
 * @param {object} f      engine fighter (state, stateFrame, move, crouching…)
 * @param {object} State  the engine's State enum
 */
export function driveFromEngine(f3d, f, State) {
    const st = f.state;

    if (st === State.ATTACKING && f.move) {
        const m = f.move;
        const total = (m.startupFrames ?? 6) + (m.activeFrames ?? 2) + (m.recoveryFrames ?? 8);
        const u = THREE.MathUtils.clamp(f.stateFrame / Math.max(1, total), 0, 1);
        // Resolve the move's SLOT from the character's own moveset rather than
        // parsing its name — moveName is flavour text ("Sleeve Flick", "Nine
        // Panels") and matching on it silently fell through to `heavy` for every
        // attack. f.moveKey + def.moveset is the authoritative mapping.
        let clip = 'heavy';
        const ms = f.def?.moveset;
        if (ms && f.moveKey) {
            const slot = Object.keys(ms).find((k) => ms[k] === f.moveKey);
            if (slot === 'light') clip = 'light';
            else if (slot === 'low') clip = 'low';
            else if (slot === 'special') clip = 'special';
            else if (slot === 'grab') clip = 'heavy';
            else if (slot === 'super') clip = 'special';
        }
        // Height is the backstop: anything that must be blocked low should read
        // as a leg attack even if a character names its slots unusually.
        if (m.height === 'LOW') clip = 'low';
        f3d.scrub(clip, u);
        return;
    }

    switch (st) {
        case State.HITSTUN:
        case State.JUGGLED:   f3d.play('hurt'); break;
        case State.KNOCKDOWN: f3d.play('ko'); break;
        case State.BLOCKING:  f3d.play('block'); break;
        case State.WIN:       f3d.play('win'); break;
        case State.LOSE:      f3d.play('ko'); break;
        case State.CROUCH:    f3d.play('crouch'); break;
        case State.MOVING:
        case State.SIDESTEP:  f3d.play('walk'); break;
        default:              f3d.play(f.crouching ? 'crouch' : 'idle'); break;
    }
}

/** Legacy single-pose helper kept for the bare preview. */
export function poseIdle(vrm) {
    const set = (b, x, y, z) => { const n = vrm.humanoid?.getNormalizedBoneNode(b); if (n) n.rotation.set(x, y, z); };
    for (const b of Object.keys(GUARD)) { const e = GUARD[b]; set(b, e[0], e[1], e[2]); }
}
