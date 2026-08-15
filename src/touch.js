/**
 * YAMIWARD — touch controls
 * ============================================================================
 * The game shipped keyboard + gamepad only, which meant every visitor arriving
 * from TikTok — an audience that is essentially all mobile — landed on a game
 * they physically could not play. That is a distribution bug wearing a feature
 * bug's clothes, and it was the single highest-impact gap in the audit.
 *
 * DESIGN
 *   left  half — a floating analog pad. Touch anywhere to place it, drag to
 *                walk/sidestep. It is FLOATING rather than fixed because a
 *                fixed stick forces the player to look at their thumb; a
 *                floating one appears wherever the thumb already landed.
 *   right half — five attack buttons, each >=44px per touch-target guidance.
 *
 * The stick resolves to the SAME Btn bitmask the keyboard and gamepad produce,
 * and merges in `readInput()` as a third source. That is the whole integration:
 * the engine never learns touch exists, so determinism and the frame-data
 * contract are untouched.
 *
 * TAP-VS-HOLD parity: the keyboard treats a short vertical press as a sidestep
 * and a sustained one as a crouch. The stick reproduces that with the same
 * frame counter, so a phone player and a keyboard player get identical mechanics
 * rather than a simplified mobile variant.
 */
import { Btn } from './CombatEngine.js';

const DEAD = 0.28;          // fraction of radius before motion registers
const RADIUS = 62;          // px, stick travel
const CROUCH_FRAMES = 8;    // matches the keyboard/gamepad hold threshold

/** Attack buttons: [id, label, sub, Btn bit]. */
const BUTTONS = [
    ['t-light', 'J', '弱', Btn.LIGHT],
    ['t-heavy', 'K', '強', Btn.HEAVY],
    ['t-low', 'L', '下', Btn.LOW],
    ['t-special', 'I', '技', Btn.SPECIAL],
    ['t-super', 'U', '極', Btn.SUPER],
];

export class TouchControls {
    /**
     * @param {HTMLElement} root  container appended to the HUD
     * @param {() => void} [onFirstTouch]  fired once — used to unlock audio
     */
    constructor(root, onFirstTouch = null) {
        this.enabled = false;
        this.root = root;
        this._onFirstTouch = onFirstTouch;
        this._fired = false;
        this.mask = 0;                 // attack bits, set by button handlers
        this._stickId = null;          // pointerId owning the stick
        this._origin = { x: 0, y: 0 };
        this._vec = { x: 0, y: 0 };
        this._tap = { up: 0, down: 0 };
        this._build();
    }

    /**
     * Does this device need touch controls?
     *
     * Primary signal is a COARSE PRIMARY POINTER — a finger. Width alone was
     * tried first and is wrong in both directions: it showed the stick to a
     * desktop user with a narrow window (and hid their keyboard hint), while a
     * phone in landscape can be wider than the breakpoint. The secondary clause
     * catches touch-capable devices that report a fine pointer, but only when
     * the viewport is also phone-sized, so a touchscreen laptop keeps its keys.
     */
    static wanted() {
        if (window.matchMedia('(pointer: coarse)').matches) return true;
        // The `> 0` is not redundant: a hidden/unlaid-out tab reports
        // innerWidth 0, which sailed through a bare `<= 900` and handed touch
        // controls to a desktop with a touchscreen. A zero-width viewport is
        // not a phone; it is a viewport that has not been measured yet.
        const w = window.innerWidth;
        return (navigator.maxTouchPoints || 0) > 0 && w > 0 && w <= 900;
    }

