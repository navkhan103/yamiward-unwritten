/**
 * YAMIWARD — STORY MODE director
 * ============================================================================
 * Walks the shipped VN graph in `src/story-data.js` and hands main.js one beat
 * at a time. It is deliberately shaped like `ladder.js` — `active`, `current`,
 * `reportMatch()` — because showResults() already knows how to intercept a run
 * in progress and chain into the next bout, and a second, different pattern for
 * the same job would be one more thing to keep in your head.
 *
 * WHAT THE GRAPH LOOKS LIKE. Each chapter is `{ title, route, open, fight?,
 * mid?, fight2?, close }` and plays open → fight → mid → fight2 → close. `mid`
 * and `fight2` are optional and most chapters have neither. So a chapter
 * flattens to an alternating list of LINES and FIGHT beats, and the director is
 * really just a cursor over that list.
 *
 * ROUTES ARE THE FOUR LAUNCH CHAMPIONS AND NOTHING ELSE. Canon: four walked
 * through the gates. Shigure, Tsukimi, Kazakiri and Yumihari are in ROSTER as
 * playable fighters, but they were Eclipsed for the whole main story and cannot
 * have a route through it — their content is the RESCUE chapters, which are
 * route-agnostic and unlock separately. Picking one of them for Story Mode is a
 * category error rather than missing content, and `begin()` says so.
 *
 * THE FIGHT KEYS ARE THE HONEST PART. The bundled acts reference 27 distinct
 * fights and the game currently has eight fighters. Every key below therefore
 * resolves to a real ROSTER member, and where that member is not literally the
 * character in the fiction it is marked STAND-IN with what it is standing in
 * for. A stand-in is a scheduling fact, not a canon claim: repoint it when the
 * real fighter ships and change nothing else.
 *
 * The cast covers the MAIN STORY only. Rescue-chapter keys are deliberately
 * absent — those acts are not bundled, and naming their champions here would put
 * eight unreleased characters into a file that ships. Add each one alongside the
 * fighter it belongs to, when that fighter is public.
 *
 * WHAT IS NOT HERE, ON PURPOSE. No choice UI. The main story branches by
 * CHARACTER SELECT — the route is the choice — and the only in-story fork is
 * the epilogue's two endings, which is wired as `alternate` and needs a
 * two-button prompt that does not exist in overlay.js yet. Building a general
 * choice system for one binary fork would be the wrong order of work; it is
 * listed in the handoff instead.
 */

// GENERATED bundle, not the authored source. `story/` is private and is never
// on the deploy allowlist: importing it directly made a dev build work and a
// deployed one 404, and putting it on the allowlist to fix that would ship the
// canon checks, the QC output and chapter headers that spell out every ending.
// `tools/build-story.mjs` writes this file; `tools/verify-story.mjs` fails if it
// is stale.
import { PROLOGUE, CHAPTER_1, CHAPTER_2, CHAPTER_3, CHAPTER_4, CHAPTER_5, CHAPTER_6, EPILOGUE } from './story-data.js';

const SAVE_KEY = 'yamiward.story.v1';

/** The four that walked through the gates. Story Mode is these and only these. */
export const STORY_ROUTES = ['yukiwari', 'tetsuki', 'mayoi', 'raiga'];

/** Chapters in play order. Prologue and epilogue bracket the six. */
const ACTS = [
    { key: 'prologue', graph: PROLOGUE },
    { key: 'ch1', graph: CHAPTER_1 },
    { key: 'ch2', graph: CHAPTER_2 },
    { key: 'ch3', graph: CHAPTER_3 },
    { key: 'ch4', graph: CHAPTER_4 },
    { key: 'ch5', graph: CHAPTER_5 },
    { key: 'ch6', graph: CHAPTER_6 },
    { key: 'epilogue', graph: EPILOGUE },
];

