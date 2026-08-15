/**
 * YAMIWARD — CombatEngine
 * ============================================================================
 * Renderer-agnostic fighting-game core. Knows nothing about Three.js: it moves
 * numbers, and main.js copies those numbers onto meshes. That separation is
 * what lets the whole engine be unit-tested headlessly and, later, run under
 * rollback netcode.
 *
 * CONTRACT — do not break these three rules, everything else depends on them:
 *   1. Fixed 60Hz. `step()` advances EXACTLY one frame (16.667ms). Never scale
 *      gameplay by delta-time; variable timesteps make frame data a lie.
 *   2. No wall-clock, no Math.random inside step(). The seeded RNG lives in
 *      engine state, so a match replays identically from (seed, inputs).
 *   3. Rendering never writes engine state. Read-only, always.
 *
 * FRAME DATA CONVENTION (matches how Tekken frame data is published):
 *   startup  = frames before the hitbox exists. A "i13" launcher has startup 13
 *              and its FIRST ACTIVE FRAME is frame index 13 (0-indexed).
 *   active   = frames the hitbox is live.
 *   recovery = frames after the hitbox dies, still vulnerable.
 *   total    = startup + active + recovery
 *   Frame advantage on block = blockStun - (framesLeftAfterContact)
 *
 * @module CombatEngine
 */

export const FPS = 60;
export const FRAME_MS = 1000 / FPS;

/** Fighter states. JUGGLED is distinct from HITSTUN: it has no ground friction
 *  and accepts follow-up hits with damage scaling. */
export const State = Object.freeze({
    IDLE: 'IDLE',
    MOVING: 'MOVING',
    SIDESTEP: 'SIDESTEP',
    CROUCH: 'CROUCH',
    ATTACKING: 'ATTACKING',
    BLOCKING: 'BLOCKING',
    HITSTUN: 'HITSTUN',
    JUGGLED: 'JUGGLED',
    KNOCKDOWN: 'KNOCKDOWN',
    WAKEUP: 'WAKEUP',
    WIN: 'WIN',
    LOSE: 'LOSE',
});

/** Attack/guard height matrix. */
export const Height = Object.freeze({
    HIGH: 'HIGH',   // blocked standing; CRUSHED by crouching (whiffs entirely)
    MID: 'MID',     // must be blocked standing — the answer to crouch-blocking
    LOW: 'LOW',     // must be blocked crouching; CRUSHED by being airborne
});

/**
 * @typedef {Object} MoveData
 * @property {string}  moveName
 * @property {string}  inputCommand      e.g. "f,f+2" — display + parser key
 * @property {number}  startupFrames
 * @property {number}  activeFrames
 * @property {number}  recoveryFrames
 * @property {string}  attackHeight      Height.HIGH | MID | LOW
 * @property {number}  damage
 * @property {number}  hitStun           frames the defender is stunned on hit
 * @property {number}  blockStun         frames the defender is stunned on block
 * @property {number}  [chipDamage]      damage dealt through a correct block
 * @property {number}  reach             hitbox forward offset + radius, world units
 * @property {number}  [hitboxRadius]
 * @property {number}  [hitboxHeight]    height of the hitbox centre off the floor
 * @property {number}  trackingDegrees   how far off-axis it still connects — the
 *                                       whole reason sidestepping matters
 * @property {{x:number,y:number,z:number}} knockbackOnHit
 * @property {{x:number,y:number,z:number}} knockbackOnBlock
 * @property {boolean} [launches]        LAUNCH IS AN EXPLICIT FLAG. Never derive
 *                                       it from knockback: if every heavy sends
 *                                       the opponent airborne the match becomes
 *                                       an unbroken knockdown loop and neutral
 *                                       never restarts. (Learned the hard way.)
 * @property {{x:number,y:number,z:number}} [launchImpulse]
 * @property {boolean} [groundBounce]
 * @property {boolean} [wallSplat]
 * @property {number}  [meterGainAttacker]
 * @property {number}  [meterGainDefender]
 * @property {number}  [meterCost]
 * @property {string}  [cancelInto]      move key this can be buffered into on contact
 * @property {boolean} [highCrush]       startup ducks highs (evasive low)
 * @property {boolean} [lowCrush]        startup leaves the ground (evasive)
 * @property {number}  [hitstop]         freeze frames on connect — impact weight
 * @property {boolean} [isSuper]
 */

/** Input bitmask. Directions are RELATIVE to facing, resolved by the caller. */
export const Btn = Object.freeze({
    BACK: 1, FORWARD: 2, STEP_LEFT: 4, STEP_RIGHT: 8, CROUCH: 16,
    LIGHT: 32, HEAVY: 64, LOW: 128, SUPER: 256,
    // SPECIAL is the archetype button: Yukiwari's needle, Raiga's rush,
    // Mayoi's feint, and — on Tetsuki alone — the command grab.
    SPECIAL: 512,
});

/** Buttons that can sit in the input buffer. Shared by control() and the
 *  hitstop freeze path, which both capture rising edges into that buffer. */
