/**
 * YAMIWARD — NIGHT PARADE ladder mode
 * ============================================================================
 * Single-character run against the field in seed-shuffled order. Score is
 * accumulated across matches; best run persists. Deterministic from seed.
 */

function mulberry32(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

export function createLadder(rosterKeys) {
    // Get CPU level keys in order from easiest to hardest
    const cpuLevels = ['easy', 'medium', 'hard'];
    
    let active = false;
    let playerKey = null;
    let opponents = [];
    let currentIndex = 0;
    let currentCpuLevel = 0;
    let runScore = 0;
    let wins = 0;
    let defeated = [];
    let bestCombo = 0;
    let lastRunNewBest = false;

    function begin(player, seed) {
        if (!rosterKeys.includes(player)) {
            throw new Error(`Player key "${player}" not found in roster`);
        }
        
        playerKey = player;
        active = true;
        runScore = 0;
        wins = 0;
        defeated = [];
        bestCombo = 0;
        
        // Create opponent pool excluding the player
        const pool = rosterKeys.filter(k => k !== player);
        
        // Shuffle using seeded PRNG
        const random = mulberry32(seed);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        
        opponents = pool;
        currentIndex = 0;
        currentCpuLevel = 0; // Start with the easiest CPU level
    }

    function getCurrentOpponent() {
        if (currentIndex >= opponents.length) return null;
        return {
            opponentKey: opponents[currentIndex],
            index: currentIndex,
            total: opponents.length,
            cpuLevel: cpuLevels[Math.min(currentCpuLevel, cpuLevels.length - 1)]
        };
    }

    function reportMatch(result) {
        if (!active) {
            return { runOver: true, matchScore: 0, runScore: 0 };
        }

        // A loss scores ZERO — the base 1000 is per WIN (the draft credited
        // losses 1000, which made throwing the last match a scoring strategy).
        let matchScore = 0;

        if (result.won) {
            matchScore = 1000
                + Math.round(result.playerHealthFrac * 1000)
                + Math.max(0, 600 - Math.round(result.seconds) * 10)
                + (result.perfect ? 500 : 0);

            wins++;
            defeated.push(opponents[currentIndex]);
            currentIndex++;
            // Escalate proportionally across the run: first ~half easy->medium,
            // the final two matches always at the top level.
            if (currentIndex < opponents.length) {
                const remaining = opponents.length - currentIndex;
                currentCpuLevel = remaining <= 2
                    ? cpuLevels.length - 1
                    : Math.min(cpuLevels.length - 1,
                        Math.floor((currentIndex / opponents.length) * cpuLevels.length));
            }
        } else {
            // Player lost, run is over
            active = false;
        }

        runScore += matchScore;

        const runOver = !active || currentIndex >= opponents.length;

        if (runOver) {
            active = false;
            // Decide newBest BEFORE writing the record — summary() reads the
            // latched flag, not storage (the draft compared against the record
            // it had just written, so newBest could never be true).
            lastRunNewBest = false;
            try {
                const stored = localStorage.getItem('yw_parade_best');
                lastRunNewBest = !stored || runScore > JSON.parse(stored).score;
                if (lastRunNewBest) {
                    localStorage.setItem('yw_parade_best', JSON.stringify({
                        score: runScore,
                        player: playerKey,
                        defeated: [...defeated],
                        when: Date.now()
                    }));
                }
            } catch (e) {
                // localStorage unavailable - ignore
            }
        }

        return {
            runOver,
            matchScore,
            runScore
        };
    }

    function summary() {
        return {
            runScore,
            wins,
            bestCombo: bestCombo || undefined,
            defeated: [...defeated],
            newBest: lastRunNewBest
        };
    }

    function abort() {
        active = false;
    }

    return {
        begin,
        get active() { return active; },
        get current() { 
            return active ? getCurrentOpponent() : null; 
        },
        reportMatch,
        summary,
        abort
    };
}