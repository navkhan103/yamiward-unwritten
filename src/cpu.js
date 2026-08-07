/**
 * YAMIWARD — CPU opponent
 * ============================================================================
 * A scripted state-machine brain, NOT machine learning. It reads the public
 * engine state and returns an input bitmask each frame — exactly what a human
 * hand on a pad produces. The engine cannot tell the difference, which means:
 *   - zero engine changes, zero new code paths to balance-test
 *   - fully deterministic (own seeded xorshift, never Math.random), so a
 *     CPU match replays identically from (seed, roster) — replay/netcode safe
 *   - runs headless under Node for automated matchup sweeps (tools/)
 *
 * Design stance: the CPU plays the CHARACTER, not the engine. Each archetype
 * gets a preferred range and an attack mix that matches its published game
 * plan (grappler walks you down and grabs turtles; zoner keeps needle range;
 * rushdown never lets go; trickster steps and feints). Difficulty changes
 * reaction time and guess quality — never cheats. The CPU sees only what a
 * player sees: states, positions, and the move that is already coming out.
 */

import { Btn, State, Height } from './CombatEngine.js';

/** Same generator the engine uses; separate stream so CPU "thought" never
 *  advances the match RNG (inputs must not perturb the sim's own dice). */
function xorshift(s) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return s | 0;
}

/** Difficulty is honesty-preserving: harder = faster reactions and better
 *  guard guesses, not more damage or free meter. */
export const CPU_LEVELS = {
    easy: { reaction: 18, blockSkill: 0.40, punishSkill: 0.35, stepSkill: 0.15, thinkEvery: 14, attackCooldown: 34, superSense: 0.4 },
    medium: { reaction: 11, blockSkill: 0.68, punishSkill: 0.65, stepSkill: 0.35, thinkEvery: 9, attackCooldown: 22, superSense: 0.75 },
    hard: { reaction: 6, blockSkill: 0.86, punishSkill: 0.85, stepSkill: 0.55, thinkEvery: 6, attackCooldown: 12, superSense: 0.95 },
};

/** Preferred fighting distance per archetype — the whole personality in one
 *  number. Zoner wants needle space; grappler wants to be in your collar. */
const HOME_RANGE = {
    GRAPPLER: 1.15,
    ZONER: 3.4,
    RUSHDOWN: 1.35,
    TRICKSTER: 1.55,
};

export class CpuBrain {
    /**
     * @param {number} slot fighter slot this brain drives (0 or 1)
     * @param {string} level 'easy' | 'medium' | 'hard'
     * @param {number} [seed] deterministic seed for this brain's decisions
     */
    constructor(slot, level = 'medium', seed = 0xCB0B0 + slot) {
        this.slot = slot;
        this.level = CPU_LEVELS[level] ? level : 'medium';
        this.cfg = CPU_LEVELS[this.level];
        this.rng = seed | 0 || 1;

        // Held movement plan — humans commit to walking for many frames, and
        // an AI that re-decides every frame vibrates in place.
        this.plan = 0;
        this.planUntil = 0;

        // One-frame button taps queue here (engine buffers rising edges only).
        this.tap = 0;

        this.lastAttackFrame = -999;
        // The guard guess is made ONCE per incoming move, at reaction time —
        // re-rolling every frame would let the CPU "fuzzy block" perfectly.
        this.guardGuessFor = -1;
        this.guardGuess = 0;
    }

    rand(n) { this.rng = xorshift(this.rng); return ((this.rng >>> 8) % n + n) % n; }
    chance(p) { return this.rand(1000) < p * 1000; }

