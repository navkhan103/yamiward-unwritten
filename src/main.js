/**
 * YAMIWARD — bootstrap and render loop
 * ============================================================================
 * Wires the four systems together and owns the ONLY loop in the project:
 *
 *   requestAnimationFrame  ->  accumulator  ->  N x CombatEngine.step()  ->  render
 *
 * The accumulator is the important part. The engine advances in fixed 60Hz
 * steps no matter what the display does; the renderer then draws wherever the
 * simulation currently is. A 144Hz monitor gets smoother presentation, not a
 * faster game — and frame data stays true.
 *
 * Flow: character select (DOM) -> intro VN beat -> match. The select screen
 * reads `yd_clan` from localStorage — a resident whose bloodline champion is
 * in the roster gets their fighter pre-highlighted. That is the site tie-in.
 *
 * Placeholder fighters are primitive meshes. The Meshy/Mixamo GLB pipeline
 * drops in at `loadFighterModel()` without touching anything else, because the
 * engine only ever moves numbers.
 */

import * as THREE from 'three';
import { CombatEngine, Btn, State } from './CombatEngine.js';
import { MOVES, CHARACTERS, RIVALS, ROSTER } from './moves.js';
import { TekkenCamera } from './TekkenCamera.js';
import { createCelMaterial, setHitFlash } from './celShader.js';
import { buildDoll } from './paperdoll.js';
import { Overlay } from './overlay.js';
import { CpuBrain, CPU_LEVELS } from './cpu.js';
import { Stage, stageForMatch, STAGE_FOR, STAGE_TITLES } from './stage.js';
import { createInkNoirFX } from './postfx.js';
import { createTimeCtl, createKOCam } from './motionfx.js';
import { createIntroDirector } from './introdirector.js';
import { introLines } from './intro-lines.js';
import { createLadder } from './ladder.js';
import { Fighter3D, loadVRM, prefetchVRM, driveFromEngine, applyFighterLook, applyFighterBuild, applyOutline, resolveModelUrl } from './fighter3d.js';
import { attachAccessories } from './accessories.js';
import { HitSparks } from './hitsparks.js';

const FIXED_DT = 1 / 60;

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // cap: 3x DPR on mobile murders fill rate
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05050b);
scene.fog = new THREE.FogExp2(0x05050b, 0.035);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 200);

// Ink-noir post chain (M-C of the graphics program; see look-target/LOOK-TARGET.md).
// Self-contained — vendor/addons does not exist, so no three/addons imports.
const fx = createInkNoirFX(renderer, scene, camera);
// Slow-mo + KO camera (motionfx job A). Sim/doll/stage run on simDt; the
// camera and post chain stay on real time so presentation glides through
// the dilated moment.
const timeCtl = createTimeCtl();
const koCam = createKOCam();
// Pre-fight showdown (job C): pauses the sim, walks the camera through the
// entrances + dialogue, then hands back to the bell.
const intro = createIntroDirector();
// NIGHT PARADE ladder run (see src/ladder.js). One player, the field in
// seeded order, score chase; parade matches force a CPU opponent.
const ladder = createLadder(ROSTER);
let paradePlayer = null;
let paradePrevP2Mode = null;

// Hand-drawn hit sparks (sprite-sheet VFX in 3D). Lives for the session —
// shared textures are never disposed per match. See src/hitsparks.js.
const hitSparks = new HitSparks(scene);

// --- lighting: one strong key for readable cel banding, plus cool fill.
// Anime lighting is high-contrast and directional; three soft lights average
// out into mush and destroy the banding the toon ramp exists to produce.
const key = new THREE.DirectionalLight(0xfff0e0, 2.6);
key.position.set(5, 9, 4);
key.castShadow = true;
// Shadow budget. Fighters can reach wallDistance 8 / arenaRadius 9, so the old
// ±7 box clipped edge shadows during wall-splats and corner pressure. A ±10 box
// covers the full walkable area with room for airborne arcs. At 1024 over a
// 20×20 area that is ~51 texels/unit — still tight, but the fill cost stays at
// a quarter of the original 2048×24×24 and the doll depth pass is the real
// driver of shadow cost anyway.
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1;
key.shadow.camera.far = 28;
key.shadow.camera.left = -10; key.shadow.camera.right = 10;
key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key);

const rim = new THREE.DirectionalLight(0x8a5cff, 1.1);
rim.position.set(-6, 4, -5);
scene.add(rim);

const hemi = new THREE.HemisphereLight(0x2a2a4a, 0x0a0a12, 0.55);
scene.add(hemi);

// The stage owns the fog, the background colour and these three lights, because
// a district is a light as much as it is a place: the Still Quarter has no warm
// source anywhere in it, and the Gatehouse is lit by a forge.
const LIGHTS = { key, rim, hemi };

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------
// The floor, the sky, the skyline and the weather (src/stage.js). Loading is
// async and deliberately NOT awaited by startMatch: a fight must never wait on
// a texture. Until the real stage lands the fallback void is already in the
// scene, so the arena is always legible — the same degrade-don't-block rule the
// doll atlas follows.

let stage = Stage.fallback().attach(scene, LIGHTS);
let stageWanted = null;         // id currently being loaded, if any

/**
 * Compile one subtree, not the whole scene — and hand back the promise.
 *
 * `compileAsync(scene, camera)` walks EVERY material in the scene, then polls
 * each one's `currentProgram.isReady()` on a timer until they all report in.
 * Disposing a material clears its properties, so if anything in that captured
 * set is freed before its poll runs, three dereferences `undefined.isReady`
 * inside a setTimeout — uncaught, unstoppable, and it repeats forever because
 * the promise never settles. Starting a match compiled the scene INCLUDING the
 * outgoing stage, whose textures were freed a beat later when the new district
 * finished loading, which is exactly that sequence.
 *
 * Passing the object as the first argument and the scene as `targetScene`
 * compiles just that subtree against the scene's lighting, so the captured set
 * only ever holds materials we just created. Callers keep the promise and wait
 * on it before disposing what they compiled.
 */
function compileSubtree(object) {
    return renderer.compileAsync(object, camera, scene).catch(() => { /* see above */ });
}

async function setStage(id) {
    if (!id || stage?.id === id || stageWanted === id) return;
    stageWanted = id;
    try {
        const next = await Stage.load(id);
        // A second request may have landed while this one was in flight; the
        // last request wins, and the loser is disposed rather than leaked.
        if (stageWanted !== id) { next.dispose(); return; }
        const old = stage;
        stage = next.attach(scene, LIGHTS);
        next.compiled = compileSubtree(next.group);
        // Free the outgoing district only once ITS compile has settled.
        Promise.resolve(old?.compiled).then(() => old?.dispose());
    } catch (err) {
        console.warn(`stage '${id}' failed to load — staying on ${stage?.id}`, err);
    } finally {
        if (stageWanted === id) stageWanted = null;
    }
}

// ---------------------------------------------------------------------------
// Fighters (placeholder primitives — swap for GLB at loadFighterModel)
// ---------------------------------------------------------------------------

/**
 * A 3D (VRM) fighter. Returns the group SYNCHRONOUSLY so every consumer that
 * expects meshes[i] to exist right now (camera rig, viewPose positioning,
 * compile) keeps working; the model is added into it when the async load
 * resolves. Until then the group is empty and the match simply runs unseen.
 *
 * Until per-fighter models exist, everyone loads the same stand-in — the point
 * of this path is to prove combat-driven 3D animation, not the roster art.
 */
// Roster keys that have a REAL per-fighter model exported. Anyone not listed
// wears the shared stand-in in their clan palette. Upgrading a fighter is:
// drop assets/models/<key>.vrm in, add the key here.
const MODELS_AVAILABLE = new Set();

// `?vrm3d=1` swaps in real 3D (VRM) fighters. Opt-in while the 3D roster is one
// model deep — every fighter currently loads the same stand-in in their clan
// palette. Module-scope because both the select screen (to prefetch) and
// startMatch (to build) need to agree on it.
// Shared reference height for every fighter before their build is applied. The
// engine uses cylinder hitboxes, not mesh bounds, so visual height differences
// are free — they change silhouette without touching gameplay.
const FIGHTER_HEIGHT = 1.8;