/**
 * fight key -> the ROSTER fighter who actually stands there.
 *
 * `null` on the right of a STAND-IN comment means "this character does not exist
 * as a fighter yet"; the left is who is filling in. Mirror fights resolve to the
 * player at call time, which is why they are a function.
 */
const FIGHT_CAST = {
    // -- real, one-to-one -----------------------------------------------
    'rival/tetsuki': 'tetsuki',
    'rival/raiga': 'raiga',
    'semifinal/tetsuki': 'tetsuki',
    'semifinal/raiga': 'raiga',
    'semifinal/mayoi': 'mayoi',
    'semifinal/yukiwari': 'yukiwari',
    'eclipsed/shigure': 'shigure',
    'eclipsed/tsukimi': 'tsukimi',
    'eclipsed/kazakiri': 'kazakiri',
    'eclipsed/yumihari': 'yumihari',

    // -- STAND-IN: the prologue trial ------------------------------------
    // The Registry testing a new resident. It wants a bespoke construct rather
    // than a champion; until it has one, a zoner stands in because a zoner is
    // the most legible thing to put in front of somebody's first ever match —
    // it keeps distance and telegraphs, which teaches spacing instead of
    // punishing it.
    'trial/selection': 'yukiwari',    // STAND-IN — Registry selection trial

    // -- STAND-IN: leftovers, wardens, architects, the Moonless ----------
    // A shadow is residue in the shape of a champion's habits, so the champion
    // of that clan is the correct body to borrow. Where the clan has no fighter,
    // the Form is matched instead.
    'shadow/stair': 'yukiwari',       // STAND-IN — Yukionna leftover, CH.2 Yukiwari route
    'shadow/street': 'yukiwari',      // STAND-IN — the empty-street whisper
    'shadow/hitodama': 'shigure',     // STAND-IN — the seventh gate's leftover (zoner)
    'shadow/tsukiusagi': 'tsukimi',   // STAND-IN — Tsukimi's leftover
    'shadow/shrine': 'mayoi',         // STAND-IN — Kitsune shrine leftover
    'shadow/crowd': 'raiga',          // STAND-IN — Raiju crowd leftover
    'warden/yukionna': 'yukiwari',
    'warden/oni': 'tetsuki',
    'warden/kitsune': 'mayoi',
    'warden/raiju': 'raiga',
    'architect/iwane': 'tetsuki',     // STAND-IN — Office of the Mountain, immovable
    'architect/tsukuyo': 'tsukimi',   // STAND-IN — Office of the Moon
    'architect/kagami': 'mayoi',      // STAND-IN — Office of the Mirror
    'architect/hirume': 'raiga',      // STAND-IN — Office of the Sun
    'moonless/phase1': 'kazakiri',    // STAND-IN — challenger phase 1: mimicry. Tengu reads and returns your kit
    'moonless/phase2': 'raiga',       // STAND-IN — challenger phase 2, the aggressive one
};

/** Mirror fights are you, against you. CH.4 is the only chapter that does this. */
const isMirror = (key) => key.startsWith('mirror/');

/**
 * CPU level by act index. The story is a difficulty curve, not a flat ladder:
 * the prologue should not filter anybody out and CH.6 should be the wall.
 * Values are the same strings ladder.js hands to CpuBrain.
 */
// These MUST be keys of CPU_LEVELS in cpu.js. CpuBrain silently falls back to
// 'medium' on an unknown string, so a typo here is a flat difficulty curve that
// nothing reports — which is exactly what the first draft of this line shipped.
const CPU_BY_ACT = ['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard'];

/**
 * Flatten one chapter's route section into an alternating beat list.
 * Reads SHAPE rather than assuming it, so a chapter that grows a `mid` later
 * needs no change here — the same reason tools/reading-copy.mjs does it this way.
 */
function beatsOf(section) {
    const out = [];
    const push = (lines) => { if (lines && lines.length) out.push({ kind: 'lines', lines }); };
    push(section.open);
    if (section.fight) out.push({ kind: 'fight', fight: section.fight });
    push(section.mid);
    if (section.fight2) out.push({ kind: 'fight', fight: section.fight2 });
    push(section.close);
    return out;
}

