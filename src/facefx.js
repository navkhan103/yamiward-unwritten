import * as THREE from 'three';

export const FACE_STATES = ['neutral', 'game', 'strain', 'pain', 'grit', 'ko'];

// Cache: state_clanKey -> texture
const faceTexCache = new Map();

function makeFaceTexture(state, def) {
    const cacheKey = `${state}_${def.clanKey}`;
    if (faceTexCache.has(cacheKey)) return faceTexCache.get(cacheKey);

    const W = 256;
    const cvs = document.createElement('canvas');
    cvs.width = W;
    cvs.height = W;
    const ctx = cvs.getContext('2d');

    // Clear background (transparent)
    ctx.clearRect(0, 0, W, W);

    // Set stroke properties
    ctx.strokeStyle = '#0a0a10';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.9;

    // Accent color (under-eye rim) — 1-2px line
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(W * 0.2, W * 0.6);
    ctx.lineTo(W * 0.8, W * 0.6);
    ctx.stroke();

    // Reset stroke for main features
    ctx.strokeStyle = '#0a0a10';
    ctx.lineWidth = 12;
    ctx.globalAlpha = 0.9;

    // Draw features based on state
    if (state === 'neutral') {
        drawEyes(ctx, W, 'level');
        drawMouth(ctx, W, 'flat');
    } else if (state === 'game') {
        drawEyes(ctx, W, 'narrowed', 'menacing');
        drawMouth(ctx, W, 'slightFrown');
    } else if (state === 'strain') {
        drawEyes(ctx, W, 'tighter');
        drawMouth(ctx, W, 'grittedOpen');
    } else if (state === 'pain') {
        drawEye(ctx, W, 'left', 'closed');
        drawEye(ctx, W, 'right', 'open');
        drawBrows(ctx, W, 'peaked');
        drawMouth(ctx, W, 'openWide');
    } else if (state === 'grit') {
        drawEyes(ctx, W, 'slit');
        drawMouth(ctx, W, 'wideClamp');
    } else if (state === 'ko') {
        drawKOEyes(ctx, W);
        drawMouth(ctx, W, 'slack');
    }

    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    faceTexCache.set(cacheKey, tex);

    return tex;
}

// Helper drawing functions
function drawEyes(ctx, W, style, browStyle = null) {
    drawEye(ctx, W, 'left', style);
    drawEye(ctx, W, 'right', style);
    if (browStyle) {
        drawBrows(ctx, W, browStyle);
    }
}

function drawEye(ctx, W, side, style) {
    const x = side === 'left' ? W * 0.3 : W * 0.7;
    const y = W * 0.4;

    if (style === 'level') {
        ctx.beginPath();
        ctx.moveTo(x - 20, y);
        ctx.lineTo(x + 20, y);
        ctx.stroke();
    } else if (style === 'narrowed') {
        ctx.beginPath();
        ctx.moveTo(x - 18, y - 3);
        ctx.lineTo(x + 18, y - 3);
        ctx.stroke();
    } else if (style === 'tighter') {
        ctx.beginPath();
        ctx.moveTo(x - 15, y - 2);
        ctx.lineTo(x + 15, y - 2);
        ctx.stroke();
    } else if (style === 'slit') {
        ctx.beginPath();
        ctx.moveTo(x - 12, y);
        ctx.lineTo(x + 12, y);
        ctx.stroke();
    } else if (style === 'closed') {
        ctx.beginPath();
        ctx.moveTo(x - 18, y);
        ctx.lineTo(x + 18, y);
        ctx.stroke();
    } else if (style === 'open') {
        ctx.beginPath();
        ctx.moveTo(x - 18, y - 5);
        ctx.lineTo(x + 18, y - 5);
        ctx.stroke();
    }
}

function drawBrows(ctx, W, style) {
    if (style === 'menacing') {
        ctx.beginPath();
        ctx.moveTo(W * 0.25, W * 0.3);
        ctx.lineTo(W * 0.35, W * 0.25);
        ctx.moveTo(W * 0.65, W * 0.25);
        ctx.lineTo(W * 0.75, W * 0.3);
        ctx.stroke();
    } else if (style === 'peaked') {
        ctx.beginPath();
        ctx.moveTo(W * 0.25, W * 0.25);
        ctx.lineTo(W * 0.3, W * 0.15);
        ctx.lineTo(W * 0.35, W * 0.25);
        ctx.moveTo(W * 0.65, W * 0.25);
        ctx.lineTo(W * 0.7, W * 0.15);
        ctx.lineTo(W * 0.75, W * 0.25);
        ctx.stroke();
    }
}

function drawMouth(ctx, W, style) {
    if (style === 'flat') {
        ctx.beginPath();
        ctx.moveTo(W * 0.4, W * 0.7);
        ctx.lineTo(W * 0.6, W * 0.7);
        ctx.stroke();
    } else if (style === 'slightFrown') {
        ctx.beginPath();
        ctx.moveTo(W * 0.4, W * 0.72);
        ctx.lineTo(W * 0.6, W * 0.7);
        ctx.stroke();
    } else if (style === 'grittedOpen') {
        ctx.beginPath();
        ctx.moveTo(W * 0.4, W * 0.7);
        ctx.lineTo(W * 0.6, W * 0.7);
        ctx.stroke();
        // Small gap to suggest open mouth
        ctx.beginPath();
        ctx.moveTo(W * 0.5, W * 0.7);
        ctx.lineTo(W * 0.5, W * 0.72);
        ctx.stroke();
    } else if (style === 'openWide') {
        ctx.beginPath();
        ctx.ellipse(W * 0.5, W * 0.75, 15, 10, 0, 0, Math.PI * 2);
        ctx.stroke();
    } else if (style === 'wideClamp') {
        ctx.beginPath();
        ctx.moveTo(W * 0.35, W * 0.7);
        ctx.lineTo(W * 0.65, W * 0.7);
        ctx.stroke();
        // Jaw line
        ctx.beginPath();
        ctx.moveTo(W * 0.45, W * 0.7);
        ctx.lineTo(W * 0.55, W * 0.75);
        ctx.stroke();
    } else if (style === 'slack') {
        ctx.beginPath();
        ctx.moveTo(W * 0.4, W * 0.75);
        ctx.lineTo(W * 0.6, W * 0.75);
        ctx.stroke();
    }
}