const ATTACK_BITS = Btn.LIGHT | Btn.HEAVY | Btn.LOW | Btn.SUPER | Btn.SPECIAL;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Deterministic RNG — state lives on the engine, never on Math. */
function xorshift(s) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return s | 0;
}

// ---------------------------------------------------------------------------

export class Fighter {
    /**
     * @param {Object} def character definition (see characters.js)
     * @param {number} slot 0 or 1
     */
    constructor(def, slot) {
        this.def = def;
        this.slot = slot;
        this.name = def.name;

        // Transform. y is height off the floor; x/z is the arena plane.
        this.pos = { x: slot === 0 ? -2.2 : 2.2, y: 0, z: 0 };
        this.vel = { x: 0, y: 0, z: 0 };
        this.facing = slot === 0 ? 1 : -1;      // +1 faces +x

        this.state = State.IDLE;
        this.stateFrame = 0;

        this.health = def.maxHealth;
        this.meter = 0;
        this.stun = 0;

        /** @type {MoveData|null} */
        this.move = null;
        this.moveKey = null;
        this.hitUsed = false;          // this swing already connected
        this.canCancel = false;

        this.airborne = false;
        this.crouching = false;
        this.juggleCount = 0;
        this.comboCount = 0;
        this.comboDamage = 0;
        this.invuln = 0;

        this.prevInput = 0;
        this.roundsWon = 0;

        // ---- archetype state ------------------------------------------------
        /** Armor hits still available on the CURRENT swing (see armorHits). */
        this.armorLeft = 0;
        /** Frostbite: multiplier on walk speed, and how long it lasts. */
        this.slowScale = 1;
        this.slowFrames = 0;
        /** Raiga's Static Charge. Resets to 0 on knockdown — that is the point. */
        this.charge = 0;

        // Buffered input: fighting games are unplayable without it. A button
        // pressed up to BUFFER frames early still comes out when it can.
        this.bufferedBtn = 0;
        this.bufferAge = 0;
    }

    get isAttacking() { return this.state === State.ATTACKING; }

    /** True while this fighter cannot act. */
    get isLocked() {
        return this.state === State.HITSTUN || this.state === State.JUGGLED ||
            this.state === State.KNOCKDOWN || this.state === State.WAKEUP ||
            this.state === State.WIN || this.state === State.LOSE;
    }

    /** Frames remaining in the current move after the current frame. */
    framesLeft() {
        if (!this.move) return 0;
        const total = this.move.startupFrames + this.move.activeFrames + this.move.recoveryFrames;
        return Math.max(0, total - this.stateFrame);
    }

    setState(s) {
        if (this.state !== s) { this.state = s; this.stateFrame = 0; }
    }
}

// ---------------------------------------------------------------------------

export class CombatEngine {
    /**
     * @param {Object} charA definition for slot 0
     * @param {Object} charB definition for slot 1
     * @param {Object} [opts]
     */
    constructor(charA, charB, opts = {}) {
        this.moves = opts.moves || {};
        this.seed = (opts.seed | 0) || 0x5eed1234;
        this.rng = this.seed;

        this.fighters = [new Fighter(charA, 0), new Fighter(charB, 1)];
        this.frame = 0;
        this.hitstop = 0;
        this.roundTime = opts.roundSeconds ?? 60;
        this.timer = this.roundTime * FPS;
        this.round = 1;
        this.roundsToWin = opts.roundsToWin ?? 2;
        this.phase = 'INTRO';          // INTRO | FIGHT | KO | MATCH_END
        this.phaseFrame = 0;
        this.winner = 0;               // 0 none/draw, 1 slot0, 2 slot1

        this.arenaRadius = opts.arenaRadius ?? 9;
        this.wallDistance = opts.wallDistance ?? 8;

        /** Consumers (renderer, audio, UI) subscribe; the engine never calls
         *  into them synchronously beyond pushing plain event objects. */
        this.events = [];

        this.gravity = opts.gravity ?? 0.055;
        this.pushRadius = opts.pushRadius ?? 0.62;

        /** Live travelling hitboxes. Presentation layer mirrors this list. */
        this.projectiles = [];
        this.projectileId = 0;
    }

    emit(type, data) { this.events.push(Object.assign({ type, frame: this.frame }, data)); }
    drainEvents() { const e = this.events; this.events = []; return e; }

    rand(n) { this.rng = xorshift(this.rng); return ((this.rng >>> 8) % n + n) % n; }

    other(f) { return this.fighters[1 - f.slot]; }

    // -- geometry ----------------------------------------------------------

