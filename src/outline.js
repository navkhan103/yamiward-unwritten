/**
 * YAMIWARD — inverted-hull outlines (ArcSys technique)
 * ============================================================================
 * Why not a post-process edge detector?
 *
 * Screen-space edge detection (sobel on depth/normals) gives you a uniform
 * hairline. Anime line art is not uniform: the jaw and silhouette carry a heavy
 * line, fingers and cloth folds carry a thin one. Guilty Gear gets that by
 * pushing a BACK-FACE-ONLY copy of the mesh outward along its normals, where
 * the push distance is authored per vertex. That is what this module does.
 *
 * Two knobs the art pipeline must serve:
 *   1. thickness is stored in a per-vertex attribute (`aOutline`, 0..1), so the
 *      artist paints line weight in Blender as a vertex colour channel.
 *   2. the push uses the SMOOTHED normal, not the shading normal — otherwise
 *      hard-edged geometry tears the hull open at UV/normal splits.
 *
 * The second point is the one that bites: a mesh out of AI image-to-3D almost
 * always has split normals, so we rebuild a welded "outline normal" per vertex
 * by averaging across position-identical vertices. Without this you get gaps in
 * the outline exactly at the silhouette, which is where it is most visible.
 */

import * as THREE from 'three';

const OUTLINE_VERT = /* glsl */`
    attribute float aOutline;
    attribute vec3  aWeldedNormal;
    uniform float uThickness;
    uniform float uMinPixels;   // keeps thin lines from vanishing at distance

    #include <common>
    #include <skinning_pars_vertex>

    void main() {
        vec3 objectNormal = aWeldedNormal;
        vec3 transformed  = position;

        // Skinning must run on BOTH position and the outline normal, or the hull
        // detaches from the animated mesh. Three's macros handle position; the
        // normal is skinned by reusing the same bone matrix blend.
        #ifdef USE_SKINNING
            mat4 boneMatX = getBoneMatrix( skinIndex.x );
            mat4 boneMatY = getBoneMatrix( skinIndex.y );
            mat4 boneMatZ = getBoneMatrix( skinIndex.z );
            mat4 boneMatW = getBoneMatrix( skinIndex.w );

            mat4 skinMatrix = mat4( 0.0 );
            skinMatrix += skinWeight.x * boneMatX;
            skinMatrix += skinWeight.y * boneMatY;
            skinMatrix += skinWeight.z * boneMatZ;
            skinMatrix += skinWeight.w * boneMatW;
            skinMatrix  = bindMatrixInverse * skinMatrix * bindMatrix;

            objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;

            vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
            vec4 skinned = vec4( 0.0 );
            skinned += boneMatX * skinVertex * skinWeight.x;
            skinned += boneMatY * skinVertex * skinWeight.y;
            skinned += boneMatZ * skinVertex * skinWeight.z;
            skinned += boneMatW * skinVertex * skinWeight.w;
            transformed = ( bindMatrixInverse * skinned ).xyz;
        #endif

        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        vec3 viewNormal = normalize( normalMatrix * objectNormal );

        // Scale the push by view depth so the line holds a roughly constant
        // pixel width as the camera dollies — a fixed world-space offset makes
        // outlines fat in close-ups and invisible in wide shots.
        float depthScale = -mvPosition.z;
        float w = uThickness * aOutline * depthScale;

        // Floor in pixels so the thinnest painted lines never disappear.
        float perPixel = depthScale * uMinPixels;
        w = max( w, aOutline > 0.0 ? perPixel : 0.0 );

        mvPosition.xyz += viewNormal * w;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const OUTLINE_FRAG = /* glsl */`
    uniform vec3  uColor;
    uniform float uOpacity;
    void main() {
        gl_FragColor = vec4( uColor, uOpacity );
        #include <colorspace_fragment>
    }
