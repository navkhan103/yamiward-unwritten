/**
 * Fluid motion + slow-mo + KO camera for YAMIWARD UNWRITTEN
 */

/**
 * System 1: Per-joint pose springs
 */
export function createPoseSprings(jointIds, options = {}) {
    const defaults = {
        core: { omega: 2 * Math.PI * 7, zeta: 1.0 },      // root, torso, hips
        upperLimb: { omega: 2 * Math.PI * 6.5, zeta: 0.85 },
        // Authored zeta undershoots the visual damping (semi-implicit Euler
        // at 60Hz adds numerical damping on top). First playtest (2026-08-10)
        // read the 2π·4.0/0.55 tuning as floppy — stiffened so follow-through
        // is a hint, not a wobble.
        extremity: { omega: 2 * Math.PI * 6.0, zeta: 0.75 }
    };
    const { core, upperLimb, extremity } = { ...defaults, ...options };

    const coreStiffness = core.omega * core.omega;
    const coreDamping = 2 * core.zeta * core.omega;
    const upperLimbStiffness = upperLimb.omega * upperLimb.omega;
    const upperLimbDamping = 2 * upperLimb.zeta * upperLimb.omega;
    const extremityStiffness = extremity.omega * extremity.omega;
    const extremityDamping = 2 * extremity.zeta * extremity.omega;

    // Classify joints and initialize state. Robe/wings ride the springs as
    // extremities: their targets are derived per-frame by the doll, and cloth
    // lagging the body is exactly the drape physics we want.
    const state = new Map();

    for (const id of jointIds) {
        let stiffness, damping;
        if (id === 'torso' || id === 'hips') {
            stiffness = coreStiffness;
            damping = coreDamping;
        } else if (id.includes('Upper')) {
            stiffness = upperLimbStiffness;
            damping = upperLimbDamping;
        } else {
            stiffness = extremityStiffness;
            damping = extremityDamping;
        }

        state.set(id, {
            x: 0,
            v: 0,
            stiffness,
            damping
        });
    }

    // Root channels handled separately
    const rootState = {
        y: { x: 0, v: 0, stiffness: coreStiffness, damping: coreDamping },
        rz: { x: 0, v: 0, stiffness: coreStiffness, damping: coreDamping }
    };

    const outputMap = new Map();
    let outputY = 0;
    let outputRZ = 0;

    function step(targetRot, targetRootY, targetRootRZ, dt) {
        // Clamp dt to avoid numerical explosion
        const clampedDt = Math.min(dt, 1/30);

        // Two substeps: at 60Hz, omega*dt approaches 0.5 for the stiff
        // classes and semi-implicit Euler's numerical damping flattens the
        // authored response; halving h restores fidelity for pennies.
        const h = clampedDt / 2;
        // NOTE the parentheses: `?? 0 - s.x` would parse as `?? (0 - s.x)`
        // and detach the spring from its anchor.
        for (const [id, s] of state) {
            const target = targetRot[id] ?? 0;
            for (let sub = 0; sub < 2; sub++) {
                s.v += (s.stiffness * (target - s.x) - s.damping * s.v) * h;
                s.x += s.v * h;
            }
            outputMap.set(id, s.x);
        }

        // Process root channels
        const yState = rootState.y;
        yState.v += (yState.stiffness * (targetRootY - yState.x) - yState.damping * yState.v) * clampedDt;
        yState.x += yState.v * clampedDt;
        outputY = yState.x;

        const rzState = rootState.rz;
        rzState.v += (rzState.stiffness * (targetRootRZ - rzState.x) - rzState.damping * rzState.v) * clampedDt;
        rzState.x += rzState.v * clampedDt;
        outputRZ = rzState.x;

        return {
            rot: outputMap,
            rootY: outputY,
            rootRZ: outputRZ
        };
    }

    function reset(targetRot, targetRootY, targetRootRZ) {
        for (const [id, s] of state) {
            s.x = targetRot[id] ?? 0;
            s.v = 0;
            outputMap.set(id, s.x);
        }

        rootState.y.x = targetRootY;
        rootState.y.v = 0;
        rootState.rz.x = targetRootRZ;
        rootState.rz.v = 0;
        
        outputY = targetRootY;
        outputRZ = targetRootRZ;
    }

    return { step, reset };
}

