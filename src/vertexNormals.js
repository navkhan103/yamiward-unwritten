/**
 * YAMIWARD — vertex normal editing (the ArcSys / Street Fighter IV technique)
 * ============================================================================
 * The problem this solves:
 *
 * Cel shading quantises N·L into hard bands. On a real face mesh the geometric
 * normals wobble — nose, brow, cheekbone, lips all point slightly differently —
 * so the hard band boundary snakes through those wobbles and the face reads as
 * blotchy. Adding polygons makes it WORSE, not better, because it adds wobble.
 *
 * Arc System Works' answer (and Capcom's before them) is to throw away the
 * geometric normals on the head and replace them with the normals of a smooth
 * proxy — typically a sphere or an egg centred in the skull. The silhouette and
 * the texture still carry all the facial detail, but the shading term becomes
 * one clean sweep, so the shadow terminator lands as a single deliberate curve.
 *
 * That is the entire trick. It is cheap, it is done once per character at build
 * time, and it is the difference between "cel-shaded 3D" and "looks drawn".
 *
 * IMPORTANT: this rewrites `normal` (used for shading). The outline module keeps
 * its own `aWeldedNormal` for hull extrusion, so run this FIRST — outline.js
 * derives its welded normals from whatever it finds, and we want the outline
 * built from geometry, not from the smoothed shading normals.
 */

import * as THREE from 'three';

/**
 * Replace normals with directions radiating from a point.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.Vector3} center      in geometry-local space
 * @param {Object} [o]
 * @param {number} [o.blend]          0 = keep original, 1 = fully spherical
 * @param {function} [o.mask]         (x,y,z,i) => 0..1 weight; default: all
 * @param {THREE.Vector3} [o.scale]   ellipsoid shaping (a skull is not a ball)
 */
export function sphericalizeNormals(geo, center, {
    blend = 1.0,
    mask = null,
    scale = new THREE.Vector3(1, 1, 1),
} = {}) {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    if (!nrm) { geo.computeVertexNormals(); }

    const p = new THREE.Vector3();
    const target = new THREE.Vector3();
    const orig = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
        p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const w = mask ? mask(p.x, p.y, p.z, i) : 1.0;
        if (w <= 0) continue;

        target.copy(p).sub(center);
        target.x /= scale.x; target.y /= scale.y; target.z /= scale.z;
        if (target.lengthSq() < 1e-12) continue;
        target.normalize();

        orig.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        const t = blend * w;
        orig.lerp(target, t).normalize();
        nrm.setXYZ(i, orig.x, orig.y, orig.z);
    }
    nrm.needsUpdate = true;
    return geo;
}

/**
 * Head-region mask with a soft falloff into the neck.
 *
 * Hard-switching normals at a Y plane leaves a visible shading seam at the jaw,
 * so we ramp the blend over a band. `yTop`/`yBottom` are in geometry-local space.
 */
export function headMask(yBottom, yTop) {
    return (x, y) => {
        if (y >= yTop) return 1;
        if (y <= yBottom) return 0;
        const t = (y - yBottom) / (yTop - yBottom);
        return t * t * (3 - 2 * t);   // smoothstep
    };
}

/**
 * Flatten normals toward a single direction across a region.
 *
 * Used on hair cards and cloth: anime hair is shaded as a few big masses, not
 * as hundreds of individual strands. Pointing a whole hair clump's normals the
 * same way makes it catch light as one shape.
 */
export function flattenNormals(geo, direction, { blend = 0.85, mask = null } = {}) {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const d = direction.clone().normalize();
    const n = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
        const w = mask ? mask(pos.getX(i), pos.getY(i), pos.getZ(i), i) : 1.0;
        if (w <= 0) continue;
        n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        n.lerp(d, blend * w).normalize();
        nrm.setXYZ(i, n.x, n.y, n.z);
    }
    nrm.needsUpdate = true;
    return geo;
}

/**
 * Auto-treat a character mesh with no hand authoring.
 *
 * This is the "good default" so a fighter looks right the moment it drops out of
 * the AI pipeline, before anyone opens Blender. Hand-authored masks will beat it,
 * but it removes the blotchy-face failure mode immediately.
 *
 * Assumes origin-at-feet and Y-up, per the README pipeline contract.
 *
 * @param {THREE.Object3D} root  loaded GLB scene or a single mesh
 * @param {Object} [o]
 * @param {number} [o.height]    character height in world units (default 1.8)
 * @param {number} [o.blend]
 */
export function autoTreatCharacter(root, { height = 1.8, blend = 0.9 } = {}) {
    const meshes = [];
    root.traverse((o) => { if (o.isMesh && !o.name.endsWith('__outline')) meshes.push(o); });

    const treated = [];
    for (const m of meshes) {
        const geo = m.geometry;
        if (!geo.attributes.normal) geo.computeVertexNormals();
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const size = new THREE.Vector3();
        bb.getSize(size);

        // Heuristic: the head occupies roughly the top ~13% of a stylised figure,
        // with the jaw fading in over the ~8% below that.
        const yTop = bb.min.y + size.y * 0.87;
        const yBottom = bb.min.y + size.y * 0.79;
        const headCenterY = bb.min.y + size.y * 0.93;

        const center = new THREE.Vector3(
            (bb.min.x + bb.max.x) / 2,
            headCenterY,
            (bb.min.z + bb.max.z) / 2,
        );

        // A skull is taller than it is wide and flatter front-to-back than a ball.
        const skull = new THREE.Vector3(1.0, 1.25, 1.05);

        sphericalizeNormals(geo, center, {
            blend,
            scale: skull,
            mask: headMask(yBottom, yTop),
        });
        treated.push(m.name || '(unnamed)');
    }
    return treated;
}