`;

/**
 * Average normals across position-identical vertices.
 *
 * Meshes arriving from Meshy/GLB are split at UV seams and hard edges, which
 * means the same corner of the model exists several times with different
 * normals. Pushing along those splits opens visible cracks in the outline, so
 * we weld by quantised position and average.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {number} [epsilon] weld tolerance in world units
 * @returns {THREE.BufferAttribute} welded normals, same count as geo
 */
export function buildWeldedNormals(geo, epsilon = 1e-4) {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const count = pos.count;
    const inv = 1 / epsilon;
    const buckets = new Map();

    for (let i = 0; i < count; i++) {
        const key =
            Math.round(pos.getX(i) * inv) + '|' +
            Math.round(pos.getY(i) * inv) + '|' +
            Math.round(pos.getZ(i) * inv);
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(i);
    }

    const out = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (const idxs of buckets.values()) {
        v.set(0, 0, 0);
        for (const i of idxs) v.x += nrm.getX(i), v.y += nrm.getY(i), v.z += nrm.getZ(i);
        if (v.lengthSq() < 1e-12) v.set(0, 1, 0);   // degenerate: fall back to up
        v.normalize();
        for (const i of idxs) {
            out[i * 3 + 0] = v.x;
            out[i * 3 + 1] = v.y;
            out[i * 3 + 2] = v.z;
        }
    }
    return new THREE.BufferAttribute(out, 3);
}

/**
 * Per-vertex line weight.
 *
 * The art pipeline should ship this painted in Blender (vertex colour channel).
 * Until an artist has painted one, we derive a defensible default: thinner on
 * upward-facing surfaces (tops of shoulders, scalp) and on small extremities,
 * heavier around the silhouette mass. It reads far better than a flat 1.0.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.BufferAttribute} [vertexColors] optional painted channel
 */
export function buildOutlineWeights(geo, vertexColors = null) {
    const count = geo.attributes.position.count;
    const out = new Float32Array(count);

    if (vertexColors) {
        // Red channel is line weight by convention.
        for (let i = 0; i < count; i++) out[i] = vertexColors.getX(i);
        return new THREE.BufferAttribute(out, 1);
    }

    const nrm = geo.attributes.normal;
    for (let i = 0; i < count; i++) {
        const ny = nrm.getY(i);
        // Up-facing → lighter line (light comes from above; anime keeps tops open).
        out[i] = THREE.MathUtils.clamp(1.0 - Math.max(0, ny) * 0.55, 0.35, 1.0);
    }
    return new THREE.BufferAttribute(out, 1);
}

/**
 * Build the outline hull for a mesh.
 *
 * Returns a sibling mesh to add next to the original (NOT a child — parenting to
 * a SkinnedMesh re-applies its transform twice). Share the skeleton so the hull
 * animates with the character for free.
 *
 * @param {THREE.Mesh|THREE.SkinnedMesh} mesh
 * @param {Object} [o]
 * @param {number|string} [o.color]      line colour; near-black beats pure black
 * @param {number} [o.thickness]         world-ish scale factor
 * @param {number} [o.minPixels]         minimum line width factor
 * @returns {THREE.Mesh|THREE.SkinnedMesh}
 */
export function createOutline(mesh, {
    color = 0x0b0b10,
    thickness = 0.012,
    minPixels = 0.0016,
} = {}) {
    const geo = mesh.geometry;

    if (!geo.getAttribute('aWeldedNormal')) {
        if (!geo.attributes.normal) geo.computeVertexNormals();
        geo.setAttribute('aWeldedNormal', buildWeldedNormals(geo));
    }
    if (!geo.getAttribute('aOutline')) {
        geo.setAttribute('aOutline', buildOutlineWeights(geo, geo.attributes.color || null));
    }

    const mat = new THREE.ShaderMaterial({
        vertexShader: OUTLINE_VERT,
        fragmentShader: OUTLINE_FRAG,
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uOpacity: { value: 1.0 },
            uThickness: { value: thickness },
            uMinPixels: { value: minPixels },
        },
        // The whole trick: draw only back faces, so the hull is hidden behind the
        // real mesh everywhere except where it spills past the silhouette.
        side: THREE.BackSide,
        transparent: false,
        depthWrite: true,
        skinning: !!mesh.isSkinnedMesh,
    });

    let hull;
    if (mesh.isSkinnedMesh) {
        hull = new THREE.SkinnedMesh(geo, mat);
        hull.bind(mesh.skeleton, mesh.bindMatrix);
        hull.bindMode = mesh.bindMode;
    } else {
        hull = new THREE.Mesh(geo, mat);
    }
    hull.name = (mesh.name || 'mesh') + '__outline';
    hull.frustumCulled = mesh.frustumCulled;
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.renderOrder = (mesh.renderOrder || 0) - 1;
    hull.matrixAutoUpdate = mesh.matrixAutoUpdate;
    hull.userData.outlineUniforms = mat.uniforms;
    hull.userData.sourceMesh = mesh;
    return hull;
}

/**
 * Walk a loaded GLB and attach outlines to every skinned/static mesh in it.
 * @param {THREE.Object3D} root
 * @param {Object} [opts] forwarded to createOutline
 * @returns {THREE.Mesh[]} the created hulls (already added to the scene graph)
 */
export function attachOutlines(root, opts = {}) {
    const targets = [];
    root.traverse((o) => { if (o.isMesh && !o.name.endsWith('__outline')) targets.push(o); });

    const hulls = [];
    for (const m of targets) {
        const hull = createOutline(m, opts);
        // Sibling, not child — see createOutline docblock.
        (m.parent || root).add(hull);
        hulls.push(hull);
    }
    return hulls;
}

/** Set line weight at runtime (e.g. thicken during a super for punch). */
export function setOutlineThickness(hull, v) {
    const u = hull.userData && hull.userData.outlineUniforms;
    if (u) u.uThickness.value = v;
}
