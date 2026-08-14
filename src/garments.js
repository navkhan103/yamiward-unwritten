/**
 * YAMIWARD — per-fighter garments
 * ============================================================================
 * The 3D path put all eight fighters in one VRoid bodysuit and told them apart
 * by colour. That was always going to fail, and it did: eight recoloured copies
 * of one mannequin read as one character in eight shirts, because SILHOUETTE is
 * what identifies a fighter at arena distance — not hue.
 *
 * The paper-doll build already knew this. `CHARACTERS[key].rig` records who is
 * robed (`robe`, `robewings`) because their canon art is floor-length: Yukiwari's
 * kimono, Kazakiri's crow robes, Shigure's coat, Yumihari's hakama. This module
 * puts that geometry back.
 *
 * Built from primitives and parented to bones, exactly like accessories.js —
 * no skinning, no new art, no external assets. A garment is a handful of cone
 * shells and tapered tubes, which is all a silhouette needs to read.
 *
 * WHY SKIRT PANELS PARENT TO THE HIPS AND NOT THE LEGS
 * Following the legs would avoid clipping on a high kick, but it requires the
 * panels to live in each leg's local space, and the leg bones rotate hard
 * enough that the skirt tears itself open in a stance. Parenting to the hips
 * keeps the garment whole. The fighters who get FLOOR-LENGTH panels are exactly
 * the ones canon already marks as robed — who fight from a robe silhouette and
 * whose paper-doll rig had no separable legs either. Everyone else gets a short
 * apron or nothing, which cannot clip because it ends above the knee.
 */
import * as THREE from 'three';
import { VRMHumanBoneName as B } from '@pixiv/three-vrm';

/** Cel material matching the VRM's toon look. */
function mat(color, { flat = false, emissive = 0x000000, emissiveIntensity = 0 } = {}) {
    const m = new THREE.MeshToonMaterial({ color, emissive, emissiveIntensity });
    m.side = flat ? THREE.DoubleSide : THREE.FrontSide;
    return m;
}

/**
 * A skirt/robe as separated panels. Panels rather than one cone because the gaps
 * between them are what read as cloth rather than a lampshade — and because a
 * split hem lets the legs show through when the fighter moves.
 *
 * @param {object} o
 * @param {number} o.len     length downward, hips-local
 * @param {number} o.topR    radius at the waist
 * @param {number} o.botR    radius at the hem (> topR = flare)
 * @param {number} o.panels  how many
 * @param {number} o.gap     0..1 fraction of each slot left empty
 */
function skirt({ len, topR, botR, panels = 8, gap = 0.18, color, y = 0 }) {
    const g = new THREE.Group();
    const slot = (Math.PI * 2) / panels;
    const material = mat(color, { flat: true });
    for (let i = 0; i < panels; i++) {
        const geo = new THREE.CylinderGeometry(
            topR, botR, len, 4, 1, true,
            i * slot + slot * gap * 0.5, slot * (1 - gap),
        );
        geo.translate(0, -len / 2 + y, 0);
        const m = new THREE.Mesh(geo, material);
        m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
        g.add(m);
    }
    return g;
}

/** An open haori/vest shell over the torso — reads as a worn layer, not a skin. */
function haori({ len = 0.30, r = 0.135, color, flare = 1.18 }) {
    const g = new THREE.Group();
    const material = mat(color, { flat: true });
    // Two halves, left open down the front (a gap either side of +Z).
    for (const side of [1, -1]) {
        const geo = new THREE.CylinderGeometry(r, r * flare, len, 5, 1, true,
            side > 0 ? 0.34 : Math.PI + 0.06, Math.PI - 0.40);
        geo.translate(0, -len / 2 + 0.06, 0);
        const m = new THREE.Mesh(geo, material);
        m.castShadow = true; m.frustumCulled = false;
        g.add(m);
    }
    return g;
}