const USE_3D = new URLSearchParams(location.search).has('vrm3d');

/**
 * Character lighting for the 3D path, added once.
 *
 * The stage lights were tuned for FLAT paper-doll planes, which take a single
 * strong key and read fine. Real geometry has a shaded side, and on the night
 * stages (Spotlight Roof especially) the fighters came out as murky silhouettes
 * — visible immediately in the first 3D match shot. These follow the arena
 * rather than the sun: a warm key, a cool fill from the opposite side so the
 * shadow side still carries form, and a little ambient to lift the floor.
 */
let lit3D = false;
function ensure3DLighting() {
    if (lit3D) return;
    lit3D = true;
    // Three-point, the way a character is actually lit. Key reads the form,
    // fill keeps the shadow side from going black, and the BACK light is the one
    // that was missing — it rides the silhouette and lifts the fighter off the
    // backdrop. Without it a dark fighter on a night stage is a hole in the
    // frame, which is most of why the 3D path looked flat.
    const k = new THREE.DirectionalLight(0xfff2e6, 1.30); k.position.set(3, 5, 5); scene.add(k);
    const f = new THREE.DirectionalLight(0x9bd0ff, 0.70); f.position.set(-4, 2.5, 2); scene.add(f);
    const back = new THREE.DirectionalLight(0xffffff, 0.70); back.position.set(-1.5, 4.5, -6); scene.add(back);
    scene.add(new THREE.AmbientLight(0xffffff, 0.24));
}

function build3DFighter(def) {
    ensure3DLighting();
    const g = new THREE.Group();
    // Stubs keep any stray reader (syncMeshes' placeholder branch, teardown)
    // harmless before the model lands.
    g.userData = { f3d: null, flash: 0, mats: [], mat: null, def };
    loadVRM(resolveModelUrl(def.key, MODELS_AVAILABLE)).then((vrm) => {
        // Retint to the fighter's clan palette BEFORE the first compile, so the
        // shader programs are built once with their final colours.
        applyFighterLook(vrm, def.key, def.rimColor);
        applyOutline(vrm);
        // Normalise to a common height FIRST, from the untouched mesh — then
        // apply the build. Doing it the other way round makes the bounding box
        // include the build's own scaling, and the normalisation cancels exactly
        // the height differences the build exists to create.
        const box = new THREE.Box3().setFromObject(vrm.scene);
        const h = (box.max.y - box.min.y) || 1.5;
        vrm.scene.scale.setScalar(FIGHTER_HEIGHT / h);
        applyFighterBuild(vrm, def.key);
        attachAccessories(vrm, def.key, def.rimColor);
        g.add(vrm.scene);
        g.userData.f3d = new Fighter3D(vrm);
        compileSubtree(g);
    }).catch((err) => console.warn('[vrm3d] load failed for', def.key, err));
    return g;
}

function buildPlaceholder(def) {
    const group = new THREE.Group();
    const inkBase = new THREE.Color(def.color).multiplyScalar(0.42);
    const mat = createCelMaterial({
        color: inkBase, rimColor: def.rimColor,
        rimPower: 2.1, rimStrength: 1.35, steps: 3,
    });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.72, 6, 16), mat);
    torso.position.y = 1.02;
    torso.castShadow = true;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 18), mat);
    head.position.y = 1.72;
    head.castShadow = true;
    group.add(head);

    // A forward marker: without it you cannot tell which way a capsule faces,
    // and facing is load-bearing for every hit check.
    const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.3, 12),
        new THREE.MeshBasicMaterial({ color: def.rimColor })
    );
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(0.3, 1.72, 0);
    group.add(nose);

    // Fist — parented so it can be driven by the active-frame hitbox later.
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), mat);
    fist.position.set(0.4, 1.3, 0);
    fist.castShadow = true;
    group.add(fist);

    group.userData = { mat, torso, head, fist, flash: 0 };
    return group;
}

/**
 * Drop-in point for the asset pipeline.
 * Meshy GLB -> Mixamo/AccuRIG -> DeepMotion -> Cascadeur -> GLTFLoader here.
 * Returns the same shape as buildPlaceholder so nothing downstream changes.
 */
// async function loadFighterModel(url, def) { ... GLTFLoader + AnimationMixer ... }

// ---------------------------------------------------------------------------
// Projectile presentation — mirrors engine.projectiles by id
// ---------------------------------------------------------------------------

const projectileMeshes = new Map();   // engine id -> THREE.Mesh

// Interpolation state reused every frame (cleared and refilled, no allocation).
const _projPrev = {};   // id -> {x,y,z}
const _projCurr = {};   // id -> {x,y,z}

function syncProjectiles(alpha) {
    if (!engine) return;
    const live = new Set();
    for (const pr of engine.projectiles) {
        live.add(pr.id);
        let mesh = projectileMeshes.get(pr.id);
        if (!mesh) {
            mesh = new THREE.Mesh(
                new THREE.SphereGeometry(pr.radius * 0.8, 14, 10),
                new THREE.MeshBasicMaterial({ color: pr.color, transparent: true, opacity: 0.9 })
            );
            // a cold glow shell — cheap, and reads at gameplay camera distance
            const halo = new THREE.Mesh(
                new THREE.SphereGeometry(pr.radius * 1.5, 12, 8),
                new THREE.MeshBasicMaterial({ color: pr.color, transparent: true, opacity: 0.22 })
            );
            mesh.add(halo);
            scene.add(mesh);
            projectileMeshes.set(pr.id, mesh);
        }
        // Interpolate between the last two sim snapshots.
        const prev = _projPrev[pr.id];
        const curr = _projCurr[pr.id];
        if (prev && curr) {
            mesh.position.set(
                prev.x + (curr.x - prev.x) * alpha,
                prev.y + (curr.y - prev.y) * alpha,
                prev.z + (curr.z - prev.z) * alpha,
            );
        } else if (curr) {
            // New projectile — no prev to lerp from; snap into place.
            mesh.position.set(curr.x, curr.y, curr.z);
        }
    }
    for (const [id, mesh] of projectileMeshes) {
        if (!live.has(id)) { scene.remove(mesh); projectileMeshes.delete(id); }
    }
}

// ---------------------------------------------------------------------------
// Match state — created by startMatch(), torn down by nothing (page reload
// is the rematch flow for now; select screen returns post-match later)
// ---------------------------------------------------------------------------

let engine = null;
let meshes = [];
let camRig = null;
let cpu = null;                // CpuBrain driving slot 1, or null for 2P versus
// Settles when every shader compile started for the CURRENT fighters is done.
// teardownMatch waits on it before freeing them — see compileSubtree.
let meshCompile = Promise.resolve();

// P2 mode cycles on the select screen and persists like the clan pick does.
// CPU medium is the boot default: solo play must work with zero setup.
const P2_MODES = ['cpu:easy', 'cpu:medium', 'cpu:hard', '2p'];
const P2_LABELS = {
    'cpu:easy': 'VS CPU · EASY 弱', 'cpu:medium': 'VS CPU · MEDIUM 中',
    'cpu:hard': 'VS CPU · HARD 強', '2p': '2P VERSUS 対戦',
};
let p2Mode = 'cpu:medium';
try {
    const saved = localStorage.getItem('yd_p2mode');
    if (P2_MODES.includes(saved)) p2Mode = saved;
} catch { /* storage unavailable — fine */ }
const overlay = new Overlay();
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/**
 * Pre-fight VN beats. Canon rival pairs get their real dialogue; any other
 * pairing gets the Registrar's framing so no matchup ships silent.
 * Voices are canon (internal design docs §5).
 */