    /**
     * Produce this frame's input bitmask. Call once per engine step, BEFORE
     * step() (it reads pre-step state, same as a human reading the screen).
     * @param {import('./CombatEngine.js').CombatEngine} engine
     */
    bits(engine) {
        const me = engine.fighters[this.slot];
        const op = engine.fighters[1 - this.slot];
        const cfg = this.cfg;

        // consume queued tap exactly once
        const tap = this.tap;
        this.tap = 0;

        if (engine.phase !== 'FIGHT') return 0;
        // Locked states ignore input; ATTACKING still reads the buffer, so
        // let queued cancels flow through but plan nothing new.
        if (me.isLocked) return 0;
        if (me.state === State.ATTACKING) return tap;

        const dist = engine.flatDist(me, op);
        const mySet = me.def.moveset;
        const arch = me.def.archetype;

        // ---- 1. defense: an attack is already coming at us ------------------
        const threat = op.state === State.ATTACKING && op.move && !op.move.projectile &&
            dist < (op.move.reach + 0.9);
        if (threat) {
            const startup = engine.startupFor(op, op.move);
            const seen = op.stateFrame >= cfg.reaction;          // have we reacted yet?
            const stillDangerous = op.stateFrame < startup + op.move.activeFrames;

            if (seen && stillDangerous) {
                // Grabs cannot be blocked — the correct read is to move.
                if (op.move.isGrab && this.chance(cfg.punishSkill)) {
                    return this.stepBit();
                }
                // Commit to one guard guess per move.
                if (this.guardGuessFor !== op.stateFrame - op.stateFrame % 1000 || this.guardGuess === 0) {
                    // key the guess to this specific swing
                }
                if (this.guardMoveId !== op.moveKey + ':' + op.stateFrameStart) {
                    // (see below — simple per-swing latch)
                }
                if (this._swing !== op.move || this._swingFrame > op.stateFrame) {
                    this._swing = op.move;
                    const correct = op.move.attackHeight === Height.LOW
                        ? (Btn.BACK | Btn.CROUCH)
                        : Btn.BACK;
                    const wrong = op.move.attackHeight === Height.LOW
                        ? Btn.BACK
                        : (Btn.BACK | Btn.CROUCH);
                    this.guardGuess = this.chance(cfg.blockSkill) ? correct : wrong;
                }
                this._swingFrame = op.stateFrame;
                return this.guardGuess;
            }

            // Whiff/recovery punish: their hitbox is spent and we can reach.
            const spent = op.hitUsed || op.stateFrame >= startup + op.move.activeFrames;
            if (spent && dist < 1.7 && this.chance(cfg.punishSkill) &&
                engine.frame - this.lastAttackFrame > 10) {
                this.lastAttackFrame = engine.frame;
                return me.meter >= 100 ? Btn.SUPER : Btn.HEAVY;   // launch the punish
            }
        } else {
            this._swing = null;
        }

        // ---- 2. incoming projectile: step around it or block it -------------
        // The sidestep is a REAL answer: a needle flies straight down its own
        // z-line, so stepping off that line whiffs it clean — and leaves the
        // stepper closer than blocking would. Backwalking to block is the
        // zoner's dream: everyone who wants IN must prefer the step, because
        // holding BACK also walks them backward and the gap never closes.
        for (const pr of engine.projectiles) {
            if (pr.owner === this.slot) continue;
            const closing = Math.sign(pr.vx) === Math.sign(me.pos.x - pr.x);
            const eta = Math.abs(me.pos.x - pr.x) / Math.max(0.01, Math.abs(pr.vx));
            if (closing && eta < 26) {
                if (Math.abs(me.pos.z - pr.z) > 0.8) break;        // already off its line
                const stepUrge = arch === 'ZONER' ? cfg.stepSkill : Math.min(0.92, cfg.stepSkill * 2);
                if (this.chance(stepUrge)) return this.stepBit();
                return Btn.BACK;                                   // stand block eats the chip
            }
        }

        // ---- 3. offense / spacing (re-planned every thinkEvery frames) ------
        if (engine.frame >= this.planUntil) {
            this.plan = this.decidePlan(engine, me, op, dist, arch, mySet, cfg);
            this.planUntil = engine.frame + cfg.thinkEvery + this.rand(6);
        }
        return this.plan | tap;
    }

    /** Sidestep direction alternates pseudo-randomly so it can't be pre-aimed. */
    stepBit() {
        return this.chance(0.5) ? Btn.STEP_LEFT : Btn.STEP_RIGHT;
    }