    /** Horizontal distance, ignoring height. */
    flatDist(a, b) {
        const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    /** Signed angle (degrees) between attacker's facing and the line to target.
     *  This is what makes a sidestep actually evade: a move only connects if the
     *  target is inside the move's trackingDegrees cone. */
    offAxisDegrees(att, def) {
        const dx = def.pos.x - att.pos.x, dz = def.pos.z - att.pos.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1e-6;
        const fx = att.facing, fz = 0;                    // facing is along ±x
        const dot = (dx / len) * fx + (dz / len) * fz;
        return Math.acos(clamp(dot, -1, 1)) * 180 / Math.PI;
    }

    // -- input -------------------------------------------------------------

    /**
     * Advance the simulation exactly one frame.
     * @param {[number, number]} inputs raw bitmasks for slot 0 and slot 1
     */
    step(inputs) {
        this.frame++;

        // Hitstop: the freeze on impact. Nothing moves, but the clock on
        // cosmetics keeps running. This is most of what "weight" feels like.
        //
        // Input is still SAMPLED during the freeze, and that is not cosmetic.
        // Hitstop is exactly when a player inputs the follow-up — it is the
        // combo window, and `cancelInto` below reads the buffer this fills.
        // control() is the only place prevInput advances and bufferedBtn is
        // set, so skipping it outright meant a press-and-release inside the
        // freeze vanished: at 60Hz a super's 16-frame stop is ~267ms, longer
        // than a normal tap. Held buttons always survived (the rising edge
        // just landed late, on the first unfrozen frame); taps did not.
        if (this.hitstop > 0) {
            this.hitstop--;
            for (let i = 0; i < 2; i++) this.bufferDuringFreeze(this.fighters[i], inputs[i] | 0);
            return;
        }

        if (this.phase === 'INTRO') {
            this.phaseFrame++;
            if (this.phaseFrame > 90) { this.phase = 'FIGHT'; this.phaseFrame = 0; this.emit('fight'); }
            return;
        }
        if (this.phase === 'KO' || this.phase === 'MATCH_END') {
            this.phaseFrame++;
            for (const f of this.fighters) this.physics(f);
            if (this.phase === 'KO' && this.phaseFrame > 120) this.nextRound();
            return;
        }

        this.timer--;
        if (this.timer <= 0) { this.timer = 0; return this.timeOut(); }

        for (let i = 0; i < 2; i++) this.tickStatus(this.fighters[i]);
        for (let i = 0; i < 2; i++) this.control(this.fighters[i], inputs[i] | 0);
        for (let i = 0; i < 2; i++) this.physics(this.fighters[i]);
        this.pushApart();
        for (let i = 0; i < 2; i++) this.resolveHit(this.fighters[i], this.fighters[1 - i]);
        this.stepProjectiles();
        for (let i = 0; i < 2; i++) this.faceOpponent(this.fighters[i]);

        if (this.fighters[0].health <= 0 || this.fighters[1].health <= 0) this.knockout();
    }

    // -----------------------------------------------------------------------
    // Status effects (Frostbite, Static Charge)
    // -----------------------------------------------------------------------

    /**
     * Frostbite decays on a timer; Static Charge does not decay with time —
     * it is spent by getting knocked down. Two different pressure clocks on
     * purpose: Yukiwari's debuff rewards patience, Raiga's buff rewards
     * never letting go.
     */
    tickStatus(f) {
        if (f.slowFrames > 0) {
            f.slowFrames--;
            if (f.slowFrames === 0) {
                f.slowScale = 1;
                this.emit('statusend', { slot: f.slot, kind: 'frostbite' });
            }
        }
    }

    /** Walk speed after Frostbite and Static Charge are applied. */
    speedFor(f, base) {
        const chargeBonus = (f.def.chargeSpeedPerStack ?? 0) * f.charge;
        return (base + chargeBonus) * f.slowScale;
    }

    /** Startup is shortened by Static Charge — Raiga literally gets faster. */
    startupFor(f, m) {
        const per = f.def.chargeStartupPerStack ?? 0;
        if (!per || !f.charge) return m.startupFrames;
        return Math.max(4, Math.round(m.startupFrames - per * f.charge));
    }

    // -----------------------------------------------------------------------
    // Projectiles
    // -----------------------------------------------------------------------

    spawnProjectile(att, m) {
        const p = m.projectile;
        this.projectiles.push({
            id: ++this.projectileId,
            owner: att.slot,
            move: m,
            x: att.pos.x + att.facing * 0.65,
            y: p.height ?? 1.15,
            z: att.pos.z,
            vx: att.facing * p.speed,
            life: p.life ?? 90,
            radius: p.radius ?? 0.3,
            color: p.color ?? 0xffffff,
        });
        this.emit('projectilespawn', { slot: att.slot, move: m });
    }

    /**
     * Travelling hitboxes. Deliberately simple: they fly straight, they hit
     * once, and they die on contact or timeout. A projectile that lingers or
     * curves is a balance nightmare in a game with a sidestep.
     */
    stepProjectiles() {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const pr = this.projectiles[i];
            pr.x += pr.vx;
            pr.life--;

            const def = this.fighters[1 - pr.owner];
            const dx = Math.abs(def.pos.x - pr.x);
            const dz = Math.abs(def.pos.z - pr.z);
            const hit = dx < pr.radius + this.pushRadius && dz < pr.radius + 0.45 && !def.airborne;

            if (hit) {
                this.applyProjectileHit(this.fighters[pr.owner], def, pr);
                this.projectiles.splice(i, 1);
                continue;
            }
            if (pr.life <= 0 || Math.abs(pr.x) > 14) {
                this.emit('projectileend', { id: pr.id });
                this.projectiles.splice(i, 1);
            }
        }
    }

