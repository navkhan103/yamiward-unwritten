/**
 * YAMIWARD — narrative + HUD overlay
 * ============================================================================
 * Everything here is DOM on top of the WebGL canvas. Reasons this is not drawn
 * into the canvas: crisp text at any DPI for free, real accessibility, CSS
 * transitions instead of hand-animated tweens, and text that can be localised
 * and selected. The canvas draws the world; the DOM draws the story.
 *
 * The controller never reads engine internals directly — main.js pushes it a
 * flat snapshot each frame. That keeps the UI swappable (and testable).
 */

const $ = (sel) => document.querySelector(sel);

export class Overlay {
    constructor() {
        this.el = {
            root: $('#hud'),
            p1Name: $('#p1-name'), p2Name: $('#p2-name'),
            p1Health: $('#p1-health'), p2Health: $('#p2-health'),
            p1Chip: $('#p1-chip'), p2Chip: $('#p2-chip'),
            p1Meter: $('#p1-meter'), p2Meter: $('#p2-meter'),
            p1Portrait: $('#p1-portrait'), p2Portrait: $('#p2-portrait'),
            p1Rounds: $('#p1-rounds'), p2Rounds: $('#p2-rounds'),
            timer: $('#timer'),
            combo: $('#combo'), comboCount: $('#combo-count'), comboDmg: $('#combo-dmg'),
            announce: $('#announce'), announceMain: $('#announce-main'), announceSub: $('#announce-sub'),
            story: $('#story'), storyName: $('#story-name'), storyText: $('#story-text'),
            storyPortrait: $('#story-portrait'), storyNext: $('#story-next'),
            wipe: $('#wipe'),
            letterbox: $('#letterbox'),
            debug: $('#debug'),
        };

        // Health bars use two layers: the front bar snaps to true health, the
        // "chip" layer behind drains toward it. That lag is what makes a combo
        // feel like it took something from you.
        this._chip = [1, 1];
        this._announceTimer = 0;

        this._storyQueue = [];
        this._typing = null;
        this._onStoryDone = null;
        // VN conveniences. backlog is a ring buffer of committed lines; the rest
        // are player settings storyMode reads back when it saves.
        this.backlog = [];
        this._storyCursor = 0;
        this._onStoryLine = null;
        this._textSpeed = 18;
        this._auto = false;
        this._skip = false;
        this._autoTimer = null;

        this.el.storyNext?.addEventListener('click', () => this.advanceStory());
        window.addEventListener('keydown', (e) => {
            if (this.storyActive && (e.code === 'Space' || e.code === 'Enter')) {
                e.preventDefault(); this.advanceStory();
            }
        });
    }

    get storyActive() { return this.el.story && !this.el.story.hidden; }

    /** @param {{name:string,kanji:string,color:string,portrait?:string}} a slot 0 */
    setFighters(a, b) {
        this.el.p1Name.textContent = `${a.name}  ${a.kanji}`;
        this.el.p2Name.textContent = `${b.name}  ${b.kanji}`;
        this.el.root.style.setProperty('--p1-color', a.color);
        this.el.root.style.setProperty('--p2-color', b.color);
        // Portrait art with kanji fallback: paint the image over the glyph so a
        // missing/unloaded file shows the character's kanji, never a blank box.
        for (const [el, f] of [[this.el.p1Portrait, a], [this.el.p2Portrait, b]]) {
            el.textContent = f.kanji;
            if (f.portrait) {
                el.style.backgroundImage = `url("${f.portrait}")`;
                el.style.backgroundSize = 'cover';
                el.style.backgroundPosition = 'center 12%';
            }
        }
    }

