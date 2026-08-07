/**
 * YAMIWARD — move tables and character definitions
 * ============================================================================
 * Data only. Every number here is balance surface and is meant to be edited by
 * a designer without touching engine code — that separation is the point.
 *
 * Reading the frame data (Tekken notation):
 *   i13   -> startupFrames 13 ("this move is i13")
 *   +5 / -9  -> frame advantage on hit / on block, DERIVED by the engine from
 *               hitStun/blockStun and recovery. Never hand-write advantage;
 *               it will drift from the real numbers the moment you tune a move.
 *
 * Design rules that were paid for the hard way in the 2D prototype:
 *   - `launches: true` is an EXPLICIT flag on a small number of moves. If most
 *     mids launch, every exchange ends in a knockdown and the game never
 *     returns to neutral.
 *   - The grappler-archetype must NOT have the longest reach. Reach dominates
 *     matchups more than damage does.
 *   - Backwalk speed must be slower than the opponent's forward walk, or a
 *     close-range character can never close distance and is unplayable.
 *     CONCRETELY: the slowest forward walk in the cast is Tetsuki at 0.046, so
 *     no one — not even the zoner — may back up faster than that. Yukiwari sits
 *     at 0.042: best backwalk in the game, still catchable by the grappler.
 *
 * ---------------------------------------------------------------------------
 * ARCHETYPE FIELDS (beyond the base engine vocabulary)
 * ---------------------------------------------------------------------------
 *   isGrab: true      Unblockable. Ignores the guard matrix entirely, but
 *                     whiffs on airborne opponents and cannot be comboed into.
 *                     This is the grappler's answer to a turtle. It MUST be
 *                     short-range and slow or it invalidates blocking.
 *   armorHits: n      While in startup, absorb n hits: take chip-scale damage,
 *                     skip hitstun, keep swinging. The grappler's way through
 *                     a jab wall. Spent armor does not regenerate mid-move.
 *   projectile: {...} Spawns a travelling hitbox instead of an attached one.
 *                     speed = units/frame, life = frames before it despawns.
 *   applySlow: {...}  On hit, scale the victim's walk speeds for N frames.
 *                     Yukiwari's Frostbite: she doesn't outrun you, she makes
 *                     you slower than her.
 *   chargeGain: n     On hit, attacker gains n Static Charge (Raiga only).
 *                     Charge scales his walk + startup; it is his whole engine.
 *
 * Every one of these is read by CombatEngine. Nothing here is decorative.
 */

import { Height } from './CombatEngine.js';

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });

