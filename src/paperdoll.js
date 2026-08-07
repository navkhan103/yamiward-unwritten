/**
 * YAMIWARD — paperdoll
 * ============================================================================
 * The paper-doll fighter rig (SPEC-PAPERDOLL.md). ~10 textured planes parented
 * into a 2-level limb hierarchy; THIS is the skeleton — there was never a GLB
 * one. The doll billboards toward the camera (Paper-Mario-in-3D): the arena,
 * sidestep and hitboxes stay fully 3D, only the drawing is planar.
 *
 * CONTRACT (inherited from CombatEngine rule 3): update() reads engine state
 * and writes ONLY presentation. Pose = pure function of (state, stateFrame,
 * moveKey, move frame data) — deterministic under rollback. The exponential
 * smoothing between poses uses render dt, which is legal for the same reason
 * the placeholder's fist-lerp was: it never feeds back into the sim.
 *
 * Art arrives in two stages:
 *   untextured — cel-shaded colored planes in the fighter's palette. Always
 *                available; this alone replaces the capsule placeholder.
 *   atlas      — assets/dolls/<key>.webp + <key>.json {piece:{rect,pivot,size}}
 *                cut from character renders. Loaded async; pieces re-skin in place
 *                when it lands. Missing atlas is not an error.
 *
 * The clan mark (§3): a band quad on the near forearm, crest silhouette
 * knocked out at runtime from assets/crests/<clanKey>.webp, tinted def.color.
 * Composited, never model output — small regions are where generators drift.
 */

import * as THREE from 'three';
import { createCelMaterial } from './celShader.js';
import { State } from './CombatEngine.js';
import { CLIPS, STATE_CLIP, SLOT_CLIP } from './dollPoses.js';

const DEG = Math.PI / 180;

/**
 * Rig description. `joint` = offset of the pivot from the PARENT's pivot in
 * the guard-neutral skeleton; `plane` = [w,h] of the visual; `center` = plane
 * centre offset from the pivot (limbs hang down, torso stands up); `z` =
 * draw-order bias (near arm in front of torso, far arm behind).
 * L = far side, R = near side in the unmirrored view.
 */
const RIG = [
    { id: 'torso',      parent: null,         joint: [0, 0, 0],        plane: [0.46, 0.62], center: [0, 0.30], z: 0 },
    { id: 'head',       parent: 'torso',      joint: [0, 0.55, 0],     plane: [0.36, 0.38], center: [0, 0.16], z: 0.010 },
    { id: 'armUpper.L', parent: 'torso',      joint: [-0.17, 0.50, 0], plane: [0.15, 0.34], center: [0, -0.15], z: -0.020 },
    { id: 'armFore.L',  parent: 'armUpper.L', joint: [0, -0.31, 0],    plane: [0.14, 0.36], center: [0, -0.16], z: 0 },
    { id: 'armUpper.R', parent: 'torso',      joint: [0.17, 0.50, 0],  plane: [0.16, 0.34], center: [0, -0.15], z: 0.030 },
    { id: 'armFore.R',  parent: 'armUpper.R', joint: [0, -0.31, 0],    plane: [0.15, 0.36], center: [0, -0.16], z: 0 },
    { id: 'legUpper.L', parent: null,         joint: [-0.09, 0, 0],    plane: [0.19, 0.50], center: [0, -0.23], z: -0.015 },
    { id: 'legLower.L', parent: 'legUpper.L', joint: [0, -0.46, 0],    plane: [0.17, 0.52], center: [0, -0.24], z: 0 },
    { id: 'legUpper.R', parent: null,         joint: [0.09, 0, 0],     plane: [0.20, 0.50], center: [0, -0.23], z: 0.015 },
    { id: 'legLower.R', parent: 'legUpper.R', joint: [0, -0.46, 0],    plane: [0.18, 0.52], center: [0, -0.24], z: 0 },
];

const HIP_Y = 0.95;   // guard-neutral hip height; root.y offsets are relative