function introFor(aKey, bKey, stageId) {
    const A = CHARACTERS[aKey], B = CHARACTERS[bKey];
    const pair = [aKey, bKey].sort().join('+');
    const REG = { speaker: 'THE REGISTRAR', kanji: '闇', color: '#9BE8E0' };

    const RIVAL_INTROS = {
        'raiga+tetsuki': [
            { ...REG, text: 'Twelve gates opened. Four champions answered. Tonight, two of them settle an old argument.' },
            { speaker: 'RAIGA', kanji: '雷牙', color: hex(CHARACTERS.raiga.color), text: 'Gatekeeper! Smile for them once — the crowd came all this way.' },
            { speaker: 'TETSUKI', kanji: '鉄鬼', color: hex(CHARACTERS.tetsuki.color), text: 'They came for the fight. Doors work both ways, Raiga. So do spotlights.' },
        ],
        'mayoi+yukiwari': [
            { ...REG, text: 'The Registry notes an irregularity: one entrant refuses to be read. The other refuses to be reached.' },
            { speaker: 'MAYOI', kanji: '迷', color: hex(CHARACTERS.mayoi.color), text: 'Snow-cutter! Guess which smile is real and I will let you hit it.' },
            { speaker: 'YUKIWARI', kanji: '雪割', color: hex(CHARACTERS.yukiwari.color), text: 'Neither. You are not hiding, Mayoi. You are unfinished.' },
        ],
    };

    const beats = RIVAL_INTROS[pair] || [
        { ...REG, text: `Twelve bloodlines keep the ward. Tonight, ${A.clan} and ${B.clan} disagree about who keeps which street.` },
        { speaker: A.name, kanji: A.kanji, color: hex(A.color), text: A.voice },
        { speaker: B.name, kanji: B.kanji, color: hex(B.color), text: B.voice },
    ];

    // Name the district before anyone speaks. This is not set dressing: rivals
    // live at opposite gates, so a grudge is fought AWAY from home (see
    // stageForMatch) — hearing the away district named is how the player learns
    // they travelled, without a line of dialogue spent explaining it.
    const where = STAGE_TITLES[stageId];
    if (where) beats.unshift({ ...REG, text: `${where.name.toUpperCase()} · ${where.blurb}` });
    return beats;
}

/** Remove the current match from the scene so select/rematch starts clean. */
function teardownMatch() {
    // Removing from the scene graph un-parents but does not free GPU memory:
    // every doll owns ~11 plane geometries and a cloned texture per piece, so a
    // long couch session of rematches would climb until the context is lost.
    // Dispose on the way out. Textures are per-piece clones, so disposing them
    // with their material is safe — nothing else holds them.
    //
    // Un-parent NOW so the next round never renders the old fighters, but free
    // the GPU objects only once their shader compiles have settled: three's
    // compileAsync polls the materials it captured, and freeing one mid-flight
    // throws forever from inside a timer (see compileSubtree). A rematch is a
    // teardown milliseconds after a compile, so this is the live case, not a
    // hypothetical one.
    const doomed = meshes;
    const pending = meshCompile;
    for (const m of doomed) scene.remove(m);
    meshes = [];
    meshCompile = Promise.resolve();
    Promise.resolve(pending).then(() => {
        for (const m of doomed) {
            m.traverse((o) => {
                if (!o.isMesh) return;
                o.geometry?.dispose();
                // `material` is not the only material a mesh can own. Every doll
                // piece also carries a customDepthMaterial — added so the shadow
                // pass cuts the piece's silhouette instead of a rectangle — and
                // it holds its own reference to the piece texture. Disposing only
                // `material` left 20 depth materials and their maps alive per
                // match: measured as a steady +20 textures on every rematch, with
                // geometries flat, which is what pointed at a second material
                // rather than a missed mesh.
                for (const mat of [
                    ...(Array.isArray(o.material) ? o.material : [o.material]),
                    o.customDepthMaterial, o.customDistanceMaterial,
                ]) {
                    if (!mat) continue;
                    // EVERY texture the material owns, not just `map`.
                    // `material.dispose()` frees the program, never the textures
                    // hanging off it, and these materials own more than an
                    // albedo: createCelMaterial builds a private toon
                    // `gradientMap` per material, so a doll leaked one ramp per
                    // PIECE — a measured +20 textures on every rematch that
                    // disposing `map` alone could never have caught. Walking the
                    // properties means the next map anyone adds is covered
                    // without anyone having to remember this comment.
                    for (const k of Object.keys(mat)) {
                        if (mat[k] && mat[k].isTexture) mat[k].dispose();
                    }
                    mat.dispose();
                }
                o.customDepthMaterial = undefined;
            });
        }
    });
    for (const [id, mesh] of projectileMeshes) { scene.remove(mesh); projectileMeshes.delete(id); }
    // Clear interpolation state so stale snapshots don't leak into the next match.
    for (const k of Object.keys(_projPrev)) delete _projPrev[k];
    for (const k of Object.keys(_projCurr)) delete _projCurr[k];
    // Hit spark system lives for the session — sparks self-clear via age in the
    // shader; no explicit reset API exists and we must NOT dispose shared textures.
    engine = null;
    camRig = null;
    cpu = null;
    resultsShown = false;
}

let currentMatch = null;      // { p1, p2 } for rematch
let resultsShown = false;

// ---------------------------------------------------------------------------
// Results screen — a finished match must flow somewhere, not dead-end.
// Rematch keeps the matchup (the "run it back" loop is the core of couch
// play); CHANGE CHAMPION returns to select. Both tear down fully.
// ---------------------------------------------------------------------------

function showResults(winnerDef, loserDef, winnerRounds, loserRounds) {
    const root = document.getElementById('results');
    if (!root) return;

    // NIGHT PARADE: mid-run wins chain straight into the next bout (no card,
    // no intro); the card appears only when the run ends, repurposed as the
    // run summary.
    if (ladder.active && engine) {
        const playerWon = engine.winner === 1;
        const p = engine.fighters[0];
        const res = ladder.reportMatch({
            won: playerWon,
            playerHealthFrac: Math.max(0, p.health) / p.def.maxHealth,
            seconds: Math.max(0, (60 * 60 - engine.timer) / 60),
            perfect: playerWon && engine.fighters[1].roundsWon === 0,
        });
        if (!res.runOver) {
            overlay.announce(`SCORE ${res.runScore}`, `${ladder.current.index}/${ladder.current.total}`, 1.4);
            p2Mode = `cpu:${ladder.current.cpuLevel}`;
            teardownMatch();
            startMatch(paradePlayer, ladder.current.opponentKey, { skipIntro: true });
            return;
        }
        const s = ladder.summary();
        if (paradePrevP2Mode) { p2Mode = paradePrevP2Mode; paradePrevP2Mode = null; }
        document.getElementById('results-kanji').textContent = '宴';
        document.getElementById('results-title').textContent =
            s.wins === ladder.current?.total || s.wins >= 7 ? 'PARADE CONQUERED' : 'THE PARADE ENDS';
        document.getElementById('results-line').textContent =
            `NIGHT PARADE · ${s.wins} wins · score ${s.runScore}${s.newBest ? ' · NEW BEST' : ''}`;
        root.style.setProperty('--accent', hex(CHARACTERS[paradePlayer]?.color ?? winnerDef.color));
        root.hidden = false;
        resultsShown = true;
        return;
    }

    document.getElementById('results-kanji').textContent = winnerDef.kanji;
    document.getElementById('results-title').textContent = `${winnerDef.name} WINS`;
    document.getElementById('results-line').textContent =
        `${winnerRounds}–${loserRounds} over ${loserDef.name} · ${winnerDef.clan}`;
    root.style.setProperty('--accent', hex(winnerDef.color));
    root.hidden = false;
    resultsShown = true;
}

function hideResults() {
    const root = document.getElementById('results');
    if (root) root.hidden = true;
}

function rematch() {
    if (!currentMatch) return;
    hideResults();
    teardownMatch();
    startMatch(currentMatch.p1, currentMatch.p2);
}

function backToSelect() {
    hideResults();
    if (ladder.active) ladder.abort();
    if (paradePrevP2Mode) { p2Mode = paradePrevP2Mode; paradePrevP2Mode = null; }
    teardownMatch();
    showSelect();
}