/** Shoulder plate — the single cheapest way to make a fighter read as heavy. */
function pauldron({ r = 0.085, color }) {
    const geo = new THREE.SphereGeometry(r, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const m = new THREE.Mesh(geo, mat(color));
    m.castShadow = true; m.frustumCulled = false;
    return m;
}

/**
 * Wide kimono sleeve, built along -Y and rotated onto the arm by the caller.
 *
 * The rotation is NOT optional and not cosmetic. Everything else here hangs off
 * the hips or chest, where bone-local -Y really is "down" — but an arm bone's
 * local axes point along the ARM, and which way is an authoring detail of the
 * model, not something the humanoid spec pins down. Hanging a sleeve down
 * bone-local -Y put a flat slab across Yukiwari's face, which is exactly what
 * "the graphics removed the players" looked like on her.
 */
function sleeve({ len = 0.22, r0 = 0.06, r1 = 0.13, color }) {
    const geo = new THREE.CylinderGeometry(r0, r1, len, 6, 1, true);
    geo.translate(0, -len / 2, 0);
    const m = new THREE.Mesh(geo, mat(color, { flat: true }));
    m.castShadow = true; m.frustumCulled = false;
    return m;
}

const _DOWN = new THREE.Vector3(0, -1, 0);
const _dir = new THREE.Vector3();
/**
 * Point an object's -Y at `child`, expressed in `bone`'s local space.
 * Measured from the rig rather than assumed, so it is right on any VRM.
 */
function aimAtChild(obj, bone, child) {
    if (!child) return;
    bone.updateWorldMatrix(true, false);
    child.updateWorldMatrix(true, false);
    // Child's world position, brought back into the parent bone's local frame.
    _dir.setFromMatrixPosition(child.matrixWorld);
    bone.worldToLocal(_dir);
    if (_dir.lengthSq() < 1e-8) return;
    obj.quaternion.setFromUnitVectors(_DOWN, _dir.normalize());
}

/** Obi / sash at the waist. */
function sash({ r = 0.115, h = 0.075, color }) {
    const geo = new THREE.CylinderGeometry(r, r * 1.02, h, 10, 1, true);
    const m = new THREE.Mesh(geo, mat(color, { flat: true }));
    m.castShadow = true; m.frustumCulled = false;
    return m;
}

/** High collar standing behind the neck. */
function collar({ r = 0.075, h = 0.10, color }) {
    const geo = new THREE.CylinderGeometry(r * 1.25, r, h, 8, 1, true, Math.PI * 0.15, Math.PI * 1.7);
    const m = new THREE.Mesh(geo, mat(color, { flat: true }));
    m.castShadow = true; m.frustumCulled = false;
    return m;
}

// ---------------------------------------------------------------------------
// Per-fighter wardrobe
// ---------------------------------------------------------------------------
// Each entry returns a list of { bone, make, pos?, rot? }. Colours are the
// fighter's canon clan palette, kept SATURATED here rather than gained — these
// are untextured primitives, so the authored colour is what you see.
const WARDROBE = {
    // ONI 鬼 — exiled smith. Heavy shoulders, sleeveless, short work apron. He
    // should look like the heaviest thing in the ward before he moves.
    tetsuki: () => [
        { bone: B.Chest, make: () => haori({ len: 0.34, r: 0.145, color: 0x8e2018, flare: 1.22 }), pos: [0, 0.06, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.125, h: 0.085, color: 0x2a1a18 }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.30, topR: 0.125, botR: 0.175, panels: 6, gap: 0.22, color: 0x6e1a14 }), pos: [0, -0.02, 0] },
        { bone: B.LeftUpperArm, make: () => pauldron({ r: 0.074, color: 0x4f4a44 }), pos: [0.01, 0.01, 0] },
        { bone: B.RightUpperArm, make: () => pauldron({ r: 0.074, color: 0x4f4a44 }), pos: [-0.01, 0.01, 0] },
    ],
    // YUKIONNA 雪女 — floor-length kimono (canon rig: robe). The robe IS her
    // silhouette; she is the one fighter who should barely show a leg.
    yukiwari: () => [
        { bone: B.Chest, make: () => haori({ len: 0.36, r: 0.13, color: 0x9fc0c6, flare: 1.10 }), pos: [0, 0.06, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.112, h: 0.09, color: 0x63879a }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.86, topR: 0.115, botR: 0.26, panels: 10, gap: 0.17, color: 0x93b7c2 }), pos: [0, -0.02, 0] },
        { bone: B.LeftUpperArm, make: () => sleeve({ len: 0.26, r0: 0.062, r1: 0.15, color: 0x93b7c2 }), aim: B.LeftLowerArm },
        { bone: B.RightUpperArm, make: () => sleeve({ len: 0.26, r0: 0.062, r1: 0.15, color: 0x93b7c2 }), aim: B.RightLowerArm },
        { bone: B.Neck, make: () => collar({ r: 0.072, h: 0.11, color: 0xdcefF3 }), pos: [0, 0.02, -0.01] },
    ],
    // RAIJU 雷獣 — rushdown. Cropped jacket, nothing below the waist to slow him.
    raiga: () => [
        { bone: B.Chest, make: () => haori({ len: 0.24, r: 0.14, color: 0x2a4f8f, flare: 1.05 }), pos: [0, 0.07, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.115, h: 0.055, color: 0x14203a }), pos: [0, 0.02, 0] },
    ],
    // KITSUNE 狐 — mid-length coat, wide sleeves, jade over fox-rose.
    mayoi: () => [
        { bone: B.Chest, make: () => haori({ len: 0.40, r: 0.128, color: 0x2f6f63, flare: 1.30 }), pos: [0, 0.06, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.108, h: 0.07, color: 0x7a2a52 }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.42, topR: 0.11, botR: 0.20, panels: 9, gap: 0.20, color: 0x2f6f63 }), pos: [0, -0.02, 0] },
        { bone: B.LeftUpperArm, make: () => sleeve({ len: 0.23, r0: 0.058, r1: 0.13, color: 0x2f6f63 }), aim: B.LeftLowerArm },
        { bone: B.RightUpperArm, make: () => sleeve({ len: 0.23, r0: 0.058, r1: 0.13, color: 0x2f6f63 }), aim: B.RightLowerArm },
    ],
    // AMEONNA 雨女 — ankle-length coat (canon rig: robe). Everything hangs.
    shigure: () => [
        { bone: B.Chest, make: () => haori({ len: 0.44, r: 0.126, color: 0x4a3f78, flare: 1.16 }), pos: [0, 0.06, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.108, h: 0.06, color: 0x241f38 }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.74, topR: 0.11, botR: 0.21, panels: 8, gap: 0.17, color: 0x5b4f8e }), pos: [0, -0.02, 0] },
        { bone: B.LeftUpperArm, make: () => sleeve({ len: 0.24, r0: 0.058, r1: 0.12, color: 0x5b4f8e }), aim: B.LeftLowerArm },
        { bone: B.RightUpperArm, make: () => sleeve({ len: 0.24, r0: 0.058, r1: 0.12, color: 0x5b4f8e }), aim: B.RightLowerArm },
    ],
    // TSUKIUSAGI 月兎 — smallest, quickest. Short skirt, short sleeves.
    tsukimi: () => [
        { bone: B.Chest, make: () => haori({ len: 0.22, r: 0.128, color: 0xbfb0d8, flare: 1.08 }), pos: [0, 0.07, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.105, h: 0.055, color: 0x6f6390 }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.24, topR: 0.105, botR: 0.175, panels: 10, gap: 0.16, color: 0xcfc2e6 }), pos: [0, -0.02, 0] },
    ],
    // TENGU 天狗 — floor-length crow robes (canon rig: robewings; the wings
    // themselves are already in accessories.js).
    kazakiri: () => [
        { bone: B.Chest, make: () => haori({ len: 0.42, r: 0.130, color: 0x6e2a5e, flare: 1.20 }), pos: [0, 0.06, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.110, h: 0.07, color: 0x2a1626 }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.82, topR: 0.112, botR: 0.25, panels: 9, gap: 0.17, color: 0x7d3369 }), pos: [0, -0.02, 0] },
        { bone: B.LeftUpperArm, make: () => sleeve({ len: 0.28, r0: 0.060, r1: 0.16, color: 0x7d3369 }), aim: B.LeftLowerArm },
        { bone: B.RightUpperArm, make: () => sleeve({ len: 0.28, r0: 0.060, r1: 0.16, color: 0x7d3369 }), aim: B.RightLowerArm },
        { bone: B.Neck, make: () => collar({ r: 0.074, h: 0.12, color: 0x2a1626 }), pos: [0, 0.02, -0.01] },
    ],
    // RYU 龍 — wide hakama (canon rig: robe: "reads as one mass to the shins").
    // The flare is the point: he should look broad and planted.
    yumihari: () => [
        { bone: B.Chest, make: () => haori({ len: 0.30, r: 0.142, color: 0x9c6a1c, flare: 1.14 }), pos: [0, 0.06, 0] },
        { bone: B.Hips, make: () => sash({ r: 0.122, h: 0.088, color: 0x2e2413 }), pos: [0, 0.02, 0] },
        { bone: B.Hips, make: () => skirt({ len: 0.62, topR: 0.122, botR: 0.30, panels: 8, gap: 0.16, color: 0xb0801f }), pos: [0, -0.02, 0] },
        { bone: B.LeftUpperArm, make: () => sleeve({ len: 0.25, r0: 0.062, r1: 0.14, color: 0xb0801f }), aim: B.LeftLowerArm },
        { bone: B.RightUpperArm, make: () => sleeve({ len: 0.25, r0: 0.062, r1: 0.14, color: 0xb0801f }), aim: B.RightLowerArm },
    ],
};

