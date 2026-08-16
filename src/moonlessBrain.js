/**
 * YAMIWARD — THE MOONLESS (final encounter, both phases)
 * ============================================================================
 * Drives the `moonless/*` fights. It is the exact inverse of src/eclipsedBrain.js
 * and the two are meant to be read together: a leftover is all habit and no
 * agency, and you beat it by learning its loop. This is all agency and no
 * material of its own, and you beat it by outlasting a vocabulary that is not
 * his. One of them cannot see you. The other one has nothing BUT you and the
 * people he took.
 *
 * THE FILE NEVER NAMES HIM, and that is not squeamishness. He is on
 * release-check's BANNED_NAMES because he has never been public, and this file
 * ships — but it also happens to be the Codex's own device: the Registry cannot
 * see the Moonless, so the villain never appears in that book by name either.
 * The techniques are named BY GATE here for the same reason the chapter names
 * them by gate. If a name is ever needed, it belongs in story/, not in src/.
 *
 * WHAT HE THROWS. Bible §2 gives the Phase 1 kit as move-mirroring and meter
 * drain, and CH.6 says out loud what the mirroring actually is:
 *
 *     "Nobody has recognised them. Eleven months and a hall full of people and
 *      not one of them could name what I was throwing."
 *     "The flame that goes on burning after the hand has moved on. That is the
 *      seventh gate. The strike that has a true moment in it. Ninth. The stance
 *      that changes what a body is halfway through. Sixth. The beam. The dish.
 *      The seed. The gap."
 *     "I have eight of them in me and I did not want a single one."
 *
 * So every phrase he throws is somebody else's, taken from one of the eight, and
 * one more is yours — he plays your own last committed move back at you. Nothing
 * in his vocabulary was written for him, which is the whole character.
 *
 * PHASE 1 — THE UNNAMED. All eight phrases plus the mirror, drawn in a shuffled
 * order that never repeats a phrase back-to-back. There is no loop to learn: the
 * point of Phase 1 is that it is unreadable, because nobody in the Ward has been
 * able to name what he is throwing for eleven months.
 *
 * PHASE 2 — WHILE I STILL HAVE THE ORDER OF IT. He is coming apart — the mask
 * has cracked, the starfield behind it is thinner than it was an hour ago — and
 * the mechanic is the inverse of a rage phase: as he takes damage he LOSES the
 * stolen phrases, one at a time, and his vocabulary shrinks. Fewer techniques
 * means more predictable, so he gets easier to read exactly as he gets more
 * desperate to talk. The player wins by attrition of things that were never his.
 *
 * HE REACTS, HE BLOCKS, HE SUPERS. All the things a leftover cannot do. Neutral,
 * spacing and defence are delegated to CpuBrain on 'hard' rather than rewritten
 * — that behaviour is already balanced and harness-covered, and duplicating it
 * to add a boss would be two things to keep in sync. This class overrides the
 * OFFENCE only: when the delegate wants to attack, a stolen phrase comes out
 * instead of that character's own game plan.
 *
 * METER DRAIN IS DATA, NOT A BRAIN HACK. The engine already applies
 * `meterGainDefender` to whoever eats a hit, so a negative value drains them.
 * `movesFor()` returns the host's kit with that one field flipped. No engine
 * change, no reaching into the sim from a brain, and the input-bitmask contract
 * that makes every other brain deterministic and headless-testable is intact.
 */

import { Btn, State } from './CombatEngine.js';
import { CpuBrain } from './cpu.js';

/** Same generator the engine and CpuBrain use; separate stream. */
function xorshift(s) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return s | 0;
}

/**
 * THE EIGHT, BY GATE. Each is a short input phrase shaped like the technique the
 * chapter names — not a quotation of that champion's kit, which he does not have
 * either. He has the SHAPE of what they did, thrown with a body that is not
 * theirs, which is why nobody can place it.
 */
const STOLEN = {
    fourth: [Btn.HEAVY, Btn.LIGHT, Btn.HEAVY],                 // the seed — goes first, leaves
    fifth: [Btn.HEAVY, Btn.LOW],                               // the dish — plants, does not move
    sixth: [Btn.LIGHT, Btn.SPECIAL, Btn.LIGHT],                // the stance that changes halfway
    seventh: [Btn.SPECIAL, Btn.HEAVY],                         // the flame that burns after the hand
    ninth: [Btn.LIGHT, Btn.HEAVY, Btn.SPECIAL],                // the strike with a true moment in it
    tenth: [Btn.SPECIAL, Btn.LOW, Btn.SPECIAL],                // the beam
    eleventh: [Btn.SPECIAL, Btn.LIGHT],                        // the gap
    twelfth: [Btn.SPECIAL, Btn.HEAVY, Btn.HEAVY],              // the draw
};

/** The order he loses them in during Phase 2. Gate order, because that is the
 *  only order he has left — "while I still have the order of it". */
const LOSS_ORDER = ['fourth', 'fifth', 'sixth', 'seventh', 'ninth', 'tenth', 'eleventh'];

