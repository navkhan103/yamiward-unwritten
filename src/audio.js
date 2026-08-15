/**
 * YAMIWARD — audio
 * ============================================================================
 * The game had ZERO sound. We had built five layers of visual feedback on a
 * hit — spark, flash, shake, hit-stop, speed lines — and zero audio layers, and
 * sound is the half of impact a player feels rather than sees.
 *
 * EVERY SOUND HERE IS SYNTHESIZED IN CODE. No .wav, no .mp3, no CDN. That is a
 * deliberate constraint, not a limitation we settled for:
 *   - the deploy allowlist and release-check stay unchanged (no new asset ext)
 *   - the 17.6MB payload does not grow by a single byte, which matters because
 *     mobile is exactly the audience we are trying to reach
 *   - nothing third-party enters the boot path, same rule as the vendored three
 *
 * A fighting game's sound vocabulary is mostly noise bursts and pitched thumps,
 * which is precisely what WebAudio primitives are good at. A punch is a filtered
 * noise transient over a low sine thump; a block is the same noise with a
 * shorter, tighter envelope and no thump.
 *
 * AUTOPLAY: browsers refuse to start an AudioContext without a user gesture, so
 * the context is created lazily on the first real input and `resume()`d on any
 * gesture afterwards. Calling a play method before that is a silent no-op — by
 * design, never an exception, because audio must never be able to break a match.
 */

const LS_MUTE = 'yw_muted';

/** Tier presets, mirroring the visual juice tiers in main.js. */
const TIER = {
    light: { gain: 0.28, thump: 90, noise: 0.055, tone: 0.10 },
    heavy: { gain: 0.50, thump: 62, noise: 0.085, tone: 0.16 },
    super: { gain: 0.72, thump: 44, noise: 0.130, tone: 0.26 },
};

