/**
 * YAMIWARD — THE LEFTOVER (Eclipsed-champion encounter brain)
 * ============================================================================
 * Drives a fighter for the `eclipsed/*` fights. It is NOT a difficulty setting
 * and it is not CpuBrain with the numbers turned up — it is a different kind of
 * opponent, and the difference is the whole point of the chapter it belongs to.
 *
 * WHAT IT IS. An Eclipsed champion's leftover: residue in the shape of an erased
 * person's habits. Canon is unambiguous and this file is built to it — it has no
 * agency, it repeats, and it never answers. So:
 *
 *   - It does not react. It never blocks on reaction, never punishes a whiff,
 *     never adapts to range or health. Nothing you do changes what it does next.
 *   - It never stops mid-stroke. Interrupt it and it finishes the stroke it had
 *     started, then carries on. Mechanically this means it will EAT a punish
 *     rather than abandon a swing, which is both the fair way to make it
 *     learnable and the literal canon line.
 *   - It never supers. A super is an expression and there is nobody in here to
 *     express anything. Meter simply accumulates and is never spent.
 *   - It is not fighting you. It is doing her job. It hurts you because you are
 *     standing where the work happens.
 *
 * HOW YOU BEAT IT, WHICH IS THE CHAPTER'S ARGUMENT IN MECHANICS. You learn the
 * cycle. The district kept her tool order for a year without knowing whose it
 * was; the player does the same thing with a combat loop, and wins by reading
 * habits rather than by out-fighting a person. Tsukimi's own published weakness
 * is the key to it — "blocking her does not give the turn back; stepping does" —
 * so the loop is beaten by sidestepping the batch, not by turtling through it.
 *
 * DEGRADATION IS NOT RAGE. Bosses escalate at low health; this comes apart. The
 * cycle stutters (a stroke repeated), then gaps open in it, then strokes drop
 * out of the order. It is a thing being relieved of a load, not a thing fighting
 * harder, and RESCUE I says out loud that the fight is relief rather than
 * destruction.
 *
 * DETERMINISM. There is no RNG in here at all, which is stronger than CpuBrain's
 * seeded stream: the same inputs produce the identical fight every time. That is
 * correct for a thing with no agency, and it makes the encounter fully
 * replayable and testable headless.
 *
 * SELF-TIMING. Steps advance when the fighter leaves ATTACKING rather than after
 * a hardcoded frame count, so re-tuning any move's frame data cannot silently
 * desync the loop.
 */

import { Btn, State } from './CombatEngine.js';

/**
 * One stroke of the work cycle.
 *   press — a button; the step ends when the swing resolves
 *   wait  — idle for N frames
 *   close — walk toward the player until inside `range`, then continue
 *
 * Positioning steps are interleaved THROUGH a cycle, not just at the top of it.
 * That is not the leftover reacting: it reads distance-to-work and nothing else —
 * no player state, no health, no threat. It is somebody returning to their bench
 * between strokes, which is what a habit looks like from outside. The first draft
 * positioned once per cycle and then swung at wherever the player used to be;
 * two of the eight ran twenty batches to land fifteen hits.
 */
const S = {
    light: { press: Btn.LIGHT, name: 'light' },
    heavy: { press: Btn.HEAVY, name: 'heavy' },
    low: { press: Btn.LOW, name: 'low' },
    special: { press: Btn.SPECIAL, name: 'special' },
    beat: { wait: 14, name: 'beat' },
    rest: { wait: 32, name: 'rest' },
    // A held beat, not a nap. The first draft made this 90 frames — a second and
    // a half of a leftover doing nothing — and six of the eight cycles became
    // walkovers because the pauses ate the encounter. Withholding is the SHAPE
    // of these fights, not a substitute for threat.
    hold: { wait: 34, name: 'hold' },
    close: { close: 1.5, name: 'close' },
    reach: { close: 3.2, name: 'reach' },
    away: { away: 3.4, name: 'away' },
    mid: { away: 2.4, name: 'mid' },
    back: { retreat: 30, name: 'back' },
};