    _build() {
        const wrap = document.createElement('div');
        wrap.id = 'touch';
        wrap.hidden = true;
        wrap.innerHTML = `
            <div id="t-stick-zone"></div>
            <div id="t-stick"><i></i></div>
            <div id="t-buttons">
                ${BUTTONS.map(([id, label, sub]) =>
                    `<button id="${id}" class="t-btn"><b>${label}</b><span>${sub}</span></button>`).join('')}
            </div>`;
        this.root.appendChild(wrap);
        this.el = wrap;
        this.stick = wrap.querySelector('#t-stick');
        this.zone = wrap.querySelector('#t-stick-zone');

        // --- attack buttons -------------------------------------------------
        for (const [id, , , bit] of BUTTONS) {
            const b = wrap.querySelector('#' + id);
            const down = (e) => {
                e.preventDefault();
                this._first();
                this.mask |= bit;
                b.classList.add('on');
            };
            // Clearing on BOTH up and cancel matters: a finger that slides off
            // the button, or a call that steals focus, fires cancel only — and
            // a stuck attack bit means the fighter mashes forever.
            const up = (e) => { e.preventDefault(); this.mask &= ~bit; b.classList.remove('on'); };
            b.addEventListener('pointerdown', down);
            b.addEventListener('pointerup', up);
            b.addEventListener('pointercancel', up);
            b.addEventListener('pointerleave', up);
        }

        // --- floating stick -------------------------------------------------
        this.zone.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this._first();
            this._stickId = e.pointerId;
            this._origin = { x: e.clientX, y: e.clientY };
            this._vec = { x: 0, y: 0 };
            this.stick.style.left = `${e.clientX}px`;
            this.stick.style.top = `${e.clientY}px`;
            this.stick.classList.add('on');
            this.zone.setPointerCapture(e.pointerId);
        });
        const move = (e) => {
            if (e.pointerId !== this._stickId) return;
            e.preventDefault();
            const dx = e.clientX - this._origin.x;
            const dy = e.clientY - this._origin.y;
            const len = Math.hypot(dx, dy) || 1;
            const clamped = Math.min(len, RADIUS);
            this._vec = { x: (dx / len) * (clamped / RADIUS), y: (dy / len) * (clamped / RADIUS) };
            const knob = this.stick.firstElementChild;
            knob.style.transform = `translate(${(dx / len) * clamped}px, ${(dy / len) * clamped}px)`;
        };
        const release = (e) => {
            if (e.pointerId !== this._stickId) return;
            this._stickId = null;
            this._vec = { x: 0, y: 0 };
            this._tap = { up: 0, down: 0 };
            this.stick.classList.remove('on');
            this.stick.firstElementChild.style.transform = '';
        };
        this.zone.addEventListener('pointermove', move);
        this.zone.addEventListener('pointerup', release);
        this.zone.addEventListener('pointercancel', release);
    }

    _first() {
        if (this._fired) return;
        this._fired = true;
        this._onFirstTouch?.();
    }

    show(on) {
        this.enabled = on;
        this.el.hidden = !on;
        if (!on) { this.mask = 0; this._vec = { x: 0, y: 0 }; }
    }

    /**
     * Current input bits. Called once per frame from readInput(), so the
     * tap/hold counters advance at exactly the engine's rate — the same reason
     * the gamepad path counts frames rather than milliseconds.
     *
     * @param {number} slot  0 = P1 (touch only ever drives P1)
     */
    bits(slot) {
        if (!this.enabled || slot !== 0) return 0;
        let m = this.mask;
        const { x, y } = this._vec;

        // Horizontal = walk. P1 convention: left is BACK, right is FORWARD.
        if (x < -DEAD) m |= Btn.BACK;
        else if (x > DEAD) m |= Btn.FORWARD;

        // Vertical: rising edge sidesteps, sustained crouches — keyboard parity.
        const up = y < -DEAD, down = y > DEAD;
        if (up && this._tap.up === 0) m |= Btn.STEP_LEFT;
        this._tap.up = up ? this._tap.up + 1 : 0;
        if (down && this._tap.down === 0) m |= Btn.STEP_RIGHT;
        this._tap.down = down ? this._tap.down + 1 : 0;
        if (down && this._tap.down > CROUCH_FRAMES) m |= Btn.CROUCH;

        return m;
    }
}