/**
 * Robe variant: identical from the hips up, but the four leg pieces are replaced
 * by ONE robe plane hanging from the hips. Built for Yukiwari, whose canon
 * costume (story bible §5) is a floor-length kimono — she has no separable
 * lower legs to cut, and faking a leg split under the robe would invent art.
 * The robe is not animated by clips: its sway is DERIVED from the leg channels
 * the clips already carry (walk scissor -> sway, sweep -> swish), so every
 * existing pose works unmodified on both rigs.
 */
const ROBE_RIG = [
    ...RIG.filter((p) => !p.id.startsWith('leg')),
    { id: 'robe', parent: null, joint: [0, 0, 0], plane: [0.36, 0.97], center: [0, -0.48], z: -0.012 },
];

/**
 * Winged variant: the full 10-piece rig plus ONE wing plane parented to the
 * torso and drawn behind everything. Built for Kazakiri, whose owned traits
 * include "long black crow wings" — baking them into the torso piece would
 * make his silhouette a solid slab, and the wings are most of his read at
 * gameplay distance.
 * One plane, not two: the wings are a single spread behind him in the source
 * art, and splitting a shape the art never separated is how a paper doll
 * starts showing seams. Like the robe it carries no authored channel — it
 * counter-rotates gently against the torso so the spread lags the body.
 */
const WING_RIG = [
    ...RIG,
    { id: 'wings', parent: 'torso', joint: [0, 0.34, 0], plane: [1.05, 0.78], center: [0, 0.02], z: -0.055 },
];

/**
 * Robe + wings: Kazakiri. His canon costume is floor-length black robes AND
 * long crow wings, so he needs both variants at once.
 * The wings are TWO pieces here rather than the single plane WING_RIG uses,
 * for a cutting reason rather than an animation one: his spread reaches both
 * frame edges, so one rect wide enough to hold it also contains his whole body,
 * and that body would ghost behind the real pieces. Two rects take the left and
 * right spreads and leave the torso column alone.
 */
const ROBE_WING_RIG = [
    ...ROBE_RIG,
    { id: 'wings.L', parent: 'torso', joint: [-0.16, 0.30, 0], plane: [0.62, 0.86], center: [-0.26, -0.06], z: -0.060 },
    { id: 'wings.R', parent: 'torso', joint: [0.16, 0.30, 0], plane: [0.62, 0.86], center: [0.26, -0.06], z: -0.058 },
];

// ---------------------------------------------------------------------------
// Clan mark texture — band + crest knockout, composed once per clan at runtime.
// ---------------------------------------------------------------------------

const markTexCache = new Map();   // clanKey -> THREE.CanvasTexture

function makeMarkTexture(clanKey) {
    if (markTexCache.has(clanKey)) return markTexCache.get(clanKey);

    const W = 128, H = 72;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');

    // Solid band immediately — crest knockout composites in when the PNG lands.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 6, W, H - 12);

    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    markTexCache.set(clanKey, tex);

    if (clanKey) {
        const img = new Image();
        img.onload = () => {
            // Crest luminance -> knockout. The crest is a dark seal on its own
            // ground; treat DARK pixels as ink and punch them out of the band.
            const s = document.createElement('canvas');
            const side = H - 16;
            s.width = side; s.height = side;
            const sctx = s.getContext('2d');
            sctx.drawImage(img, 0, 0, side, side);
            const d = sctx.getImageData(0, 0, side, side);
            for (let i = 0; i < d.data.length; i += 4) {
                const lum = 0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2];
                // ink (dark) -> opaque in the stencil; ground (light) -> clear
                d.data[i + 3] = lum < 110 ? 255 : 0;
                d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
            }
            sctx.putImageData(d, 0, 0);
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(s, (W - side) / 2, 8);
            ctx.globalCompositeOperation = 'source-over';
            tex.needsUpdate = true;
        };
        img.onerror = () => { /* band stays solid — still a clan-colored mark */ };
        img.src = `./assets/crests/${clanKey}.webp`;
    }
    return tex;
}

// ---------------------------------------------------------------------------
// Pose evaluation — pure (clip, u|frame, move) -> {rot per piece, root}
// ---------------------------------------------------------------------------

