/**
 * YAMIWARD — TekkenCamera
 * ============================================================================
 * The camera is a gameplay system, not set dressing. In Tekken it does four
 * things at once, and getting any one of them wrong makes the game feel cheap:
 *
 *   1. Frames the MIDPOINT of the two fighters, not either one of them.
 *   2. Dollies out as they separate and in as they close, so a poke at range
 *      and a throw at point blank both read clearly.
 *   3. Sits PERPENDICULAR to the line between the fighters — the "side view"
 *      that keeps the 2D fighting plane legible even though movement is 3D.
 *   4. Rises and tilts as the action goes airborne, keeping juggles in frame.
 *
 * The subtle part is (3). The perpendicular has two solutions, and naively
 * recomputing it every frame makes the camera teleport across the arena the
 * instant the fighters cross over. Two guards prevent that: a minimum
 * separation below which the axis is considered undefined (we keep the last
 * good one), and side continuity — we only swap sides deliberately.
 *
 * All smoothing is frame-rate independent: alpha = 1 - exp(-lambda * dt).
 * Using a raw `lerp(a, b, 0.1)` per frame would make the camera behave
 * differently at 60fps and 144fps.
 */

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class TekkenCamera {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {Object} [opts]
     */
    constructor(camera, opts = {}) {
        this.camera = camera;

        // Separation range that the framing reacts to (world units).
        this.minSeparation = opts.minSeparation ?? 1.4;
        this.maxSeparation = opts.maxSeparation ?? 8.0;

        // Dolly distance at those extremes.
        this.minDistance = opts.minDistance ?? 5.9;
        this.maxDistance = opts.maxDistance ?? 11.2;

        // Camera height, and how high it looks — both rise with separation so
        // wide spacing reads from slightly above, like a broadcast angle.
        this.minHeight = opts.minHeight ?? 1.72;
        this.maxHeight = opts.maxHeight ?? 2.75;
        this.lookHeight = opts.lookHeight ?? 1.02;

        // Airborne framing: how much of the highest fighter's altitude to track.
        this.airTrack = opts.airTrack ?? 0.55;

        this.minFov = opts.minFov ?? 38;
        this.maxFov = opts.maxFov ?? 46;
        this.useFovZoom = opts.useFovZoom ?? true;

        // Smoothing rates (higher = snappier).
        this.posLambda = opts.posLambda ?? 6.5;
        this.lookLambda = opts.lookLambda ?? 8.0;
        this.fovLambda = opts.fovLambda ?? 5.0;

        /** Keep slot 0 on the left of frame. When they cross, the camera swings
         *  around rather than cutting — set false to let the camera hold its
         *  side and the fighters swap on screen instead. */
        this.keepP1Left = opts.keepP1Left ?? true;

        /** Below this separation the axis between fighters is meaningless
         *  (they are basically on top of each other) so we freeze the side. */
        this.minAxisSeparation = opts.minAxisSeparation ?? 0.75;

        this._a = null;
        this._b = null;

        this._axis = new THREE.Vector3(1, 0, 0);
        this._side = new THREE.Vector3(0, 0, 1);
        this._pos = new THREE.Vector3();
        this._look = new THREE.Vector3();
        this._fov = camera.fov;
        this._initialised = false;

        // impact shake
        this._shake = 0;
        this._shakeDecay = opts.shakeDecay ?? 7.0;
        this._shakeAmp = opts.shakeAmplitude ?? 0.09;
        this._shakeSeed = 1337;

        // Directional kick. Random jitter alone says "something happened"; it
        // does not say WHICH WAY. A right hook and a left hook shook the frame
        // identically, so every hit read the same. This carries the world-space
        // direction the blow travelled, and the camera lurches along it before
        // the jitter takes over — the frame moves with the punch.
        this._imp = new THREE.Vector3();
        this._impMag = 0;
        this._impDecay = opts.impulseDecay ?? 16.0;   // faster than jitter: a kick, not a wobble
        this._impAmp = opts.impulseAmplitude ?? 0.16;

        // ------------------------------------------------------------------
        // Cinematic layer
        // ------------------------------------------------------------------
        // Everything above frames the fight correctly. None of it makes the
        // fight look like a MOVIE — that is what this layer is for. It rides on
        // top of the framing as pure offsets, so the rig can never lose the
        // fighters no matter what the drama is doing.

        // Impact punch: a fast narrowing of FOV plus a shove toward the action.
        // Attack is short enough to land inside hitstop; release is slow enough
        // to feel like recoil rather than a snap back.
        this._punch = 0;             // 0..1 envelope value
        this._punchPhase = 0;        // seconds into the envelope
        this._punchPeak = 0;         // strength of the current punch
        this.punchAttack = opts.punchAttack ?? 0.09;
        this.punchRelease = opts.punchRelease ?? 0.25;
        this.punchFov = opts.punchFov ?? 8.0;      // degrees narrower at full strength
        this.punchDolly = opts.punchDolly ?? 0.14; // metres toward the action

        // Handheld. A camera bolted to a spline reads as CG; an operator never
        // holds perfectly still. Two incommensurate sine pairs give smooth,
        // non-repeating, allocation-free drift — deterministic, and presentation
        // only, so it can never desync the engine.
        this._hh = 0;
        this.handheldAmp = opts.handheldAmplitude ?? 0.022;
        this.handheldRate = opts.handheldRate ?? 1.0;

        // Hero angle: drop under the fighters and look up. Supers only — used
        // constantly it stops meaning anything.
        this._hero = 0;              // 0..1 blend into the low angle
        this._heroWant = 0;
        this._heroHold = 0;          // seconds left before it releases
        this.heroDrop = opts.heroDrop ?? 0.62;     // metres of camera height removed
        this.heroPull = opts.heroPull ?? 0.55;     // metres closer
        this.heroLift = opts.heroLift ?? 0.42;     // metres the look point rises

        // scratch — allocating vectors inside a 60Hz loop is how you get GC hitches
        this._t1 = new THREE.Vector3();
        this._t2 = new THREE.Vector3();
        this._t3 = new THREE.Vector3();
        this._mid = new THREE.Vector3();
    }

    /**
     * @param {THREE.Object3D} a slot 0
     * @param {THREE.Object3D} b slot 1
     */
    setFighters(a, b) { this._a = a; this._b = b; this._initialised = false; }

    /**
     * Call on a landed hit. `amount` roughly 0..1.
     *
     * `dirX`/`dirZ` are the world-space direction the blow travelled (attacker
     * toward defender). Passing them makes the frame kick that way; omitting
     * them falls back to pure jitter, which is right for things with no
     * direction (a parry, a round-start thud).
     */
    addShake(amount, dirX = 0, dirZ = 0) {
        this._shake = Math.min(1, this._shake + amount);
        const len = Math.hypot(dirX, dirZ);
        if (len > 1e-4) {
            this._imp.set(dirX / len, 0, dirZ / len);
            this._impMag = Math.min(1, this._impMag + amount);
        }
    }

    /**
     * Impact punch — call on a landed hit. `strength` roughly 0..1.
     *
     * Kept separate from addShake so the two can be tuned against each other:
     * shake is noise (something hit me), punch is emphasis (THAT hit).
     */
    punch(strength = 1) {
        const s = THREE.MathUtils.clamp(strength, 0, 1);
        // Never cut a bigger punch short with a smaller one landing on top.
        if (s >= this._punchPeak || this._punchPhase > this.punchAttack) {
            this._punchPeak = Math.max(s, this._punchPeak * 0.4);
            this._punchPhase = 0;
        }
    }

    /**
     * Hold a low hero angle for `seconds`. Supers and KOs only.
     * Re-calling extends the hold rather than restarting the ramp.
     */
    hero(seconds = 1.2) { this._heroHold = Math.max(this._heroHold, seconds); }

    /** Jump straight to the ideal framing (round start, cutscene cut). */
    snap() { this._initialised = false; }

    /**
     * @param {number} dt seconds since last frame
     */
    update(dt) {
        if (!this._a || !this._b) return;

        const pa = this._a.position, pb = this._b.position;

        // --- midpoint, with partial vertical tracking so juggles stay framed
        this._mid.set((pa.x + pb.x) * 0.5, 0, (pa.z + pb.z) * 0.5);
        const highest = Math.max(pa.y, pb.y);
        this._mid.y = highest * this.airTrack;

        // --- axis between fighters (horizontal only)
        const ax = this._t1.set(pb.x - pa.x, 0, pb.z - pa.z);
        const separation = ax.length();
        if (separation > this.minAxisSeparation) {
            this._axis.copy(ax).divideScalar(separation);
        } // else: keep the previous axis — they are too close to define one

        // --- perpendicular. cross(axis, UP) puts slot 0 on the left of frame
        //     (derivation: a lookAt camera's +X ends up ≈ +axis for this choice)
        const side = this._t2.crossVectors(this._axis, UP).normalize();
        if (this.keepP1Left) {
            this._side.copy(side);
        } else if (side.dot(this._side) < 0) {
            // hold the current side rather than cutting to the other one
            this._side.copy(side).negate();
        } else {
            this._side.copy(side);
        }

        // --- framing curve
        const t = THREE.MathUtils.clamp(
            (separation - this.minSeparation) / (this.maxSeparation - this.minSeparation), 0, 1);
        // ease so the camera is calm in mid-range and only opens up at extremes
        const e = t * t * (3 - 2 * t);
        const dist = THREE.MathUtils.lerp(this.minDistance, this.maxDistance, e);
        const height = THREE.MathUtils.lerp(this.minHeight, this.maxHeight, e);
        const fov = THREE.MathUtils.lerp(this.minFov, this.maxFov, e);

        // --- desired transform
        const want = this._t3.copy(this._mid)
            .addScaledVector(this._side, dist);
        want.y = this._mid.y + height;

        // --- hero angle: fold into the DESIRED transform, not the final one, so
        //     the rig's own smoothing eases in and out of it instead of the
        //     camera teleporting under the fighters on the frame a super lands.
        this._heroHold = Math.max(0, this._heroHold - dt);
        this._heroWant = this._heroHold > 0 ? 1 : 0;
        this._hero += (this._heroWant - this._hero) * (1 - Math.exp(-6.0 * dt));
        if (this._hero > 0.001) {
            want.y -= this.heroDrop * this._hero;
            want.addScaledVector(this._side, -this.heroPull * this._hero);
        }

        const wantLook = this._t1.copy(this._mid);
        wantLook.y = this._mid.y + this.lookHeight + this.heroLift * this._hero;

        if (!this._initialised) {
            this._pos.copy(want);
            this._look.copy(wantLook);
            this._fov = fov;
            this._initialised = true;
        } else {
            const ap = 1 - Math.exp(-this.posLambda * dt);
            const al = 1 - Math.exp(-this.lookLambda * dt);
            const af = 1 - Math.exp(-this.fovLambda * dt);
            this._pos.lerp(want, ap);
            this._look.lerp(wantLook, al);
            this._fov += (fov - this._fov) * af;
        }

        // --- impact shake, applied as an offset so it never fights the framing
        let sx = 0, sy = 0, sz = 0;
        if (this._shake > 0.001) {
            this._shakeSeed = (this._shakeSeed * 1103515245 + 12345) & 0x7fffffff;
            const r1 = ((this._shakeSeed >> 8) % 1000) / 500 - 1;
            this._shakeSeed = (this._shakeSeed * 1103515245 + 12345) & 0x7fffffff;
            const r2 = ((this._shakeSeed >> 8) % 1000) / 500 - 1;
            const amp = this._shake * this._shake * this._shakeAmp;
            sx = r1 * amp; sy = r2 * amp;
            this._shake *= Math.exp(-this._shakeDecay * dt);
        }
        // Directional kick rides on top, along the blow's own axis. The camera
        // moves WITH the punch (not against it): the frame is dragged in the
        // direction the force went, which is what sells the transfer of weight.
        if (this._impMag > 0.001) {
            const k = this._impMag * this._impMag * this._impAmp;
            sx += this._imp.x * k;
            sz += this._imp.z * k;
            sy -= k * 0.35;   // a touch of drop — impacts push the frame down
            this._impMag *= Math.exp(-this._impDecay * dt);
        }

        // --- impact punch envelope: fast in, slow out
        if (this._punchPeak > 0.001) {
            this._punchPhase += dt;
            if (this._punchPhase < this.punchAttack) {
                this._punch = this._punchPeak * (this._punchPhase / this.punchAttack);
            } else {
                const r = (this._punchPhase - this.punchAttack) / this.punchRelease;
                if (r >= 1) { this._punch = 0; this._punchPeak = 0; }
                else {
                    // cubic ease-out: most of the recoil is spent early, which
                    // is what makes it read as a hit rather than a zoom
                    const k = 1 - r;
                    this._punch = this._punchPeak * k * k * k;
                }
            }
        }
        // Dolly toward the fight along the view axis (never sideways — sideways
        // rotates the framing and the fighters slide across the screen).
        if (this._punch > 0.001) {
            sx -= this._side.x * this.punchDolly * this._punch;
            sz -= this._side.z * this.punchDolly * this._punch;
        }

        // --- handheld drift, always on, deliberately below conscious notice
        this._hh += dt * this.handheldRate;
        const hx = Math.sin(this._hh * 0.87) * 0.6 + Math.sin(this._hh * 2.13) * 0.4;
        const hy = Math.sin(this._hh * 1.31 + 1.7) * 0.6 + Math.sin(this._hh * 3.07) * 0.4;
        sx += hx * this.handheldAmp;
        sy += hy * this.handheldAmp;

        this.camera.position.set(this._pos.x + sx, this._pos.y + sy, this._pos.z + sz);
        this.camera.lookAt(this._look);

        // FOV: framing value, narrowed by the punch. The punch is applied at
        // write time rather than folded into _fov so it cannot be eaten by the
        // framing smoother — an 8-degree kick that takes 200ms to arrive is a
        // zoom, not an impact.
        const fovOut = this._fov - this.punchFov * this._punch;
        if (this.useFovZoom && Math.abs(this.camera.fov - fovOut) > 0.01) {
            this.camera.fov = fovOut;
            this.camera.updateProjectionMatrix();
        }
    }
}