/**
 * Dress a fighter. Mounts to RAW bones so garments inherit the per-fighter build
 * scaling and the animation for free, exactly as accessories do.
 *
 * Skipped entirely for authored per-fighter models — someone who built a
 * character in VRoid already gave them clothes, and stacking a procedural robe
 * on top is the same mistake as recolouring their hair.
 *
 * @returns {THREE.Object3D[]} roots, for disposal with the fighter
 */
export function attachGarments(vrm, key, rim) {
    const spec = WARDROBE[key];
    if (!spec || !vrm.humanoid?.getRawBoneNode) return [];
    const made = [];
    const glow = new THREE.Color(rim ?? 0xffffff);

    for (const entry of spec()) {
        let bone = vrm.humanoid.getRawBoneNode(entry.bone);
        if (!bone && entry.bone === B.UpperChest) bone = vrm.humanoid.getRawBoneNode(B.Chest);
        if (!bone) continue;
        const obj = entry.make();
        if (entry.pos) obj.position.set(entry.pos[0], entry.pos[1], entry.pos[2]);
        if (entry.aim) aimAtChild(obj, bone, vrm.humanoid.getRawBoneNode(entry.aim));
        else if (entry.rot) obj.rotation.set(entry.rot[0], entry.rot[1], entry.rot[2]);
        obj.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
            // Same trick accessories use: a low clan emissive lifts untextured
            // cloth off a night backdrop without the white blowout that killed
            // the first pass at pale colours plus bloom.
            // ...but scaled by how dark the cloth already is. A flat 0.10 blew
            // Yukiwari's pale kimono out to a featureless white cone — her robe
            // is the largest surface in the cast and it clipped first. Dark
            // cloth needs the lift; pale cloth is already carrying the light.
            const m = o.material;
            if (m && m.emissive && m.emissive.getHex() === 0x000000) {
                const c = m.color;
                const peak = Math.max(c.r, c.g, c.b);
                m.emissive.copy(glow);
                m.emissiveIntensity = 0.09 * (1 - THREE.MathUtils.smoothstep(peak, 0.35, 0.80));
            }
        });
        bone.add(obj);
        made.push(obj);
    }
    return made;
}

/** Free garment geometry/materials. */
export function disposeGarments(list) {
    for (const root of list || []) {
        root.traverse((o) => {
            if (!o.isMesh) return;
            o.geometry?.dispose();
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) m?.dispose();
        });
        root.parent?.remove(root);
    }
}
