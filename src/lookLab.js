/**
 * YAMIWARD — Look Lab
 * ============================================================================
 * A/B harness for the revised graphics target (PLAN-3D §0, ArcSys-class).
 *
 * This is deliberately NOT the game. It loads a free rigged stand-in character
 * so the technique stack can be proven — and costed — before any YAMIWARD asset
 * is produced to spec. Every toggle here maps to a requirement the art pipeline
 * will have to satisfy, so what survives this page becomes the mesh spec.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { createCelMaterial, setHitFlash } from './celShader.js';
import { attachOutlines, setOutlineThickness } from './outline.js';
import { autoTreatCharacter } from './vertexNormals.js';
import { HitSparks } from './hitsparks.js';

const MODEL_URL = 'https://threejs.org/examples/models/gltf/Soldier.glb';

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070b);
scene.fog = new THREE.Fog(0x07070b, 9, 26);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 1.5, 4.2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.minDistance = 1.2;
controls.maxDistance = 12;

// --- lighting: one committed key + a coloured rim, the anime staple ----------
const key = new THREE.DirectionalLight(0xfff2e4, 2.4);
key.position.set(3.4, 6.2, 4.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 22;
key.shadow.camera.left = -4; key.shadow.camera.right = 4;
key.shadow.camera.top = 5; key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0012;
scene.add(key);

// Rim comes mostly from the shader's fresnel term; a strong red LIGHT here
// floods the whole scene and turns the ground pink. Keep it as a kicker only.
const rimLight = new THREE.DirectionalLight(0xe51e25, 0.55);
rimLight.position.set(-4.2, 2.4, -3.4);
scene.add(rimLight);
scene.add(new THREE.HemisphereLight(0x20203a, 0x08080f, 0.35));

// --- ground -----------------------------------------------------------------
const ground = new THREE.Mesh(
    new THREE.CircleGeometry(9, 64),
    new THREE.MeshStandardMaterial({ color: 0x0d0d16, roughness: 0.7, metalness: 0.05 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.55, 2.62, 96),
    new THREE.MeshBasicMaterial({ color: 0xe51e25, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.002;
scene.add(ring);

// --- post -------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.75, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// --- state ------------------------------------------------------------------
const S = {
    outline: true, normals: true, stepped: true, cel: true, post: true,
    sparks: true, hitstop: true,
    thickness: 0.012, blend: 0.9, stepRate: 3,
};

// VFX run on the engine frame counter, not wall-clock — see hitsparks.js.
const sparks = new HitSparks(scene, { capacity: 192 });
let engineFrame = 0;
let hitstopFrames = 0;      // frames to freeze on impact
let flash = 0;              // white impact flash on the character material

let mixer = null, actions = [], actionIdx = 0, hulls = [], charRoot = null;
let celMats = [], originalMats = new Map(), originalNormals = new Map();

const clock = new THREE.Clock();

new GLTFLoader().load(MODEL_URL, (gltf) => {
    charRoot = gltf.scene;
    charRoot.position.set(0, 0, 0);

    // Stand-in is ~1.8u already; normalise anyway so the spec matches our pipeline
    // contract (origin at feet, ~1.8 world units tall).
    const box = new THREE.Box3().setFromObject(charRoot);
    const h = box.max.y - box.min.y;
    const s = 1.8 / h;
    charRoot.scale.setScalar(s);
    charRoot.position.y = -box.min.y * s;
    // GLB characters conventionally face -Z; our camera sits on +Z, so turn it
    // to face us. Same flip the game will need at loadFighterModel().
    charRoot.rotation.y = Math.PI;

    charRoot.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;              // skinned bounds lie during animation
        originalMats.set(o, o.material);
        // keep a pristine copy of normals so the toggle can restore them
        const n = o.geometry.attributes.normal;
        if (n) originalNormals.set(o, n.array.slice());
    });

    // Order matters: outlines derive welded normals from geometry, so build the
    // hulls BEFORE smoothing the shading normals.
    hulls = attachOutlines(charRoot, { thickness: S.thickness, color: 0x0b0b10 });
    autoTreatCharacter(charRoot, { blend: S.blend });

    // Cel materials, one per mesh, carrying the original albedo map.
    charRoot.traverse((o) => {
        if (!o.isMesh || o.name.endsWith('__outline')) return;
        const src = originalMats.get(o);
        const cel = createCelMaterial({
            color: 0xffffff,
            map: src && src.map ? src.map : null,
            rimColor: 0xe51e25,
            rimPower: 2.4,
            rimStrength: 0.75,
            steps: 3,
        });
        celMats.push({ mesh: o, cel });
        o.material = cel;
    });

    scene.add(charRoot);

    mixer = new THREE.AnimationMixer(charRoot);
    actions = gltf.animations.map((c) => mixer.clipAction(c));
    if (actions.length) { actions[0].play(); }

    document.getElementById('loading').remove();
    applyAll();
    resize();
}, undefined, (err) => {
    document.getElementById('loading').textContent = 'failed to load test model: ' + err;
});

// --- toggles ----------------------------------------------------------------
function applyOutline() {
    hulls.forEach((h) => { h.visible = S.outline; });
}
function applyNormals() {
    for (const [mesh, pristine] of originalNormals) {
        const n = mesh.geometry.attributes.normal;
        n.array.set(pristine);
        n.needsUpdate = true;
    }
    if (S.normals) autoTreatCharacter(charRoot, { blend: S.blend });
}
function applyCel() {
    for (const { mesh, cel } of celMats) {
        mesh.material = S.cel ? cel : originalMats.get(mesh);
    }
}
function applyAll() { applyOutline(); applyNormals(); applyCel(); }

const bind = (id, fn) => document.getElementById(id).addEventListener('change', fn);
bind('t-outline', (e) => { S.outline = e.target.checked; applyOutline(); });
bind('t-normals', (e) => { S.normals = e.target.checked; applyNormals(); });
bind('t-stepped', (e) => { S.stepped = e.target.checked; });
bind('t-cel',     (e) => { S.cel = e.target.checked; applyCel(); });
bind('t-post',    (e) => { S.post = e.target.checked; });
bind('t-sparks',  (e) => { S.sparks = e.target.checked; sparks.mesh.visible = e.target.checked; });
bind('t-hitstop', (e) => { S.hitstop = e.target.checked; });

/**
 * Fire a demo impact. The ORDER here is the whole craft of impact feel:
 * sparks spawn, the material flashes white, and time stops. Hitstop is what
 * makes a hit feel heavy — without it, sparks read as a sticker on the screen.
 */
