/**
 * YAMIWARD — 3D fighter (VRM) loader + procedural animation
 * ============================================================================
 * The paper-dolls were always the placeholder; this is the real thing. A VRoid
 * VRM is a rigged humanoid (standard bone set), so we load it with the shared
 * three-vrm plugin and drive the humanoid bones ourselves.
 *
 * Animation is PROCEDURAL keyframes (poses over time) rather than Mixamo clips,
 * for two reasons: it needs no external assets or downloads, and it stays fully
 * in our control so the fight engine can drive it frame-exactly. The clip player
 * is authored so a Mixamo/glTF clip can be swapped in per move later without
 * touching the combat bridge.
 *
 * Everything imports the SAME vendored three (via the import map) as the rest of
 * the game — a second three instance is the classic cause of "VRM loads but
 * every class check fails" breakage, so we never bundle our own.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName as B } from '@pixiv/three-vrm';
import { attachAccessories } from './accessories.js';
import { loadClipBundle, ClipPlayer } from './anim.js';

// The baked mocap bundle, fetched once per session. A missing bundle is not an
// error: the hand-authored pose system still runs, so a build without it plays
// exactly as it did before.
let _clipBundle;
export function loadMocap(url = './assets/anim/clips.ywa') {
    if (!_clipBundle) _clipBundle = loadClipBundle(url).catch((e) => {
        console.warn('[anim] no mocap bundle, falling back to poses:', e.message);
        return null;
    });
    return _clipBundle;
}

// ---------------------------------------------------------------------------
// Model bytes cache
// ---------------------------------------------------------------------------
// A match needs TWO fighters from (currently) the same 16MB file. Calling
// loader.loadAsync(url) per fighter downloads it twice — the requests fire in
// parallel, so the browser's HTTP cache does not reliably coalesce them, and on
// a static host that is 32MB across the wire before anyone throws a punch.
//
// So: fetch the bytes ONCE per URL (memoised promise), then parse per fighter.
// Parsing twice is deliberate and required — it is what gives each fighter its
// OWN materials, which is what lets the two of them wear different clan
// palettes. Verified: re-parsing the same ArrayBuffer is safe (it is only ever
// read) and the resulting materials are distinct objects, so a tint applied to
// one fighter cannot leak into the other.
const _bytes = new Map();   // url -> Promise<ArrayBuffer>

function vrmBytes(url) {
    let p = _bytes.get(url);
    if (!p) {
        p = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
            return r.arrayBuffer();
        }).catch((e) => { _bytes.delete(url); throw e; });   // don't cache a failure
        _bytes.set(url, p);
    }
    return p;
}

/**
 * Warm the cache before the model is needed. Called while the player is still
 * on the character-select screen, so the download overlaps the time they spend
 * choosing instead of stalling the match start.
 */
export function prefetchVRM(url) { vrmBytes(url).catch(() => { /* surfaced at load */ }); }

