/**
 * YAMIWARD — dollPoses
 * ============================================================================
 * Pose clips for the paper-doll rig (SPEC-PAPERDOLL.md §1.2). Data, not code:
 * per-state keyframes of per-piece Z-rotations in DEGREES, evaluated by
 * paperdoll.js as a pure function of engine state. Positive rotation swings
 * the limb FORWARD (toward facing) for arms/legs hanging from their joint.
 *
 * Two clip kinds:
 *   loop  — `dur` in engine frames, keys at absolute frame `t`, wraps.
 *   phase — attack clips; `t` is a FRACTION 0..1 of the move's total
 *           startup+active+recovery, so one clip stays honest for every
 *           move's frame data. Anchor strings resolve per-move:
 *           "start"=0, "active"=startup/total, "recover"=(startup+active)/total,
 *           "end"=1.
 *
 * Pieces: torso, head, armUpper.L/R, armFore.L/R, legUpper.L/R, legLower.L/R.
 * `root` entries move the hip joint: y (lift/drop), rz (whole-body tilt, deg).
 * R is the NEAR side (screen-facing) in the default mirror.
 *
 * Convention: fighting stance, not T-pose — every clip is a delta from the
 * guard position baked into IDLE's first key.
 */

// The guard stance every other clip returns to.
const GUARD = {
    torso: -4, head: 4,
    'armUpper.R': -38, 'armFore.R': -68,   // rear/near arm cocked high
    'armUpper.L': -18, 'armFore.L': -55,   // lead arm probing
    'legUpper.R': -14, 'legLower.R': 10,
    'legUpper.L': 16, 'legLower.L': 6,
};