export class GameAudio {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.muted = false;
        try { this.muted = localStorage.getItem(LS_MUTE) === '1'; } catch { /* private mode */ }
        this._noise = null;
        this._musicGain = null;
        this._musicNodes = [];
    }

    /**
     * Create (or resume) the context. Safe to call on every gesture.
     * Returns false when audio is unavailable so callers can stay silent.
     */
    unlock() {
        if (this.muted) return false;
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            try { this.ctx = new AC(); } catch { return false; }
            this.master = this.ctx.createGain();
            this.master.gain.value = 0.9;
            this.master.connect(this.ctx.destination);
            this._buildNoise();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return true;
    }

    /** One second of white noise, reused by every percussive sound. */
    _buildNoise() {
        const n = Math.floor(this.ctx.sampleRate);
        const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        // Deterministic LCG rather than Math.random: identical audio across
        // runs, which matches the engine's own determinism contract and makes
        // recorded clips reproducible.
        let s = 0x2F6E2B1;
        for (let i = 0; i < n; i++) {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            d[i] = (s / 0x7FFFFFFF) - 1;
        }
        this._noise = buf;
    }

    get _t() { return this.ctx.currentTime; }

    /** Filtered noise burst — the "crack" of a contact. */
    _burst(dur, freq, gain, type = 'bandpass', q = 1.2) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._noise;
        src.loop = true;
        const f = this.ctx.createBiquadFilter();
        f.type = type; f.frequency.value = freq; f.Q.value = q;
        const g = this.ctx.createGain();
        const t = this._t;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.004);       // near-instant attack
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(f).connect(g).connect(this.master);
        src.start(t); src.stop(t + dur + 0.02);
    }

    /** Pitched thump — the "weight" under a contact. */
    _thump(dur, from, to, gain, type = 'sine') {
        const o = this.ctx.createOscillator();
        o.type = type;
        const g = this.ctx.createGain();
        const t = this._t;
        o.frequency.setValueAtTime(from, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.master);
        o.start(t); o.stop(t + dur + 0.02);
    }

    // -----------------------------------------------------------------------
    // Game sounds. Each is a stack of primitives, the way the visual juice is a
    // stack of effects — see game-feel doctrine: one impact is many small
    // responses firing together inside ~100ms.
    // -----------------------------------------------------------------------

    /** @param {'light'|'heavy'|'super'} tier */
    hit(tier = 'light', counter = false) {
        if (!this.unlock()) return;
        const p = TIER[tier] || TIER.light;
        this._burst(p.tone, 1700, p.noise * 2.2);        // skin/cloth crack
        this._thump(p.tone * 1.7, p.thump, p.thump * 0.45, p.gain);  // body weight
        // A counter-hit gets a bright metallic ping on top — the audio
        // equivalent of the COUNTER banner, so it registers without reading.
        if (counter) this._thump(0.16, 1180, 760, 0.16, 'triangle');
    }

    block() {
        if (!this.unlock()) return;
        this._burst(0.07, 2600, 0.11, 'highpass', 0.7);
        this._thump(0.06, 200, 150, 0.10, 'square');
    }

    /** Armor absorb — duller and lower than a block: it went THROUGH. */
    armor() {
        if (!this.unlock()) return;
        this._burst(0.10, 620, 0.10, 'lowpass', 0.9);
        this._thump(0.14, 74, 50, 0.30);
    }

    whiff() {
        if (!this.unlock()) return;
        this._burst(0.13, 900, 0.045, 'bandpass', 0.5);
    }

    /** Wall splat / ground bounce — hard, bright, short. */
    slam() {
        if (!this.unlock()) return;
        this._burst(0.13, 480, 0.16, 'lowpass', 0.8);
        this._thump(0.30, 110, 38, 0.55);
    }

    /** KO — the one sound allowed to be big. */
    ko() {
        if (!this.unlock()) return;
        this._burst(0.42, 300, 0.20, 'lowpass', 0.7);
        this._thump(0.70, 130, 28, 0.70);
        // Struck-bell tail: two detuned partials, the ward's signature.
        this._thump(1.30, 460, 300, 0.14, 'triangle');
        this._thump(1.30, 690, 452, 0.08, 'triangle');
    }

    /** Round start / announce sting. */
    sting(high = false) {
        if (!this.unlock()) return;
        this._thump(0.40, high ? 720 : 480, high ? 480 : 300, 0.20, 'triangle');
        this._burst(0.10, 1500, 0.05);
    }

    /** Menu move / hover. */
    tick() {
        if (!this.unlock()) return;
        this._thump(0.045, 900, 700, 0.10, 'square');
    }

    /** Menu confirm. */
    confirm() {
        if (!this.unlock()) return;
        this._thump(0.10, 620, 900, 0.18, 'triangle');
        this._thump(0.20, 930, 1240, 0.10, 'triangle');
    }

    /** Meter full / super activation. */
    super_() {
        if (!this.unlock()) return;
        this._thump(0.55, 180, 900, 0.30, 'sawtooth');
        this._burst(0.40, 2200, 0.10, 'highpass', 0.6);
    }

    /**
     * Toggle mute. Persisted, because a player who muted a game and had it come
     * back loud on the next visit does not return a third time.
     */
    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem(LS_MUTE, this.muted ? '1' : '0'); } catch { /* fine */ }
        if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
        if (this.muted) this.stopMusic();
        return this.muted;
    }

    /**
     * Ambient drone bed. Not a melody — a low two-note pad that gives the night
     * stages air. Deliberately dull: it must survive a hundred rounds without
     * becoming the thing the player mutes.
     */
    startMusic() {
        if (!this.unlock() || this._musicNodes.length) return;
        const t = this._t;
        this._musicGain = this.ctx.createGain();
        this._musicGain.gain.setValueAtTime(0, t);
        this._musicGain.gain.linearRampToValueAtTime(0.055, t + 2.5);  // slow fade-in
        this._musicGain.connect(this.master);
        for (const [freq, detune] of [[55, -4], [82.4, 5], [110, 0]]) {
            const o = this.ctx.createOscillator();
            o.type = 'sine'; o.frequency.value = freq; o.detune.value = detune;
            const g = this.ctx.createGain(); g.gain.value = 0.34;
            // Slow LFO on gain so the pad breathes instead of sitting flat.
            const lfo = this.ctx.createOscillator();
            lfo.frequency.value = 0.07 + freq / 4000;
            const lg = this.ctx.createGain(); lg.gain.value = 0.16;
            lfo.connect(lg).connect(g.gain);
            o.connect(g).connect(this._musicGain);
            o.start(t); lfo.start(t);
            this._musicNodes.push(o, lfo);
        }
    }

    stopMusic() {
        if (!this._musicGain) return;
        const t = this._t;
        try {
            this._musicGain.gain.cancelScheduledValues(t);
            this._musicGain.gain.setValueAtTime(this._musicGain.gain.value, t);
            this._musicGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        } catch { /* context may be closed */ }
        for (const n of this._musicNodes) { try { n.stop(t + 0.9); } catch { /* already stopped */ } }
        this._musicNodes = [];
        this._musicGain = null;
    }
}

export const audio = new GameAudio();