/** Load a .vrm and return the VRM object (has .scene, .humanoid, .update(dt)). */
export async function loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const buf = await vrmBytes(url);
    // parseAsync needs a path for resolving external resources; a VRM is a
    // self-contained GLB, so '' is correct here.
    const gltf = await loader.parseAsync(buf, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('file is not a VRM (no userData.vrm)');

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);   // VRM0 faces -Z; normalise to +Z like VRM1

    vrm.scene.traverse((o) => {
        o.frustumCulled = false;
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return vrm;
}

// ---------------------------------------------------------------------------
// Per-fighter appearance
// ---------------------------------------------------------------------------
// One VRM body, eight fighters. VRoid names its materials by convention
// (`..._SKIN`, `..._HAIR`, `..._CLOTH_01`, `Onepiece`, `Shoes`, `_EYE`, plus a
// matching `(Outline)` for each), which gives a reliable seam to retint without
// authoring eight models. Each palette is built from the character's canon clan
// colour so the roster reads at a glance — the yokai each fighter descends from
// is the design brief.
//
// This is a STAND-IN strategy, not the destination: real per-fighter models
// replace these one at a time, and dropping assets/models/<key>.vrm in is all
// that takes (see resolveModelUrl).

// `cloth2` (VRoid's Onepiece/Tops_02) is the DOMINANT surface on this body — it
// is the bodysuit, and it covers more of a fighter than everything else put
// together. Five of these were authored near-black, which looked correct on a
// single fighter and turned the line-up into eight black shapes on a night
// stage. They are now mid-dark and clan-tinted: still night-ward, but each one
// separates from the backdrop and from its neighbours. Judge this on the
// ?roster=1 line-up, never on one fighter.
const PALETTES = {
    tetsuki:  { skin: 0xc9b6ad, hair: 0x241a1c, cloth1: 0x8e2018, cloth2: 0x5a2f26, shoes: 0x4d3a33, eye: 0xe51e25 }, // oni: ash skin, forge red
    // Yukiwari is the snow fighter, but a near-white palette blew out to a
    // featureless blob once bloom hit it (roster QA). Pulled down into pale
    // blue-greys: still unmistakably "snow", still has readable form.
    yukiwari: { skin: 0xdccfc9, hair: 0xa9c4d4, cloth1: 0x9fc0c6, cloth2: 0x63879a, shoes: 0x546f7e, eye: 0x9be8e0 }, // yukionna
    raiga:    { skin: 0xd9b89a, hair: 0x1c2b4a, cloth1: 0x2a4f8f, cloth2: 0x2b477e, shoes: 0x2e3d63, eye: 0x4a8fe8 }, // raiju: storm blue
    mayoi:    { skin: 0xf0d9c2, hair: 0x3b2a34, cloth1: 0x2f6f63, cloth2: 0x7a2a52, shoes: 0x4a3448, eye: 0x5be0c8 }, // kitsune: jade + fox rose
    shigure:  { skin: 0xe3d6d0, hair: 0x2b2540, cloth1: 0x4a3f78, cloth2: 0x36305c, shoes: 0x39335a, eye: 0x7c6fd4 }, // ameonna: rain violet
    tsukimi:  { skin: 0xf6ecea, hair: 0xe8dcf5, cloth1: 0xbfb0d8, cloth2: 0x6f6390, shoes: 0x4a4266, eye: 0xd8c9f0 }, // tsukiusagi: moon pale
    kazakiri: { skin: 0xdcc3b4, hair: 0x2a1420, cloth1: 0x6e2a5e, cloth2: 0x53294a, shoes: 0x442b3c, eye: 0xa0468c }, // tengu: plum + shadow
    yumihari: { skin: 0xe8c9a0, hair: 0x30240f, cloth1: 0x9c6a1c, cloth2: 0x5c4a24, shoes: 0x463a26, eye: 0xe0a83c }, // ryu: gold scale
};

/** Multiply a hex by a factor, for deriving a shade/outline tone. */
function darken(hex, f) {
    return new THREE.Color(hex).multiplyScalar(f);
}

// The base model's bodysuit (VRoid `Onepiece`) ships a DARK texture, and a
// material tint is a MULTIPLY against that texture — so the palette can only
// ever make it darker. Every fighter's largest surface (7,086 triangles, more
// than everything else combined) was therefore rendering black no matter what
// colour it was assigned, which is most of why the line-up read as eight
// silhouettes rather than eight fighters. Measured, not guessed: the tint was
// set correctly on the material and the pixels were still #000000.
//
// The fix is gain. Each bodysuit tint is scaled so its brightest channel lands
// on the same target, which lifts the dark texture into range and equalises the
// cast at the same time — hue stays the fighter's, brightness stops being an
// accident of which hex someone typed. Applied ONLY to that slot: everything
// else on this body has a light texture and behaves normally.
const CLOTH2_TARGET = 2.0;

function bodysuitTint(hex) {
    const c = new THREE.Color(hex);
    const peak = Math.max(c.r, c.g, c.b) || 1;
    return c.multiplyScalar(CLOTH2_TARGET / peak);
}

/**
 * Retint a loaded VRM to a fighter's palette.
 *
 * MToon carries several colour slots and they must move together or the model
 * looks wrong under stage light: `color` is the lit tone, `shadeColorFactor` is
 * what the shaded side becomes (leaving it white makes a dark outfit glow in
 * shadow), and `outlineColorFactor` is the ink line. `parametricRimColorFactor`
 * gets the clan colour, which is what actually separates eight silhouettes in a
 * dark arena.
 */
/**
 * The half of the look that is RENDER QUALITY rather than identity.
 *
 * Everything in here is about making an MToon material read as a fighter under
 * stage light — it says nothing about who the fighter is, so it applies to an
 * authored per-fighter model exactly as much as to the shared stand-in. Keeping
 * it separate from the palette is what lets a model the user built in VRoid keep
 * its own colours while still getting the game's cel look.
 */
function tuneMToon(m, rimColor) {
    const n = m.name || '';
    const isFace = /_EYE|Eyeline|Brow|Mouth/.test(n);
    // Clan colour as the rim — the cheapest way to tell eight fighters apart at
    // a glance in a night stage, and the single strongest "anime" cue available:
    // a bright edge is what separates a character from the backdrop instead of
    // letting them sink into it.
    if (m.parametricRimColorFactor && !isFace) {
        m.parametricRimColorFactor.copy(rimColor).multiplyScalar(0.16);
        // Tight rim that hugs the silhouette instead of coating the fighter.
        // Tuned down across three passes (0.62/p3.6 -> 0.42/p5.2 -> 0.16/p6.5)
        // because LIMBS ARE CYLINDERS: on an arm or a leg most of the visible
        // surface sits at a grazing angle, so a rim wide enough to look right on
        // a flat chest repaints every limb. Tetsuki was solid gold with only his
        // chest showing clan red. Judge rim width on a limb, never on the torso.
        if ('parametricRimFresnelPowerFactor' in m) m.parametricRimFresnelPowerFactor = 6.5;
        if ('parametricRimLiftFactor' in m) m.parametricRimLiftFactor = 0.0;
        // Read the shader before touching these two, they are coupled:
        //   rim  = parametricRimColor * fresnel  + matcapFactor * matcap
        //   col += mix(1.0, directSpecular, rimLightingMixFactor) * rim
        // So rimLightingMixFactor 1.0 means "modulate by scene light" (which
        // quietly SUPPRESSES the term on a dark stage) and 0.0 means "always
        // full". Setting it to 0 for a predictable edge is right, but it also
        // unleashed the second half of that sum: VRoid ships a MATCAP at full
        // white, and an unmodulated matcap painted Tetsuki head to toe in gold
        // sheen and buried his clan red. The matcap has to be killed for the
        // constant rim to be usable.
        if ('rimLightingMixFactor' in m) m.rimLightingMixFactor = 0.0;
        // Kill VRoid's spherical sheen — it is a portrait-viewer look and it
        // fights a cel-shaded fighter under stage light.
        if (m.matcapFactor) m.matcapFactor.setScalar(0.0);
    }
    // Crisper cel banding. MToon ships a soft ramp, which on a night stage reads
    // as muddy gradient rather than the two-tone anime look the art direction is
    // built on. `toony` hardens the terminator; `shift` widens the lit side so
    // faces do not sit in shadow.
    if (!isFace) {
        if ('shadingToonyFactor' in m) m.shadingToonyFactor = 0.95;
        if ('shadingShiftFactor' in m) m.shadingShiftFactor = -0.05;
        if ('giEqualizationFactor' in m) m.giEqualizationFactor = 0.9;
    }
    m.needsUpdate = true;
}

/** Walk every material on a VRM once. */
function eachMaterial(vrm, fn) {
    vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.name) fn(m);
    });
}

/**
 * Render tuning WITHOUT recolouring — for models that were authored per fighter.
 * Their colours are a deliberate art decision; only the cel/rim setup is ours.
 */
export function applyUniversalLook(vrm, rim) {
    const rimColor = new THREE.Color(rim ?? 0xffffff);
    eachMaterial(vrm, (m) => tuneMToon(m, rimColor));
}

export function applyFighterLook(vrm, key, rim) {
    const p = PALETTES[key];
    if (!p) return;
    const rimColor = new THREE.Color(rim ?? 0xffffff);

    eachMaterial(vrm, (m) => {
        const n = m.name;
        let tint = null, bodysuit = false;
        if (/_SKIN/.test(n)) tint = p.skin;
        else if (/_HAIR/.test(n)) tint = p.hair;
        else if (/Tops_01/.test(n)) tint = p.cloth1;
        else if (/Tops_02|Onepiece/.test(n)) { tint = p.cloth2; bodysuit = true; }
        else if (/Shoes/.test(n)) tint = p.shoes;
        else if (/EyeIris/.test(n)) tint = p.eye;
        if (tint === null) return;   // face lines, eye whites, highlights: leave alone

        const lit = bodysuit ? bodysuitTint(tint) : new THREE.Color(tint);
        if (m.color) m.color.copy(lit);
        // Shade tone must follow the LIT tone (gain included) or the dark side
        // drops straight back to the black we just climbed out of.
        if (m.shadeColorFactor) m.shadeColorFactor.copy(lit).multiplyScalar(0.55);
        // The ink line is drawn flat, with no texture under it, so it takes the
        // authored colour ungained — a gained outline is a grey halo.
        if (m.outlineColorFactor) m.outlineColorFactor.copy(darken(tint, 0.18));
        tuneMToon(m, rimColor);
    });
}