    /**
     * @param {Object} s flat snapshot from main.js
     * @param {number} dt seconds
     */
    update(s, dt) {
        for (let i = 0; i < 2; i++) {
            const f = s.fighters[i];
            const pct = Math.max(0, f.health / f.maxHealth);
            const bar = i === 0 ? this.el.p1Health : this.el.p2Health;
            const chip = i === 0 ? this.el.p1Chip : this.el.p2Chip;
            bar.style.transform = `scaleX(${pct})`;

            // chip drains toward true health, with a beat of hang time
            if (this._chip[i] > pct) {
                this._chip[i] = Math.max(pct, this._chip[i] - dt * 0.55);
            } else {
                this._chip[i] = pct;
            }
            chip.style.transform = `scaleX(${this._chip[i]})`;

            const meter = i === 0 ? this.el.p1Meter : this.el.p2Meter;
            meter.style.transform = `scaleX(${Math.max(0, Math.min(1, f.meter / 100))})`;
            meter.classList.toggle('ready', f.meter >= 100);

            const rounds = i === 0 ? this.el.p1Rounds : this.el.p2Rounds;
            const pips = rounds.children;
            for (let k = 0; k < pips.length; k++) pips[k].classList.toggle('won', k < f.roundsWon);
        }

        this.el.timer.textContent = String(Math.ceil(s.timer / 60)).padStart(2, '0');
        this.el.timer.classList.toggle('urgent', s.timer < 600);

        // combo readout follows whichever fighter is currently being hit
        const victim = s.fighters.find((f) => f.combo > 1);
        if (victim) {
            this.el.combo.hidden = false;
            this.el.combo.classList.toggle('right', victim.slot === 0);
            this.el.comboCount.textContent = victim.combo;
            this.el.comboDmg.textContent = `${victim.comboDamage} DMG`;
        } else {
            this.el.combo.hidden = true;
        }

        if (this._announceTimer > 0) {
            this._announceTimer -= dt;
            if (this._announceTimer <= 0) this.el.announce.hidden = true;
        }

        if (this.el.debug && s.debug) this.el.debug.textContent = s.debug;
    }

    /** Big centre text: ROUND 1 / FIGHT / K.O. / PERFECT */
    announce(main, sub = '', seconds = 1.6) {
        this.el.announceMain.textContent = main;
        this.el.announceSub.textContent = sub;
        this.el.announce.hidden = false;
        // restart the CSS animation
        this.el.announce.classList.remove('play');
        void this.el.announce.offsetWidth;
        this.el.announce.classList.add('play');
        this._announceTimer = seconds;
    }

    /**
     * Slide the letterbox in for `seconds`, then out.
     *
     * Re-calling EXTENDS the hold instead of restarting it — a super that lands
     * during a KO must not slam the bars shut and re-open them, which reads as
     * a glitch rather than a flourish.
     */
    cinematic(seconds = 1.3) {
        const box = this.el.letterbox;
        if (!box) return;
        box.classList.add('on');
        this._cineUntil = Math.max(this._cineUntil || 0, performance.now() + seconds * 1000);
        clearTimeout(this._cineTimer);
        this._cineTimer = setTimeout(() => {
            if (performance.now() >= (this._cineUntil || 0) - 16) box.classList.remove('on');
        }, Math.max(0, this._cineUntil - performance.now()));
    }

    /** Full-screen wipe between story beats and fights. */
    wipe(ms = 520) {
        return new Promise((res) => {
            this.el.wipe.classList.add('play');
            setTimeout(() => { this.el.wipe.classList.remove('play'); res(); }, ms);
        });
    }

    // -- visual-novel dialogue ------------------------------------------

    /**
     * @param {Array<{speaker:string, kanji?:string, text:string, color?:string}>} lines
     * @param {{startAt?:number, onLine?:(index:number, line:object)=>void}} [opts]
     *   startAt — resume mid-block after a load. A VN save has to restore the exact
     *   line, not the top of the scene (see the save-anywhere rule): storyMode
     *   persists the cursor this reports and hands it straight back here.
     *   onLine  — fires as each line is COMMITTED to the box, which is both the
     *   backlog feed and the save cursor. One callback covers both because they
     *   want the identical moment.
     * @returns {Promise<void>} resolves when the player has read them all
     */
    playStory(lines, opts = {}) {
        return new Promise((resolve) => {
            this._storyCursor = opts.startAt || 0;
            this._storyQueue = lines.slice(this._storyCursor);
            this._onStoryLine = opts.onLine || null;
            this._onStoryDone = resolve;
            this.el.story.hidden = false;
            this.el.root.classList.add('story-mode');
            this.advanceStory();
        });
    }