/**
 * THE CYCLES.
 *
 * The absence is identical in all of them — no agency, no reaction, no super.
 * What differs is the HABIT, because a habit is the only thing an erasure leaves
 * behind, and eight people did not have the same one. Each cycle is that
 * champion's own work, and each therefore teaches the player a different read:
 *
 *   tsukimi   the bench     learn the loop and step off its line
 *   kazakiri  the watch     the gap it leaves on purpose is your window
 *   shigure   the arrival   it never commits, so you have to
 *   yumihari  the draw      bait the release, survive the one that lands
 *
 * Four more exist and are not in this file. They belong to champions who have
 * never been public, and this file ships — so they live in the private
 * `story/eclipsed-cycles.js` and arrive through `register()`. Naming them in a
 * comment here is the same leak as naming them in code; release-check.mjs
 * flagged both, in that order, and was right twice.
 *
 * `host` names the ROSTER fighter the cycle actually runs on where that champion
 * has no kit yet. The habit is theirs; the hands are borrowed. Repoint when the
 * real fighter ships and the cycle needs no change.
 *
 * Every cycle degrades through the same three stages. STUTTER repeats a stroke,
 * because nothing is counting. LOOSE opens gaps and drops strokes out of the
 * order. Neither is harder than the clean cycle — both are strictly easier, and
 * that is the intent: it is a load coming off, not a boss enraging.
 */
const CYCLES = {
    // THE BENCH. A morning's work: set it down, check it, pound, fold, pound,
    // lift, set it down, rest. Her gate's beast is the Rabbit at the Mortar, so
    // the pound is the spine and everything else is arranged around it.
    tsukimi: {
        batch: [S.close, S.light, S.light, S.heavy, S.low, S.heavy, S.special, S.heavy, S.rest],
        stutter: [S.close, S.light, S.light, S.heavy, S.heavy, S.low, S.beat, S.heavy, S.special, S.rest],
        loose: [S.close, S.light, S.beat, S.heavy, S.rest, S.low, S.beat, S.heavy, S.rest, S.rest],
    },

    // THE WATCH. Up the ridge, record what it sees, and leave a gap — the marked
    // omission this bloodline's paperwork requires. Four hundred gaps since she
    // went, every one empty. The gap is a real hole in the offence and it is the
    // player's whole window.
    kazakiri: {
        batch: [S.mid, S.special, S.light, S.mid, S.special, S.heavy, S.hold, S.mid, S.special, S.low, S.special, S.rest],
        stutter: [S.mid, S.special, S.special, S.light, S.mid, S.heavy, S.hold, S.special, S.low, S.rest],
        loose: [S.mid, S.special, S.hold, S.light, S.mid, S.heavy, S.hold, S.special, S.rest],
    },

    // THE ARRIVAL. It arrives, and arrives, and starts again from the far side.
    // The launcher is authored into the cycle and it never reaches it: one step
    // before the finish it turns round and walks back. Nothing merges, nothing
    // stays, and the hour never hands off.
    shigure: {
        batch: [S.close, S.light, S.light, S.special, S.low, S.special, S.light, S.back, S.away, S.beat],
        stutter: [S.close, S.light, S.special, S.special, S.low, S.light, S.back, S.away, S.beat],
        loose: [S.close, S.light, S.beat, S.special, S.low, S.back, S.away, S.rest],
    },

    // THE DRAW. The bow held bent and not loosed. Mostly tension: it closes,
    // holds, holds again, and once per cycle it releases and that one hurts.
    // Then a long rest, because the release is the only thing it has.
    yumihari: {
        batch: [S.close, S.hold, S.special, S.heavy, S.light, S.close, S.low, S.special, S.heavy, S.light, S.rest],
        stutter: [S.close, S.hold, S.special, S.special, S.close, S.heavy, S.light, S.close, S.low, S.rest],
        loose: [S.close, S.hold, S.special, S.close, S.heavy, S.beat, S.close, S.light, S.rest],
    },




};