// ---------------------------------------------------------------------------
// Per-fighter BUILD
// ---------------------------------------------------------------------------
// Colour alone cannot carry eight identities — recolouring one body gives you
// eight tinted copies of the same guy, which is exactly what it looks like.
// SILHOUETTE is what actually reads at fighting-game distance, so each fighter
// also gets a skeleton shape.
//
// These scale the RAW bone nodes. The animation system writes ROTATION to the
// NORMALIZED nodes, and three-vrm keeps those hierarchies separate, so build
// and pose never fight each other (verified before relying on it).
//
// Values are per-bone [x, y, z] multipliers. Scaling a bone scales its children,
// so `hips` is overall mass, `chest` is the V-taper, and limb bones are girth.
// LIMB BONES MUST SCALE UNIFORMLY. A bone's children continue down the chain,
// so a non-uniform scale on an arm shears every joint below it — at 1.26x on X
// and Z the arms rendered as flat slabs (close-up QA). Only the torso, which is
// effectively one segment, takes a non-uniform scale. Limbs and head get a
// single number and are expanded below.
const BUILDS = {
    // Oni grappler: the biggest thing in the ward. Heavy chest, thick limbs,
    // small head against a big body (the classic "reads as huge" trick).
    tetsuki:  { hips: [1.12, 1.0, 1.12], chest: [1.24, 1.05, 1.20], upperArm: 1.13, lowerArm: 1.10, upperLeg: 1.10, head: 0.93, neck: 1.12 },
    // Yukionna zoner: tall, narrow, long-limbed. Takes up space without mass.
    yukiwari: { hips: [0.91, 1.0, 0.91], chest: [0.89, 1.02, 0.89], upperArm: 0.93, lowerArm: 0.93, upperLeg: 1.02, head: 1.02, neck: 0.94 },
    // Raiju rushdown: athletic, compact, springy.
    raiga:    { hips: [1.02, 0.98, 1.02], chest: [1.08, 1.0, 1.06], upperArm: 1.04, lowerArm: 1.02, upperLeg: 1.02, head: 0.98, neck: 1.0 },
    // Kitsune trickster: small and light, larger head — reads younger, quicker.
    mayoi:    { hips: [0.90, 0.95, 0.90], chest: [0.88, 0.96, 0.88], upperArm: 0.90, lowerArm: 0.90, upperLeg: 0.94, head: 1.09, neck: 0.90 },
    // Ameonna trickster: tall, thin, drawn-out.
    shigure:  { hips: [0.91, 1.02, 0.91], chest: [0.90, 1.04, 0.90], upperArm: 0.94, lowerArm: 0.95, upperLeg: 1.03, head: 1.03, neck: 0.95 },
    // Tsukiusagi rushdown: smallest of the cast, big head, coiled.
    tsukimi:  { hips: [0.88, 0.93, 0.88], chest: [0.86, 0.95, 0.86], upperArm: 0.88, lowerArm: 0.88, upperLeg: 0.92, head: 1.12, neck: 0.88 },
    // Tengu zoner: long and lean, longest reach in the cast.
    kazakiri: { hips: [0.94, 1.03, 0.94], chest: [0.96, 1.05, 0.94], upperArm: 1.06, lowerArm: 1.07, upperLeg: 1.05, head: 0.97, neck: 0.97 },
    // Ryu rushdown: broad-shouldered, solid, second only to the oni.
    yumihari: { hips: [1.05, 1.0, 1.05], chest: [1.15, 1.02, 1.11], upperArm: 1.08, lowerArm: 1.05, upperLeg: 1.05, head: 0.96, neck: 1.07 },
};

// Bones a build may address, mapped to the humanoid names they touch. Arms and
// legs are symmetric, so one entry drives both sides.
const BUILD_BONES = {
    hips: [B.Hips], chest: [B.Chest], neck: [B.Neck], head: [B.Head],
    upperArm: [B.LeftUpperArm, B.RightUpperArm],
    lowerArm: [B.LeftLowerArm, B.RightLowerArm],
    upperLeg: [B.LeftUpperLeg, B.RightUpperLeg],
    lowerLeg: [B.LeftLowerLeg, B.RightLowerLeg],
};

/** Give a fighter their body shape. Safe to call once, after load. */
export function applyFighterBuild(vrm, key) {
    const build = BUILDS[key];
    if (!build || !vrm.humanoid?.getRawBoneNode) return;
    for (const [slot, scale] of Object.entries(build)) {
        // A number means uniform (limbs, head); an array is torso-only.
        const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
        for (const bone of (BUILD_BONES[slot] || [])) {
            const node = vrm.humanoid.getRawBoneNode(bone);
            if (node) node.scale.set(s[0], s[1], s[2]);
        }
    }
}

/**
 * Ink line weight.
 *
 * VRoid ships outlines at 0.0006 world units, which is invisible past about a
 * metre — fine for a portrait viewer, useless at fighting-game camera distance.
 * A heavier line is most of what separates "3D model" from "anime character".
 */
export function applyOutline(vrm, width = 0.0035) {
    vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if (!m || !/Outline/.test(m.name || '')) continue;
            if ('outlineWidthFactor' in m) m.outlineWidthFactor = width;
            m.needsUpdate = true;
        }
    });
}