/** @type {Record<string, import('./CombatEngine.js').MoveData>} */
export const MOVES = {

    // =====================================================================
    // TETSUKI 鉄鬼 — GRAPPLER (Feb · Aquarius · Oni)
    // ---------------------------------------------------------------------
    // Slowest walk, highest health, shortest reach. He does not win neutral;
    // he survives it with armor and then ends the round in two touches.
    // His whiffs are death — that asymmetry is the character.
    // =====================================================================
    tetsuki_jab: {
        moveName: 'Gauntlet', inputCommand: '1',
        startupFrames: 9, activeFrames: 3, recoveryFrames: 13,
        attackHeight: Height.HIGH, damage: 11,
        hitStun: 18, blockStun: 11, chipDamage: 1,
        reach: 1.20, hitboxHeight: 1.38, trackingDegrees: 32,
        knockbackOnHit: V(0.045), knockbackOnBlock: V(0.03),
        meterGainAttacker: 5, hitstop: 5,
        cancelInto: 'tetsuki_advance',
    },
    tetsuki_advance: {
        // The armored mid. Walking through a jab is the ONLY way a 0.046-walk
        // grappler ever reaches a rushdown character who is doing his job.
        moveName: 'Iron Advance', inputCommand: 'f+2',
        startupFrames: 16, activeFrames: 3, recoveryFrames: 20,
        attackHeight: Height.MID, damage: 22,
        hitStun: 23, blockStun: 12,
        reach: 1.42, hitboxHeight: 1.25, trackingDegrees: 26,
        knockbackOnHit: V(0.07), knockbackOnBlock: V(0.05),
        armorHits: 1,
        advanceSpeed: 0.055,
        meterGainAttacker: 10, hitstop: 8,
        cancelInto: 'tetsuki_super',
    },
    tetsuki_grip: {
        // Command grab. Unblockable, huge, and deliberately i14 with 34 frames
        // of recovery: if you read it, you get a full punish. Blocking is not
        // the answer to this move — moving is.
        moveName: 'Crushing Grip', inputCommand: 'f,f+1+2',
        startupFrames: 14, activeFrames: 2, recoveryFrames: 34,
        attackHeight: Height.MID, damage: 34,
        hitStun: 40, blockStun: 0, chipDamage: 0,
        reach: 1.15, hitboxHeight: 1.1, trackingDegrees: 20,
        knockbackOnHit: V(0.02), knockbackOnBlock: V(0),
        isGrab: true,
        meterGainAttacker: 14, hitstop: 14,
    },
    tetsuki_sweep: {
        moveName: 'Chain Sweep', inputCommand: 'd+3',
        startupFrames: 18, activeFrames: 4, recoveryFrames: 25,
        attackHeight: Height.LOW, damage: 18,
        hitStun: 25, blockStun: 9,
        reach: 1.55, hitboxHeight: 0.34, trackingDegrees: 20,
        knockbackOnHit: V(0.06), knockbackOnBlock: V(0.03),
        highCrush: true, meterGainAttacker: 8, hitstop: 7,
    },
    tetsuki_super: {
        // 金継 kintsugi — the gold-mended horn. He was broken and repaired in
        // gold, and the super is him proving the repair is the strong part.
        moveName: 'KINTSUGI VERDICT 金継裁', inputCommand: 'Super',
        startupFrames: 11, activeFrames: 6, recoveryFrames: 34,
        attackHeight: Height.MID, damage: 44,
        hitStun: 34, blockStun: 18,
        reach: 1.70, hitboxHeight: 1.3, trackingDegrees: 45,
        knockbackOnHit: V(0.16), knockbackOnBlock: V(0.11),
        launches: true, launchImpulse: V(0.09, 0.30, 0),
        armorHits: 1,
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 16,
    },

    // =====================================================================
    // YUKIWARI 雪割 — ZONER (Jan · Capricorn · Yukionna)
    // ---------------------------------------------------------------------
    // Lowest health in the cast. She wins by never being where you are, and
    // her Frostbite makes closing the gap take longer every time you eat one.
    // Up close she loses — that is the deal she signed for the projectile.
    // =====================================================================
    yukiwari_needle: {
        moveName: 'Frost Needle', inputCommand: '2',
        startupFrames: 15, activeFrames: 1, recoveryFrames: 26,
        attackHeight: Height.MID, damage: 9,
        hitStun: 16, blockStun: 10, chipDamage: 2,
        reach: 0.9, hitboxHeight: 1.15, trackingDegrees: 12,
        knockbackOnHit: V(0.05), knockbackOnBlock: V(0.03),
        projectile: { speed: 0.20, life: 90, radius: 0.30, height: 1.15, color: 0x9BE8E0 },
        applySlow: { scale: 0.72, frames: 150 },   // Frostbite
        meterGainAttacker: 7, hitstop: 5,
    },
    yukiwari_jab: {
        moveName: 'Sleeve Cut', inputCommand: '1',
        startupFrames: 8, activeFrames: 2, recoveryFrames: 11,
        attackHeight: Height.HIGH, damage: 7,
        hitStun: 15, blockStun: 10,
        reach: 1.30, hitboxHeight: 1.40, trackingDegrees: 36,
        knockbackOnHit: V(0.05), knockbackOnBlock: V(0.04),
        meterGainAttacker: 5, hitstop: 4,
        cancelInto: 'yukiwari_needle',
    },
    yukiwari_low: {
        moveName: 'Geta Sweep', inputCommand: 'd+4',
        startupFrames: 14, activeFrames: 3, recoveryFrames: 20,
        attackHeight: Height.LOW, damage: 12,
        hitStun: 20, blockStun: 8,
        reach: 1.45, hitboxHeight: 0.30, trackingDegrees: 22,
        knockbackOnHit: V(0.07), knockbackOnBlock: V(0.05),
        highCrush: true, meterGainAttacker: 7, hitstop: 5,
        applySlow: { scale: 0.85, frames: 90 },
    },
    yukiwari_launcher: {
        // Her panic button and her only real reward for winning close range.
        moveName: 'Rising Frost', inputCommand: 'df+2',
        startupFrames: 14, activeFrames: 3, recoveryFrames: 30,
        attackHeight: Height.MID, damage: 17,
        hitStun: 26, blockStun: 10,
        reach: 1.35, hitboxHeight: 1.55, trackingDegrees: 16,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.09),
        launches: true, launchImpulse: V(0.04, 0.33, 0),
        meterGainAttacker: 11, hitstop: 9,
    },
    yukiwari_super: {
        moveName: 'THE LONG WINTER 長冬', inputCommand: 'Super',
        startupFrames: 9, activeFrames: 5, recoveryFrames: 32,
        attackHeight: Height.MID, damage: 38,
        hitStun: 32, blockStun: 17,
        reach: 1.85, hitboxHeight: 1.25, trackingDegrees: 48,
        knockbackOnHit: V(0.17), knockbackOnBlock: V(0.1),
        launches: true, launchImpulse: V(0.10, 0.28, 0),
        applySlow: { scale: 0.6, frames: 240 },
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 15,
    },

    // =====================================================================
    // RAIGA 雷牙 — RUSHDOWN (Aug · Leo · Raiju)
    // ---------------------------------------------------------------------
    // Static Charge: every hit makes him faster, up to a cap. He is average
    // at neutral and terrifying once rolling — so the counterplay is to break
    // his turn, not to out-poke him. Charge fully resets on knockdown, which
    // is the Leo shadow arc in mechanical form: he needs the momentum, and
    // losing it once costs him everything he'd built.
    // =====================================================================
    raiga_jab: {
        moveName: 'Fang Jab', inputCommand: '1',
        startupFrames: 6, activeFrames: 2, recoveryFrames: 9,
        attackHeight: Height.HIGH, damage: 6,
        hitStun: 15, blockStun: 10,
        reach: 1.30, hitboxHeight: 1.40, trackingDegrees: 38,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.02),
        meterGainAttacker: 5, hitstop: 4, chargeGain: 1,
        cancelInto: 'raiga_rush',
    },
    raiga_rush: {
        moveName: 'Thunder Rush', inputCommand: '1,4',
        startupFrames: 11, activeFrames: 3, recoveryFrames: 15,
        attackHeight: Height.MID, damage: 16,
        hitStun: 21, blockStun: 12,
        reach: 1.55, hitboxHeight: 1.2, trackingDegrees: 24,
        knockbackOnHit: V(0.06), knockbackOnBlock: V(0.045),
        advanceSpeed: 0.07,
        meterGainAttacker: 8, hitstop: 6, chargeGain: 2,
        cancelInto: 'raiga_super',
    },
    raiga_low: {
        moveName: 'Ankle Arc', inputCommand: 'd+4',
        startupFrames: 12, activeFrames: 3, recoveryFrames: 18,
        attackHeight: Height.LOW, damage: 12,
        hitStun: 20, blockStun: 8,
        reach: 1.48, hitboxHeight: 0.30, trackingDegrees: 22,
        knockbackOnHit: V(0.04), knockbackOnBlock: V(0.02),
        highCrush: true, meterGainAttacker: 7, hitstop: 5, chargeGain: 1,
    },
    raiga_launcher: {
        moveName: 'Rising Fang', inputCommand: 'df+2',
        startupFrames: 13, activeFrames: 3, recoveryFrames: 28,
        attackHeight: Height.MID, damage: 18,
        hitStun: 26, blockStun: 11,
        reach: 1.45, hitboxHeight: 1.55, trackingDegrees: 16,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.07),
        launches: true, launchImpulse: V(0.045, 0.31, 0),
        meterGainAttacker: 11, hitstop: 9, chargeGain: 2,
    },
    raiga_super: {
        // 喝采 kassai — applause. He calls for the crowd; the crowd is the move.
        moveName: 'CROWD ROAR 喝采', inputCommand: 'Super',
        startupFrames: 8, activeFrames: 5, recoveryFrames: 30,
        attackHeight: Height.MID, damage: 36,
        hitStun: 30, blockStun: 16,
        reach: 1.90, hitboxHeight: 1.25, trackingDegrees: 50,
        knockbackOnHit: V(0.18), knockbackOnBlock: V(0.1),
        launches: true, launchImpulse: V(0.11, 0.27, 0),
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 15,
    },

    // =====================================================================
    // MAYOI 迷 — TRICKSTER (Mar · Pisces · Kitsune)
    // ---------------------------------------------------------------------
    // Paper defense, best cancels in the cast. Their gimmick is the FEINT:
    // a move that whiffs on purpose but leaves them plus, so the opponent
    // guesses wrong about whose turn it is. Predictable once scouted — the
    // feint is only strong against a player who hasn't learned the timing.
    // =====================================================================
    mayoi_jab: {
        moveName: 'Sleeve Flick', inputCommand: '1',
        startupFrames: 7, activeFrames: 2, recoveryFrames: 10,
        attackHeight: Height.HIGH, damage: 6,
        hitStun: 16, blockStun: 11,
        reach: 1.28, hitboxHeight: 1.40, trackingDegrees: 36,
        knockbackOnHit: V(0.035), knockbackOnBlock: V(0.02),
        meterGainAttacker: 5, hitstop: 4,
        cancelInto: 'mayoi_feint',
    },
    mayoi_feint: {
        // Foxfire Feint. Low damage, tiny recovery, cancels into everything —
        // the point is not the hit, it's that they are STILL THEIR TURN after.
        moveName: 'Foxfire Feint', inputCommand: '2',
        startupFrames: 10, activeFrames: 2, recoveryFrames: 9,
        attackHeight: Height.MID, damage: 9,
        hitStun: 21, blockStun: 14,
        reach: 1.40, hitboxHeight: 1.2, trackingDegrees: 30,
        knockbackOnHit: V(0.02), knockbackOnBlock: V(0.015),
        meterGainAttacker: 9, hitstop: 5,
        cancelInto: 'mayoi_super',
    },
    mayoi_tail: {
        moveName: 'Tail Sweep', inputCommand: 'd+3',
        startupFrames: 13, activeFrames: 3, recoveryFrames: 17,
        attackHeight: Height.LOW, damage: 11,
        hitStun: 21, blockStun: 9,
        reach: 1.50, hitboxHeight: 0.32, trackingDegrees: 24,
        knockbackOnHit: V(0.05), knockbackOnBlock: V(0.03),
        highCrush: true, meterGainAttacker: 7, hitstop: 5,
    },
    mayoi_launcher: {
        moveName: 'Nine Panels', inputCommand: 'df+2',
        startupFrames: 14, activeFrames: 3, recoveryFrames: 27,
        attackHeight: Height.MID, damage: 16,
        hitStun: 25, blockStun: 11,
        reach: 1.42, hitboxHeight: 1.52, trackingDegrees: 18,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.07),
        launches: true, launchImpulse: V(0.05, 0.32, 0),
        meterGainAttacker: 11, hitstop: 9,
    },
    mayoi_super: {
        // 美夢 — the beautiful dream. Their shadow arc, weaponised.
        moveName: 'THE BEAUTIFUL DREAM 美夢', inputCommand: 'Super',
        startupFrames: 9, activeFrames: 5, recoveryFrames: 31,
        attackHeight: Height.MID, damage: 37,
        hitStun: 31, blockStun: 16,
        reach: 1.80, hitboxHeight: 1.25, trackingDegrees: 50,
        knockbackOnHit: V(0.17), knockbackOnBlock: V(0.1),
        launches: true, launchImpulse: V(0.10, 0.29, 0),
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 15,
    },

    // #####################################################################
    // SEASON-DROP FOUR — kits authored 2026-08-07 for the 8-fighter launch.
    // ---------------------------------------------------------------------
    // Every kit here is built from the EXISTING engine vocabulary. Nothing
    // below needs a CombatEngine change, which is deliberate: a kit that
    // ships is worth more than a kit that waits on a mechanic. Where a
    // character's canon suggested a new system (Shigure's literal stance
    // switch), it is expressed through move properties instead, and the
    // system is left as a future upgrade rather than a launch blocker.
    //
    // Roster-wide spacing check performed while writing these:
    //   projectiles  3 of 8 (Yukiwari, Shigure, Kazakiri) — a wall of zoners
    //                is how a roster stops having matchups. Yumihari reads as
    //                an archer but has NO projectile; his bow is a melee arc.
    //   longest reach Kazakiri (fan). Tetsuki still tops out at 1.55, so the
    //                grappler-must-not-have-the-longest-reach rule holds.
    //   backwalk     every new fighter <= 0.043, still under Tetsuki's 0.046
    //                forward walk, so the grappler can always close.
    // #####################################################################

    // =====================================================================
    // SHIGURE 時雨 — TRICKSTER (Jun · Gemini · Ameonna)
    // ---------------------------------------------------------------------
    // Two skies in one heart. Mayoi's trick is FRAME advantage; Shigure's is
    // RANGE — she is the only fighter who can cancel a normal into a
    // projectile, so the same blockstring works point-blank and at tip range
    // and the opponent cannot pick a distance that turns her off.
    // Her Gemini shadow is that she never commits: the drizzle is chip and
    // conversion, never a wall. If she tries to zone with it she loses.
    // =====================================================================
    shigure_jab: {
        moveName: 'Uneven Sleeve', inputCommand: '1',
        startupFrames: 8, activeFrames: 2, recoveryFrames: 11,
        attackHeight: Height.HIGH, damage: 6,
        hitStun: 16, blockStun: 11,
        reach: 1.32, hitboxHeight: 1.40, trackingDegrees: 34,
        knockbackOnHit: V(0.035), knockbackOnBlock: V(0.025),
        meterGainAttacker: 5, hitstop: 4,
        cancelInto: 'shigure_drizzle',
    },
    shigure_drizzle: {
        // Fast, short-lived, weak. Contrast Yukiwari's needle (0.20 speed,
        // 90 life, 0.72 slow): that one OWNS the ground. This one just keeps
        // Shigure's turn alive from further away than a normal can reach.
        moveName: 'Drizzle', inputCommand: '2',
        startupFrames: 12, activeFrames: 1, recoveryFrames: 19,
        attackHeight: Height.MID, damage: 8,
        hitStun: 18, blockStun: 12, chipDamage: 1,
        reach: 0.95, hitboxHeight: 1.18, trackingDegrees: 14,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.02),
        projectile: { speed: 0.28, life: 40, radius: 0.26, height: 1.18, color: 0x7C6FD4 },
        applySlow: { scale: 0.90, frames: 60 },
        meterGainAttacker: 8, hitstop: 5,
        cancelInto: 'shigure_super',
    },
    shigure_low: {
        moveName: 'Puddle Sweep', inputCommand: 'd+3',
        startupFrames: 13, activeFrames: 3, recoveryFrames: 18,
        attackHeight: Height.LOW, damage: 11,
        hitStun: 21, blockStun: 9,
        reach: 1.48, hitboxHeight: 0.31, trackingDegrees: 24,
        knockbackOnHit: V(0.05), knockbackOnBlock: V(0.03),
        highCrush: true, meterGainAttacker: 7, hitstop: 5,
    },
    shigure_launcher: {
        moveName: 'Clearing Sky', inputCommand: 'df+2',
        startupFrames: 15, activeFrames: 3, recoveryFrames: 28,
        attackHeight: Height.MID, damage: 16,
        hitStun: 25, blockStun: 11,
        reach: 1.40, hitboxHeight: 1.50, trackingDegrees: 18,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.075),
        launches: true, launchImpulse: V(0.05, 0.31, 0),
        meterGainAttacker: 11, hitstop: 9,
    },
    shigure_super: {
        // 双天 — both skies. The indecision stops being a weakness for
        // exactly one move: rain and clearing arrive together.
        moveName: 'BOTH SKIES 双天', inputCommand: 'Super',
        startupFrames: 10, activeFrames: 5, recoveryFrames: 32,
        attackHeight: Height.MID, damage: 36,
        hitStun: 31, blockStun: 16,
        reach: 1.78, hitboxHeight: 1.25, trackingDegrees: 48,
        knockbackOnHit: V(0.16), knockbackOnBlock: V(0.1),
        launches: true, launchImpulse: V(0.10, 0.29, 0),
        applySlow: { scale: 0.75, frames: 150 },
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 15,
    },

    // =====================================================================
    // TSUKIMI 月見 — RUSHDOWN (Sep · Virgo · Tsukiusagi)
    // ---------------------------------------------------------------------
    // Raiga's rushdown is a SNOWBALL — he needs the first hit and then he
    // accelerates. Tsukimi's is a VICE: no resource, no acceleration, just
    // the tightest recovery in the cast and blockstun high enough that her
    // turn does not end when you block. She never needs to guess.
    // Her Virgo shadow is the flip side: with no comeback resource, one
    // dropped turn is genuinely just gone. Nothing is banked.
    // =====================================================================
    tsukimi_jab: {
        moveName: 'Kine Tap', inputCommand: '1',
        startupFrames: 7, activeFrames: 2, recoveryFrames: 9,
        attackHeight: Height.HIGH, damage: 6,
        hitStun: 16, blockStun: 12,
        reach: 1.26, hitboxHeight: 1.38, trackingDegrees: 36,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.015),
        meterGainAttacker: 5, hitstop: 4,
        cancelInto: 'tsukimi_pound',
    },
    tsukimi_pound: {
        // The frame trap. Low recovery + 14 blockstun means blocking it does
        // not give the turn back — the counterplay is to step, not to hold.
        moveName: 'Mochi Pound', inputCommand: 'f+2',
        startupFrames: 12, activeFrames: 3, recoveryFrames: 14,
        attackHeight: Height.MID, damage: 17,
        hitStun: 22, blockStun: 14,
        reach: 1.38, hitboxHeight: 1.22, trackingDegrees: 26,
        knockbackOnHit: V(0.05), knockbackOnBlock: V(0.03),
        advanceSpeed: 0.040,
        meterGainAttacker: 9, hitstop: 6,
        cancelInto: 'tsukimi_super',
    },
    tsukimi_low: {
        moveName: 'Pestle Sweep', inputCommand: 'd+4',
        startupFrames: 12, activeFrames: 3, recoveryFrames: 17,
        attackHeight: Height.LOW, damage: 11,
        hitStun: 20, blockStun: 9,
        reach: 1.42, hitboxHeight: 0.30, trackingDegrees: 22,
        knockbackOnHit: V(0.045), knockbackOnBlock: V(0.025),
        highCrush: true, meterGainAttacker: 7, hitstop: 5,
    },
    tsukimi_lowCrouch: {
        // The only lowCrouch variant in the cast, and it is hers on purpose:
        // "precision, nothing wasted" reads as an extra option nobody else
        // gets. Faster and shorter — a check, not a poke.
        moveName: 'Kneeling Pestle', inputCommand: 'd+4 (crouching)',
        startupFrames: 10, activeFrames: 2, recoveryFrames: 15,
        attackHeight: Height.LOW, damage: 8,
        hitStun: 18, blockStun: 8,
        reach: 1.18, hitboxHeight: 0.28, trackingDegrees: 20,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.02),
        highCrush: true, meterGainAttacker: 6, hitstop: 4,
    },
    tsukimi_launcher: {
        moveName: 'Full Moon Rise', inputCommand: 'df+2',
        startupFrames: 13, activeFrames: 3, recoveryFrames: 27,
        attackHeight: Height.MID, damage: 17,
        hitStun: 26, blockStun: 11,
        reach: 1.36, hitboxHeight: 1.52, trackingDegrees: 16,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.07),
        launches: true, launchImpulse: V(0.045, 0.32, 0),
        meterGainAttacker: 11, hitstop: 9,
    },
    tsukimi_super: {
        // 完璧 — flawless. She finally ships the batch.
        moveName: 'FLAWLESS BATCH 完璧', inputCommand: 'Super',
        startupFrames: 8, activeFrames: 5, recoveryFrames: 30,
        attackHeight: Height.MID, damage: 37,
        hitStun: 30, blockStun: 16,
        reach: 1.72, hitboxHeight: 1.25, trackingDegrees: 46,
        knockbackOnHit: V(0.16), knockbackOnBlock: V(0.1),
        launches: true, launchImpulse: V(0.10, 0.28, 0),
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 15,
    },

    // =====================================================================
    // KAZAKIRI 風切 — ZONER (Nov · Scorpio · Tengu)
    // ---------------------------------------------------------------------
    // Yukiwari zones by making you SLOWER. Kazakiri zones by putting you
    // BACK — every fan hit and every blocked fan resets the gap to exactly
    // where he wants it. Longest reach in the cast, and the pushback means
    // even winning your turn against him costs you your position.
    // His Scorpio shadow is literal: the fan is control, and control has no
    // damage behind it. He has the lowest damage output of the eight, so a
    // player who accepts the chip and keeps walking eventually arrives.
    // =====================================================================
    kazakiri_jab: {
        moveName: 'Fan Snap', inputCommand: '1',
        startupFrames: 10, activeFrames: 2, recoveryFrames: 13,
        attackHeight: Height.HIGH, damage: 7,
        hitStun: 15, blockStun: 10,
        reach: 1.58, hitboxHeight: 1.42, trackingDegrees: 30,
        knockbackOnHit: V(0.085), knockbackOnBlock: V(0.075),
        meterGainAttacker: 5, hitstop: 4,
        cancelInto: 'kazakiri_gale',
    },
    kazakiri_gale: {
        // Wind, not ice: no slow at all. It exists to move you, and it moves
        // you whether you block or not — which is the only projectile in the
        // cast that is still doing its job on block.
        moveName: 'Gale Cut', inputCommand: '2',
        startupFrames: 14, activeFrames: 1, recoveryFrames: 24,
        attackHeight: Height.MID, damage: 8,
        hitStun: 16, blockStun: 11, chipDamage: 1,
        reach: 0.95, hitboxHeight: 1.16, trackingDegrees: 12,
        knockbackOnHit: V(0.13), knockbackOnBlock: V(0.11),
        projectile: { speed: 0.24, life: 70, radius: 0.28, height: 1.16, color: 0xA0468C },
        meterGainAttacker: 7, hitstop: 5,
    },
    kazakiri_low: {
        moveName: 'Wing Sweep', inputCommand: 'd+3',
        startupFrames: 16, activeFrames: 3, recoveryFrames: 22,
        attackHeight: Height.LOW, damage: 12,
        hitStun: 21, blockStun: 8,
        reach: 1.62, hitboxHeight: 0.32, trackingDegrees: 20,
        knockbackOnHit: V(0.09), knockbackOnBlock: V(0.06),
        highCrush: true, meterGainAttacker: 7, hitstop: 5,
    },
    kazakiri_launcher: {
        moveName: 'Updraft', inputCommand: 'df+2',
        startupFrames: 16, activeFrames: 3, recoveryFrames: 31,
        attackHeight: Height.MID, damage: 16,
        hitStun: 25, blockStun: 10,
        reach: 1.44, hitboxHeight: 1.58, trackingDegrees: 15,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.10),
        launches: true, launchImpulse: V(0.04, 0.33, 0),
        meterGainAttacker: 11, hitstop: 9,
    },
    kazakiri_super: {
        // 一扇 — one fan's length. The distance he keeps everyone at, stated
        // as a win condition.
        moveName: "ONE FAN'S LENGTH 一扇", inputCommand: 'Super',
        startupFrames: 10, activeFrames: 5, recoveryFrames: 33,
        attackHeight: Height.MID, damage: 34,
        hitStun: 30, blockStun: 17,
        reach: 1.95, hitboxHeight: 1.28, trackingDegrees: 50,
        knockbackOnHit: V(0.22), knockbackOnBlock: V(0.16),
        launches: true, launchImpulse: V(0.13, 0.26, 0),
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 15,
    },

    // =====================================================================
    // YUMIHARI 弓張 — RUSHDOWN (Dec · Sagittarius · Ryu)
    // ---------------------------------------------------------------------
    // "The arrow only means something when it lands." He is the archer who
    // has NO projectile — deliberately. Three of eight already throw things,
    // and a fourth would flatten the roster's matchup spread; more to the
    // point, a Sagittarius who can poke safely from screen-length never has
    // to commit, and committing is his entire arc.
    // So the bow is a melee arc: the longest advancing moves in the cast,
    // the worst recovery in the cast. He closes enormous distance and is
    // fully punishable every time he is wrong. He never lands — until he
    // does, and then it is a lot.
    // =====================================================================
    yumihari_jab: {
        moveName: 'Nocking Jab', inputCommand: '1',
        startupFrames: 7, activeFrames: 2, recoveryFrames: 10,
        attackHeight: Height.HIGH, damage: 6,
        hitStun: 15, blockStun: 10,
        reach: 1.34, hitboxHeight: 1.40, trackingDegrees: 36,
        knockbackOnHit: V(0.035), knockbackOnBlock: V(0.025),
        meterGainAttacker: 5, hitstop: 4,
        cancelInto: 'yumihari_gallop',
    },
    yumihari_gallop: {
        // Fastest closer in the game (0.095 vs Raiga's 0.07) and 26 frames of
        // recovery to pay for it. This is the move that defines him: it wins
        // the round or it loses the exchange, and there is no third outcome.
        moveName: 'Gallop Loose', inputCommand: 'f,f+2',
        startupFrames: 15, activeFrames: 3, recoveryFrames: 26,
        attackHeight: Height.MID, damage: 20,
        hitStun: 23, blockStun: 11,
        reach: 1.52, hitboxHeight: 1.24, trackingDegrees: 22,
        knockbackOnHit: V(0.07), knockbackOnBlock: V(0.055),
        advanceSpeed: 0.095,
        meterGainAttacker: 10, hitstop: 7,
        cancelInto: 'yumihari_super',
    },
    yumihari_low: {
        moveName: 'Low Draw', inputCommand: 'd+4',
        startupFrames: 14, activeFrames: 3, recoveryFrames: 21,
        attackHeight: Height.LOW, damage: 12,
        hitStun: 20, blockStun: 8,
        reach: 1.50, hitboxHeight: 0.31, trackingDegrees: 22,
        knockbackOnHit: V(0.05), knockbackOnBlock: V(0.03),
        highCrush: true, advanceSpeed: 0.030,
        meterGainAttacker: 7, hitstop: 5,
    },
    yumihari_launcher: {
        moveName: 'Skyward Shot', inputCommand: 'df+2',
        startupFrames: 14, activeFrames: 3, recoveryFrames: 30,
        attackHeight: Height.MID, damage: 18,
        hitStun: 26, blockStun: 10,
        reach: 1.46, hitboxHeight: 1.56, trackingDegrees: 16,
        knockbackOnHit: V(0.03), knockbackOnBlock: V(0.08),
        launches: true, launchImpulse: V(0.05, 0.34, 0),
        meterGainAttacker: 11, hitstop: 9,
    },
    yumihari_super: {
        // 弓張 — the drawn bow, his own name. The arrow finally lands.
        moveName: 'THE ARROW LANDS 弓張', inputCommand: 'Super',
        startupFrames: 9, activeFrames: 5, recoveryFrames: 34,
        attackHeight: Height.MID, damage: 40,
        hitStun: 31, blockStun: 15,
        reach: 1.88, hitboxHeight: 1.26, trackingDegrees: 44,
        knockbackOnHit: V(0.18), knockbackOnBlock: V(0.09),
        launches: true, launchImpulse: V(0.12, 0.28, 0),
        advanceSpeed: 0.060,
        wallSplat: true, meterCost: 100, isSuper: true, hitstop: 16,
    },
};