/**
 * RESILIENCE — a health multiplier, and the only systemic lever in this file.
 *
 * It exists because two published kits are structurally hostile to a brain that
 * never blocks and never adapts, and no amount of stroke-reordering fixes that.
 * Measured over a full match against an easy CPU, damage dealt vs taken:
 *
 *     tsukimi    302 / 124     "tightest recovery in the cast"
 *     kazakiri    87 / 277     "longest reach, LOWEST DAMAGE" (30 pokes blocked)
 *     yumihari    86 / 264     "punishable every time he is wrong"
 *
 * A leftover is wrong constantly — that is the definition of it — so a kit whose
 * whole balance rests on being punished for being wrong bleeds out, and a kit
 * built on low-damage chip cannot out-trade anything. Those are good designs for
 * a player character and bad bodies for a residue to borrow.
 *
 * HEALTH is the canon-defensible correction and damage is not. A leftover does
 * not hit harder than the champion did — that would be nonsense. But it is not a
 * body, it does not tire, and it has stood there for four hundred days without
 * stopping, so it takes more to put down. Scaling damage would make it a better
 * fighter; scaling health makes it a more durable object, which is what it is.
 *
 * Anything at 1 is untouched. Raise a number only with a measurement behind it.
 */
const RESILIENCE = {
    kazakiri: 1.6,
    // 1.6 was not enough: low damage (kazakiri) and punish-vulnerability
    // (yumihari) are not the same problem, and the second one compounds because
    // a leftover that closes constantly is wrong constantly.
    yumihari: 1.9,
};

export class EclipsedBrain {
    /**
     * @param {number} slot fighter slot this brain drives (0 or 1)
     * @param {string} key  which leftover. This selects a CYCLE, and the cycles
     *                      are genuinely different: the absence is the same in
     *                      all eight, but a habit is the only thing an erasure
     *                      leaves behind and eight people did not have the same
     *                      one. Unknown keys fall back to the bench, loudly.
     */
    constructor(slot, key = 'tsukimi') {
        this.slot = slot;
        this.key = CYCLES[key] ? key : 'tsukimi';
        if (!CYCLES[key]) console.warn(`[eclipsed] no cycle for "${key}" — falling back to the bench.`);
        this.set = CYCLES[this.key];
        this.i = 0;             // index into the current cycle
        this.pressed = false;   // this step's button has gone out
        this.waited = 0;        // frames spent on a wait step
        this.stage = 'batch';   // batch -> stutter -> loose, one way only
        this.batches = 0;       // completed cycles, for the harness
    }

    /** The ROSTER fighter this cycle runs on, where the champion has no kit. */
    static hostFor(key) { return CYCLES[key]?.host ?? key; }

    /** Every leftover the game can currently stage. */
    static keys() { return Object.keys(CYCLES); }

    /**
     * Add cycles for champions who have not shipped.
     *
     * Only four leftovers are authored inline here, and all four are public
     * fighters on the select screen. The other four name characters that have
     * never been revealed, so their cycles live in `story/eclipsed-cycles.js`,
     * which is private and never reaches dist/ — release-check.mjs flagged them
     * sitting in this file and was right to. The brain is engine and ships; a
     * cycle is CONTENT, because it is one specific erased person's one specific
     * habit, so it travels with the chapter it belongs to.
     *
     * @param {(S:object)=>object} make  receives the step vocabulary, returns
     *                                   `{ key: {host?, batch, stutter, loose} }`
     * @param {object} [resilience]      optional per-key health multipliers
     */
    static register(make, resilience = {}) {
        Object.assign(CYCLES, make(S));
        Object.assign(RESILIENCE, resilience);
    }

    /**
     * The fighter definition to build the leftover's body from: the host kit
     * with RESILIENCE applied. Returns the def unchanged where the multiplier is
     * 1, so the common case allocates nothing and stays identical to versus.
     * @param {string} key   which leftover
     * @param {object} defs  the CHARACTERS map
     */
    static defFor(key, defs) {
        const base = defs[EclipsedBrain.hostFor(key)];
        const mult = RESILIENCE[key] ?? 1;
        if (!base || mult === 1) return base;
        return { ...base, maxHealth: Math.round(base.maxHealth * mult) };
    }