// ---------------------------------------------------------------------------
// Model discovery — how an authored model takes over from the stand-in
// ---------------------------------------------------------------------------
// The palette and the build above exist for ONE reason: to fake eight identities
// out of one body. The moment a fighter has a model of their own, both of them
// become damage — recolouring hair the artist chose, and re-proportioning a body
// they deliberately shaped. So a model's presence flips them off.
//
// Discovery is by FILE EXISTENCE, not a list in the source. A hand-maintained
// list means every new model needs a code edit, which is a trap for whoever is
// actually making the art. The rule is simply "the file is there, so it is used".
//
// Two ways to learn that, and both are needed:
//   index.json  — a GENERATED list, written by model-intake --all and by deploy.
//                 One request, no misses in the console.
//   HEAD probes — the fallback when there is no index, i.e. exactly the case the
//                 index cannot cover: a model dropped in without running
//                 anything. Costs one 404 per absent fighter, which is why it is
//                 the fallback and not the default.
//
// Defaults once a model is found:
//   palette     OFF — the model's own colours are the art
//   build       OFF — the model's own proportions are the art
//   accessories ON  — VRoid cannot easily grow horns or fox ears, so the code
//                     keeps providing them. Author them yourself and turn this
//                     off per fighter in models.json.
//   height      preserved RELATIVELY (see dressFighter) — an authored 185cm oni
//                     stays taller than an authored 145cm rabbit.
//
// assets/models/models.json is optional and overrides any flag:
//   { "tetsuki": { "accessories": false }, "mayoi": { "build": true } }

const STANDIN_URL = './assets/models/base.vrm';

/** Everything the dresser needs to know about one fighter's model. */
function standInConfig() {
    return { url: STANDIN_URL, custom: false, palette: true, build: true, accessories: true };
}

let _discovery = null;

/**
 * Resolve every roster key to its model config, once per session.
 *
 * Memoised deliberately: every caller awaits the SAME promise, so a match can
 * never start against a half-finished probe and end up with one fighter dressed
 * by the old rules and the other by the new ones.
 */
export function discoverModels(roster) {
    if (_discovery) return _discovery;

    const probe = async (key) => {
        try {
            const r = await fetch(`./assets/models/${key}.vrm`, { method: 'HEAD' });
            return r.ok ? key : null;
        } catch { return null; }
    };
    const listed = fetch('./assets/models/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (Array.isArray(j?.models) ? j.models : null))
        .catch(() => null)
        // No index, or an index that does not parse: ask the server directly
        // rather than silently pretending nobody has a model.
        .then((list) => list || Promise.all(roster.map(probe)));

    const overrides = fetch('./assets/models/models.json')
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));

    _discovery = Promise.all([listed, overrides]).then(([found, over]) => {
        const map = new Map();
        for (const key of roster) {
            const has = found.includes(key);
            // base.vrm is the SHARED stand-in and must stay generic — it is what
            // the fighters without their own export are wearing. Keeping it
            // separate from tetsuki.vrm is deliberate: a real, oni-specific
            // Tetsuki can drop in without turning the whole roster into Tetsuki.
            const cfg = has
                ? { url: `./assets/models/${key}.vrm`, custom: true, palette: false, build: false, accessories: true }
                : standInConfig();
            map.set(key, Object.assign(cfg, over && over[key]));
        }
        return map;
    });
    return _discovery;
}

/** Config for one fighter, tolerating a missing/incomplete discovery map. */
export function modelConfig(models, key) {
    return (models && models.get(key)) || standInConfig();
}

// An authored model carries its own height, and that height is the point — the
// user sets it in VRoid in centimetres. Normalising every model to one number
// would erase exactly the difference they authored. So a custom model is scaled
// by a SHARED factor derived from this reference instead of per-model: a fighter
// authored at 170cm lands on the game's standard height, and everyone else keeps
// their real ratio to that.
const AUTHORED_REF_H = 1.70;
// ...but a wrong export unit (or a chibi test model) would otherwise put a
// fighter through the roof or below the floor, so the RESULT is clamped. The
// band is wide enough to hold the intended cast (≈145cm rabbit to ≈195cm oni).
const HEIGHT_BAND = [1.42, 2.15];

/**
 * Turn a freshly loaded VRM into a specific fighter.
 *
 * This is the ONLY place the order is written down, because the order is not
 * obvious and has bitten us twice:
 *   1. look BEFORE the first compile, so shaders are built with final colours
 *   2. outline
 *   3. height — measured from the UNTOUCHED mesh. Normalising after the build
 *      makes the bounding box include the build's own scaling, and the
 *      normalisation then cancels exactly the height differences the build
 *      exists to create.
 *   4. build, then accessories (which hang off the built bones and inherit
 *      their scale for free)
 *
 * Returns the accessory roots so they can be disposed with the fighter.
 */
export function dressFighter(vrm, key, { rim, height = 1.8, cfg = null } = {}) {
    const c = cfg || standInConfig();
    if (c.palette) applyFighterLook(vrm, key, rim);
    else applyUniversalLook(vrm, rim);
    applyOutline(vrm);

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const h = (box.max.y - box.min.y) || 1.5;
    if (c.custom) {
        // Preserve what the artist authored, in proportion (see AUTHORED_REF_H).
        const want = Math.min(HEIGHT_BAND[1], Math.max(HEIGHT_BAND[0], h * (height / AUTHORED_REF_H)));
        vrm.scene.scale.setScalar(want / h);
    } else {
        vrm.scene.scale.setScalar(height / h);
    }

    if (c.build) applyFighterBuild(vrm, key);
    return c.accessories ? attachAccessories(vrm, key, rim) : [];
}

// ---------------------------------------------------------------------------
// Pose library
// ---------------------------------------------------------------------------
// A POSE is a partial map { boneName: [x,y,z] } of Euler radians applied to the
// NORMALIZED humanoid bones. Anything not named falls back to REST. Axis signs
// were verified against renders (e.g. lowering an arm needs left z<0, right z>0).

const BONES = [
    B.Spine, B.Chest, B.Neck, B.Head,
    B.LeftShoulder, B.LeftUpperArm, B.LeftLowerArm, B.LeftHand,
    B.RightShoulder, B.RightUpperArm, B.RightLowerArm, B.RightHand,
    B.LeftUpperLeg, B.LeftLowerLeg, B.RightUpperLeg, B.RightLowerLeg,
];

// Neutral rest: arms down at the sides, everything else at bind pose.
const REST = {
    [B.LeftUpperArm]: [0, 0, -1.28], [B.RightUpperArm]: [0, 0, 1.28],
    [B.LeftLowerArm]: [0, 0, -0.12], [B.RightLowerArm]: [0, 0, 0.12],
};