    decidePlan(engine, me, op, dist, arch, mySet, cfg) {
        const home = HOME_RANGE[arch] ?? 1.4;
        const canAttack = engine.frame - this.lastAttackFrame > cfg.attackCooldown;

        // Re-centre — but only once we're near striking range. Facing only
        // rotates along x, so a z-offset means whiffing forever; the counter
        // is to step back onto the opponent's line. Doing it at long range is
        // a trap though: against a zoner, OFF the needle's line is exactly
        // where the approach is safe. Walk in off-axis, re-align to strike.
        const dz = op.pos.z - me.pos.z;
        if (Math.abs(dz) > 0.45 && arch !== 'ZONER' && dist < home + 0.9) {
            return dz > 0 ? Btn.STEP_RIGHT : Btn.STEP_LEFT;
        }

        // Super: the one universal answer. Fires in range at full meter.
        if (me.meter >= 100 && dist < 1.8 && this.chance(cfg.superSense)) {
            this.lastAttackFrame = engine.frame;
            return Btn.SUPER;
        }

        // Zoner keeps her distance and works the needle.
        if (arch === 'ZONER') {
            if (dist > 2.2 && mySet.special && canAttack && this.chance(0.7)) {
                this.lastAttackFrame = engine.frame;
                return Btn.SPECIAL;
            }
            if (dist < home - 0.5) {
                // Too close — back off, and sometimes check them with the launcher.
                if (dist < 1.3 && canAttack && this.chance(0.4)) {
                    this.lastAttackFrame = engine.frame;
                    return Btn.HEAVY;
                }
                return Btn.BACK;
            }
            if (dist > home + 0.8) return Btn.FORWARD;
            return this.chance(0.2) ? this.stepBit() : 0;
        }

        // Everyone else wants IN, at their own pace.
        if (dist > home + 0.35) {
            // Grappler's armored advance IS his approach — but only inside its
            // true carry range. Against a live backwalk the advance whiffs
            // from 2.3 and the 20-frame recovery hands the zoner free space,
            // so the trigger sits at what the move actually reaches.
            if (arch === 'GRAPPLER' && dist < 1.9 && canAttack && this.chance(0.5)) {
                this.lastAttackFrame = engine.frame;
                return Btn.HEAVY;                    // Iron Advance, armor forward
            }
            if (arch === 'RUSHDOWN' && dist < 2.4 && canAttack && this.chance(0.45)) {
                this.lastAttackFrame = engine.frame;
                return Btn.SPECIAL;                  // Thunder Rush closes and charges
            }
            // Approach with occasional angle changes so it isn't a straight line.
            return this.chance(0.15) ? this.stepBit() : Btn.FORWARD;
        }

        // In range: the attack mix is the archetype.
        if (canAttack) {
            this.lastAttackFrame = engine.frame;
            const r = this.rand(100);
            if (arch === 'GRAPPLER') {
                // Grab beats a standing guard — throw it exactly when they turtle.
                if (op.state === State.BLOCKING && mySet.grab && this.chance(0.65)) return Btn.SPECIAL;
                if (r < 35) return Btn.LIGHT;
                if (r < 60) return Btn.HEAVY;
                if (r < 80) return Btn.LOW;
                return mySet.grab ? Btn.SPECIAL : Btn.HEAVY;
            }
            if (arch === 'RUSHDOWN') {
                if (r < 40) return Btn.LIGHT;        // jab starts the train (chargeGain)
                if (r < 65) return Btn.SPECIAL;
                if (r < 85) return Btn.LOW;
                return Btn.HEAVY;
            }
            if (arch === 'TRICKSTER') {
                if (r < 35) return Btn.SPECIAL;      // the feint is the character
                if (r < 60) return Btn.LIGHT;
                if (r < 85) return Btn.LOW;
                return Btn.HEAVY;
            }
            // ZONER close-range fallback handled above; generic mix:
            if (r < 40) return Btn.LIGHT;
            if (r < 70) return Btn.LOW;
            return Btn.HEAVY;
        }

        // Waiting our turn: hold ground more than we retreat — a CPU that
        // over-blocks produces chip-only rounds nobody enjoys.
        const r = this.rand(100);
        if (r < 22) return Btn.BACK;
        if (r < 40) return this.stepBit();
        if (r < 75) return Btn.FORWARD;
        return 0;
    }
}
