/**
 * YAMIWARD — per-fighter accessories
 * ============================================================================
 * Eight fighters share one body. Colour separates them, build separates their
 * silhouettes, and this is the part that says WHAT THEY ARE: the oni's horns,
 * the kitsune's ears, the tengu's wings. It is the cheapest identity in the
 * project — a few primitives bolted to the right bone read as character design
 * from the fighting camera, and none of it needs new art.
 *
 * Everything here parents to the RAW humanoid bones, so props inherit the
 * animation and the per-fighter build scaling for free. They are built from
 * primitives on purpose: a horn is a cone, an ear is a squashed cone, a wing is
 * a lathe. Swapping any one of them for authored art later is a one-line change
 * inside its spec.
 *
 * Sizes are expressed in HEAD-LOCAL units. The head bone carries the model's
 * scale chain, so a horn authored against the head is automatically right on a
 * big oni and a small tsukiusagi without per-fighter numbers.
 */
import * as THREE from 'three';
import { VRMHumanBoneName as B } from '@pixiv/three-vrm';
import { cullSafely } from './gfxutil.js';

/** Toon material that matches the cel look of the VRM itself. */
function mat(color, { emissive = 0x000000, emissiveIntensity = 0, flat = false } = {}) {
    const m = new THREE.MeshToonMaterial({ color, emissive, emissiveIntensity });
    m.side = flat ? THREE.DoubleSide : THREE.FrontSide;
    return m;
}

/** A tapered horn/spike. Length runs along +Y before the caller rotates it. */
function horn(len, rad, color, curve = 0) {
    const g = new THREE.ConeGeometry(rad, len, 7, 3, false);
    g.translate(0, len / 2, 0);
    if (curve) {
        // Bend the tip backward so it reads as grown, not glued on.
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
            const y = p.getY(i);
            const t = Math.max(0, y / len);
            p.setZ(i, p.getZ(i) - curve * t * t * len);
        }
        p.needsUpdate = true;
        g.computeVertexNormals();
    }
    return new THREE.Mesh(g, mat(color));
}

/** A flat leaf shape — ears, fins, wing membranes. */
function leaf(len, wide, color) {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.quadraticCurveTo(wide, len * 0.45, 0, len);
    s.quadraticCurveTo(-wide, len * 0.45, 0, 0);
    const g = new THREE.ShapeGeometry(s, 12);
    return new THREE.Mesh(g, mat(color, { flat: true }));
}

/** A feathered wing built from overlapping leaves. */
function wing(color, span = 0.42, feathers = 5) {
    const grp = new THREE.Group();
    for (let i = 0; i < feathers; i++) {
        const t = i / (feathers - 1);
        const f = leaf(span * (1 - t * 0.42), span * 0.11, color);
        f.position.set(0, -span * 0.06 * i, -span * 0.05 * i);
        f.rotation.z = -0.55 - t * 0.5;
        grp.add(f);
    }
    return grp;
}

/**
 * Per-fighter specs. Each returns props already positioned in the local space of
 * the bone named by `bone`. Rotations were tuned against renders — the head
 * bone's local axes are not intuitive, so these are measured, not assumed.
 */