document.getElementById('results-rematch')?.addEventListener('click', rematch);
document.getElementById('results-select')?.addEventListener('click', backToSelect);
window.addEventListener('keydown', (e) => {
    if (!resultsShown) return;
    if (e.code === 'KeyR') { e.preventDefault(); rematch(); }
    else if (e.code === 'Enter') { e.preventDefault(); backToSelect(); }
});

// ---------------------------------------------------------------------------
// Render interpolation — fixed-timestep state snapshots
// ---------------------------------------------------------------------------
// The sim steps at FIXED_DT inside the accumulator loop; meshes and camera
// previously read engine state directly, so they snap at 60 Hz while rAF runs
// up to 144 Hz (judder). We capture prev/curr snapshots around each engine
// step and lerp between them in the render phase so everything moves smoothly.
//
// Snapshots happen INSIDE the while loop, immediately BEFORE each engine.step()
// call — NOT once per rAF before the loop. Doing it before the loop would
// overwrite prev on no-step frames and reintroduce the snap.
//
// Teleport guard: if prev and curr are >3 units apart (round transition,
// wall-break teleport), snap instead of lerping so the fighter doesn't streak
// across the arena for one frame.

const _prevPos = [new THREE.Vector3(), new THREE.Vector3()];
const _currPos = [new THREE.Vector3(), new THREE.Vector3()];
const _prevFacing = [1, 1];
const _currFacing = [1, 1];

// Module-scope array reused every frame — no per-frame allocation.
const viewPose = [
    { x: 0, y: 0, z: 0, facing: 1 },
    { x: 0, y: 0, z: 0, facing: 1 },
];

function startMatch(p1Key, p2Key, opts = {}) {
    // Idempotent: starting a match while one exists must not leak the old one.
    // `rematch` and `backToSelect` both tear down before calling here, but any
    // other caller — a story-mode chapter transition, a debug/QA driver — would
    // otherwise stack a second pair of dolls at the origin with nothing removing
    // them. That leak is invisible in play (the new fighters render on top) and
    // was only caught when a QA sweep counted 28 dolls in the scene.
    if (meshes.length) teardownMatch();

    currentMatch = { p1: p1Key, p2: p2Key };
    const P1_DEF = CHARACTERS[p1Key];
    const P2_DEF = CHARACTERS[p2Key];

    // `?stage=<id>` pins one arena for QA and for shooting stills; without it
    // the matchup decides (see stageForMatch — rivals fight at the away gate).
    const stageId = new URLSearchParams(location.search).get('stage') ||
        stageForMatch(p1Key, p2Key, RIVALS);
    setStage(stageId);

    // Paper-doll rig by default (SPEC-PAPERDOLL.md); `?placeholder=1` keeps
    // the primitive capsules reachable for A/B and as the proven fallback.
    const wantPlaceholder = new URLSearchParams(location.search).has('placeholder');
    const buildFighter = (def) => {
        if (USE_3D) return build3DFighter(def);
        if (wantPlaceholder) return buildPlaceholder(def);
        try { return buildDoll(def); }
        catch (err) { console.warn('doll build failed, using placeholder', err); return buildPlaceholder(def); }
    };
    meshes = [buildFighter(P1_DEF), buildFighter(P2_DEF)];
    meshes.forEach((m) => scene.add(m));

    // Compile up front. Three compiles a material's program the first time it is
    // actually drawn, so without this the cost lands on frame 1 of the round —
    // measured at 510ms, i.e. a visible half-second freeze exactly as the fight
    // starts. Doing it here moves the stall into the transition where nothing is
    // animating yet. The atlas swaps materials asynchronously, so loadAtlas
    // re-compiles when its pieces land (see paperdoll.js).
    // Per-fighter, not scene-wide — see compileSubtree for why that distinction
    // is load-bearing rather than a micro-optimisation.
    meshCompile = Promise.all(meshes.map(compileSubtree));

    engine = new CombatEngine(P1_DEF, P2_DEF, { moves: MOVES, seed: 0xBEEF, roundSeconds: 60 });

    // Seed interpolation state so the first render frame has valid prev/curr.
    for (let i = 0; i < 2; i++) {
        const f = engine.fighters[i];
        _currPos[i].set(f.pos.x, f.pos.y, f.pos.z);
        _currFacing[i] = f.facing;
        _prevPos[i].copy(_currPos[i]);
        _prevFacing[i] = _currFacing[i];
    }

    // Debug/QA handle — read-only inspection for browser-qa; nothing in the
    // game reads this back.
    window.__yw = { meshes, engine, scene, camera, renderer, fx, intro, overlay, camRig: () => camRig, pump: (n = 1, dtMs = 16.67) => { let t = performance.now(); for (let i = 0; i < n; i++) { t += dtMs; frame(t); } } };
    // The CPU is an input source, not an engine feature: it emits the same
    // bitmasks a pad does, so replays and future netplay are unaffected.
    cpu = p2Mode.startsWith('cpu:') ? new CpuBrain(1, p2Mode.split(':')[1]) : null;
    camRig = new TekkenCamera(camera, { keepP1Left: true });
    camRig.setFighters(meshes[0], meshes[1]);

    // Pre-fight showdown. Dialogue comes from the CANON introFor lines that
    // already exist for each matchup (the standalone playStory call below was
    // racing the director's WORDS phase — two story queues fighting); the
    // placeholder introLines are only the fallback for pairs introFor doesn't
    // cover. skipIntro (ladder matches 2+) resolves the whole sequence at once.
    const canonLines = introFor(p1Key, p2Key, stageId);
    intro.start({
        overlay,
        meshes,
        defs: [P1_DEF, P2_DEF],
        lines: (canonLines && canonLines.length) ? canonLines : introLines(p1Key, p2Key, CHARACTERS, RIVALS),
        faces: [meshes[0].userData.doll?.face ?? null, meshes[1].userData.doll?.face ?? null],
    }).then(() => {
        overlay.wipe();
        overlay.announce('ROUND 1', '闘');
    });
    if (opts.skipIntro) intro.skip();

    overlay.setFighters(
        { name: P1_DEF.name, kanji: P1_DEF.kanji, color: hex(P1_DEF.color), portrait: `./assets/portraits/${p1Key}.webp` },
        { name: P2_DEF.name, kanji: P2_DEF.kanji, color: hex(P2_DEF.color), portrait: `./assets/portraits/${p2Key}.webp` }
    );

}

// ---------------------------------------------------------------------------
// Character select — DOM over the idle arena. P2 defaults to the canon rival,
// which makes single-player boot straight into the story-correct matchup.
// ---------------------------------------------------------------------------

// Track the current cycleMode handler so we can remove it before re-adding —
// showSelect() runs on every return to the select screen and was stacking
// listeners, so after N visits one click advanced N modes.
let _modeBtnHandler = null;