/**
 * Pull the player's section out of an act.
 *
 * Two shapes exist and both have bitten once, so they are both handled
 * explicitly rather than by duck-typing:
 *
 *   1. The PROLOGUE is a section ITSELF — `{title, route:null, open, fight,
 *      close}` — not a map of sections. It is shared by every route.
 *   2. Every other act is a map keyed by CLAN (`yukionna`, `oni`, `kitsune`,
 *      `raiju`), and the champion is in the section's `route` field in UPPER
 *      CASE. So the lookup is by route field, never by key: `graph['yukiwari']`
 *      is always undefined and looking it up silently returned the epilogue's
 *      route-null `alternate` ending to all four routes.
 *
 * The epilogue's `alternate` is the unwrite ending and is deliberately NOT
 * reachable here — see the header note on the fork not being wired yet.
 */
function sectionFor(graph, route) {
    if (!graph) return null;
    if (graph.open) return graph;                       // shape 1: the act IS the section
    const want = route.toUpperCase();
    return Object.values(graph).find((v) => v && v.open && v.route === want) || null;
}

export function createStoryMode(roster) {
    let active = false;
    let route = null;
    let beats = [];          // flattened across all acts
    let cursor = 0;          // index into beats
    let lineCursor = 0;      // index within the current lines beat (save-anywhere)
    let current = null;      // the pending fight, ladder-style

    function build(r) {
        const list = [];
        ACTS.forEach((act, actIdx) => {
            const sec = sectionFor(act.graph, r);
            if (!sec) return;
            for (const b of beatsOf(sec)) {
                list.push({ ...b, act: act.key, actIdx, title: sec.title || act.key });
            }
        });
        return list;
    }

    // Is there authored story data in THIS build? Derived from the data rather
    // than declared, so it needs no maintenance: a build that ships the real
    // script reports true, a build whose story-data.js was stubbed out at deploy
    // time reports false, and neither has to remember to flip a constant.
    //
    // Exists because Story Mode can be cut from a release while the code that
    // runs it still ships (the reveal gate in release-check.mjs may hold the
    // script back long after the feature is finished). Callers use this to hide
    // the entry point instead of offering a button that opens nothing.
    let _available = null;

    const api = {
        get active() { return active; },
        get current() { return current; },
        get route() { return route; },

        /** True when at least one route can actually be played. Computed once. */
        get available() {
            if (_available === null) _available = STORY_ROUTES.some((r) => build(r).length > 0);
            return _available;
        },

        /** Progress for a menu: which act, and how far through the whole run. */
        get progress() {
            const b = beats[cursor];
            return {
                act: b?.act ?? 'done',
                title: b?.title ?? '',
                index: cursor,
                total: beats.length,
                percent: beats.length ? Math.round((cursor / beats.length) * 100) : 0,
            };
        },

        /**
         * @returns {{ok:true}|{ok:false, reason:string}} — a refusal is explained,
         * because "pick one of the four" is a real answer and a silent no is not.
         */
        begin(playerKey) {
            if (!STORY_ROUTES.includes(playerKey)) {
                return {
                    ok: false,
                    reason: `${playerKey.toUpperCase()} has no Story Mode route. Four champions walked through the gates — ` +
                        `${STORY_ROUTES.map((k) => k.toUpperCase()).join(', ')}. ` +
                        `The others were Eclipsed for the whole of it; their chapters are the Rescues.`,
                };
            }
            active = true;
            route = playerKey;
            beats = build(playerKey);
            cursor = 0;
            lineCursor = 0;
            current = null;
            return { ok: true };
        },

        abort() { active = false; current = null; },

        /**
         * The pump. Returns the next thing for main.js to do, and does NOT
         * advance past a fight — a fight beat stays current until reportMatch()
         * settles it, so a loss can retry the same fight rather than skipping
         * the chapter it belonged to.
         */
        next() {
            if (!active) return { kind: 'idle' };
            const beat = beats[cursor];
            if (!beat) { active = false; return { kind: 'end', route }; }

            if (beat.kind === 'lines') {
                return {
                    kind: 'lines',
                    lines: beat.lines,
                    startAt: lineCursor,
                    title: beat.title,
                    act: beat.act,
                    onLine: (i) => { lineCursor = i; api.save(); },
                };
            }

            const opponentKey = isMirror(beat.fight) ? route : FIGHT_CAST[beat.fight];
            if (!opponentKey || !roster.includes(opponentKey)) {
                // Fail loud. A missing mapping silently skipping a fight would
                // desync the story from the fight count and be very hard to see.
                console.error(`[storyMode] no cast for fight key "${beat.fight}" — skipping.`);
                cursor += 1; lineCursor = 0;
                return api.next();
            }
            // An Eclipsed leftover is not a difficulty — it is a different brain
            // (src/eclipsedBrain.js), so the mode string changes rather than the
            // level. Difficulty means nothing to a thing with no agency.
            const leftover = beat.fight.startsWith('eclipsed/');
            // The final encounter is its own brain again (src/moonlessBrain.js) —
            // all agency where a leftover has none, and two phases that are two
            // separate fights in the graph.
            const moonless = beat.fight.startsWith('moonless/');
            const mode = leftover ? `eclipsed:${beat.fight.slice('eclipsed/'.length)}`
                : moonless ? `moonless:${beat.fight.endsWith('phase2') ? 2 : 1}`
                : `cpu:${CPU_BY_ACT[beat.actIdx] ?? 'medium'}`;
            current = {
                fight: beat.fight,
                opponentKey,
                mirror: isMirror(beat.fight),
                leftover,
                moonless,
                mode,
                cpuLevel: CPU_BY_ACT[beat.actIdx] ?? 'medium',
                title: beat.title,
                act: beat.act,
            };
            return { kind: 'fight', ...current };
        },

        /** Called when a lines beat has been read to the end. */
        finishLines() {
            cursor += 1;
            lineCursor = 0;
            api.save();
        },

        /**
         * @param {{won:boolean}} res
         * @returns {{advanced:boolean}} — false means "the same fight is still
         * current", i.e. a retry. The story does not branch on losing; it waits.
         */
        reportMatch({ won }) {
            if (!active || !current) return { advanced: false };
            if (!won) return { advanced: false };
            current = null;
            cursor += 1;
            lineCursor = 0;
            api.save();
            return { advanced: true };
        },

        // -- save-anywhere ---------------------------------------------------
        // Position is (beat, line-within-beat), which is the exact line the
        // player was on. Versioned: the beat list is derived from the script, so
        // an edit to any chapter can move indices under an old save. On a
        // mismatch we drop the save rather than resume into the wrong scene.

        save() {
            if (!active) return;
            try {
                localStorage.setItem(SAVE_KEY, JSON.stringify({
                    v: 1, route, cursor, lineCursor, len: beats.length,
                }));
            } catch { /* private mode / quota — losing a save is not worth throwing */ }
        },

        hasSave() {
            try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
        },

        load() {
            let s;
            try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return { ok: false, reason: 'unreadable' }; }
            if (!s || s.v !== 1 || !STORY_ROUTES.includes(s.route)) return { ok: false, reason: 'unreadable' };
            const rebuilt = build(s.route);
            if (rebuilt.length !== s.len || s.cursor > rebuilt.length) {
                return { ok: false, reason: 'the script changed since this save was written' };
            }
            active = true; route = s.route; beats = rebuilt;
            cursor = s.cursor; lineCursor = s.lineCursor || 0; current = null;
            return { ok: true, route };
        },

        clear() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } },
    };

    return api;
}