// A bladed fighting guard: weight low, lead shoulder in, fists up.
// Upper-arm z was -0.85/0.80 in the first pass, which left the arms SPLAYED
// out from the body like an A-pose (visible immediately on the roster line-up).
// A real guard keeps the elbows in against the ribs — z near -1.15 — and does
// the work with the forearms.
const GUARD = {
    [B.Spine]: [0.10, 0.20, 0], [B.Chest]: [0.05, 0.12, 0],
    // Solved rather than guessed. Measuring the SHOULDER->ELBOW vector (the
    // shoulder->hand vector lies, because the elbow bend carries the hand
    // forward) gives: z -1.16 = 50 deg drop / 0.186 lateral, -1.5 = 61 / 0.132,
    // -1.7 = 69 deg / 0.092. A boxing guard wants ~70 with the elbows tucked,
    // so -1.7 it is. Two earlier passes at -0.85 and -1.16 both still read as an
    // A-pose on screen.
    [B.LeftUpperArm]: [-0.62, 0.18, -1.70], [B.LeftLowerArm]: [-1.45, -0.25, -0.30],
    [B.RightUpperArm]: [-0.52, -0.18, 1.66], [B.RightLowerArm]: [-1.62, 0.25, 0.30],
    [B.LeftUpperLeg]: [-0.12, 0, 0.10], [B.LeftLowerLeg]: [0.22, 0, 0],
    [B.RightUpperLeg]: [-0.10, 0, -0.12], [B.RightLowerLeg]: [0.26, 0, 0],
    [B.Head]: [0.06, 0.10, 0],
};

const g = (over) => ({ ...GUARD, ...over });   // pose built on top of the guard

// NOTE ON EXAGGERATION: these are deliberately larger than life. A punch tuned
// to look "anatomically correct" reads as a twitch at gameplay camera distance —
// fighting games push the extremes so the SILHOUETTE tells you what happened in
// a single frame. First pass here was naturalistic and was unreadable on a
// contact sheet; every attack now commits the whole body.

// Jab: lead (left) arm fires straight out, shoulder and chest drive behind it.
const JAB_OUT = g({
    [B.Spine]: [0.08, -0.28, 0], [B.Chest]: [0.04, -0.30, 0],
    [B.LeftShoulder]: [0, -0.25, 0],
    [B.LeftUpperArm]: [-1.62, -0.30, -0.10], [B.LeftLowerArm]: [-0.06, 0, -0.02],
    [B.RightUpperArm]: [-0.55, -0.15, 0.95], [B.RightLowerArm]: [-1.7, 0.2, 0.3],
});
// Cross / heavy: rear (right) arm drives through, hips rotate fully over.
const CROSS_WIND = g({
    [B.Spine]: [0.14, 0.62, 0], [B.Chest]: [0.06, 0.40, 0],
    [B.RightShoulder]: [0, 0.30, 0],
    [B.RightUpperArm]: [-0.25, -0.55, 1.15], [B.RightLowerArm]: [-2.0, 0.3, 0.35],
    [B.LeftUpperArm]: [-0.85, 0.25, -0.75],
});
const CROSS_OUT = g({
    [B.Spine]: [0.10, -0.62, 0], [B.Chest]: [0.05, -0.45, 0],
    [B.RightShoulder]: [0, -0.32, 0],
    [B.RightUpperArm]: [-1.68, 0.28, 0.08], [B.RightLowerArm]: [-0.05, 0, 0.02],
    [B.LeftUpperArm]: [-0.35, 0.30, -1.05], [B.LeftLowerArm]: [-1.5, -0.2, -0.25],
    [B.LeftUpperLeg]: [-0.2, 0, 0.12], [B.RightUpperLeg]: [0.12, 0, -0.12],
});
// Low kick: rear leg chambers then whips through at shin height.
const KICK_WIND = g({
    [B.Spine]: [0.16, 0.25, 0],
    [B.RightUpperLeg]: [-0.85, 0, -0.20], [B.RightLowerLeg]: [1.35, 0, 0],
    [B.LeftUpperLeg]: [-0.15, 0, 0.10], [B.LeftLowerLeg]: [0.30, 0, 0],
});
const KICK_OUT = g({
    [B.Spine]: [0.05, -0.35, 0.18], [B.Chest]: [0.02, -0.25, 0.10],
    [B.RightUpperLeg]: [-1.15, 0, -0.35], [B.RightLowerLeg]: [0.12, 0, 0],
    [B.LeftUpperLeg]: [-0.10, 0, 0.12], [B.LeftLowerLeg]: [0.28, 0, 0],
    [B.LeftUpperArm]: [-0.30, 0.2, -1.15], [B.RightUpperArm]: [-0.5, 0, 1.0],
});
// Hurt: flinch back, head snaps, arms break guard.
const HURT = {
    [B.Spine]: [-0.28, 0.05, 0], [B.Chest]: [-0.15, 0, 0], [B.Head]: [-0.30, -0.15, 0.1],
    [B.LeftUpperArm]: [-0.15, 0, -1.05], [B.RightUpperArm]: [-0.15, 0, 1.0],
    [B.LeftLowerArm]: [-0.6, 0, -0.2], [B.RightLowerArm]: [-0.6, 0, 0.2],
    [B.LeftUpperLeg]: [-0.1, 0, 0.08], [B.RightUpperLeg]: [-0.15, 0, -0.1], [B.RightLowerLeg]: [0.3, 0, 0],
};
// Knockdown: collapse backward onto the ground (root drop handled separately).
const FALL = {
    [B.Spine]: [-0.5, 0, 0], [B.Chest]: [-0.35, 0, 0], [B.Head]: [-0.5, 0, 0],
    [B.LeftUpperArm]: [-0.2, 0, -1.4], [B.RightUpperArm]: [-0.2, 0, 1.4],
    [B.LeftUpperLeg]: [-0.6, 0, 0.1], [B.RightUpperLeg]: [-0.5, 0, -0.1],
    [B.LeftLowerLeg]: [0.7, 0, 0], [B.RightLowerLeg]: [0.6, 0, 0],
};
// Win: arms open, chest up.
const WIN = {
    [B.Spine]: [-0.08, 0, 0], [B.Chest]: [-0.06, 0, 0], [B.Head]: [-0.05, 0, 0],
    [B.LeftUpperArm]: [-0.2, 0, -0.7], [B.RightUpperArm]: [-0.2, 0, 0.7],
    [B.LeftLowerArm]: [-0.5, 0, -0.3], [B.RightLowerArm]: [-0.5, 0, 0.3],
};