    applyProjectileHit(att, def, pr) {
        const m = pr.move;
        if (def.invuln > 0) { this.emit('projectileend', { id: pr.id }); return; }

        // A projectile is blockable by anyone guarding, either stance. Frost
        // Needle's job is chip and Frostbite, not a mixup.
        const guarding = def.state === State.BLOCKING && !def.airborne;
        if (guarding) {
            const chip = m.chipDamage ?? 2;
            def.health = Math.max(0, def.health - chip);
            def.stun = m.blockStun;
            def.setState(State.BLOCKING);
            def.meter = clamp(def.meter + (m.meterGainDefender ?? 3), 0, 100);
            att.canCancel = true;
            this.emit('block', { slot: def.slot, move: m, projectile: true });
            this.emit('projectileend', { id: pr.id });
            return;
        }

        def.comboCount++;
        const scale = Math.max(0.3, 1 - (def.comboCount - 1) * 0.11);
        const dmg = Math.max(1, Math.round(m.damage * scale));
        def.health = Math.max(0, def.health - dmg);
        def.comboDamage += dmg;
        def.vel.x = Math.sign(pr.vx) * m.knockbackOnHit.x;
        def.stun = m.hitStun;
        def.setState(State.HITSTUN);
        this.applyOnHitEffects(att, def, m);

        att.meter = clamp(att.meter + (m.meterGainAttacker ?? 6), 0, 100);
        // resolveHit() (the attached-hitbox path) grants this on both block
        // and hit; this projectile path never did, so Shigure's drizzle ->
        // super — her one cancel that depends on a projectile connecting,
        // not a normal — could never fire. Same bug family as buttonForKey.
        att.canCancel = true;
        this.hitstop = m.hitstop ?? 5;
        this.emit('hit', {
            slot: def.slot, attacker: att.slot, move: m, damage: dmg,
            counter: false, combo: def.comboCount, comboDamage: def.comboDamage,
            projectile: true,
        });
        this.emit('projectileend', { id: pr.id });
    }

    /** Shared on-hit riders: Frostbite application and Static Charge gain. */
    applyOnHitEffects(att, def, m) {
        if (m.applySlow) {
            // Refresh rather than stack — stacking slows spirals into a stunlock.
            def.slowScale = Math.min(def.slowScale, m.applySlow.scale);
            def.slowFrames = Math.max(def.slowFrames, m.applySlow.frames);
            this.emit('status', { slot: def.slot, kind: 'frostbite', scale: def.slowScale });
        }
        if (m.chargeGain) {
            const cap = att.def.maxCharge ?? 0;
            if (cap > 0) {
                const before = att.charge;
                att.charge = Math.min(cap, att.charge + m.chargeGain);
                if (att.charge !== before) this.emit('status', { slot: att.slot, kind: 'charge', value: att.charge });
            }
        }
    }

    faceOpponent(f) {
        // Only turn while neutral; turning mid-move is a classic exploit.
        if (f.state === State.IDLE || f.state === State.MOVING || f.state === State.CROUCH) {
            f.facing = this.other(f).pos.x >= f.pos.x ? 1 : -1;
        }
    }

    /**
     * The buffering half of control(), for frames the simulation is frozen by
     * hitstop. Captures the rising edge into the input buffer and nothing
     * else — no state machine, no stateFrame, no physics.
     *
     * The buffer is deliberately NOT aged here. No game time passes for a
     * fighter during a freeze, so a button pressed into the stop should still
     * be waiting when it lifts; aging it would let a long super freeze expire
     * the very input the freeze exists to let you make.
     *
     * Deterministic from (state, inputs), so the replay contract at the top of
     * this file still holds.
     */
    bufferDuringFreeze(f, raw) {
        const pressed = raw & ~f.prevInput;
        f.prevInput = raw;
        if (pressed & ATTACK_BITS) {
            f.bufferedBtn = pressed & ATTACK_BITS;
            f.bufferAge = 6;
        }
    }