function showSelect() {
    const root = document.getElementById('select');
    const grid = document.getElementById('select-grid');
    if (!root || !grid) { startMatch('tetsuki', 'raiga'); return; }

    // Start pulling the 3D model down NOW. Choosing a fighter takes a few
    // seconds of human time; spending it on the download means the match starts
    // against a warm cache instead of a cold 16MB fetch.
    if (USE_3D) for (const k of ROSTER) prefetchVRM(resolveModelUrl(k, MODELS_AVAILABLE));

    // Resident tie-in: highlight the player's bloodline champion if theirs.
    let residentPick = null;
    try {
        const clan = (localStorage.getItem('yd_clan') || '').toLowerCase();
        residentPick = ROSTER.find((k) => CHARACTERS[k].clan.toLowerCase().startsWith(clan) && clan);
    } catch { /* storage unavailable — fine */ }

    let cursor = Math.max(0, ROSTER.indexOf(residentPick ?? 'tetsuki'));

    // Opponent mode toggle — click or press C to cycle. Lives on the select
    // screen so switching from solo to couch versus is one input, not a menu.
    const modeBtn = document.getElementById('select-p2mode');
    function paintMode() {
        if (modeBtn) modeBtn.textContent = P2_LABELS[p2Mode];
    }
    function cycleMode() {
        p2Mode = P2_MODES[(P2_MODES.indexOf(p2Mode) + 1) % P2_MODES.length];
        try { localStorage.setItem('yd_p2mode', p2Mode); } catch { /* fine */ }
        paintMode();
    }
    // Remove previous handler before adding to prevent stacking across visits.
    if (_modeBtnHandler && modeBtn) modeBtn.removeEventListener('click', _modeBtnHandler);
    _modeBtnHandler = cycleMode;
    modeBtn?.addEventListener('click', _modeBtnHandler);
    paintMode();

    // NIGHT PARADE entry — reuses the mode button's styling; shows the best
    // run so the score chase starts on the select screen.
    // Guarded by `!document.getElementById('select-parade')` so the button is
    // created only once across visits; its click listener does NOT stack.
    if (modeBtn && !document.getElementById('select-parade')) {
        const pb = document.createElement('button');
        pb.id = 'select-parade';
        pb.className = modeBtn.className;
        let bestLine = '';
        try {
            const best = JSON.parse(localStorage.getItem('yw_parade_best') || 'null');
            if (best?.score) bestLine = ` · BEST ${best.score}`;
        } catch { /* fine */ }
        pb.textContent = `NIGHT PARADE 百鬼夜行${bestLine}`;
        pb.addEventListener('click', () => {
            const player = ROSTER[cursor] ?? 'tetsuki';
            paradePlayer = player;
            paradePrevP2Mode = p2Mode;
            ladder.begin(player, (Date.now() & 0x7fffffff) || 1);
            root.hidden = true;
            p2Mode = `cpu:${ladder.current.cpuLevel}`;
            startMatch(player, ladder.current.opponentKey);
        });
        modeBtn.parentElement?.appendChild(pb);
    }

    grid.innerHTML = '';
    const cards = ROSTER.map((keyName, i) => {
        const def = CHARACTERS[keyName];
        const card = document.createElement('button');
        card.className = 'select-card';
        card.style.setProperty('--accent', hex(def.color));
        card.innerHTML =
            // eager, not lazy: 4 x ~40KB, and lazy-load defers forever in a
            // non-composited (hidden/background) tab — burned us in testing
            `<img class="sc-portrait" src="./assets/portraits/${keyName}.webp" alt=""` +
            ` onerror="this.remove()">` +   // missing art degrades to the kanji card, never a broken icon
            `<div class="sc-kanji">${def.kanji}</div>` +
            `<div class="sc-name">${def.name}</div>` +
            `<div class="sc-arch">${def.archetype}</div>` +
            `<div class="sc-clan">${def.clanKey ? `<img class="sc-crest" src="./assets/crests/${def.clanKey}.webp" alt="" onerror="this.remove()">` : ''}${def.clan} · ${def.sign}</div>` +
            `<div class="sc-blurb">${def.blurb}</div>` +
            (keyName === residentPick ? '<div class="sc-resident">YOUR BLOODLINE</div>' : '');
        card.addEventListener('click', () => pick(i));
        card.addEventListener('mouseenter', () => focus(i));
        grid.appendChild(card);
        return card;
    });

    function focus(i) {
        cursor = i;
        cards.forEach((c, k) => c.classList.toggle('focused', k === i));
    }

    function pick(i) {
        const p1 = ROSTER[i];
        const p2 = RIVALS[p1] || ROSTER.find((k) => k !== p1);
        root.hidden = true;
        window.removeEventListener('keydown', onKey);
        startMatch(p1, p2);
    }

    function onKey(e) {
        if (root.hidden) return;
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') focus((cursor + ROSTER.length - 1) % ROSTER.length);
        else if (e.code === 'ArrowRight' || e.code === 'KeyD') focus((cursor + 1) % ROSTER.length);
        else if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyJ') { e.preventDefault(); pick(cursor); }
        else if (e.code === 'KeyC') cycleMode();
    }

    window.addEventListener('keydown', onKey);
    focus(cursor);
    root.hidden = false;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// Tekken mapping, which is not the obvious one: LEFT/RIGHT walk along the
// fighting axis, UP/DOWN *sidestep* into 3D. Holding down crouches; tapping it
// steps. Getting this right is most of why the game feels like Tekken.

const held = new Set();
window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    held.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    // Escape is the deliberate, unambiguous "skip the showdown" input — a
    // gameplay key (J/K/WASD) doing the same was tried and reverted: an
    // instinctive first keypress silently yanked away dialogue the player
    // never chose to skip, which read as broken rather than responsive.
    // Space/Enter still advance a line one at a time via the overlay.
    if (intro.active && e.code === 'Escape') intro.skip();
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

const P1_KEYS = { back: 'KeyA', fwd: 'KeyD', stepL: 'KeyW', stepR: 'KeyS', crouch: 'KeyS', light: 'KeyJ', heavy: 'KeyK', low: 'KeyL', special: 'KeyI', super: 'KeyU' };
const P2_KEYS = { back: 'ArrowRight', fwd: 'ArrowLeft', stepL: 'ArrowUp', stepR: 'ArrowDown', crouch: 'ArrowDown', light: 'Numpad1', heavy: 'Numpad2', low: 'Numpad3', special: 'Numpad5', super: 'Numpad0' };

// ---------------------------------------------------------------------------
// Gamepads — controller N drives fighter slot N, merged with the keyboard so
// either input works at any time. Standard mapping:
//   left stick / d-pad ......... walk (x) and sidestep-tap / crouch-hold (y)
//   X(2) light · Y(3) heavy · A(0) low · B(1) special · RB(5)/RT(7) super
// Walk direction mirrors each slot's keyboard convention (P2's is flipped),
// so a controller feels identical to the keys it replaces.
// ---------------------------------------------------------------------------

const PAD_DEAD = 0.35;
const padTap = [{ up: 0, down: 0 }, { up: 0, down: 0 }];

function padBits(slot) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads[slot];
    if (!p || !p.connected) return 0;
    let m = 0;

    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    const left = ax < -PAD_DEAD || p.buttons[14]?.pressed;
    const right = ax > PAD_DEAD || p.buttons[15]?.pressed;
    const up = ay < -PAD_DEAD || p.buttons[12]?.pressed;
    const down = ay > PAD_DEAD || p.buttons[13]?.pressed;

    // slot 0 keyboard: A=back(left) D=fwd(right); slot 1 mirrored
    if (slot === 0) { if (left) m |= Btn.BACK; if (right) m |= Btn.FORWARD; }
    else { if (right) m |= Btn.BACK; if (left) m |= Btn.FORWARD; }

    // vertical: rising edge = sidestep, sustained down = crouch (same
    // tap-vs-hold rule as the keyboard, tracked per pad)
    const t = padTap[slot];
    if (up && t.up === 0) m |= Btn.STEP_LEFT;
    t.up = up ? t.up + 1 : 0;
    if (down && t.down === 0) m |= Btn.STEP_RIGHT;
    t.down = down ? t.down + 1 : 0;
    if (down && t.down > 8) m |= Btn.CROUCH;

    if (p.buttons[2]?.pressed) m |= Btn.LIGHT;
    if (p.buttons[3]?.pressed) m |= Btn.HEAVY;
    if (p.buttons[0]?.pressed) m |= Btn.LOW;
    if (p.buttons[1]?.pressed) m |= Btn.SPECIAL;
    if (p.buttons[5]?.pressed || p.buttons[7]?.pressed) m |= Btn.SUPER;
    return m;
}

window.addEventListener('gamepadconnected', (e) => {
    overlay.announce(`P${e.gamepad.index + 1} PAD`, '接続', 1.2);
});