    /** ms per character. 0 = instant. Player setting; skip drives it to 0. */
    setTextSpeed(ms) { this._textSpeed = Math.max(0, ms | 0); }
    /** Hands-free reading. Cancelled by any manual advance. */
    setAuto(on) { this._auto = !!on; if (!on) this._clearAuto(); }
    /**
     * Fast-forward. Deliberately NOT gated on seen-text: this game's story mode
     * is one pass per route with no unlockable re-reads, so a seen-only skip
     * would do nothing on a first play and confuse anyone who pressed it. If
     * replayable routes ever ship, gate it then — the backlog already gives us
     * the seen set to gate on.
     */
    setSkip(on) { this._skip = !!on; if (on && this.storyActive) this.advanceStory(); }

    _clearAuto() { if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; } }

    advanceStory() {
        this._clearAuto();
        // A tap while typing should complete the line, not skip it — anything
        // else feels like the game stole your input.
        if (this._typing) {
            clearInterval(this._typing.handle);
            this.el.storyText.textContent = this._typing.full;
            this._typing = null;
            this.el.storyNext.classList.add('ready');
            this._armAuto();
            return;
        }
        const line = this._storyQueue.shift();
        if (!line) {
            this.el.story.hidden = true;
            this.el.root.classList.remove('story-mode');
            const done = this._onStoryDone;
            this._onStoryDone = null;
            this._onStoryLine = null;
            if (done) done();
            return;
        }

        // Committed: this line is now the resume point and the newest backlog
        // entry. Cap the buffer — an unbounded history across a six-chapter
        // route is a slow leak nobody would ever look at the far end of.
        this.backlog.push(line);
        if (this.backlog.length > 200) this.backlog.shift();
        if (this._onStoryLine) this._onStoryLine(this._storyCursor, line);
        this._storyCursor += 1;

        this.el.storyName.textContent = line.speaker;
        this.el.storyPortrait.textContent = line.kanji || '闇';
        this.el.story.style.setProperty('--speaker-color', line.color || '#9BE8E0');
        this.el.storyNext.classList.remove('ready');

        // typewriter
        const full = line.text;
        const rate = this._skip ? 0 : (this._textSpeed ?? 18);
        if (rate === 0) {
            this.el.storyText.textContent = full;
            this._typing = null;
            this.el.storyNext.classList.add('ready');
            // Skip must not recurse: a 200-line block would blow the stack.
            if (this._skip) this._autoTimer = setTimeout(() => this.advanceStory(), 0);
            else this._armAuto();
            return;
        }
        this.el.storyText.textContent = '';
        let i = 0;
        const handle = setInterval(() => {
            i += 1;
            this.el.storyText.textContent = full.slice(0, i);
            if (i >= full.length) {
                clearInterval(handle);
                this._typing = null;
                this.el.storyNext.classList.add('ready');
                this._armAuto();
            }
        }, rate);
        this._typing = { handle, full };
    }

    /** Auto-advance scaled to line length, so long lines get longer to read. */
    _armAuto() {
        if (!this._auto || this._skip) return;
        const len = this.el.storyText.textContent.length;
        this._autoTimer = setTimeout(() => this.advanceStory(), 900 + len * 28);
    }

    /**
     * Force-close the VN panel from OUTSIDE the normal advance flow (the
     * intro director's skip path). advanceStory() only hides the panel when
     * it naturally runs out of lines — a skip while lines remain left the
     * panel (and storyActive) stuck true forever, which permanently blocked
     * engine.step() in the main loop. This tears the panel down unconditionally
     * and resolves the outstanding promise so nothing double-hangs.
     */
    closeStory() {
        if (this._typing) { clearInterval(this._typing.handle); this._typing = null; }
        this._clearAuto();
        this._onStoryLine = null;
        this._storyQueue = [];
        this.el.story.hidden = true;
        this.el.root.classList.remove('story-mode');
        const done = this._onStoryDone;
        this._onStoryDone = null;
        if (done) done();
    }
}