export const CLIPS = {

    IDLE: {
        dur: 96, keys: [
            { t: 0, r: GUARD, root: { y: 0 } },
            { t: 48, r: { ...GUARD, torso: -6, 'armUpper.R': -34, 'armFore.R': -72, head: 5 }, root: { y: -0.02 } },
            { t: 96, r: GUARD, root: { y: 0 } },
        ],
    },

    WALK: {
        dur: 36, keys: [
            { t: 0, r: { ...GUARD, 'legUpper.L': 28, 'legLower.L': 14, 'legUpper.R': -24, 'legLower.R': 26 }, root: { y: 0 } },
            { t: 18, r: { ...GUARD, 'legUpper.L': -22, 'legLower.L': 24, 'legUpper.R': 26, 'legLower.R': 8 }, root: { y: -0.03 } },
            { t: 36, r: { ...GUARD, 'legUpper.L': 28, 'legLower.L': 14, 'legUpper.R': -24, 'legLower.R': 26 }, root: { y: 0 } },
        ],
    },

    SIDESTEP: {
        dur: 27, keys: [
            { t: 0, r: GUARD, root: { y: 0 } },
            { t: 13, r: { ...GUARD, torso: -10, head: 8, 'legUpper.L': 6, 'legUpper.R': -26 }, root: { y: -0.06 } },
            { t: 27, r: GUARD, root: { y: 0 } },
        ],
    },

    CROUCH: {
        dur: 1, keys: [
            {
                t: 0, r: {
                    torso: -18, head: 14,
                    'armUpper.R': -30, 'armFore.R': -78, 'armUpper.L': -12, 'armFore.L': -66,
                    'legUpper.R': -58, 'legLower.R': 74, 'legUpper.L': 62, 'legLower.L': 70,
                }, root: { y: -0.34 },
            },
        ],
    },

    BLOCK: {
        dur: 1, keys: [
            {
                t: 0, r: {
                    ...GUARD, torso: -8, head: 6,
                    'armUpper.R': -52, 'armFore.R': -95, 'armUpper.L': -40, 'armFore.L': -88,
                }, root: { y: -0.02 },
            },
        ],
    },

    // Attacks — phase clips. Wind back through startup, strike at the active
    // edge, settle through recovery. The strike key sits just past "active"
    // so contact frames actually look extended.
    ATK_LIGHT: {
        phase: true, keys: [
            { t: 'start', r: GUARD },
            { t: 'active', r: { ...GUARD, torso: 6, 'armUpper.L': 74, 'armFore.L': -8 } },
            { t: 'recover', r: { ...GUARD, torso: 4, 'armUpper.L': 60, 'armFore.L': -20 } },
            { t: 'end', r: GUARD },
        ],
    },

    ATK_HEAVY: {
        phase: true, keys: [
            { t: 'start', r: { ...GUARD, torso: -14, 'armUpper.R': -70, 'armFore.R': -95 }, root: { y: -0.05 } },
            { t: 'active', r: { ...GUARD, torso: 14, 'armUpper.R': 85, 'armFore.R': -6, 'legUpper.L': 30, 'legUpper.R': -30, 'legLower.R': 20 }, root: { y: 0.02 } },
            { t: 'recover', r: { ...GUARD, torso: 8, 'armUpper.R': 55, 'armFore.R': -25 } },
            { t: 'end', r: GUARD },
        ],
    },

    ATK_LOW: {
        phase: true, keys: [
            { t: 'start', r: { ...GUARD, torso: -16 }, root: { y: -0.18 } },
            { t: 'active', r: { torso: -26, head: 18, 'armUpper.R': -20, 'armFore.R': -60, 'armUpper.L': 30, 'armFore.L': -10, 'legUpper.L': 78, 'legLower.L': 4, 'legUpper.R': -50, 'legLower.R': 66 }, root: { y: -0.30 } },
            { t: 'recover', r: { ...GUARD, torso: -18 }, root: { y: -0.22 } },
            { t: 'end', r: GUARD, root: { y: 0 } },
        ],
    },

    // Grab / special / super share one committed full-body lunge for M1;
    // per-archetype flavour lands with the per-fighter clip overrides (M2).
    ATK_COMMIT: {
        phase: true, keys: [
            { t: 'start', r: { ...GUARD, torso: -12, 'armUpper.R': -55, 'armUpper.L': -35 }, root: { y: -0.04 } },
            { t: 'active', r: { ...GUARD, torso: 16, 'armUpper.R': 70, 'armFore.R': -15, 'armUpper.L': 66, 'armFore.L': -12, 'legUpper.R': -34, 'legLower.R': 26, 'legUpper.L': 34 }, root: { y: 0.03 } },
            { t: 'recover', r: { ...GUARD, torso: 6, 'armUpper.R': 40, 'armUpper.L': 30 } },
            { t: 'end', r: GUARD },
        ],
    },

    HIT: {
        dur: 1, keys: [
            {
                t: 0, r: {
                    torso: -22, head: -16,
                    'armUpper.R': 20, 'armFore.R': -30, 'armUpper.L': 26, 'armFore.L': -20,
                    'legUpper.R': -8, 'legLower.R': 14, 'legUpper.L': 10, 'legLower.L': 12,
                }, root: { y: -0.04, rz: -6 },
            },
        ],
    },

    JUGGLE: {
        dur: 1, keys: [
            {
                t: 0, r: {
                    torso: -30, head: -22,
                    'armUpper.R': -60, 'armFore.R': -20, 'armUpper.L': 45, 'armFore.L': -15,
                    'legUpper.R': -45, 'legLower.R': 60, 'legUpper.L': 35, 'legLower.L': 50,
                }, root: { rz: -38 },
            },
        ],
    },

    DOWN: {
        dur: 1, keys: [
            {
                t: 0, r: {
                    torso: 0, head: -8,
                    'armUpper.R': -70, 'armFore.R': -10, 'armUpper.L': 60, 'armFore.L': 10,
                    'legUpper.R': -12, 'legLower.R': 18, 'legUpper.L': 16, 'legLower.L': 22,
                }, root: { y: -0.72, rz: -84 },
            },
        ],
    },

    WAKEUP: {
        dur: 20, keys: [
            { t: 0, r: { torso: 0, head: -8, 'armUpper.R': -70, 'armFore.R': -10, 'armUpper.L': 60, 'armFore.L': 10, 'legUpper.R': -12, 'legLower.R': 18, 'legUpper.L': 16, 'legLower.L': 22 }, root: { y: -0.72, rz: -84 } },
            { t: 12, r: { torso: -20, head: 10, 'armUpper.R': -40, 'armFore.R': -60, 'armUpper.L': -20, 'armFore.L': -50, 'legUpper.R': -50, 'legLower.R': 66, 'legUpper.L': 54, 'legLower.L': 62 }, root: { y: -0.30, rz: -20 } },
            { t: 20, r: GUARD, root: { y: 0, rz: 0 } },
        ],
    },

    WIN: {
        dur: 120, keys: [
            { t: 0, r: GUARD, root: { y: 0 } },
            { t: 24, r: { torso: 6, head: -6, 'armUpper.R': 165, 'armFore.R': -10, 'armUpper.L': -10, 'armFore.L': -20, 'legUpper.R': -10, 'legLower.R': 8, 'legUpper.L': 12, 'legLower.L': 4 }, root: { y: 0 } },
            { t: 120, r: { torso: 6, head: -6, 'armUpper.R': 160, 'armFore.R': -14, 'armUpper.L': -10, 'armFore.L': -20, 'legUpper.R': -10, 'legLower.R': 8, 'legUpper.L': 12, 'legLower.L': 4 }, root: { y: 0 } },
        ],
    },
};

/** Engine state -> clip key. Attacks resolve separately via moveKey. */
export const STATE_CLIP = {
    IDLE: 'IDLE',
    MOVING: 'WALK',
    SIDESTEP: 'SIDESTEP',
    CROUCH: 'CROUCH',
    BLOCKING: 'BLOCK',
    HITSTUN: 'HIT',
    JUGGLED: 'JUGGLE',
    KNOCKDOWN: 'DOWN',
    WAKEUP: 'WAKEUP',
    WIN: 'WIN',
    LOSE: 'DOWN',
};

/** moveset slot -> attack clip. */
export const SLOT_CLIP = {
    light: 'ATK_LIGHT',
    heavy: 'ATK_HEAVY',
    low: 'ATK_LOW',
    grab: 'ATK_COMMIT',
    special: 'ATK_COMMIT',
    super: 'ATK_COMMIT',
};