const SPECS = {
    // ONI 鬼 — the horns are the whole silhouette. Heavy, swept back, bone pale.
    tetsuki: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            for (const side of [-1, 1]) {
                const h = horn(0.19, 0.035, 0xb0a494, 0.35);
                h.position.set(0.055 * side, 0.055, -0.005);
                h.rotation.set(-0.25, 0, -0.30 * side);
                g.add(h);
            }
            return g;
        },
    }),
    // YUKIONNA 雪女 — a crown of ice shards, cold and thin.
    yukiwari: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            for (let i = 0; i < 5; i++) {
                const t = (i / 4) - 0.5;
                const s = horn(0.10 + Math.abs(t) * -0.045 + 0.045, 0.014, 0x9dc2d4);
                s.material.emissive = new THREE.Color(0x9be8e0);
                s.material.emissiveIntensity = 0.15;
                s.position.set(t * 0.10, 0.062, -0.03);
                s.rotation.set(-0.35, 0, t * 0.55);
                g.add(s);
            }
            return g;
        },
    }),
    // RAIJU 雷獣 — beast ears, alert and forward.
    raiga: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            for (const side of [-1, 1]) {
                const e = horn(0.115, 0.032, 0x1c2b4a);
                e.position.set(0.062 * side, 0.05, -0.012);
                e.rotation.set(-0.2, 0, -0.34 * side);
                const inner = horn(0.075, 0.018, 0x4a8fe8);
                inner.material.emissive = new THREE.Color(0x4a8fe8);
                inner.material.emissiveIntensity = 0.14;
                inner.position.copy(e.position);
                inner.position.z += 0.012;
                inner.rotation.copy(e.rotation);
                g.add(e, inner);
            }
            return g;
        },
    }),
    // KITSUNE 狐 — fox ears plus the mask pushed up off the face.
    mayoi: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            for (const side of [-1, 1]) {
                const e = horn(0.10, 0.030, 0x3b2a34);
                e.position.set(0.058 * side, 0.052, -0.008);
                e.rotation.set(-0.15, 0, -0.30 * side);
                const inner = horn(0.062, 0.016, 0xff7bc8);
                inner.position.copy(e.position); inner.position.z += 0.011;
                inner.rotation.copy(e.rotation);
                g.add(e, inner);
            }
            // Mask tilted onto the side of the head.
            const mask = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10, 0, Math.PI), mat(0xd6cabb, { flat: true }));
            mask.position.set(0.072, 0.02, 0.01);
            mask.rotation.set(0, -1.15, 0.5);
            mask.scale.set(1, 1.12, 0.55);
            g.add(mask);
            return g;
        },
    }),
    // AMEONNA 雨女 — a hood, and rain that never lands.
    shigure: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            const hood = new THREE.Mesh(new THREE.SphereGeometry(0.105, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(0x241f38));
            hood.position.set(0, 0.02, -0.01);
            hood.scale.set(1.05, 1.0, 1.15);
            g.add(hood);
            for (let i = 0; i < 6; i++) {
                const d = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 6), mat(0xa79ac2, { emissive: 0x7c6fd4, emissiveIntensity: 0.22 }));
                const a = (i / 6) * Math.PI * 2;
                d.position.set(Math.cos(a) * 0.13, 0.05 + (i % 3) * 0.03, Math.sin(a) * 0.13);
                d.scale.set(1, 1.8, 1);
                g.add(d);
            }
            return g;
        },
    }),
    // TSUKIUSAGI 月兎 — long rabbit ears. The tallest thing on the smallest body.
    tsukimi: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            for (const side of [-1, 1]) {
                const e = leaf(0.30, 0.038, 0xc3b6d2);
                e.position.set(0.035 * side, 0.05, -0.01);
                e.rotation.set(-0.12, 0, -0.16 * side);
                const inner = leaf(0.23, 0.024, 0xb08aa0);
                inner.position.copy(e.position); inner.position.z += 0.006;
                inner.rotation.copy(e.rotation);
                g.add(e, inner);
            }
            return g;
        },
    }),
    // TENGU 天狗 — the mask nose, and wings off the back.
    kazakiri: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            const nose = horn(0.10, 0.022, 0xc0392b);
            nose.position.set(0, -0.015, 0.075);
            nose.rotation.set(1.45, 0, 0);
            g.add(nose);
            return g;
        },
        extra: {
            bone: B.UpperChest,
            make: () => {
                const g = new THREE.Group();
                for (const side of [-1, 1]) {
                    const w = wing(0x2a1626, 0.40, 5);
                    w.position.set(0.07 * side, 0.06, -0.06);
                    w.rotation.set(0.25, side * 0.5, side * 0.15);
                    w.scale.x = side;
                    g.add(w);
                }
                return g;
            },
        },
    }),
    // RYU 龍 — swept dragon horns.
    yumihari: (c) => ({
        bone: B.Head,
        make: () => {
            const g = new THREE.Group();
            for (const side of [-1, 1]) {
                const h = horn(0.16, 0.026, 0xb2955f, 0.6);
                h.position.set(0.05 * side, 0.055, -0.02);
                h.rotation.set(-0.55, 0, -0.18 * side);
                g.add(h);
            }
            return g;
        },
    }),
};

// Wings take a colour first in `wing(color, span, feathers)`; kazakiri's extra
// passes a number by mistake if this order is ever changed, so keep the guard.
/**
 * Attach a fighter's accessories. Returns the created roots so they can be
 * disposed with the fighter.
 */
export function attachAccessories(vrm, key, rim) {
    const spec = SPECS[key];
    if (!spec || !vrm.humanoid?.getRawBoneNode) return [];
    const s = spec();
    const made = [];
    // The bodies get their clan colour as an MToon rim, which is what keeps them
    // legible on a night stage. These props are MeshToon and have no rim, so the
    // dark ones (horns especially) disappeared into the background. A LOW clan
    // emissive does the same job: it lifts the prop off the backdrop without the
    // white blowout that killed the first pass at pale colours + bloom.
    const glow = new THREE.Color(rim ?? 0xffffff);

    const mount = (entry) => {
        if (!entry) return;
        let bone = vrm.humanoid.getRawBoneNode(entry.bone);
        // upperChest is optional in the VRM spec; fall back to chest.
        if (!bone && entry.bone === B.UpperChest) bone = vrm.humanoid.getRawBoneNode(B.Chest);
        if (!bone) return;
        const obj = entry.make();
        obj.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = true; o.receiveShadow = true; cullSafely(o);
            const m = o.material;
            // Only props that authored no glow of their own — an ice shard or a
            // raindrop already set theirs deliberately.
            if (m && m.emissive && m.emissive.getHex() === 0x000000) {
                m.emissive.copy(glow);
                m.emissiveIntensity = 0.16;
            }
        });
        bone.add(obj);
        made.push(obj);
    };

    mount(s);
    mount(s.extra);
    return made;
}

/** Free accessory geometry/materials. */
export function disposeAccessories(list) {
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
