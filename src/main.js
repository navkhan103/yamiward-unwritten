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

// --- lighting: one strong key for readable cel banding, plus cool fill.
// Anime lighting is high-contrast and directional; three soft lights average
// out into mush and destroy the banding the toon ramp exists to produce.
const key = new THREE.DirectionalLight(0xfff0e0, 2.6);
key.position.set(5, 9, 4);
key.castShadow = true;
// Shadow budget. The old 2048 map over a 24x24 box spent most of its texels on
// empty arena: fighters are pushed apart by at most ~7 units and are ~2 tall, so
// a 14x14 box at 1024 gives ~73 texels/unit against the old ~85 — visually a
// wash, at a QUARTER of the fill cost. That matters more now than it did before,
// because doll pieces render a real cutout into the depth pass instead of being
// skipped, so the shadow pass draws 22 planes per frame rather than a handful.
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1;
key.shadow.camera.far = 26;
key.shadow.camera.left = -7; key.shadow.camera.right = 7;
key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
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

function syncProjectiles() {
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
        mesh.position.set(pr.x, pr.y, pr.z);
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
    // Debug/QA handle — read-only inspection for browser-qa; nothing in the
    // game reads this back.
    window.__yw = { meshes, engine, scene, camera };
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

function showSelect() {
    const root = document.getElementById('select');
    const grid = document.getElementById('select-grid');
    if (!root || !grid) { startMatch('tetsuki', 'raiga'); return; }

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
    modeBtn?.addEventListener('click', cycleMode);
    paintMode();

    // NIGHT PARADE entry — reuses the mode button's styling; shows the best
    // run so the score chase starts on the select screen.
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
    // Any key skips the showdown (Space/Enter keep their advance-a-line role
    // via the overlay's own listener). The first playtest read the intro as
    // "the game is frozen" — a mashed punch must always reach the bell.
    if (intro.active && e.code !== 'Space' && e.code !== 'Enter') intro.skip();
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
                break;
            }
            case 'block': camRig.addShake(0.18); break;
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
        g.position.set(f.pos.x, f.pos.y, f.pos.z);

        const ud = g.userData;

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
                setHitFlash(ud.mat, ud.flash * 0.8);
                // Strong hits kick the post chain — this branch was missing it
                // (only the legacy placeholder path had the hook).
                if (ud.flash > 0.5) fx.impact(ud.flash * 0.7);
            }
            continue;
        }

        // face the opponent; +1 faces +x
        g.rotation.y = f.facing === 1 ? 0 : Math.PI;

        // crude state posing until skeletal clips land
        const crouched = f.state === State.CROUCH || f.crouching;
        const targetScale = crouched ? 0.72 : 1;
        ud.torso.scale.y += (targetScale - ud.torso.scale.y) * Math.min(1, dt * 18);
        ud.head.position.y = 1.72 * (crouched ? 0.78 : 1);

        // punch extension during active frames — reads the hitbox visually
        let reach = 0.4;
        if (f.state === State.ATTACKING && f.move) {
            const m = f.move;
            const p = f.stateFrame / Math.max(1, m.startupFrames + m.activeFrames);
            reach = 0.4 + Math.min(1, p) * (m.reach - 0.4);
            ud.fist.position.y = m.hitboxHeight ?? 1.3;
        } else {
            ud.fist.position.y += (1.3 - ud.fist.position.y) * Math.min(1, dt * 12);
        }
        ud.fist.position.x += (reach - ud.fist.position.x) * Math.min(1, dt * 30);

        // impact flash decay
        if (ud.flash > 0) {
            ud.flash = Math.max(0, ud.flash - dt * 6);
            setHitFlash(ud.mat, ud.flash * 0.8);
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
        fx.render(dt);
        acc = 0;
        return;
    }

    // Fixed-step simulation. The cap stops a long stall from spiralling.
    let steps = 0;
    while (acc >= FIXED_DT && steps < 5) {
        if (!overlay.storyActive && !intro.active) {
            engine.step([readInput(0), cpu ? cpu.bits(engine) : readInput(1)]);
        }
        acc -= FIXED_DT;
        steps++;
    }

    handleEvents();
    syncMeshes(simDt);
    syncProjectiles();
    stage?.update(simDt);
    camRig.update(dt);
    koCam.apply(camera, dt);
    intro.apply(camera, dt);   // overrides the rig while the showdown runs

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
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // FX targets follow the DRAWING BUFFER (device px), not CSS px.
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    fx.resize(db.x, db.y);
}
window.addEventListener('resize', resize);
resize();

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

showSelect();
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

// yw-202608092055-319627