    /** The cycle for the current stage. Chosen by health, and never goes back. */
    cycle() { return this.set[this.stage]; }

    /**
     * Health only ever moves the stage FORWARD. A leftover that healed back into
     * a clean cycle would be reacting to the fight, which is the one thing it
     * cannot do — and it would also punish the player for landing damage.
     */
    _degrade(me) {
        const frac = Math.max(0, me.health) / me.def.maxHealth;
        const was = this.stage;
        if (frac <= 0.30) this.stage = 'loose';
        else if (frac <= 0.60 && this.stage === 'batch') this.stage = 'stutter';
        if (this.stage === was) return;

        // The three cycles are DIFFERENT LENGTHS — a stroke is added or dropped,
        // which is the point of them. So the cursor has to be brought into the
        // new cycle when the stage turns over, or it can sit past the end and
        // read an undefined step. Wrap rather than reset: it carries on from
        // roughly where its hands were, which is what coming loose looks like.
        this.i %= this.cycle().length;
        this.pressed = false;
        this.waited = 0;
    }

    _advance() {
        const cyc = this.cycle();
        this.i += 1;
        this.pressed = false;
        this.waited = 0;
        if (this.i >= cyc.length) { this.i = 0; this.batches += 1; }
    }

    bits(engine) {
        const me = engine.fighters[this.slot];
        const op = engine.fighters[1 - this.slot];

        if (engine.phase !== 'FIGHT') return 0;

        this._degrade(me);

        // Never stops mid-stroke. While the swing is live we emit nothing —
        // no cancels, no follow-ups, no reconsidering. The stroke finishes and
        // whatever it costs, it costs.
        if (me.state === State.ATTACKING) { this.pressed = true; return 0; }

        // Locked states (hitstun, knockdown, wakeup) are not decisions. When it
        // comes out the other side it picks the cycle up exactly where it was,
        // because nothing in here noticed it had been hit.
        if (me.isLocked) return 0;

        // The previous step's swing has resolved; move on.
        if (this.pressed) { this._advance(); }

        // Defensive: the cursor should always be in range after _degrade, but a
        // brain that throws mid-match takes the whole game down, and a leftover
        // that quietly restarts its cycle is indistinguishable from one that
        // meant to. Cheap insurance.
        let step = this.cycle()[this.i];
        if (!step) { this.i = 0; this.pressed = false; this.waited = 0; step = this.cycle()[0]; }

        if (step.wait !== undefined) {
            this.waited += 1;
            if (this.waited >= step.wait) this._advance();
            return 0;
        }

        if (step.close !== undefined) {
            // It relocates to where the work is. It does NOT chase mid-batch,
            // and it never backs off to be safe. Unhurried, which this Ward
            // would like on the record is not the same as slow.
            //
            // The Kappa leftover is the exception and it is the whole of that
            // encounter: the Bull stands IN the ford so the crossing stays a
            // crossing. It never comes to you. If you stay out of its space
            // nothing happens to either of you and the clock decides — which is
            // the correct outcome for standing in a river, and means a player
            // who runs away loses on health rather than being chased down.
            if (this.set.neverRelocates) { this._advance(); return 0; }
            if (engine.flatDist(me, op) > step.close) return Btn.FORWARD;
            this._advance();
            return 0;
        }

        if (step.away !== undefined) {
            // Zoner habit: hold the ground it prefers. Not kiting — it is not
            // avoiding you, it is standing where the work is done from.
            if (engine.flatDist(me, op) < step.away) return Btn.BACK;
            this._advance();
            return 0;
        }

        if (step.retreat !== undefined) {
            this.waited += 1;
            if (this.waited >= step.retreat) { this._advance(); return 0; }
            return Btn.BACK;
        }

        // A stroke. One rising edge; the engine buffers it, and the ATTACKING
        // branch above holds us here until it resolves.
        this.pressed = true;
        return step.press;
    }

    /** Debug/QA only — read by the headless harness, never by the game. */
    report() {
        return { key: this.key, stage: this.stage, batches: this.batches, step: this.cycle()[this.i]?.name ?? '-' };
    }
}
