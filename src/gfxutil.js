/**
 * YAMIWARD — shared rendering helpers
 * ============================================================================
 * Small, file-spanning helpers that don't belong to any one system.
 */

// Garments/accessories/VRM body meshes are rigid geometry parented onto VRM
// bones (see garments.js, accessories.js, fighter3d.js) — no per-vertex
// skinning. Three transforms a mesh's LOCAL bounding sphere by its
// matrixWorld every frame automatically, so a static bounding sphere tracks
// the bone's motion (attacks, wall-splats, all of it) for free; nothing here
// needs recomputing per frame. These pieces previously shipped with
// frustumCulled disabled outright — this re-enables culling (so an
// off-camera fighter, e.g. mid wall-splat or in a background preview, isn't
// submitted to the main AND shadow depth passes for nothing) while padding
// the bounding sphere generously as insurance against any geometry whose
// authored bounds run tight to its silhouette.
export function cullSafely(mesh, pad = 0.25) {
    mesh.geometry.computeBoundingSphere();
    if (mesh.geometry.boundingSphere) mesh.geometry.boundingSphere.radius += pad;
    mesh.frustumCulled = true;
}