function anchorU(t, move) {
    if (typeof t === 'number') return t;
    const total = Math.max(1, move.startupFrames + move.activeFrames + move.recoveryFrames);
    switch (t) {
        case 'start': return 0;
        case 'active': return move.startupFrames / total;
        case 'recover': return (move.startupFrames + move.activeFrames) / total;
        case 'end': return 1;
        default: return 0;
    }
}

/** Evaluate a clip. For phase clips pass the move; u is stateFrame/total. */
function evalClip(clip, frame, move) {
    const keys = clip.keys;
    let u;
    if (clip.phase) {
        const total = Math.max(1, move.startupFrames + move.activeFrames + move.recoveryFrames);
        u = Math.min(1, frame / total);
    } else if (clip.dur > 1) {
        u = (frame % clip.dur);
    } else {
        u = 0;
    }

    // Locate bracketing keys.
    let a = keys[0], b = keys[keys.length - 1];
    const keyT = (k) => clip.phase ? anchorU(k.t, move) : k.t;
    for (let i = 0; i < keys.length - 1; i++) {
        if (u >= keyT(keys[i]) && u <= keyT(keys[i + 1])) { a = keys[i]; b = keys[i + 1]; break; }
    }
    const ta = keyT(a), tb = keyT(b);
    const s = tb > ta ? (u - ta) / (tb - ta) : 0;

    const out = { rot: {}, rootY: 0, rootRZ: 0 };
    const ra = a.r || {}, rb = b.r || {};
    for (const piece of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        const va = ra[piece] ?? 0, vb = rb[piece] ?? 0;
        out.rot[piece] = (va + (vb - va) * s) * DEG;
    }
    const rootA = a.root || {}, rootB = b.root || {};
    out.rootY = (rootA.y ?? 0) + ((rootB.y ?? 0) - (rootA.y ?? 0)) * s;
    out.rootRZ = ((rootA.rz ?? 0) + ((rootB.rz ?? 0) - (rootA.rz ?? 0)) * s) * DEG;
    return out;
}

/** Pick the clip for a fighter's current engine state. */
function clipFor(f, def) {
    if (f.state === State.ATTACKING && f.move) {
        const slot = Object.keys(def.moveset).find((k) => def.moveset[k] === f.moveKey);
        return { clip: CLIPS[SLOT_CLIP[slot] || 'ATK_HEAVY'], move: f.move };
    }
    let key = STATE_CLIP[f.state] || 'IDLE';
    if (f.state === State.CROUCH || (f.state === State.BLOCKING && f.crouching)) key = 'CROUCH';
    return { clip: CLIPS[key] || CLIPS.IDLE, move: null };
}

// ---------------------------------------------------------------------------
// Doll construction
// ---------------------------------------------------------------------------

/**
 * Build a paper-doll for a character def. Returns a THREE.Group whose
 * userData matches buildPlaceholder's shape ({mat, flash}) plus {doll}.
 * Never throws for missing art — untextured mode is the floor.
 */