const KINDS = ['light', 'heavy', 'launcher', 'block'];
let kindIdx = 1;
function demoHit(kind = KINDS[kindIdx]) {
    if (!charRoot) return;
    // Chest height, slightly toward camera so the billboard is not inside the mesh.
    const p = new THREE.Vector3(
        charRoot.position.x + (Math.random() - 0.5) * 0.25,
        1.15 + Math.random() * 0.35,
        charRoot.position.z + 0.28,
    );
    if (S.sparks) sparks.burst(p, kind, 0xe51e25);
    // A full-body white-out reads as a bug, not a hit. Keep the flash subtle and
    // let the sparks carry the impact; the flash only has to tint the silhouette.
    flash = kind === 'block' ? 0.14 : 0.32;
    if (S.hitstop) hitstopFrames = { light: 4, heavy: 8, launcher: 11, block: 5 }[kind] || 5;
}
addEventListener('pointerdown', (e) => { if (!e.target.closest('#panel')) demoHit(); });
document.getElementById('btn-hit')?.addEventListener('click', () => demoHit());
document.getElementById('sel-kind')?.addEventListener('change', (e) => {
    kindIdx = KINDS.indexOf(e.target.value);
    demoHit(e.target.value);
});

document.getElementById('s-thick').addEventListener('input', (e) => {
    S.thickness = e.target.value / 1000;
    hulls.forEach((h) => setOutlineThickness(h, S.thickness));
});
document.getElementById('s-blend').addEventListener('input', (e) => {
    S.blend = e.target.value / 100;
    applyNormals();
});
document.getElementById('s-step').addEventListener('input', (e) => {
    S.stepRate = +e.target.value;
});

addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !actions.length) return;
    e.preventDefault();
    actions[actionIdx].fadeOut(0.25);
    actionIdx = (actionIdx + 1) % actions.length;
    actions[actionIdx].reset().fadeIn(0.25).play();
});

// --- loop -------------------------------------------------------------------
// Stepped animation: hold the pose for N display frames before advancing the
// mixer, then advance by the full accumulated time. Anime is drawn "on 2s/3s";
// interpolating every frame is exactly what makes 3D read as 3D.
let stepAccum = 0, stepFrame = 0;
let fpsAccum = 0, fpsFrames = 0, lastTris = 0, lastCalls = 0;
const fpsEl = document.getElementById('fps');
const trisEl = document.getElementById('tris');
const callsEl = document.getElementById('calls');

function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);
    controls.update();

    // Hitstop freezes animation and the engine clock, but NOT the spark playback
    // frame — the sparks keep animating while the fighters are frozen, which is
    // exactly the fighting-game convention that makes impact read.
    const frozen = hitstopFrames > 0;
    if (frozen) hitstopFrames--;

    engineFrame++;
    sparks.update(engineFrame);

    // Impact flash decays fast — 3–4 frames, or it reads as a lighting bug.
    if (flash > 0) {
        flash = Math.max(0, flash - 0.22);
        celMats.forEach(({ cel }) => setHitFlash(cel, flash));
    }

    if (mixer && !frozen) {
        if (S.stepped) {
            stepAccum += dt;
            if (++stepFrame >= S.stepRate) {
                mixer.update(stepAccum);
                stepAccum = 0;
                stepFrame = 0;
            }
        } else {
            mixer.update(dt);
        }
    }

    // renderer.info is reset per render() call, and EffectComposer issues several
    // — so read the scene pass's numbers before the post passes overwrite them.
    renderer.info.autoReset = false;
    renderer.info.reset();
    if (S.post) composer.render();
    else renderer.render(scene, camera);

    // First pass in the chain is the scene render; capture it now.
    lastTris = Math.max(lastTris, renderer.info.render.triangles);
    lastCalls = Math.max(lastCalls, renderer.info.render.calls);

    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) {
        fpsEl.textContent = Math.round(fpsFrames / fpsAccum) + ' fps';
        trisEl.textContent = lastTris.toLocaleString() + ' tris';
        callsEl.textContent = lastCalls + ' draws';
        fpsAccum = 0; fpsFrames = 0; lastTris = 0; lastCalls = 0;
    }
}

function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
}
addEventListener('resize', resize);
resize();
tick();

window.LOOKLAB = { scene, renderer, camera, S, get hulls() { return hulls; } };