    control(f, raw) {
        const pressed = raw & ~f.prevInput;
        f.prevInput = raw;
        f.stateFrame++;

        if (f.invuln > 0) f.invuln--;
        if (f.bufferAge > 0) { f.bufferAge--; if (f.bufferAge === 0) f.bufferedBtn = 0; }
        if (pressed & ATTACK_BITS) {
            f.bufferedBtn = pressed & ATTACK_BITS;
            f.bufferAge = 6;
        }

        // ---- locked states -------------------------------------------------
        if (f.state === State.HITSTUN) {
            f.stun--;
            if (f.stun <= 0) { f.setState(State.IDLE); f.comboCount = 0; f.comboDamage = 0; }
            return;
        }
        if (f.state === State.JUGGLED) {
            if (f.pos.y <= 0 && f.vel.y <= 0) {
                f.pos.y = 0; f.airborne = false;
                f.setState(State.KNOCKDOWN); f.stun = 40;
                // A knocked-down fighter had no invuln at all — resolveHit
                // only checks def.invuln, and KNOCKDOWN never set it (only
                // WAKEUP did, 480 lines down). A meaty hit landing on frame 1
                // of a knockdown converted it straight into HITSTUN/JUGGLED,
                // deleting the escape entirely: knock down, meaty, knock
                // down, meaty, forever. Invuln now covers the whole knockdown
                // (WAKEUP's own 10-frame grant takes over the instant it ends).
                f.invuln = f.stun;
                f.comboCount = 0; f.comboDamage = 0; f.juggleCount = 0;
                // Static Charge dies on the floor. Raiga's whole shadow arc is
                // that he needs the momentum, and losing it once costs him
                // everything he had built.
                if (f.charge > 0) {
                    f.charge = 0;
                    this.emit('status', { slot: f.slot, kind: 'charge', value: 0, lost: true });
                }
                this.emit('ground', { slot: f.slot });
            }
            return;
        }
        if (f.state === State.KNOCKDOWN) {
            f.stun--;
            if (f.stun <= 0) { f.setState(State.WAKEUP); f.invuln = 10; }
            return;
        }
        if (f.state === State.WAKEUP) {
            if (f.stateFrame > 14) f.setState(State.IDLE);
            return;
        }
        if (f.state === State.WIN || f.state === State.LOSE) return;

        // ---- attacking -----------------------------------------------------
        if (f.state === State.ATTACKING) {
            const m = f.move;
            const startup = this.startupFor(f, m);
            const total = startup + m.activeFrames + m.recoveryFrames;

            // Projectile moves release on their first active frame, then the
            // fighter is stuck in recovery while the needle does the work —
            // that recovery IS the counterplay to a zoner.
            if (m.projectile && !f.hitUsed && f.stateFrame >= startup) {
                f.hitUsed = true;
                this.spawnProjectile(f, m);
            }

            // Advancing moves only carry momentum during startup.
            if (m.advanceSpeed && f.stateFrame >= startup) f.vel.x = 0;

            // Cancel window: a connected move can be buffered into its follow-up.
            if (f.canCancel && m.cancelInto && f.stateFrame >= startup + m.activeFrames) {
                const nxt = this.moves[m.cancelInto];
                if (nxt && (f.bufferedBtn & this.buttonForKey(f, m.cancelInto))) { this.startMove(f, m.cancelInto); return; }
            }
            if (f.stateFrame >= total) {
                f.setState(f.airborne ? State.MOVING : State.IDLE);
                f.move = null; f.canCancel = false;
            }
            return;
        }

        // ---- sidestep (committed, cannot be cancelled) ---------------------
        if (f.state === State.SIDESTEP) {
            const dur = f.def.sidestepFrames ?? 22;
            const t = f.stateFrame / dur;
            const speed = f.def.sidestepSpeed ?? 0.085;
            // ease out — a burst then a settle, so the step reads as a step
            f.vel.z = f.stepDir * speed * (1 - t) * 2;
            if (f.stateFrame >= dur) { f.vel.z = 0; f.setState(State.IDLE); }
            else if (f.bufferedBtn) {
                // stepping into an attack is the core Tekken offence
                const key = this.moveForButton(f, f.bufferedBtn);
                if (key) { f.bufferedBtn = 0; this.startMove(f, key); }
            }
            return;
        }

        if (f.airborne) return;    // no air control in this prototype

        // ---- neutral -------------------------------------------------------
        const wantSuper = (raw & Btn.SUPER) && f.meter >= 100;
        const btn = wantSuper ? Btn.SUPER : (f.bufferedBtn || 0);
        if (btn) {
            const key = this.moveForButton(f, btn);
            if (key) { f.bufferedBtn = 0; this.startMove(f, key); return; }
        }

        const holdBack = !!(raw & Btn.BACK);
        const holdFwd = !!(raw & Btn.FORWARD);
        const holdDown = !!(raw & Btn.CROUCH);

        // Sidestep on a TAP of step-left/right; the axis Tekken is built on.
        if (pressed & Btn.STEP_LEFT) { f.stepDir = -1; f.setState(State.SIDESTEP); return; }
        if (pressed & Btn.STEP_RIGHT) { f.stepDir = 1; f.setState(State.SIDESTEP); return; }

        f.crouching = holdDown;

        // Blocking is holding away — no dedicated block button.
        if (holdBack) {
            f.setState(State.BLOCKING);
            f.vel.x = -f.facing * this.speedFor(f, f.def.walkBack);
            f.vel.z = 0;
            return;
        }
        if (holdDown) { f.setState(State.CROUCH); f.vel.x = 0; f.vel.z = 0; return; }
        if (holdFwd) { f.setState(State.MOVING); f.vel.x = f.facing * this.speedFor(f, f.def.walkForward); f.vel.z = 0; return; }

        f.setState(State.IDLE);
        f.vel.x = 0; f.vel.z = 0;
    }

