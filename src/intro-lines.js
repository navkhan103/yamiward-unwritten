/**
 * Generates dialogue lines for the pre-fight showdown.
 * 
 * @param {string} p1Key - Key identifier for player 1
 * @param {string} p2Key - Key identifier for player 2  
 * @param {Object} characters - Character definitions map
 * @param {Object} rivals - Rival relationship map
 * @returns {Array<{speaker:string, kanji?:string, text:string, color?:string}>} Array of dialogue lines
 */
export function introLines(p1Key, p2Key, characters, rivals) {
    const p1Def = characters[p1Key];
    const p2Def = characters[p2Key];
    const lines = [];
    
    // Check if these characters are rivals
    const isRivalry = (rivals[p1Key] === p2Key || rivals[p2Key] === p1Key);
    
    // First line: Player 1 entrance boast
    lines.push({
        speaker: p1Def.name,
        kanji: p1Def.kanji,
        text: "[PLACEHOLDER — Canon Lane: entrance boast from P1]",
        color: p1Def.color
    });
    
    // Second line: Player 2 dismissive reply
    lines.push({
        speaker: p2Def.name,
        kanji: p2Def.kanji,
        text: "[PLACEHOLDER — Canon Lane: dismissive reply from P2]", 
        color: p2Def.color
    });
    
    // Add rivalry lines if these characters are rivals
    if (isRivalry) {
        // Third line: P1 rivalry callback
        lines.push({
            speaker: p1Def.name,
            kanji: p1Def.kanji,
            text: "[PLACEHOLDER — Canon Lane: rivalry callback from P1]",
            color: p1Def.color
        });
        
        // Fourth line: P2 threat before the bell
        lines.push({
            speaker: p2Def.name,
            kanji: p2Def.kanji,
            text: "[PLACEHOLDER — Canon Lane: threat before the bell from P2]",
            color: p2Def.color
        });
    }
    
    return lines;
}

/**
 * Documented rival beat pairs - these are examples of how rival detection works.
 * Actual rival detection happens per-call from the rivals argument.
 * 
 * Example format: "characterA:characterB"
 */
export const RIVAL_BEATS = {
    // This would be populated with actual rival pairs at runtime based on the rivals argument
    // e.g., "akuma:ryu": true,
    // e.g., "ken:chunli": true
};