export function buildDoll(def) {
    const group = new THREE.Group();

    // One shared cel material (M1): whole-body tint + rim + hit flash, same
    // program as the placeholder had. Atlas stage will move to per-piece maps.
    const inkBase = new THREE.Color(def.color).multiplyScalar(0.5);
    const mat = createCelMaterial({
        color: inkBase, rimColor: def.rimColor,
        rimPower: 2.1, rimStrength: 1.3, steps: 3,
    });
    mat.side = THREE.DoubleSide;

    // rigRoot carries mirror (scale.x) and knockdown tilt; hips carries pose
    // root offsets. group itself carries world position + billboard yaw.
    const rigRoot = new THREE.Group();
    group.add(rigRoot);
    const hips = new THREE.Group();
    hips.position.y = HIP_Y;
    rigRoot.add(hips);

    // Rig variant is a def-level choice (moves.js `rig: 'robe'`) so the
    // untextured fallback doll has the right silhouette before any atlas loads.
    const rig = def.rig === 'robe' ? ROBE_RIG
        : def.rig === 'wings' ? WING_RIG
        : def.rig === 'robewings' ? ROBE_WING_RIG
        : RIG;

    const joints = new Map();   // piece id -> joint group
    for (const p of rig) {
        const joint = new THREE.Group();
        const parent = p.parent ? joints.get(p.parent) : hips;
        joint.position.set(p.joint[0], p.joint[1], p.joint[2] + p.z);
        parent.add(joint);

        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.plane[0], p.plane[1]), mat);
        mesh.position.set(p.center[0], p.center[1], 0);
        mesh.castShadow = true;
        joint.add(mesh);
        joints.set(p.id, joint);
    }

    // Clan mark — §3. Child of the near forearm, in front of its plane.
    const markMat = new THREE.MeshBasicMaterial({
        map: makeMarkTexture(def.clanKey),
        color: def.color,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.095), markMat);
    mark.position.set(0, -0.13, 0.006);
    joints.get('armFore.R').add(mark);

    // Smoothed pose state (presentation-only).
    const current = { rot: new Map(rig.map((p) => [p.id, 0])), rootY: 0, rootRZ: 0 };

    const doll = {
        joints, hips, rigRoot, mark,

        // Canon relative height; 1 until an atlas manifest says otherwise, so the
        // untextured fallback doll is unaffected.
        stature: 1,

        // Robe plane dimensions in world units — hip-to-hem, and half the hem
        // width (the swing arm of a bottom corner). Seeded from the untextured
        // ROBE_RIG and re-measured from the art once an atlas lands.
        robeHemH: HIP_Y,
        robeHalfW: 0.18,

        /** Read engine fighter -> pose the doll. Presentation writes only. */
        update(f, dt, camera) {
            // Billboard toward the camera around Y; mirror by engine facing.
            const yaw = Math.atan2(
                camera.position.x - group.position.x,
                camera.position.z - group.position.z
            );
            group.rotation.y = yaw;
            // Uniform stature scale (canon relative height) times the facing
            // mirror. Uniform is deliberate: hip height scales with limb length,
            // so the feet stay on the floor at any stature.
            const st = doll.stature;
            rigRoot.scale.set(f.facing === 1 ? st : -st, st, st);
            // Both dolls billboard into near-parallel planes, so when fighters
            // overlap their piece z-biases interleave and z-fight. Push each
            // slot apart along the view axis (local +z faces the camera after
            // the billboard) — invisible at gameplay distance, kills the moiré.
            rigRoot.position.z = f.slot === 0 ? 0.09 : -0.09;

            const { clip, move } = clipFor(f, def);
            const target = evalClip(clip, f.stateFrame, move);

            // Exponential settle toward the target pose — hides state pops.
            const k = Math.min(1, dt * 18);
            for (const p of rig) {
                const cur = current.rot.get(p.id);
                // The robe has no authored channel: its sway is derived from the
                // far leg's thigh channel, which every locomotion/sweep clip
                // already animates. 0.35 keeps it a drape, not a pendulum.
                const want = p.id === 'robe'
                    ? (target.rot['legUpper.L'] ?? 0) * 0.35
                    : p.id.startsWith('wings')
                        // counter-rotate against the torso so the spread lags
                        // the body instead of moving welded to it; the paired
                        // wings splay in opposite directions so the spread
                        // opens and closes rather than sliding sideways
                        ? (target.rot['torso'] ?? 0) * (p.id === 'wings.R' ? 0.55 : -0.55)
                        : (target.rot[p.id] ?? 0);
                const next = cur + (want - cur) * k;
                current.rot.set(p.id, next);
                joints.get(p.id).rotation.z = next;
            }
            current.rootY += (target.rootY - current.rootY) * k;
            current.rootRZ += (target.rootRZ - current.rootRZ) * k;
            hips.position.y = HIP_Y + current.rootY;
            rigRoot.rotation.z = current.rootRZ;
            // Hem stays on the floor: the robe hangs from the hips, so a crouch
            // would otherwise push it through the stage. Compress by the ratio of
            // available hip height to the robe's OWN length — measured from the
            // geometry in loadAtlas, not assumed to equal HIP_Y. The art decides
            // where the hem falls (Yukiwari's is 0.993, not 0.95), and using
            // HIP_Y as the divisor buried the hem 4cm into the stage standing
            // and 13cm crouched.
            const robeJoint = joints.get('robe');
            if (robeJoint) {
                // The robe swings about the hip, so its lowest point is a bottom
                // CORNER, not the hem's centre. The joint scales in Y and then
                // rotates, so that corner sits at  W·sin(θ) + H·s·cos(θ)  below
                // the hip — the width term does NOT scale with s. Solving that
                // for s is what actually keeps the hem out of the stage; treating
                // the two terms as a single scaled "reach" still left the corner
                // 7cm under on crouch.
                const sway = Math.abs(robeJoint.rotation.z);
                const drop = HIP_Y + current.rootY - doll.robeHalfW * Math.sin(sway);
                const s = drop / Math.max(1e-4, doll.robeHemH * Math.cos(sway));
                // Floor of 0.3 (not 0.45): the solve needs that much room on deep
                // crouch frames with a hard sway, and clamping early is what put
                // the hem 10cm into the stage on transients. 0.3 still reads as a
                // gathered kimono rather than a collapsed one.
                robeJoint.scale.y = Math.min(1.05, Math.max(0.3, s));
            }
        },

        /**
         * Atlas re-skin (M4): swap piece planes to per-piece textured
         * materials from assets/dolls/<key>.{webp,json}. Fire-and-forget;
         * untextured doll keeps playing if it never lands.
         */
        async loadAtlas() {
            try {
                const res = await fetch(`./assets/dolls/${def.key}.json`);
                if (!res.ok) return false;
                const doc = await res.json();
                // atlas.mjs nests pieces under `pieces` alongside build metadata;
                // a bare id-keyed object is still accepted.
                const manifest = doc.pieces ?? doc;
                const tex = await new THREE.TextureLoader().loadAsync(`./assets/dolls/${def.key}.webp`);
                tex.colorSpace = THREE.SRGBColorSpace;
                if (doc.stature) doll.stature = doc.stature;
                for (const p of rig) {
                    const m = manifest[p.id];
                    if (!m) continue;
                    const pieceTex = tex.clone();
                    pieceTex.needsUpdate = true;
                    const [x, y, w, h] = m.rect;   // px in atlas
                    pieceTex.repeat.set(w / tex.image.width, h / tex.image.height);
                    pieceTex.offset.set(x / tex.image.width, 1 - (y + h) / tex.image.height);
                    // Mipmaps are WRONG for an atlas sub-rect: lower levels average
                    // across the whole sheet, so a shrinking piece bleeds its
                    // neighbours' pixels in. Linear filtering only, and clamp so the
                    // repeat/offset window can never wrap onto an adjacent piece.
                    pieceTex.generateMipmaps = false;
                    pieceTex.minFilter = THREE.LinearFilter;
                    pieceTex.magFilter = THREE.LinearFilter;
                    pieceTex.wrapS = THREE.ClampToEdgeWrapping;
                    pieceTex.wrapT = THREE.ClampToEdgeWrapping;
                    pieceTex.anisotropy = 8;

                    const pm = createCelMaterial({
                        color: 0xffffff, rimColor: def.rimColor,
                        rimPower: 2.1, rimStrength: 1.1, steps: 3, map: pieceTex,
                    });
                    // CUTOUT, NOT BLEND. `transparent: true` moves a piece into the
                    // transparent queue: it gets depth-sorted by centroid every frame
                    // with no depth write against its siblings, so overlapping limbs
                    // pop in front of each other as the camera orbits — the single
                    // biggest source of the doll looking "wrong" in motion. Alpha
                    // TESTING renders it as opaque geometry with real depth, which is
                    // both correct for hard-edged art and materially cheaper.
                    pm.transparent = false;
                    pm.alphaTest = 0.5;
                    pm.depthWrite = true;
                    pm.side = THREE.DoubleSide;
                    const mesh = joints.get(p.id).children[0];
                    if (m.size) mesh.geometry = new THREE.PlaneGeometry(m.size[0], m.size[1]);
                    mesh.material = pm;
                    // The shadow pass uses its own material and does NOT inherit the
                    // colour material's map or alphaTest. Leaving it default made every
                    // piece cast a full RECTANGLE — eight fighters throwing box shadows.
                    // Give the depth pass the same cutout so shadows take the silhouette.
                    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
                        depthPacking: THREE.RGBADepthPacking,
                        map: pieceTex,
                        alphaTest: 0.5,
                    });

                    // Art-driven rig. The RIG constants above were authored for
                    // untextured cel planes; real art has its own limb lengths and
                    // joint positions, and forcing it into those constants is what
                    // makes a paper doll read as loose parts. When the manifest
                    // carries source-space joints, rebuild geometry, plane centre
                    // and joint offset from the art itself.
                    if (doc.scale && m.src) {
                        const S = doc.scale;
                        const [pw, ph] = [m.src.size[0] * S, m.src.size[1] * S];
                        mesh.geometry = new THREE.PlaneGeometry(pw, ph);
                        // place the plane so its pivot pixel sits on the joint origin
                        mesh.position.set((0.5 - m.pivot[0]) * pw, (m.pivot[1] - 0.5) * ph, 0);
                        const parentPivot = p.parent ? manifest[p.parent]?.src.pivot : doc.hipSrc;
                        if (parentPivot) {
                            const j = joints.get(p.id);
                            j.position.set(
                                (m.src.pivot[0] - parentPivot[0]) * S,
                                -(m.src.pivot[1] - parentPivot[1]) * S,
                                j.position.z,
                            );
                        }
                    }
                }
                // Robe length comes from the art, not the rig constants: the hem
                // sits wherever the source figure's feet were, and the
                // hem-on-floor compression divides by this.
                const robeMesh = joints.get('robe')?.children?.[0];
                if (robeMesh) {
                    robeMesh.geometry.computeBoundingBox();
                    const rb = robeMesh.geometry.boundingBox;
                    doll.robeHemH = Math.abs(robeMesh.position.y + rb.min.y);
                    doll.robeHalfW = Math.max(Math.abs(robeMesh.position.x + rb.min.x),
                                              Math.abs(robeMesh.position.x + rb.max.x));
                }
                // Refit the clan band to the forearm the atlas actually produced.
                // Its 0.17x0.095 default was sized for the placeholder rig; on real
                // art that is wider than the arm, so the band hangs off the
                // silhouette as a floating chip instead of reading as worn.
                const foreMesh = joints.get('armFore.R')?.children?.[0];
                if (foreMesh && mark) {
                    foreMesh.geometry.computeBoundingBox();
                    const fb = foreMesh.geometry.boundingBox;
                    const fw = fb.max.x - fb.min.x, fh = fb.max.y - fb.min.y;
                    const bw = fw * 0.86;
                    const img = mark.material.map?.image;
                    const aspect = img ? img.height / img.width : 0.5625;
                    mark.geometry.dispose();
                    mark.geometry = new THREE.PlaneGeometry(bw, bw * aspect);
                    // sit it on the forearm's mid-shaft, just in front of the plane
                    mark.position.set(foreMesh.position.x, foreMesh.position.y + fh * 0.12, 0.006);
                }
                // The swap above replaced every piece's material, so their programs
                // are uncompiled again. Compile now — during the load, not on the
                // first frame the player sees.
                doll.needsCompile = true;
                return true;
            } catch { return false; }
        },
    };

    // Same userData contract as buildPlaceholder — flash decay in syncMeshes
    // drives ud.mat; torso/head/fist stubs keep any stray reader harmless.
    group.userData = {
        mat, flash: 0, doll,
        torso: joints.get('torso').children[0],
        head: joints.get('head').children[0],
        fist: joints.get('armFore.R').children[0],
    };
    doll.loadAtlas();
    return group;
}