    // What button reaches `key` for THIS fighter — the exact inverse of
    // moveForButton(), looked up from the fighter's own moveset. This
    // replaced a damage-threshold guess (isSuper -> SUPER, else damage>=25
    // -> HEAVY else LIGHT) that had no case for SPECIAL at all and put every
    // heavy in the cast (all of them under 25 damage) on the wrong button.
    // Net effect: EVERY tier-1 cancel in the game (jab -> the character's
    // signature special/heavy — Mayoi's whole "cancels into everything"
    // identity, Raiga's Thunder Rush, all of it) silently never fired,
    // because the buffered button never matched what this function computed.
    buttonForKey(f, key) {
        const ms = f.def.moveset;
        if (ms.super === key) return Btn.SUPER;
        if (ms.special === key || ms.grab === key) return Btn.SPECIAL;
        if (ms.lowCrouch === key || ms.low === key) return Btn.LOW;
        if (ms.heavy === key) return Btn.HEAVY;
        if (ms.light === key) return Btn.LIGHT;
        return 0;
    }

    moveForButton(f, btn) {
        const list = f.def.moveset;
        if (btn & Btn.SUPER) return list.super;
        if (btn & Btn.SPECIAL) return list.special || list.grab || null;
        if (btn & Btn.LOW) return f.crouching ? (list.lowCrouch || list.low) : list.low;
        if (btn & Btn.HEAVY) return list.heavy;
        if (btn & Btn.LIGHT) return list.light;
        return null;
    }

    startMove(f, key) {
        const m = this.moves[key];
        if (!m) return;
        if (m.meterCost && f.meter < m.meterCost) return;
        if (m.meterCost) f.meter = Math.max(0, f.meter - m.meterCost);
        f.move = m; f.moveKey = key;
        // setState() only resets stateFrame on an ACTUAL state change — but a
        // cancel (jab -> special, launcher -> super) calls startMove() while
        // f.state is ALREADY ATTACKING, so setState() is a no-op and the new
        // move inherited the old move's frame count. If that count already
        // exceeded the new move's total (startup+active+recovery), the new
        // move satisfied its own end-of-move check on the very next control()
        // tick and completed with its hitbox never activating — a move that
        // visibly starts and vanishes with no hit, no block, nothing. Frame
        // count must always restart at 0 when a move BEGINS, cancel or not.
        f.state = State.ATTACKING;
        f.stateFrame = 0;
        f.hitUsed = false; f.canCancel = false;

        // Armor is armed at the START of the swing and is gone when it ends —
        // it never carries over into the next move.
        f.armorLeft = m.armorHits ?? 0;

        // Advancing moves carry the fighter forward instead of rooting them.
        // This is how a 0.046-walk grappler and a rushdown both close space.
        f.vel.x = m.advanceSpeed ? f.facing * m.advanceSpeed : 0;
        f.vel.z = 0;

        this.emit('move', { slot: f.slot, key, move: m, armored: f.armorLeft > 0 });
    }

    physics(f) {
        f.pos.x += f.vel.x;
        f.pos.z += f.vel.z;

        if (f.airborne || f.pos.y > 0) {
            f.pos.y += f.vel.y;
            f.vel.y -= this.gravity;
            if (f.pos.y <= 0) { f.pos.y = 0; f.vel.y = 0; f.airborne = false; }
        }

        // ground friction on knockback slides
        if (!f.airborne && (f.state === State.HITSTUN || f.state === State.KNOCKDOWN)) {
            f.vel.x *= 0.82;
            f.vel.z *= 0.82;
            if (Math.abs(f.vel.x) < 0.002) f.vel.x = 0;
            if (Math.abs(f.vel.z) < 0.002) f.vel.z = 0;
        }

        // arena bounds — a wall hit during a juggle is a combo extender
        const r = this.arenaRadius;
        if (f.pos.x < -r) { f.pos.x = -r; this.onWall(f); }
        if (f.pos.x > r) { f.pos.x = r; this.onWall(f); }
        if (f.pos.z < -r) { f.pos.z = -r; f.vel.z = 0; }
        if (f.pos.z > r) { f.pos.z = r; f.vel.z = 0; }
    }

    onWall(f) {
        if (f.state === State.JUGGLED && Math.abs(f.vel.x) > 0.06) {
            f.vel.x = -f.vel.x * 0.25;
            this.hitstop = 8;
            this.emit('wallsplat', { slot: f.slot });
        } else {
            f.vel.x = 0;
        }
    }

