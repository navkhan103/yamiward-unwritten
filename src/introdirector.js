import { Vector3 } from 'three';

const SMOOTHSTEP = (x) => x * x * (3 - 2 * x);

export function createIntroDirector() {
    return new IntroDirector();
}

class IntroDirector {
    constructor() {
        this.active = false;
        this._state = 0;
        this._clock = 0;
        this._ctx = null;
        this._resolve = null;
        this._announced = false;   // one-shot latch per state (announce/hold)
        this._scratch = {
            mid: new Vector3(),
            pos: new Vector3(),
            target: new Vector3()
        };
    }

    async start(ctx) {
        if (this.active) return;
        this.active = true;
        this._state = 0;
        this._clock = 0;
        this._ctx = ctx;
        this._resolve = null;

        return new Promise((resolve) => {
            this._resolve = resolve;
        });
    }

    apply(camera, realDt) {
        if (!this.active) return;

        this._clock += realDt;

        const { meshes, defs, overlay, lines, faces } = this._ctx;
        const { mid, pos, target } = this._scratch;

        // Compute midpoint
        mid.copy(meshes[0].position).add(meshes[1].position).multiplyScalar(0.5);

        switch (this._state) {
            case 0: // SWEEP (1.8s)
                if (this._clock <= 1.8) {
                    const t = SMOOTHSTEP(this._clock / 1.8);
                    const y = 4.2 + t * (2.2 - 4.2);
                    const z = 9.5 + t * (6.5 - 9.5);
                    pos.set(mid.x, mid.y + y, mid.z + z);
                    target.set(mid.x, mid.y + 1.1, mid.z);
                    camera.position.copy(pos);
                    camera.lookAt(target);
                } else {
                    this._advanceState();
                }
                break;

            case 1: // INTRO A (1.5s)
                if (this._clock <= 1.5) {
                    const p0 = meshes[0].position;
                    // Determine facing direction based on relative positions of fighters
                    const p1 = meshes[1].position;
                    const facingX = p0.x < p1.x ? -1 : 1; // Fighter 0 facing left if they're on the left side
                    pos.set(p0.x + facingX * 1.6, p0.y + 1.55, p0.z + 2.4);
                    target.set(p0.x, p0.y + 1.55, p0.z);
                    camera.position.copy(pos);
                    camera.lookAt(target);
                    if (!this._announced && this._clock > 0.05) {
                        this._announced = true;
                        overlay.announce(defs[0].name, defs[0].kanji, 1.3);
                        if (faces[0]) faces[0].hold('game', 4);
                    }
                } else {
                    this._advanceState();
                }
                break;

            case 2: // INTRO B (1.5s)
                if (this._clock <= 1.5) {
                    const p1 = meshes[1].position;
                    // Determine facing direction based on relative positions of fighters
                    const p0 = meshes[0].position;
                    const facingX = p1.x < p0.x ? -1 : 1; // Fighter 1 facing left if they're on the left side
                    pos.set(p1.x + facingX * 1.6, p1.y + 1.55, p1.z + 2.4);
                    target.set(p1.x, p1.y + 1.55, p1.z);
                    camera.position.copy(pos);
                    camera.lookAt(target);
                    if (!this._announced && this._clock > 0.05) {
                        this._announced = true;
                        overlay.announce(defs[1].name, defs[1].kanji, 1.3);
                        if (faces[1]) faces[1].hold('game', 4);
                    }
                } else {
                    this._advanceState();
                }
                break;

            case 3: // WORDS
                // Start story only once at the beginning of this state
                if (this._clock <= 0.1) {
                    // We need to ensure we don't restart the story if it's already started
                    if (!this._ctx._storyPromise) {
                        this._ctx._storyPromise = overlay.playStory(lines);
                    }
                }
                // Hold two-shot camera during story
                pos.set(mid.x, mid.y + 1.9, mid.z + 5.2);
                target.set(mid.x, mid.y + 1.1, mid.z);
                camera.position.copy(pos);
                camera.lookAt(target);
                
                // Check if story is done
                if (!overlay.storyActive) {
                    this._advanceState();
                }
                break;

            case 4: // STAREDOWN (1.0s)
                if (this._clock <= 1.0) {
                    const angle = (this._clock / 1.0) * (18 * Math.PI / 180); // 18 degrees in radians
                    const radius = 5.2; // Distance from midpoint
                    pos.set(
                        mid.x + radius * Math.sin(angle),
                        mid.y + 1.9,
                        mid.z + radius * Math.cos(angle)
                    );
                    target.set(mid.x, mid.y + 1.1, mid.z);
                    camera.position.copy(pos);
                    camera.lookAt(target);
                } else {
                    this._finish();
                }
                break;
        }
    }

    _advanceState() {
        this._state++;
        this._clock = 0;
        this._announced = false;
        // Clear story promise when advancing from WORDS state
        if (this._state === 4) {
            delete this._ctx._storyPromise;
        }
    }

    _finish() {
        this.active = false;
        if (this._resolve) {
            this._resolve();
            this._resolve = null;
        }
        // Clean up story promise
        if (this._ctx && this._ctx._storyPromise) {
            delete this._ctx._storyPromise;
        }
    }

    skip() {
        // Clean up story promise if skipping
        if (this._ctx && this._ctx._storyPromise) {
            delete this._ctx._storyPromise;
        }
        this._finish();
    }
}