// ---------------------------------------------------------------------------
// Mocap mapping
// ---------------------------------------------------------------------------
// The combat bridge speaks in ABSTRACT state names (idle/walk/light/hurt/...).
// This is the only place those meet real clip names, so re-casting a move is a
// one-line edit here rather than a change to the engine or the bridge.
//
// `trim` is the important field. A mocap take is authored as a complete
// performance: settle into stance, execute, return to stance. A fighting game
// move is only the middle part — the engine's startup/active/recovery already
// own the entry and exit. Playing the whole take inside the engine's frame
// budget is what makes retimed mocap read as a twitch, so attacks are trimmed
// to the window where the strike actually happens.
const MOCAP = {
    idle:    { clip: 'Fighting Idle' },
    walk:    { clip: 'Long Step Forward', rate: 1.15 },
    crouch:  { clip: 'esquiva 1', loop: true, rate: 0.6 },
    block:   { clip: 'Boxing' },
    light:   { clip: 'Jab Cross', loop: false, trim: [0.10, 0.55] },
    heavy:   { clip: 'Cross Punch', loop: false, trim: [0.12, 0.62] },
    low:     { clip: 'rasteira 1', loop: false, trim: [0.15, 0.70] },
    special: { clip: 'Mma Kick', loop: false, trim: [0.10, 0.65] },
    hurt:    { clip: 'Hit Reaction', loop: false, fade: 0.05, trim: [0.05, 0.50] },
    ko:      { clip: 'Knocked Out', loop: false, fade: 0.04 },
    win:     { clip: 'Victory', loop: false },
};

// Fingers are excluded from the bake (see tools/retarget.html). A curled fist,
// set once at attach time, is all a fighter ever needs — and it is what stops
// the hands reading as open-palmed slaps.
const FIST = {
    [B.LeftIndexProximal]: [0, 0, -1.1], [B.LeftIndexIntermediate]: [0, 0, -1.3],
    [B.LeftMiddleProximal]: [0, 0, -1.1], [B.LeftMiddleIntermediate]: [0, 0, -1.35],
    [B.LeftRingProximal]: [0, 0, -1.1], [B.LeftRingIntermediate]: [0, 0, -1.3],
    [B.LeftLittleProximal]: [0, 0, -1.05], [B.LeftLittleIntermediate]: [0, 0, -1.2],
    [B.LeftThumbProximal]: [0, 0, -0.35], [B.LeftThumbDistal]: [0, 0, -0.4],
    [B.RightIndexProximal]: [0, 0, 1.1], [B.RightIndexIntermediate]: [0, 0, 1.3],
    [B.RightMiddleProximal]: [0, 0, 1.1], [B.RightMiddleIntermediate]: [0, 0, 1.35],
    [B.RightRingProximal]: [0, 0, 1.1], [B.RightRingIntermediate]: [0, 0, 1.3],
    [B.RightLittleProximal]: [0, 0, 1.05], [B.RightLittleIntermediate]: [0, 0, 1.2],
    [B.RightThumbProximal]: [0, 0, 0.35], [B.RightThumbDistal]: [0, 0, 0.4],
};

// A CLIP is { loop, dur (s), keys:[{t:0..1, pose}] }. One-shots end on the last
// key and the state machine returns to idle; loops wrap.
const CLIPS = {
    idle:  { loop: true, dur: 2.4, keys: [{ t: 0, pose: GUARD }, { t: 1, pose: GUARD }] },
    walk:  { loop: true, dur: 0.7, keys: [
        { t: 0.0, pose: g({ [B.LeftUpperLeg]: [-0.35, 0, 0.1], [B.RightUpperLeg]: [0.2, 0, -0.1], [B.LeftLowerLeg]: [0.3, 0, 0] }) },
        { t: 0.5, pose: g({ [B.LeftUpperLeg]: [0.2, 0, 0.1], [B.RightUpperLeg]: [-0.35, 0, -0.1], [B.RightLowerLeg]: [0.3, 0, 0] }) },
        { t: 1.0, pose: g({ [B.LeftUpperLeg]: [-0.35, 0, 0.1], [B.RightUpperLeg]: [0.2, 0, -0.1], [B.LeftLowerLeg]: [0.3, 0, 0] }) },
    ] },
    crouch:{ loop: true, dur: 1, keys: [{ t: 0, pose: g({ [B.LeftUpperLeg]: [-0.6, 0, 0.12], [B.RightUpperLeg]: [-0.6, 0, -0.12], [B.LeftLowerLeg]: [0.9, 0, 0], [B.RightLowerLeg]: [0.9, 0, 0], [B.Spine]: [0.25, 0.1, 0] }) }] },
    light: { loop: false, dur: 0.34, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.28, pose: JAB_OUT }, { t: 0.5, pose: JAB_OUT }, { t: 1.0, pose: GUARD } ] },
    heavy: { loop: false, dur: 0.6, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.35, pose: CROSS_WIND }, { t: 0.55, pose: CROSS_OUT }, { t: 0.7, pose: CROSS_OUT }, { t: 1.0, pose: GUARD } ] },
    low:   { loop: false, dur: 0.5, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.35, pose: KICK_WIND }, { t: 0.55, pose: KICK_OUT }, { t: 0.7, pose: KICK_OUT }, { t: 1.0, pose: GUARD } ] },
    special:{ loop: false, dur: 0.55, keys: [
        { t: 0.0, pose: GUARD }, { t: 0.3, pose: CROSS_WIND }, { t: 0.5, pose: CROSS_OUT }, { t: 1.0, pose: GUARD } ] },
    hurt:  { loop: false, dur: 0.4, keys: [{ t: 0, pose: HURT }, { t: 0.4, pose: HURT }, { t: 1, pose: GUARD }] },
    block: { loop: true, dur: 1, keys: [{ t: 0, pose: g({ [B.LeftUpperArm]: [-0.9, 0.2, -0.7], [B.LeftLowerArm]: [-1.7, -0.2, -0.2], [B.RightUpperArm]: [-0.9, -0.2, 0.7], [B.RightLowerArm]: [-1.8, 0.2, 0.2], [B.Spine]: [0.14, 0.12, 0] }) }] },
    ko:    { loop: false, dur: 0.7, keys: [{ t: 0, pose: HURT }, { t: 1, pose: FALL }] },
    win:   { loop: true, dur: 2, keys: [{ t: 0, pose: WIN }, { t: 1, pose: WIN }] },
};

function lerpPose(a, b, u, out) {
    for (const bone of BONES) {
        const pa = a[bone] || REST[bone] || ZERO;
        const pb = b[bone] || REST[bone] || ZERO;
        out[bone] = [
            pa[0] + (pb[0] - pa[0]) * u,
            pa[1] + (pb[1] - pa[1]) * u,
            pa[2] + (pb[2] - pa[2]) * u,
        ];
    }
    return out;
}
const ZERO = [0, 0, 0];