function drawKOEyes(ctx, W) {
    // Spiral-like X pattern for knocked out
    ctx.beginPath();
    ctx.moveTo(W * 0.25, W * 0.35);
    ctx.lineTo(W * 0.35, W * 0.45);
    ctx.moveTo(W * 0.35, W * 0.35);
    ctx.lineTo(W * 0.25, W * 0.45);
    
    ctx.moveTo(W * 0.65, W * 0.35);
    ctx.lineTo(W * 0.75, W * 0.45);
    ctx.moveTo(W * 0.75, W * 0.35);
    ctx.lineTo(W * 0.65, W * 0.45);
    ctx.stroke();
}

/**
 * Painted face art: slice assets/faces/<key>.webp per its
 * manifest and hand the cells to face.loadTextures. Fire-and-forget — the
 * ink-glyph placeholders keep playing if the atlas never lands.
 */
export async function loadFaceAtlas(face, key) {
    try {
        const res = await fetch(`./assets/faces/${key}.json`);
        if (!res.ok) return false;
        const man = await res.json();
        // createImageBitmap, not Image.decode(): decode() can stall forever in
        // a non-composited (hidden) tab, which is exactly where QA runs.
        const blobRes = await fetch(`./assets/faces/${key}.webp`);
        if (!blobRes.ok) return false;
        const img = await createImageBitmap(await blobRes.blob());
        const map = {};
        for (const [state, [col, row]] of Object.entries(man.states)) {
            const cvs = document.createElement('canvas');
            cvs.width = cvs.height = man.cell;
            // Cells are full head portraits; the doll's head piece already has
            // hair. Crop to the centre face region so the plane reads as an
            // expression swap, not a second head.
            const cw = man.cell * 0.56;
            cvs.getContext('2d').drawImage(img,
                col * man.cell + man.cell * 0.22, row * man.cell + man.cell * 0.20, cw, cw,
                0, 0, man.cell, man.cell);
            const tex = new THREE.CanvasTexture(cvs);
            tex.colorSpace = THREE.SRGBColorSpace;
            map[state] = tex;
        }
        face.loadTextures(map);
        return true;
    } catch {
        return false;
    }
}

export function attachFace(headJoint, def) {
    const plane = new THREE.PlaneGeometry(0.16, 0.16);
    const material = new THREE.MeshBasicMaterial({
        map: makeFaceTexture('neutral', def),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });

    const faceMesh = new THREE.Mesh(plane, material);
    faceMesh.position.set(0, 0, 0.007); // z-offset to avoid z-fighting
    headJoint.add(faceMesh);

    let currentState = 'neutral';
    let holdState = null;
    let holdTimeLeft = 0;

    const face = {
        mesh: faceMesh,
        material: material,

        update(f, dt = 0) {
            // Decrement hold timer if active
            if (holdState && holdTimeLeft > 0) {
                holdTimeLeft -= dt;
                if (holdTimeLeft <= 0) {
                    holdState = null;
                    holdTimeLeft = 0;
                }
            }

            // Determine new state based on fighter engine state
            let newState = 'neutral';
            switch (f.state) {
                case 'HITSTUN':
                case 'JUGGLED':
                    newState = 'pain';
                    break;
                case 'KNOCKDOWN':
                case 'LOSE':
                    newState = 'ko';
                    break;
                case 'BLOCKING':
                    newState = 'grit';
                    break;
                case 'ATTACKING':
                    newState = 'strain';
                    break;
                case 'WIN':
                    newState = 'game';
                    break;
                default:
                    // Everything else defaults to 'neutral'
                    break;
            }

            // Override to 'grit' if health is low and state would be 'neutral'
            if (newState === 'neutral' && f.health <= f.def.maxHealth * 0.25) {
                newState = 'grit';
            }

            // Use hold state if active
            if (holdState) {
                newState = holdState;
            }

            // Update texture only if state changed
            if (currentState !== newState) {
                currentState = newState;
                this.material.map = makeFaceTexture(currentState, def);
                this.material.needsUpdate = true;
            }
        },

        set(state) {
            holdState = null;
            holdTimeLeft = 0;
            currentState = state;
            this.material.map = makeFaceTexture(currentState, def);
            this.material.needsUpdate = true;
        },

        hold(state, seconds) {
            holdState = state;
            holdTimeLeft = seconds;
        },

        loadTextures(textureMap) {
            // Replace canvas textures with provided ones where available
            for (const [state, texture] of Object.entries(textureMap)) {
                if (FACE_STATES.includes(state)) {
                    const cacheKey = `${state}_${def.clanKey}`;
                    faceTexCache.set(cacheKey, texture);
                }
            }
            // If current state was replaced, update material
            if (textureMap[currentState]) {
                this.material.map = textureMap[currentState];
                this.material.needsUpdate = true;
            }
        }
    };

    return face;
}