/**
 * Character definitions — the launch four (canon, internal design docs §4/§5).
 * Four archetype corners: grappler / zoner / rushdown / trickster.
 *
 * `clan`, `sign` and `month` are not decoration: the site registers a resident's
 * bloodline in `yd_clan`, and the game reads it to pick the player's route.
 */
export const CHARACTERS = {
    tetsuki: {
        key: 'tetsuki', name: 'TETSUKI', kanji: '鉄鬼', archetype: 'GRAPPLER',
        clanKey: 'oni', clan: 'ONI 鬼', sign: 'Aquarius', month: 2, element: 'Air',
        trigger: 'tetsuki_yw', pronouns: 'he/him',
        color: 0xE51E25, rimColor: 0xFFC94A,      // clan red, kintsugi gold rim
        maxHealth: 195,
        walkForward: 0.046, walkBack: 0.030,      // slowest in the cast, by design
        sidestepFrames: 27, sidestepSpeed: 0.062,
        moveset: { light: 'tetsuki_jab', heavy: 'tetsuki_advance', low: 'tetsuki_sweep', grab: 'tetsuki_grip', super: 'tetsuki_super' },
        blurb: 'Shortest reach, heaviest hands, walks through jabs. Whiff and he is on you.',
        voice: 'Doors work both ways. That is the part exile teaches.',
    },
    yukiwari: {
        key: 'yukiwari', name: 'YUKIWARI', kanji: '雪割', archetype: 'ZONER',
        clanKey: 'yukionna', clan: 'YUKIONNA 雪女', sign: 'Capricorn', month: 1, element: 'Earth',
        trigger: 'yukiwari_yw', pronouns: 'she/her',
        rig: 'robe',                               // floor-length kimono — no separable legs (paperdoll ROBE_RIG)
        color: 0x9BE8E0, rimColor: 0xE8FBFF,
        maxHealth: 145,                            // lowest — she pays for the needle
        walkForward: 0.050, walkBack: 0.042,       // best backwalk, still < Tetsuki 0.046
        sidestepFrames: 22, sidestepSpeed: 0.080,
        moveset: { light: 'yukiwari_jab', heavy: 'yukiwari_launcher', low: 'yukiwari_low', special: 'yukiwari_needle', super: 'yukiwari_super' },
        blurb: 'Frost Needle controls the ground. Frostbite makes closing in cost you more each time.',
        voice: 'You are not cold. You are unfinished.',
    },
    raiga: {
        key: 'raiga', name: 'RAIGA', kanji: '雷牙', archetype: 'RUSHDOWN',
        clanKey: 'raiju', clan: 'RAIJU 雷獣', sign: 'Leo', month: 8, element: 'Fire',
        trigger: 'raiga_yw', pronouns: 'he/him',
        color: 0x4A8FE8, rimColor: 0xFFE9A8,
        maxHealth: 160,
        walkForward: 0.070, walkBack: 0.044,
        sidestepFrames: 19, sidestepSpeed: 0.098,
        maxCharge: 10, chargeSpeedPerStack: 0.0022, chargeStartupPerStack: 0.055,
        moveset: { light: 'raiga_jab', heavy: 'raiga_launcher', low: 'raiga_low', special: 'raiga_rush', super: 'raiga_super' },
        blurb: 'Every hit makes him faster. Break his turn or watch him snowball.',
        voice: 'Louder! I cannot hear the ward from down there!',
    },
    mayoi: {
        key: 'mayoi', name: 'MAYOI', kanji: '迷', archetype: 'TRICKSTER',
        clanKey: 'kitsune', clan: 'KITSUNE 狐', sign: 'Pisces', month: 3, element: 'Water',
        trigger: 'mayoi_yw', pronouns: 'they/them',
        color: 0x5BE0C8, rimColor: 0xFF7BC8,       // aqua coat, pink foxfire rim
        maxHealth: 150,
        walkForward: 0.062, walkBack: 0.041,
        sidestepFrames: 17, sidestepSpeed: 0.104,  // best sidestep in the cast
        moveset: { light: 'mayoi_jab', heavy: 'mayoi_launcher', low: 'mayoi_tail', special: 'mayoi_feint', super: 'mayoi_super' },
        blurb: 'Feints that leave them plus. Paper defense — they must never be the one guessing.',
        voice: 'You are watching the mask. That is the whole trick, and I told you.',
    },

    // --- Season-drop four (Forms per the story bible §4, authored 2026-08-07) ---
    // Accent colours are picked for HUD SEPARATION as much as for canon. Three
    // of these four are canonically purple-family (Shigure violet, Tsukimi
    // lilac, Kazakiri plum) and the launch four already own red + three cools,
    // so each is pushed to a distinct corner: Shigure blue-violet, Tsukimi a
    // near-white lilac, Kazakiri a magenta plum. Health bars, clan bands and
    // hitsparks all read from `color`, so two neighbours in hue is a UI bug
    // waiting to happen, not a taste question.
    shigure: {
        key: 'shigure', name: 'SHIGURE', kanji: '時雨', archetype: 'TRICKSTER',
        clanKey: 'ameonna', clan: 'AMEONNA 雨女', sign: 'Gemini', month: 6, element: 'Air',
        trigger: 'shigure_yw', pronouns: 'she/her',
        rig: 'robe',                               // ankle-length coat — only her feet clear it
        color: 0x7C6FD4, rimColor: 0xD9C9F5,
        maxHealth: 152,
        walkForward: 0.058, walkBack: 0.040,
        sidestepFrames: 18, sidestepSpeed: 0.096,
        moveset: { light: 'shigure_jab', heavy: 'shigure_launcher', low: 'shigure_low', special: 'shigure_drizzle', super: 'shigure_super' },
        blurb: 'Cancels her normals into rain. The same blockstring works point-blank and at tip range.',
        voice: 'Pick a sky. I never could, and look where it got me — everywhere.',
    },
    tsukimi: {
        key: 'tsukimi', name: 'TSUKIMI', kanji: '月見', archetype: 'RUSHDOWN',
        clanKey: 'tsukiusagi', clan: 'TSUKIUSAGI 月兎', sign: 'Virgo', month: 9, element: 'Earth',
        trigger: 'tsukimi_yw', pronouns: 'she/her',
        color: 0xD8C9F0, rimColor: 0xF6F1FF,
        maxHealth: 158,
        walkForward: 0.066, walkBack: 0.043,
        sidestepFrames: 20, sidestepSpeed: 0.090,
        moveset: { light: 'tsukimi_jab', heavy: 'tsukimi_pound', low: 'tsukimi_low', lowCrouch: 'tsukimi_lowCrouch', special: 'tsukimi_launcher', super: 'tsukimi_super' },
        blurb: 'Tightest recovery in the cast. Blocking her does not give the turn back — stepping does.',
        voice: 'Again. It was close, and close is a kind of wrong.',
    },
    kazakiri: {
        key: 'kazakiri', name: 'KAZAKIRI', kanji: '風切', archetype: 'ZONER',
        clanKey: 'tengu', clan: 'TENGU 天狗', sign: 'Scorpio', month: 11, element: 'Water',
        trigger: 'kazakiri_yw', pronouns: 'he/him',
        rig: 'robewings',                          // floor-length robes AND crow wings (paperdoll ROBE_WING_RIG)
        color: 0xA0468C, rimColor: 0xE0A8D4,
        maxHealth: 150,
        walkForward: 0.052, walkBack: 0.042,
        sidestepFrames: 21, sidestepSpeed: 0.084,
        moveset: { light: 'kazakiri_jab', heavy: 'kazakiri_launcher', low: 'kazakiri_low', special: 'kazakiri_gale', super: 'kazakiri_super' },
        blurb: 'Longest reach in the cast, lowest damage. Every exchange puts you back where he wants you.',
        voice: 'This distance is not fear. It is the only honest measurement.',
    },
    yumihari: {
        key: 'yumihari', name: 'YUMIHARI', kanji: '弓張', archetype: 'RUSHDOWN',
        clanKey: 'ryu', clan: 'RYU 龍', sign: 'Sagittarius', month: 12, element: 'Fire',
        trigger: 'yumihari_yw', pronouns: 'he/him',
        rig: 'robe',                               // wide hakama reads as one mass to the shins
        color: 0xE0A83C, rimColor: 0xFFE9A8,
        maxHealth: 155,
        walkForward: 0.068, walkBack: 0.041,
        sidestepFrames: 18, sidestepSpeed: 0.100,
        moveset: { light: 'yumihari_jab', heavy: 'yumihari_launcher', low: 'yumihari_low', special: 'yumihari_gallop', super: 'yumihari_super' },
        blurb: 'Closes more distance than anyone and is punishable every time he is wrong.',
        voice: 'Everything is in range! It is the landing I keep having trouble with.',
    },
};