// Expressions the fighter drives. Everything here is eased toward its target
// every frame, so any one of them can be the active reaction without leaving a
// previous one stuck on.
const FACE_SET = ['angry', 'sad', 'happy', 'surprised', 'neutral'];

/**
 * Controller wrapping a loaded VRM. Plays procedural clips, blends between them,
 * and exposes setState() for the combat bridge to call each frame.
 */
export class Fighter3D {
    constructor(vrm) {
        this.vrm = vrm;
        this.root = vrm.scene;
        this._node = {};
        for (const b of BONES) this._node[b] = vrm.humanoid?.getNormalizedBoneNode(b) || null;

        this._clip = CLIPS.idle;
        this._name = 'idle';
        this._t = 0;             // seconds into the current clip
        this._blend = 0;         // 0..1 crossfade progress into the new clip
        this._blendDur = 0.12;
        this._from = {};         // frozen applied pose at the last switch
        this._cur = {};          // scratch sampled pose
        this._breath = 0;
        this._blinkT = 1.4;      // seconds until the next blink
        this._blinkPhase = 0;    // seconds remaining in the current blink
        this._applied = {};      // last applied euler per bone (blend source)
        for (const b of BONES) this._applied[b] = (GUARD[b] || REST[b] || ZERO).slice();
    }

    get object3d() { return this.root; }
    setPosition(x, y, z) { this.root.position.set(x, y, z); }
    setYaw(y) { this.root.rotation.y = y; }
    setScale(s) { this.root.scale.setScalar(s); }

    /** The head bone in world space — what an opponent's eyes should track. */
    get headNode() {
        return this.vrm.humanoid?.getRawBoneNode?.(B.Head) || null;
    }

    /**
     * Point this fighter's eyes at something.
     *
     * VRMLookAt was already loaded and already being ticked by `vrm.update(dt)`
     * — it just never had a target, so both fighters stared straight ahead for
     * every frame of every match. Two people in a fight watch each other; eyes
     * that don't track are the single loudest "this is a puppet" signal a 3D
     * character can send, and fixing it costs one assignment.
     *
     * The applier clamps to the VRM's authored look range, so an opponent who
     * ends up behind or underneath cannot roll the eyes into the skull.
     */
    lookAtTarget(obj) {
        if (this.vrm.lookAt) this.vrm.lookAt.target = obj || null;
    }

    /**
     * Attach a baked mocap bundle. From this point the hand-authored poses are
     * dead weight kept only as the fallback for a build with no bundle.
     * `variant` lets one fighter's jab be a different take from another's —
     * per-fighter identity for zero extra bytes, since the clips are shared.
     */
    attachClips(bundle, variant = null) {
        this.clips = new ClipPlayer(this.vrm, bundle);
        this._mocap = variant ? { ...MOCAP, ...variant } : MOCAP;
        // Fists. Fingers are not in the bundle (they are 58% of the payload and
        // a fighter never opens their hands), so they are posed once, here.
        for (const [bone, rot] of Object.entries(FIST)) {
            const n = this.vrm.humanoid?.getNormalizedBoneNode(bone);
            if (n) n.rotation.set(rot[0], rot[1], rot[2]);
        }
        this.play('idle', { restart: true });
    }

    /** Switch to a named clip. One-shots restart on request; loops don't re-trigger. */
    play(name, { restart = false } = {}) {
        if (this.clips) {
            const m = this._mocap[name];
            if (!m) return;
            this.clips.play(m.clip, { loop: m.loop !== false, fade: m.fade ?? 0.12, rate: m.rate ?? 1, restart });
            this._name = name;
            return;
        }
        if (!CLIPS[name]) return;
        if (name === this._name && !restart) return;
        // Freeze whatever is currently applied as the crossfade source.
        for (const b of BONES) this._from[b] = this._applied[b].slice();
        this._clip = CLIPS[name];
        this._name = name;
        this._t = 0;
        this._blend = 0;
    }

    /**
     * Play a clip at an EXPLICIT normalized time instead of on the wall clock.
     * The combat bridge uses this so an attack's visual progress is locked to
     * the engine's startup/active/recovery frames — the fist and the hitbox
     * must arrive on the same frame.
     * @param {string} name
     * @param {number} u 0..1 through the clip
     */
    scrub(name, u) {
        if (this.clips) {
            const m = this._mocap[name];
            if (!m) return;
            // The engine's frame data drives clip time directly. `trim` maps the
            // move onto the USEFUL part of a mocap take — a Mixamo punch spends
            // its first third settling into stance and its last third returning,
            // and playing all of that inside 20 engine frames is why the naive
            // version looked like a twitch.
            const a = m.trim ? m.trim[0] : 0, b = m.trim ? m.trim[1] : 1;
            this.clips.scrub(m.clip, a + (b - a) * THREE.MathUtils.clamp(u, 0, 1));
            this._name = name;
            this._scrubbed = true;
            return;
        }
        if (!CLIPS[name]) return;
        if (name !== this._name) {
            for (const b of BONES) this._from[b] = this._applied[b].slice();
            this._clip = CLIPS[name];
            this._name = name;
            this._blend = 0;
        }
        this._t = THREE.MathUtils.clamp(u, 0, 1) * this._clip.dur;
        this._scrubbed = true;
    }

    /** True once a one-shot clip has finished (state machine returns to idle). */
    get done() { return !this._clip.loop && this._t >= this._clip.dur; }
    get current() { return this._name; }

    _sample(out) {
        const keys = this._clip.keys;
        const u = this._clip.loop ? (this._t % this._clip.dur) / this._clip.dur
            : Math.min(1, this._t / this._clip.dur);
        let k0 = keys[0], k1 = keys[keys.length - 1];
        for (let i = 0; i < keys.length - 1; i++) {
            if (u >= keys[i].t && u <= keys[i + 1].t) { k0 = keys[i]; k1 = keys[i + 1]; break; }
        }
        const span = (k1.t - k0.t) || 1;
        const lu = THREE.MathUtils.clamp((u - k0.t) / span, 0, 1);
        // smootherstep for weight
        const s = lu * lu * lu * (lu * (lu * 6 - 15) + 10);
        return lerpPose(k0.pose, k1.pose, s, out);
    }

