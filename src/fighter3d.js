/**
 * YAMIWARD — 3D fighter (VRM) loader + controller
 * ============================================================================
 * The paper-dolls were always the placeholder; this is the real thing. A VRoid
 * VRM is a rigged humanoid (standard bone set), so we can load it with the
 * shared three-vrm plugin, pose it from the fight engine, and later retarget
 * Mixamo clips onto its humanoid rig.
 *
 * Everything imports the SAME vendored three (via the import map) as the rest of
 * the game — a second three instance is the classic cause of "VRM loads but
 * every class check fails" breakage, so we never bundle our own.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * Load a .vrm and return the VRM object (has .scene, .humanoid, .update(dt)).
 * @param {string} url
 */
export async function loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('file is not a VRM (no userData.vrm)');

    // three-vrm's recommended runtime cleanups.
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);

    // VRM0 avatars face -Z; this normalises them to face +Z like VRM1 so our
    // facing math is uniform. No-op on a VRM1 model.
    VRMUtils.rotateVRM0(vrm);

    // A fighting camera orbits the hero and gets very close — never cull it, and
    // let every piece cast into the shadow map.
    vrm.scene.traverse((o) => {
        o.frustumCulled = false;
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    return vrm;
}

/** Rotate a normalized humanoid bone by Euler radians (additive on its rest pose). */
function setBone(vrm, boneName, x, y, z) {
    const node = vrm.humanoid?.getNormalizedBoneNode(boneName);
    if (node) node.rotation.set(x, y, z);
}

/**
 * A neutral fighting idle. The VRM rest pose is a T-pose (arms straight out),
 * which reads as "broken scarecrow" — drop the arms to the sides and settle the
 * elbows so he looks like he's standing ready. This is a static hold until real
 * Mixamo clips are retargeted on top.
 */
export function poseIdle(vrm) {
    // Arms down to the sides. In this normalized rig, LOWERING an arm from the
    // T-pose needs a NEGATIVE z on the left and POSITIVE on the right (the mirror
    // of the naive guess — verified against the render).
    setBone(vrm, VRMHumanBoneName.LeftUpperArm, 0, 0, -1.22);
    setBone(vrm, VRMHumanBoneName.RightUpperArm, 0, 0, 1.22);
    // A little elbow bend so they aren't ramrod straight.
    setBone(vrm, VRMHumanBoneName.LeftLowerArm, 0, 0, -0.18);
    setBone(vrm, VRMHumanBoneName.RightLowerArm, 0, 0, 0.18);
}

/**
 * Controller wrapping a loaded VRM for the game. Keeps the per-frame update and
 * a gentle breathing bob so a static idle still feels alive.
 */
export class Fighter3D {
    constructor(vrm) {
        this.vrm = vrm;
        this.root = vrm.scene;
        this._t = 0;
        this._spine = vrm.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Spine) || null;
        this._spineRestX = this._spine ? this._spine.rotation.x : 0;
        poseIdle(vrm);
    }

    get object3d() { return this.root; }

    /** Place feet at (x, y, z) in world space. */
    setPosition(x, y, z) { this.root.position.set(x, y, z); }

    /** Face a world yaw (radians). */
    setYaw(y) { this.root.rotation.y = y; }

    setScale(s) { this.root.scale.setScalar(s); }

    update(dt) {
        this._t += dt;
        // Breathing: a tiny spine sway so the hold isn't a mannequin.
        if (this._spine) this._spine.rotation.x = this._spineRestX + Math.sin(this._t * 1.6) * 0.02;
        // three-vrm drives spring bones (hair/cloth) and look-at here.
        this.vrm.update(dt);
    }

    dispose() {
        VRMUtils.deepDispose(this.root);
    }
}