/**
 * Rival pairings. Canon rivals are polarity opposites — opposite months, exact
 * astrological poles. Three of the six canon pairs are both-present in the
 * launch roster and are wired as such:
 *   tetsuki <-> raiga    Aquarius <-> Leo   (outcast vs crowd)
 *   mayoi   <-> tsukimi  Pisces   <-> Virgo (dream vs precision)
 *   shigure <-> yumihari Gemini   <-> Sagittarius (wander vs choose)
 *
 * Yukiwari and Kazakiri are paired with each other as an explicit STAND-IN:
 * each one's true opposite is a champion who has not shipped. It is a zoner
 * mirror, which at least reads as a real fight, but it is not canon — repoint
 * both the moment their real opposites land.
 *
 * NOTE: this file ships to the client verbatim, so the unshipped champions are
 * not named here and must not be. release-check.mjs enforces that; the pairings
 * they belong to are recorded in the design log, which does not ship.
 */
export const RIVALS = {
    tetsuki: 'raiga', raiga: 'tetsuki',
    mayoi: 'tsukimi', tsukimi: 'mayoi',
    shigure: 'yumihari', yumihari: 'shigure',
    yukiwari: 'kazakiri', kazakiri: 'yukiwari',   // stand-ins — see above
};

export const ROSTER = ['tetsuki', 'yukiwari', 'raiga', 'mayoi', 'shigure', 'tsukimi', 'kazakiri', 'yumihari'];