/**
 * System 2: Presentation time control (slow motion)
 */
export function createTimeCtl() {
    let scale = 1.0;
    let active = false;

    // Envelope state: remaining time counts DOWN through hold then recovery.
    // The recover duration is stored at kick time so the phase test never
    // depends on which profile fired (the original draft hardcoded 'ko' and
    // fell to scale=1.0 mid-envelope after merged kicks).
    let dip = 1.0;
    let remaining = 0;
    let recover = 0;

    // KO is the ONLY deep slow-mo. Playtest verdict (2026-08-10): frequent
    // mid-combo dips read as stutter, not drama — counter's kick was removed
    // at the call site and wallsplat is a barely-there catch, not a dip.
    const profiles = {
        ko: { dip: 0.22, hold: 0.9, recover: 0.7 },
        counter: { dip: 0.5, hold: 0.30, recover: 0.25 },
        wallsplat: { dip: 0.8, hold: 0.12, recover: 0.15 }
    };

    function kick(kind) {
        const p = profiles[kind];
        if (!p) return;
        const total = p.hold + p.recover;
        if (active) {
            // Never pop faster mid-moment: keep the lower dip and the longer
            // remaining timeline (and that timeline's recovery tail).
            dip = Math.min(dip, p.dip);
            if (total > remaining) { remaining = total; recover = p.recover; }
        } else {
            dip = p.dip;
            remaining = total;
            recover = p.recover;
            active = true;
        }
    }

    function update(realDt) {
        if (!active) { scale = 1.0; return realDt; }
        remaining -= realDt;
        if (remaining <= 0) { scale = 1.0; active = false; return realDt; }
        if (remaining > recover) {
            scale = dip;                                  // hold phase
        } else {
            const t = 1 - remaining / recover;            // 0 -> 1 through recovery
            const s = t * t * (3 - 2 * t);                // smoothstep
            scale = dip + (1 - dip) * s;
        }
        return realDt * scale;
    }

    return {
        kick,
        update,
        get scale() { return scale; },
        get active() { return active; }
    };
}

/**
 * System 3: KO camera punch-in
 */
export function createKOCam() {
    let active = false;
    let startTime = 0;
    const duration = 1.6; // matches the 'ko' time profile
    let targetPos = null;
    let baseFov = null;   // captured lazily on the first apply() of a kick —
                          // kick() has no camera in hand, and a mid-pulse
                          // re-kick must keep the ORIGINAL base, not the
                          // currently-pulsed fov.

    function kick(pos) {
        targetPos = pos;
        if (!active) baseFov = null;
        active = true;
        startTime = 0;
    }

    function apply(camera, realDt) {
        if (!active || !targetPos) return;
        if (baseFov === null) baseFov = camera.fov;

        startTime += realDt;
        if (startTime >= duration) {
            active = false;
            // Restore original FOV exactly
            if (camera.fov !== baseFov) {
                camera.fov = baseFov;
                camera.updateProjectionMatrix();
            }
            return;
        }

        // Calculate envelope progress (0 at start, 1 at end)
        const t = Math.min(1, startTime / duration);

        // Position interpolation: 12-18% towards target, easing out
        // Peak influence at start, diminishing toward end
        const posInfluence = 0.18 * (1 - t*t); // easing out: 0.18 at start, 0 at end
        
        camera.position.lerpVectors(camera.position, targetPos, posInfluence);

        // FOV pulse: from baseFov to baseFov * 0.86, returning to baseFov
        const fovTarget = baseFov * (0.86 + (1 - 0.86) * t); // starts at 0.86 factor, returns to 1.0
        if (camera.fov !== fovTarget) {
            camera.fov = fovTarget;
            camera.updateProjectionMatrix();
        }
    }

    return { kick, apply };
}