// tap-vs-hold: a short press sidesteps, a sustained one crouches
const tapState = [{}, {}];
function readInput(slot) {
    const K = slot === 0 ? P1_KEYS : P2_KEYS;
    const t = tapState[slot];
    let m = 0;

    if (held.has(K.back)) m |= Btn.BACK;
    if (held.has(K.fwd)) m |= Btn.FORWARD;

    for (const [key, bit] of [[K.stepL, Btn.STEP_LEFT], [K.stepR, Btn.STEP_RIGHT]]) {
        const down = held.has(key);
        const prev = t[key] || 0;
        if (down && prev === 0) m |= bit;            // rising edge = step
        t[key] = down ? prev + 1 : 0;
        if (down && prev > 8 && key === K.crouch) m |= Btn.CROUCH;   // held = crouch
    }

    if (held.has(K.light)) m |= Btn.LIGHT;
    if (held.has(K.heavy)) m |= Btn.HEAVY;
    if (held.has(K.low)) m |= Btn.LOW;
    if (held.has(K.special)) m |= Btn.SPECIAL;
    if (held.has(K.super)) m |= Btn.SUPER;
    return m | padBits(slot);
}

// ---------------------------------------------------------------------------
// Engine events -> presentation
// ---------------------------------------------------------------------------

function handleEvents() {
    for (const ev of engine.drainEvents()) {
        switch (ev.type) {
            case 'hit': {
                camRig.addShake(ev.counter ? 0.85 : 0.5);
                meshes[ev.slot].userData.flash = 1;
                // No timeCtl kick on counters — they land several times a
                // round and the repeated dips read as stutter (playtest
                // 2026-08-10). KO keeps the deep slow-mo.
                if (ev.counter) { overlay.announce('COUNTER', '', 0.7); }
                else if (ev.move?.isGrab) overlay.announce('GRIP', '掴', 0.7);

                // Hit spark burst at the impact point — chest height, offset
                // slightly toward the attacker so it reads between the fighters.
                const defenderSlot = ev.slot;
                const attackerSlot = 1 - ev.slot;
                const defPose = viewPose[defenderSlot];
                const atkPose = viewPose[attackerSlot];
                const dx = atkPose.x - defPose.x;
                const dz = atkPose.z - defPose.z;
                const dist = Math.sqrt(dx * dx + dz * dz) || 1;
                const impactPoint = {
                    x: defPose.x + (dx / dist) * 0.3,
                    y: 1.2,
                    z: defPose.z + (dz / dist) * 0.3,
                };
                const kind = ev.counter ? 'heavy' : 'light';
                const tint = engine.fighters[attackerSlot].def.color;
                hitSparks.burst(impactPoint, kind, tint);
                break;
            }
            case 'block': {
                camRig.addShake(0.18);
                // Smaller spark burst on block — teal flash, reads as deflection.
                const blockerSlot = ev.slot;
                const attackerSlot = 1 - ev.slot;
                const blkPose = viewPose[blockerSlot];
                const atkPose = viewPose[attackerSlot];
                const dx = atkPose.x - blkPose.x;
                const dz = atkPose.z - blkPose.z;
                const dist = Math.sqrt(dx * dx + dz * dz) || 1;
                hitSparks.burst({
                    x: blkPose.x + (dx / dist) * 0.25,
                    y: 1.2,
                    z: blkPose.z + (dz / dist) * 0.25,
                }, 'block', 0x9be8e0);
                break;
            }
            case 'armor': {
                // reads as "he walked through it" — flash the armored fighter gold
                camRig.addShake(0.4);
                meshes[ev.slot].userData.flash = 0.6;
                overlay.announce('ARMOR', '鉄', 0.6);
                break;
            }
            case 'status': {
                if (ev.kind === 'frostbite') overlay.announce('FROSTBITE', '凍', 0.6);
                else if (ev.kind === 'charge' && ev.lost) overlay.announce('CHARGE LOST', '', 0.6);
                else if (ev.kind === 'charge' && ev.value >= 10) overlay.announce('MAX CHARGE', '雷', 0.8);
                break;
            }
            case 'wallsplat': camRig.addShake(1.0); overlay.announce('WALL', '壁', 0.8); timeCtl.kick('wallsplat'); break;
            case 'crush': overlay.announce(ev.kind === 'high' ? 'DUCKED' : 'HOPPED', '', 0.6); break;
            case 'whiff': overlay.announce('SIDESTEP', '回避', 0.7); break;
            case 'round': overlay.announce(`ROUND ${ev.round}`, '闘'); camRig.snap(); break;
            case 'fight': overlay.announce('FIGHT', '始め'); break;
            case 'ko': {
                overlay.announce('K.O.', '', 2.4); camRig.addShake(1);
                // Slow-mo + camera push toward the fallen fighter.
                timeCtl.kick('ko');
                const down = engine.fighters.findIndex((f) => f.health <= 0);
                if (down >= 0) koCam.kick(meshes[down].position);
                break;
            }
            case 'timeout': overlay.announce('TIME', '', 2.4); break;
            case 'matchend': {
                const w = engine.fighters[engine.winner - 1];
                const l = engine.fighters[2 - engine.winner];
                overlay.announce(`${w.def.name} WINS`, w.def.kanji, 2.2);
                // let the announce land, then offer the way forward
                const eng = engine;   // guard: a rematch during the delay must not resurrect a dead ref
                setTimeout(() => {
                    if (engine === eng) showResults(w.def, l.def, w.roundsWon, l.roundsWon);
                }, 2400);
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sync engine state -> scene graph
// ---------------------------------------------------------------------------

function syncMeshes(dt) {
    for (let i = 0; i < 2; i++) {
        const f = engine.fighters[i];
        const g = meshes[i];
        // Position from the interpolated viewPose, not the raw engine fighter —
        // this is the core of fixed-timestep render interpolation.
        const vp = viewPose[i];
        g.position.set(vp.x, vp.y, vp.z);

        const ud = g.userData;

        // 3D (VRM) path: the humanoid rig is posed straight from engine state.
        // Loads async, so this branch only engages once the model has landed;
        // until then the group is simply empty and the fight runs headless.
        if (ud.f3d) {
            g.rotation.y = f.facing === 1 ? Math.PI / 2 : -Math.PI / 2;
            driveFromEngine(ud.f3d, f, State);
            ud.f3d.update(dt);
            if (ud.flash > 0) {
                ud.flash = Math.max(0, ud.flash - dt * 6);
                if (ud.flash > 0.5) fx.impact(ud.flash * 0.7);
            }
            continue;
        }

        // Paper-doll path: pose evaluator + billboard live in the doll.
        if (ud.doll) {
            // The atlas lands mid-match and swaps every piece's material, which
            // invalidates their compiled programs. Compile the new set once, here,
            // rather than paying for it scattered across the next frames as each
            // piece first becomes visible.
            if (ud.doll.needsCompile) {
                ud.doll.needsCompile = false;
                // compileAsync, not compile: the synchronous form still costs the
                // full ~500ms and merely moves WHICH frame stutters. The async form
                // hands the work to the driver's parallel-compile extension and
                // resolves later, so no single frame eats it.
                meshCompile = Promise.all([meshCompile, compileSubtree(g)]);
            }
            ud.doll.update(f, dt, camera);
            if (ud.flash > 0) {
                ud.flash = Math.max(0, ud.flash - dt * 6);
                // 0.8 was a near-total whiteout against this stage's dark
                // baseline — bloom then blew it further into a featureless
                // glowing silhouette with zero readable detail (QA shot,
                // 2026-08-10). 0.35 still reads clearly as a hit.
                // ud.mats is the LIVE material list paperdoll maintains across
                // the atlas swap — flashing ud.mat alone hit an orphaned
                // material once real art loaded, and the whole doll must flash,
                // not just its first piece.
                for (const fm of (ud.mats ?? [ud.mat])) setHitFlash(fm, ud.flash * 0.35);
                // Strong hits kick the post chain — this branch was missing it
                // (only the legacy placeholder path had the hook).
                if (ud.flash > 0.5) fx.impact(ud.flash * 0.7);
            }
            continue;
        }

        // face the opponent; +1 faces +x. Facing is discrete (binary) —
        // lerping it would produce a one-frame twist, so we use curr directly.
        g.rotation.y = vp.facing === 1 ? 0 : Math.PI;

        // crude state posing until skeletal clips land
        const crouched = f.state === State.CROUCH || f.crouching;
        const targetScale = crouched ? 0.72 : 1;
        // Frame-rate-independent exponential smooth: convergence speed no longer
        // depends on framerate. Replaces the old `Math.min(1, dt * k)` pattern.
        ud.torso.scale.y += (targetScale - ud.torso.scale.y) * (1 - Math.exp(-18 * dt));
        ud.head.position.y = 1.72 * (crouched ? 0.78 : 1);

        // punch extension during active frames — reads the hitbox visually
        let reach = 0.4;
        if (f.state === State.ATTACKING && f.move) {
            const m = f.move;
            const p = f.stateFrame / Math.max(1, m.startupFrames + m.activeFrames);
            reach = 0.4 + Math.min(1, p) * (m.reach - 0.4);
            ud.fist.position.y = m.hitboxHeight ?? 1.3;
        } else {
            ud.fist.position.y += (1.3 - ud.fist.position.y) * (1 - Math.exp(-12 * dt));
        }
        ud.fist.position.x += (reach - ud.fist.position.x) * (1 - Math.exp(-30 * dt));

        // impact flash decay
        if (ud.flash > 0) {
            ud.flash = Math.max(0, ud.flash - dt * 6);
            for (const fm of (ud.mats ?? [ud.mat])) setHitFlash(fm, ud.flash * 0.8);
            // Strong hits kick the post chain (bloom boost + chromatic + pop).
            if (ud.flash > 0.5) fx.impact(ud.flash * 0.7);
        }
    }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

let acc = 0;
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, fps = 60;

function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;          // tab was backgrounded — do not fast-forward
    const simDt = timeCtl.update(dt);  // slow-mo scales the SIM clock only
    acc += simDt;

    if (!engine) {                      // still on character select
        stage?.update(dt);              // the arena keeps breathing behind the menu
        if (rosterPreview) rosterPreview.forEach((f) => f.update(dt));
        if (preview3d) {                // ?vrm= 3D preview: slow turntable + spring bones
            preview3d.update(dt);
            // Turntable only when showcasing the model; a clip demo holds still
            // so the motion itself is what you judge.
            if (!preview3dHold) preview3d.object3d.rotation.y += dt * 0.5;
        }
        fx.render(dt);
        acc = 0;
        return;
    }

    // Fixed-step simulation. The cap stops a long stall from spiralling.
    // Inside the loop, snapshot fighter + projectile state BEFORE each step
    // so the render phase can lerp between the two most recent sim states.
    let steps = 0;
    while (acc >= FIXED_DT && steps < 5) {
        // --- snapshot PREV: the state BEFORE this step ---------------------
        for (let i = 0; i < 2; i++) {
            _prevPos[i].copy(_currPos[i]);
            _prevFacing[i] = _currFacing[i];
        }
        // Projectile snapshots: move curr into prev (same objects — no
        // allocation), leaving curr empty for this step's refill below.
        for (const k of Object.keys(_projPrev)) delete _projPrev[k];
        for (const k of Object.keys(_projCurr)) {
            _projPrev[k] = _projCurr[k];
            delete _projCurr[k];
        }

        if (!overlay.storyActive && !intro.active) {
            engine.step([readInput(0), cpu ? cpu.bits(engine) : readInput(1)]);
        }
        acc -= FIXED_DT;
        steps++;

        // --- snapshot CURR: the state AFTER this step ----------------------
        for (let i = 0; i < 2; i++) {
            const f = engine.fighters[i];
            _currPos[i].set(f.pos.x, f.pos.y, f.pos.z);
            _currFacing[i] = f.facing;
        }
        for (const pr of engine.projectiles) {
            _projCurr[pr.id] = { x: pr.x, y: pr.y, z: pr.z };
        }
    }

    // Build interpolated viewPose for this frame.
    // alpha: how far we are between the last sim step (at prev) and the next
    // one (at curr). Clamped so hitstop/freeze doesn't overshoot.
    const alpha = Math.min(1, acc / FIXED_DT);
    for (let i = 0; i < 2; i++) {
        const vp = viewPose[i];
        // Teleport guard: if prev and curr are far apart (round transition,
        // wall-break reposition), snap instead of lerping to avoid a one-frame
        // streak across the arena.
        const dx = _currPos[i].x - _prevPos[i].x;
        const dz = _currPos[i].z - _prevPos[i].z;
        const jump = Math.sqrt(dx * dx + dz * dz);
        if (jump > 3) {
            vp.x = _currPos[i].x;
            vp.y = _currPos[i].y;
            vp.z = _currPos[i].z;
        } else {
            vp.x = _prevPos[i].x + (_currPos[i].x - _prevPos[i].x) * alpha;
            vp.y = _prevPos[i].y + (_currPos[i].y - _prevPos[i].y) * alpha;
            vp.z = _prevPos[i].z + (_currPos[i].z - _prevPos[i].z) * alpha;
        }
        // Facing is discrete — no lerp; use current value.
        vp.facing = _currFacing[i];
    }

    handleEvents();
    syncMeshes(simDt);
    syncProjectiles(alpha);
    stage?.update(simDt);
    // camRig reads mesh positions, which syncMeshes just set from viewPose —
    // so the camera automatically sees interpolated positions.
    camRig.update(dt);
    koCam.apply(camera, dt);
    intro.apply(camera, dt);   // overrides the rig while the showdown runs

    // Advance hit sparks with the engine frame counter (not dt) — the shader
    // computes spark age in engine frames so hitstop/slow-mo are honoured.
    hitSparks.update(engine.frame);

    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

    const f0 = engine.fighters[0], f1 = engine.fighters[1];
    overlay.update({
        timer: engine.timer,
        fighters: [f0, f1].map((f) => ({
            slot: f.slot, health: f.health, maxHealth: f.def.maxHealth,
            meter: f.meter, roundsWon: f.roundsWon,
            combo: f.comboCount, comboDamage: f.comboDamage,
        })),
        debug: `${fps} fps · frame ${engine.frame} · ${f0.state}/${f1.state}` +
            (f0.charge ? ` · ⚡${f0.charge}` : '') + (f1.charge ? ` · ⚡${f1.charge}` : '') +
            (f0.move ? ` · ${f0.move.moveName} f${f0.stateFrame}` : ''),
    }, dt);

    fx.render(dt);
}

function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // A tab that boots hidden/backgrounded (or hasn't finished its first
    // layout pass yet) can report 0 here. Applying that locks the renderer
    // and the postfx render targets at 0x0 permanently — nothing else ever
    // re-corrects it unless a genuine 'resize' event fires later, which a
    // visibility change alone doesn't reliably guarantee. Skip the zero
    // size and retry next frame instead of committing to a broken canvas.
    if (w <= 0 || h <= 0) { requestAnimationFrame(resize); return; }
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // FX targets follow the DRAWING BUFFER (device px), not CSS px.
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    fx.resize(db.x, db.y);
}
window.addEventListener('resize', resize);
resize();

// Self-rearming DPR listener: catches monitor moves and browser zoom changes
// after boot. The `once: true` handler re-applies the pixel-ratio cap and
// re-arms itself with the new ratio so a second monitor move is covered too.
function armDPRListener() {
    const mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener('change', () => {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        resize();
        armDPRListener();   // re-arm with the new ratio
    }, { once: true });
}
armDPRListener();

// A neutral establishing camera while the select screen is up.
camera.position.set(0, 3.2, 10.5);
camera.lookAt(0, 1.2, 0);

// The select screen sits in a real district, not a void. Where the visitor is a
// registered resident we open on THEIR gate — same localStorage key the roster
// highlight reads, so the game greets them at home before they pick anyone.
{
    let boot = 'gatehouse';         // Tetsuki's yard: the tutorial home (CH.1)
    try {
        const clan = (localStorage.getItem('yd_clan') || '').toLowerCase();
        const champ = clan && ROSTER.find((k) => CHARACTERS[k].clan.toLowerCase().startsWith(clan));
        if (champ && STAGE_FOR[champ]) boot = STAGE_FOR[champ];
    } catch { /* storage unavailable — fine */ }
    setStage(new URLSearchParams(location.search).get('stage') || boot);
}

// ---------------------------------------------------------------------------
// 3D fighter preview (?vrm=tetsuki) — proves the VRM pipeline in the real arena
// without touching the paper-doll fight path. Rolls out to combat once approved.
// ---------------------------------------------------------------------------
let preview3d = null;
let preview3dHold = false;   // true while a clip demo is being judged
let rosterPreview = null;    // ?roster=1 line-up

async function startVrmPreview(nameParam) {
    document.getElementById('select')?.setAttribute('hidden', '');
    const raw = (nameParam === '1' || nameParam === 'true') ? 'base' : nameParam;
    const url = `./assets/models/${raw}.vrm`;
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;left:0;right:0;top:14px;text-align:center;font:600 15px system-ui;color:#9be8e0;text-shadow:0 1px 4px #000;z-index:50;pointer-events:none';
    note.textContent = `loading ${raw}.vrm …`;
    document.body.appendChild(note);
    try {
        const vrm = await loadVRM(url);
        // Scale the avatar to the roster's ~1.8-unit fighter height.
        const box = new THREE.Box3().setFromObject(vrm.scene);
        const h = (box.max.y - box.min.y) || 1.5;
        vrm.scene.scale.setScalar(1.8 / h);
        vrm.scene.position.set(0, 0, 0);
        scene.add(vrm.scene);
        preview3d = new Fighter3D(vrm);
        // The launch stages are night-dark and swallow him. Add a dedicated
        // character key + soft fill so the preview reads (a per-fighter rig
        // light is the plan for combat too — models need more than stage light).
        const charKey = new THREE.DirectionalLight(0xfff2e6, 1.5);
        charKey.position.set(2.5, 4, 4);
        scene.add(charKey);
        const charFill = new THREE.DirectionalLight(0x9bd0ff, 0.8);
        charFill.position.set(-3, 2, 2);
        scene.add(charFill);
        scene.add(new THREE.AmbientLight(0xffffff, 0.22));
        // Face the camera and stop the turntable when a clip is being demoed —
        // you cannot judge a punch on a spinning model.
        const demo = new URLSearchParams(location.search).get('anim');
        if (demo) { preview3d.object3d.rotation.y = 0.45; preview3d.play(demo, { restart: true }); preview3dHold = true; }
        // A close 3/4 hero angle; the turntable in the loop reveals the depth.
        // Clip demos pull in tighter — a punch you can't read is untestable.
        if (demo) { camera.position.set(1.5, 1.25, 2.1); camera.lookAt(0, 1.05, 0); }
        else { camera.position.set(2.2, 1.4, 3.2); camera.lookAt(0, 1.0, 0); }
        note.textContent = demo
            ? `3D PREVIEW · clip: ${demo.toUpperCase()} — 1-9 to switch, SPACE to replay`
            : '3D PREVIEW · TETSUKI 鉄鬼 — real VRM in the arena';

        // Clip hotkeys so the animations can be flipped through by hand.
        const ORDER = ['idle', 'walk', 'light', 'heavy', 'low', 'special', 'block', 'hurt', 'ko', 'win'];
        window.addEventListener('keydown', (e) => {
            if (!preview3d) return;
            const i = '1234567890'.indexOf(e.key);
            if (i >= 0 && ORDER[i]) { preview3d.play(ORDER[i], { restart: true }); note.textContent = `clip: ${ORDER[i].toUpperCase()}`; }
            if (e.code === 'Space') { e.preventDefault(); preview3d.play(preview3d.current, { restart: true }); }
        });

        // Debug-only offscreen pump (compositor may be paused during QA).
        window.__vrmDbg = { scene, camera, renderer, fx, vrm, get f3d() { return preview3d; },
            play: (n) => preview3d.play(n, { restart: true }),
            pump: (n = 1, spin = 0) => { for (let i = 0; i < n; i++) { preview3d.update(1 / 60); preview3d.object3d.rotation.y += spin; fx.render(1 / 60); } } };
    } catch (e) {
        console.error('[vrm] preview failed', e);
        note.style.color = '#ff8080';
        note.textContent = 'VRM load failed: ' + (e && e.message ? e.message : e);
    }
}

/**
 * `?roster=1` — line the whole cast up in one shot. This is the only way to
 * judge whether eight palettes actually read as eight different fighters, which
 * a one-at-a-time preview cannot tell you.
 */
async function startRosterPreview() {
    document.getElementById('select')?.setAttribute('hidden', '');
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;left:0;right:0;top:14px;text-align:center;font:600 15px system-ui;color:#9be8e0;text-shadow:0 1px 4px #000;z-index:50;pointer-events:none';
    note.textContent = 'loading roster …';
    document.body.appendChild(note);
    scene.add(new THREE.DirectionalLight(0xfff2e6, 1.4).translateY(0));
    const kl = new THREE.DirectionalLight(0xfff2e6, 1.4); kl.position.set(2, 5, 6); scene.add(kl);
    const fl = new THREE.DirectionalLight(0x9bd0ff, 0.7); fl.position.set(-4, 2, 3); scene.add(fl);
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const gap = 1.15, x0 = -((ROSTER.length - 1) * gap) / 2;
    rosterPreview = [];
    for (let i = 0; i < ROSTER.length; i++) {
        const key = ROSTER[i], def = CHARACTERS[key];
        try {
            const vrm = await loadVRM(resolveModelUrl(key, MODELS_AVAILABLE));
            applyFighterLook(vrm, key, def.rimColor);
            applyOutline(vrm);
            const box = new THREE.Box3().setFromObject(vrm.scene);
            const h = (box.max.y - box.min.y) || 1.5;
            vrm.scene.scale.setScalar(FIGHTER_HEIGHT / h);
            applyFighterBuild(vrm, key);   // after normalisation — see build3DFighter
            attachAccessories(vrm, key, def.rimColor);
            vrm.scene.position.set(x0 + i * gap, 0, 0);
            vrm.scene.rotation.y = 0.15;
            scene.add(vrm.scene);
            rosterPreview.push(new Fighter3D(vrm));
            note.textContent = `roster ${i + 1}/${ROSTER.length} — ${key}`;
        } catch (e) { console.warn('[roster]', key, e); }
    }
    camera.position.set(0, 1.6, 7.4);
    camera.lookAt(0, 0.95, 0);
    note.textContent = 'ROSTER — eight fighters, one body, clan palettes';
    window.__rosterDbg = { scene, camera, renderer, fx, list: rosterPreview,
        pump: (n = 1) => { for (let i = 0; i < n; i++) { rosterPreview.forEach((f) => f.update(1 / 60)); fx.render(1 / 60); } } };
}

const _vrmParam = new URLSearchParams(location.search).get('vrm');
const _rosterParam = new URLSearchParams(location.search).has('roster');
if (_rosterParam) startRosterPreview();
else if (_vrmParam) startVrmPreview(_vrmParam);
else showSelect();
requestAnimationFrame(frame);

// exposed for console poking and the headless balance harness. handleEvents
// and the results/flow functions are here so a non-composited tab (frozen
// rAF) can still drive and assert the full match loop.
window.YAMIWARD = {
    get engine() { return engine; }, get camRig() { return camRig; },
    overlay, scene, renderer, camera, MOVES, CHARACTERS, ROSTER, RIVALS,
    get stage() { return stage; }, setStage, stageForMatch, STAGE_FOR,
    startMatch, showSelect, rematch, backToSelect, handleEvents, readInput, showResults,
    CpuBrain, CPU_LEVELS, get cpu() { return cpu; },
    setP2Mode(m) { if (P2_MODES.includes(m)) p2Mode = m; return p2Mode; },
    fx, intro, timeCtl,
    // Manual frame pump: lets a hidden tab (frozen rAF) drive the REAL loop
    // with synthetic timestamps — the only honest way to QA input/intro/sim
    // flow headless. Harmless in normal play; rAF re-registration is a no-op
    // queue entry the browser never fires while hidden.
    pump: frame,
};

// yw-202608121806-9c6acf