export class MoonlessBrain {
    /**
     * @param {number} slot   fighter slot this brain drives
     * @param {1|2}    phase  1 = the unnamed, 2 = the order of it
     * @param {number} [seed] deterministic seed for phrase selection
     */
    constructor(slot, phase = 1, seed = 0x13A7) {
        this.slot = slot;
        this.phase = phase === 2 ? 2 : 1;
        this.rng = seed | 0 || 1;
        this.cpu = new CpuBrain(slot, 'hard', seed ^ 0x5A);

        this.phrase = null;      // the phrase currently coming out
        this.pi = 0;             // index into it
        this.pressed = false;
        this.last = null;        // last phrase key, so it never repeats back-to-back
        this.mirror = null;      // the player's last committed button
        this.lost = 0;           // Phase 2: how many stolen phrases are gone
        this.thrown = 0;         // phrases completed, for the harness
    }

    rand(n) { this.rng = xorshift(this.rng); return ((this.rng >>> 8) % n + n) % n; }

    /** Phrases still available. Phase 2 sheds them as he takes damage. */
    available() {
        const keys = Object.keys(STOLEN);
        if (this.phase !== 2) return keys;
        const gone = new Set(LOSS_ORDER.slice(0, this.lost));
        const left = keys.filter((k) => !gone.has(k));
        return left.length ? left : ['twelfth'];   // the last one is never taken
    }

    /**
     * Phase 2 only. He does not get stronger as he drops — he gets smaller.
     * Seven of the eight are shed across the health bar; the eighth stays,
     * because a boss with nothing left to throw is a boss that cannot finish.
     */
    _shed(me) {
        if (this.phase !== 2) return;
        const frac = Math.max(0, me.health) / me.def.maxHealth;
        const want = Math.min(LOSS_ORDER.length, Math.floor((1 - frac) * (LOSS_ORDER.length + 1)));
        // Monotonic across the WHOLE match, not the round. Health restores at
        // the start of each round, so computing this from current health alone
        // handed him back techniques he had already lost — the harness caught it
        // going 8 -> 7 -> 8. He does not get them back between rounds; the mask
        // cracked once.
        this.lost = Math.max(this.lost, want);
    }

    /** Watch what the player commits to, so it can be played back at them. */
    _watch(engine, op) {
        if (op.state === State.ATTACKING && op.move && op.stateFrame <= 1) {
            const b = engine.buttonForKey(op, op.move.key);
            if (b) this.mirror = b;
        }
    }

    _pick() {
        // One phrase in five is the player's own, when there is one to give back.
        if (this.mirror && this.rand(5) === 0) {
            this.last = 'mirror';
            return [this.mirror, this.mirror];
        }
        const pool = this.available().filter((k) => k !== this.last);
        const key = pool[this.rand(pool.length)] ?? this.available()[0];
        this.last = key;
        return STOLEN[key];
    }

    bits(engine) {
        const me = engine.fighters[this.slot];
        const op = engine.fighters[1 - this.slot];

        if (engine.phase !== 'FIGHT') return 0;
        this._shed(me);
        this._watch(engine, op);

        // Mid-swing: hand back to the delegate so cancels and supers still fire.
        // Unlike a leftover he is allowed to change his mind inside a stroke.
        if (me.state === State.ATTACKING) { this.pressed = true; return this.cpu.bits(engine); }
        if (me.isLocked) { this.phrase = null; return 0; }

        if (this.phrase && this.pressed) {
            this.pressed = false;
            this.pi += 1;
            if (this.pi >= this.phrase.length) { this.phrase = null; this.thrown += 1; }
        }

        // No phrase in flight: let the delegate handle neutral — spacing, walking,
        // blocking, punishing — and only take over when it decides to swing.
        if (!this.phrase) {
            const want = this.cpu.bits(engine);
            const attacking = want & (Btn.LIGHT | Btn.HEAVY | Btn.LOW | Btn.SPECIAL);
            if (!attacking) return want;              // movement/defence: his own
            if (want & Btn.SUPER) return want;        // he supers; a leftover cannot
            this.phrase = this._pick();
            this.pi = 0;
        }

        this.pressed = true;
        return this.phrase[this.pi];
    }

    /**
     * The host kit with meter drain applied. The engine adds `meterGainDefender`
     * to whoever eats the hit, so a negative value takes it off them — which is
     * the whole of "meter drain" with no engine change and nothing new to
     * balance. Phase 2 drains harder because by then he is spending everything.
     *
     * SCOPED TO HIS OWN MOVES. Every key in MOVES is character-prefixed, so only
     * the host's are touched. The first version drained on every move in the map
     * — including the player's, which meant the player's hits took meter off the
     * BOSS, he never reached 100, and he never supered once in a full harness
     * run. A symmetric "drain" is not a drain, it is a tax on whoever is winning.
     *
     * @param {object} moves    the shared MOVES map
     * @param {string} hostKey  the body he is borrowing
     * @param {1|2}    phase
     * @returns {object} a NEW map; the original is never mutated, because versus
     *                   and the ladder read the same object.
     */
    static movesFor(moves, hostKey, phase = 1) {
        const drain = phase === 2 ? -14 : -8;
        const prefix = hostKey + '_';
        const out = {};
        for (const [k, m] of Object.entries(moves)) {
            out[k] = k.startsWith(prefix) ? { ...m, meterGainDefender: drain } : m;
        }
        return out;
    }

    /** Debug/QA only. */
    report() {
        return { phase: this.phase, lost: this.lost, vocabulary: this.available().length, thrown: this.thrown };
    }
}