    pushApart() {
        const [a, b] = this.fighters;
        if (a.airborne && b.airborne) return;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const min = this.pushRadius * 2;
        if (d >= min || d < 1e-6) return;
        const push = (min - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
    }

    // -- hit resolution ----------------------------------------------------

    /** Is the hitbox live this frame? */
    activeNow(f) {
        if (f.state !== State.ATTACKING || !f.move || f.hitUsed) return false;
        const m = f.move;
        // Projectile moves have no attached hitbox — the needle carries it.
        if (m.projectile) return false;
        const startup = this.startupFor(f, m);
        return f.stateFrame >= startup && f.stateFrame < startup + m.activeFrames;
    }

    resolveHit(att, def) {
        if (!this.activeNow(att)) return;
        const m = att.move;

        const dist = this.flatDist(att, def);
        if (dist > m.reach + this.pushRadius) return;

        // 3D evasion: stepped off the attack's tracking cone => clean whiff.
        if (this.offAxisDegrees(att, def) > (m.trackingDegrees ?? 25)) {
            att.hitUsed = true;
            this.emit('whiff', { slot: att.slot, reason: 'sidestepped' });
            return;
        }

        // Height crush: crouching ducks highs entirely; airborne clears lows.
        if (m.attackHeight === Height.HIGH && def.crouching && !def.airborne) {
            att.hitUsed = true;
            this.emit('crush', { slot: def.slot, kind: 'high' });
            return;
        }
        if (m.attackHeight === Height.LOW && def.airborne) {
            att.hitUsed = true;
            this.emit('crush', { slot: def.slot, kind: 'low' });
            return;
        }

        att.hitUsed = true;
        if (def.invuln > 0) return;

        // Guard matrix: standing blocks HIGH+MID, crouching blocks LOW+HIGH.
        // MID beating crouch-block is what forces players to stand up.
        // The guard matrix IS the game. Standing guard covers high and mid;
        // crouching guard covers low. Neither covers everything, which is what
        // creates the low/mid mix-up the whole neutral game is built around.
        //   HIGH  -> blocked standing (crouching already crushed it above)
        //   MID   -> blocked ONLY standing  — punishes crouch-blockers
        //   LOW   -> blocked ONLY crouching — punishes stand-blockers
        // A grab ignores the guard matrix entirely — that is its whole reason
        // to exist — but it cannot touch an airborne opponent, and its 34
        // recovery frames mean reading it beats blocking it.
        if (m.isGrab && def.airborne) {
            this.emit('whiff', { slot: att.slot, reason: 'grab-airborne' });
            return;
        }

        const guarding = def.state === State.BLOCKING && !def.airborne;
        let blocked = false;
        if (guarding && !m.isGrab) {
            if (m.attackHeight === Height.MID) blocked = !def.crouching;
            else if (m.attackHeight === Height.LOW) blocked = def.crouching;
            else blocked = true;
        }

        // Armor: the defender is mid-swing on an armored move, so they eat the
        // hit and keep going. Costs real health (armor is not invulnerability)
        // and burns the armor for the rest of that swing.
        // The armor WINDOW is startup + active only. It used to be the whole
        // ATTACKING state, which on Iron Advance meant 16 startup + 3 active +
        // 20 RECOVERY — armor covering the escape as well as the approach, so
        // the first punish anyone threw at a whiffed or blocked advance was
        // simply eaten. That is the opposite of the trade armor is supposed to
        // be: commit early, be vulnerable late. It was worth 42 points of win
        // rate (Tetsuki 99% -> 57% in tools/tune.mjs when armor was removed
        // entirely, and he is the only fighter in the cast who has any), and it
        // quietly cancelled the counter-play every other archetype depends on.
        const dArmorWindow = def.move &&
            def.stateFrame < this.startupFor(def, def.move) + (def.move.activeFrames ?? 0);
        if (!blocked && def.state === State.ATTACKING && def.armorLeft > 0 && dArmorWindow &&
            !def.airborne && !m.isSuper) {
            def.armorLeft--;
            // What armor COSTS. At 0.5 the armored fighter eats half and walks
            // through, which is close to free: Iron Advance out-trades every
            // opener in the cast because absorbing one is cheaper than blocking
            // it. The scale is per-move so the price can be authored per armor
            // move rather than balanced globally.
            const chip = Math.max(1, Math.round(m.damage * (def.move.armorChip ?? 0.5)));
            def.health = Math.max(0, def.health - chip);
            att.meter = clamp(att.meter + (m.meterGainAttacker ?? 6) * 0.5, 0, 100);
            this.hitstop = Math.round((m.hitstop ?? 6) * 0.7);
            this.emit('armor', { slot: def.slot, attacker: att.slot, move: m, damage: chip });
            return;
        }

        if (blocked) {
            const chip = m.chipDamage ?? Math.round(m.damage * 0.08);
            def.health = Math.max(0, def.health - chip);
            def.stun = m.blockStun;
            def.setState(State.BLOCKING);
            const kb = m.knockbackOnBlock;
            def.vel.x = att.facing * kb.x; def.vel.z = kb.z;
            att.vel.x = -att.facing * kb.x * 0.4;
            att.meter = clamp(att.meter + (m.meterGainAttacker ?? 4) * 0.5, 0, 100);
            def.meter = clamp(def.meter + (m.meterGainDefender ?? 3), 0, 100);
            this.hitstop = Math.round((m.hitstop ?? 6) * 0.5);
            att.canCancel = true;
            this.emit('block', { slot: def.slot, move: m, advantage: this.advantageOnBlock(m) });
            return;
        }

        // Counter-hit: caught them during their own startup or active frames.
        const counter = def.state === State.ATTACKING &&
            def.stateFrame < this.startupFor(def, def.move) + def.move.activeFrames;

        def.comboCount++;
        // Damage scaling — without it a single launch deletes a health bar.
        const scale = Math.max(0.3, 1 - (def.comboCount - 1) * 0.11);
        const raw = m.damage * (counter ? 1.25 : 1);
        const dmg = Math.max(1, Math.round(raw * scale));
        def.health = Math.max(0, def.health - dmg);
        def.comboDamage += dmg;

        const kb = m.knockbackOnHit;
        def.vel.x = att.facing * kb.x;
        def.vel.z = kb.z;

        if (m.launches && !def.airborne) {
            const li = m.launchImpulse || { x: 0.04, y: 0.32, z: 0 };
            def.vel.x = att.facing * li.x;
            def.vel.y = li.y;
            def.airborne = true;
            def.juggleCount = 1;
            def.setState(State.JUGGLED);
        } else if (def.airborne) {
            def.vel.y = Math.max(def.vel.y, 0.12);   // keep them up for the juggle
            def.juggleCount++;
            def.setState(State.JUGGLED);
        } else {
            def.stun = m.hitStun;
            def.setState(State.HITSTUN);
        }

        this.applyOnHitEffects(att, def, m);

        att.meter = clamp(att.meter + (m.meterGainAttacker ?? 6), 0, 100);
        def.meter = clamp(def.meter + (m.meterGainDefender ?? 3), 0, 100);
        att.canCancel = true;
        this.hitstop = m.hitstop ?? 7;
        this.emit('hit', {
            slot: def.slot, attacker: att.slot, move: m, damage: dmg,
            counter, combo: def.comboCount, comboDamage: def.comboDamage,
            advantage: this.advantageOnHit(m),
        });
    }

    /** Published-style frame advantage, assuming contact on the first active frame. */
    advantageOnHit(m) { return m.hitStun - (m.activeFrames - 1 + m.recoveryFrames); }
    advantageOnBlock(m) { return m.blockStun - (m.activeFrames - 1 + m.recoveryFrames); }

    // -- round flow --------------------------------------------------------

    knockout() {
        this.phase = 'KO'; this.phaseFrame = 0;
        this.hitstop = 20;
        const dead = this.fighters[0].health <= 0 ? 0 : 1;
        if (this.fighters[0].health <= 0 && this.fighters[1].health <= 0) {
            this.winner = 0;
            this.fighters[0].setState(State.LOSE); this.fighters[1].setState(State.LOSE);
        } else {
            const alive = 1 - dead;
            this.fighters[dead].setState(State.LOSE);
            this.fighters[alive].roundsWon++;
            this.winner = alive + 1;
        }
        this.emit('ko', { winner: this.winner });
    }

    timeOut() {
        this.phase = 'KO'; this.phaseFrame = 0;
        const [a, b] = this.fighters;
        if (a.health === b.health) this.winner = 0;
        else {
            const w = a.health > b.health ? 0 : 1;
            this.fighters[w].roundsWon++;
            this.winner = w + 1;
            this.fighters[1 - w].setState(State.LOSE);
        }
        this.emit('timeout', { winner: this.winner });
    }

    nextRound() {
        const [a, b] = this.fighters;
        if (a.roundsWon >= this.roundsToWin || b.roundsWon >= this.roundsToWin) {
            this.phase = 'MATCH_END'; this.phaseFrame = 0;
            const w = a.roundsWon > b.roundsWon ? 0 : 1;
            this.fighters[w].setState(State.WIN);
            this.fighters[1 - w].setState(State.LOSE);
            this.winner = w + 1;
            this.emit('matchend', { winner: this.winner });
            return;
        }
        this.round++;
        this.timer = this.roundTime * FPS;
        this.phase = 'INTRO'; this.phaseFrame = 0;
        this.winner = 0;
        this.fighters.forEach((f, i) => {
            f.pos = { x: i === 0 ? -2.2 : 2.2, y: 0, z: 0 };
            f.vel = { x: 0, y: 0, z: 0 };
            f.facing = i === 0 ? 1 : -1;
            f.health = f.def.maxHealth;
            f.meter = Math.round(f.meter * 0.5);
            f.setState(State.IDLE);
            f.stun = 0; f.comboCount = 0; f.comboDamage = 0;
            f.airborne = false; f.juggleCount = 0; f.move = null;
            f.hitUsed = false; f.canCancel = false; f.invuln = 0;
            f.armorLeft = 0; f.slowScale = 1; f.slowFrames = 0; f.charge = 0;
        });
        this.projectiles.length = 0;
        this.emit('round', { round: this.round });
    }
}