    update(dt) {
        // MOCAP PATH. When the baked bundle is attached it owns every bone, and
        // the hand-authored pose system below is not run at all. Mixing them per
        // frame was the obvious design and the wrong one: both write the same
        // normalised bones, so the loser's crossfade source goes stale and every
        // transition between the two systems pops.
        if (this.clips) {
            if (this._scrubbed) this._scrubbed = false;
            else this.clips.update(dt);
            this._face(dt);
            this.vrm.update(dt);
            return;
        }

        // A scrubbed frame already set _t from engine frame data — advancing it
        // again here would double-speed the attack.
        if (this._scrubbed) this._scrubbed = false;
        else this._t += dt;
        this._breath += dt;
        if (this._blend < 1) this._blend = Math.min(1, this._blend + dt / this._blendDur);

        const sampled = this._sample(this._cur);
        const bw = this._blend;
        // Idle/guard breathing so a held pose isn't a mannequin.
        const breath = Math.sin(this._breath * 1.7) * 0.02;

        for (const bone of BONES) {
            const node = this._node[bone];
            if (!node) continue;
            const s = sampled[bone];
            const f = this._from[bone] || s;
            let x = f[0] + (s[0] - f[0]) * bw;
            let y = f[1] + (s[1] - f[1]) * bw;
            let z = f[2] + (s[2] - f[2]) * bw;
            if (bone === B.Spine) x += breath;
            this._applied[bone] = [x, y, z];
            node.rotation.set(x, y, z);
        }

        this._face(dt);
        this.vrm.update(dt);   // spring bones (hair/cloth) + look-at
    }

    /**
     * Faces. A VRM ships standard expressions (happy/angry/sad/surprised/blink)
     * and leaving them at neutral is most of why a rigged model still reads as
     * a mannequin — the body fights but the face never reacts. Expression is
     * derived from the CLIP rather than plumbed separately, so every route into
     * a state (player input, CPU, replay) drives the face for free.
     *
     * Weights are eased rather than set, because snapping an expression on and
     * off is worse than having none.
     */
    _face(dt) {
        const em = this.vrm.expressionManager;
        if (!em) return;

        let want = 'neutral', amount = 0;
        switch (this._name) {
            case 'light': case 'heavy': case 'low': case 'special':
                want = 'angry'; amount = 0.85; break;
            case 'hurt':
                want = 'sad'; amount = 1.0; break;
            case 'ko':
                want = 'sad'; amount = 1.0; break;
            case 'block':
                want = 'angry'; amount = 0.45; break;
            case 'win':
                want = 'happy'; amount = 0.9; break;
            default:
                want = 'neutral'; amount = 0; break;
        }

        // Ease every non-target expression down, and the target up.
        for (const name of FACE_SET) {
            const cur = em.getValue(name) ?? 0;
            const target = (name === want) ? amount : 0;
            const k = target > cur ? 14 : 8;    // snap into a reaction, relax out of it
            em.setValue(name, cur + (target - cur) * Math.min(1, dt * k));
        }

        // Blink only while composed — blinking through a hit looks broken.
        this._blinkT -= dt;
        if (this._blinkT <= 0) {
            this._blinkPhase = 0.16;                  // seconds of closed eye
            this._blinkT = 2.6 + (this._t % 1.7);     // deterministic-ish spacing, no RNG
        }
        const calm = (want === 'neutral' || want === 'happy');
        this._blinkPhase = Math.max(0, this._blinkPhase - dt);
        const blink = calm && this._blinkPhase > 0 ? Math.sin((this._blinkPhase / 0.16) * Math.PI) : 0;
        em.setValue('blink', blink);
    }

    dispose() { VRMUtils.deepDispose(this.root); }
}

/**
 * Combat bridge: drive a Fighter3D from an engine fighter, every frame.
 *
 * The critical rule is that ATTACK animation time is slaved to the engine's own
 * frame data (startup / active / recovery), NOT to the clip's authored duration.
 * If the clip ran on its own clock, the fist would arrive on a different frame
 * than the hitbox — the exact desync that makes a fighting game feel wrong. So
 * for attacks we compute normalized progress from f.stateFrame and scrub the
 * clip to it; everything else plays on wall-clock.
 *
 * @param {Fighter3D} f3d
 * @param {object} f      engine fighter (state, stateFrame, move, crouching…)
 * @param {object} State  the engine's State enum
 */
export function driveFromEngine(f3d, f, State) {
    const st = f.state;

    if (st === State.ATTACKING && f.move) {
        const m = f.move;
        const total = (m.startupFrames ?? 6) + (m.activeFrames ?? 2) + (m.recoveryFrames ?? 8);
        const u = THREE.MathUtils.clamp(f.stateFrame / Math.max(1, total), 0, 1);
        // Resolve the move's SLOT from the character's own moveset rather than
        // parsing its name — moveName is flavour text ("Sleeve Flick", "Nine
        // Panels") and matching on it silently fell through to `heavy` for every
        // attack. f.moveKey + def.moveset is the authoritative mapping.
        let clip = 'heavy';
        const ms = f.def?.moveset;
        if (ms && f.moveKey) {
            const slot = Object.keys(ms).find((k) => ms[k] === f.moveKey);
            if (slot === 'light') clip = 'light';
            else if (slot === 'low') clip = 'low';
            else if (slot === 'special') clip = 'special';
            else if (slot === 'grab') clip = 'heavy';
            else if (slot === 'super') clip = 'special';
        }
        // Height is the backstop: anything that must be blocked low should read
        // as a leg attack even if a character names its slots unusually.
        if (m.height === 'LOW') clip = 'low';
        f3d.scrub(clip, u);
        return;
    }

    switch (st) {
        case State.HITSTUN:
        case State.JUGGLED:   f3d.play('hurt'); break;
        case State.KNOCKDOWN: f3d.play('ko'); break;
        case State.BLOCKING:  f3d.play('block'); break;
        case State.WIN:       f3d.play('win'); break;
        case State.LOSE:      f3d.play('ko'); break;
        case State.CROUCH:    f3d.play('crouch'); break;
        case State.MOVING:
        case State.SIDESTEP:  f3d.play('walk'); break;
        default:              f3d.play(f.crouching ? 'crouch' : 'idle'); break;
    }
}

/** Legacy single-pose helper kept for the bare preview. */
export function poseIdle(vrm) {
    const set = (b, x, y, z) => { const n = vrm.humanoid?.getNormalizedBoneNode(b); if (n) n.rotation.set(x, y, z); };
    for (const b of Object.keys(GUARD)) { const e = GUARD[b]; set(b, e[0], e[1], e[2]); }
}
