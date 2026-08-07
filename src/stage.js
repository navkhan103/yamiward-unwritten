/**
 * YAMIWARD — stages
 * ============================================================================
 * A stage is four layers and five draw calls. It owns the sky, the floor, the
 * ring of landmarks, the weather, the fog and the light colours; everything
 * else in the scene is fighters.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LAYER IS RADIAL
 * ---------------------------------------------------------------------------
 * TekkenCamera puts the camera on `cross(fighterAxis, UP)`, and that axis turns
 * through a full circle as the fighters move around each other. The camera can
 * therefore end up at ANY bearing. A painted backdrop plane — the obvious way
 * to build this — is edge-on and effectively gone for a quarter of every match.
 * So:
 *
 *   sky        one cylinder, MirroredRepeatWrapping x2. The mirror is what
 *              makes the wrap seamless by construction rather than by hand-
 *              tiling the art: the copy runs backwards, so its edges meet the
 *              original's exactly at both joins. Fog is DISABLED on it — the
 *              sky is the thing fog fades toward, so fogging it would flatten
 *              the stage to a single colour.
 *   landmarks  a ring of cut-outs at assorted bearings, radii and heights,
 *              each facing the arena centre. From any camera position several
 *              are near face-on behind the fighters; the ones beside the camera
 *              go edge-on, which is fine, because you are not looking at them.
 *              This layer is also what breaks the sky's 180° mirror symmetry.
 *              All of them share one atlas and one merged geometry: 1 draw call.
 *   ground     radius MATCHES the sky cylinder, so its rim lands exactly on the
 *              painted horizon. Any other radius leaves a visible disc edge
 *              hanging in the air.
 *   motes      one THREE.Points system: snow, rain, embers or foxfire.
 *
 * ---------------------------------------------------------------------------
 * TEXTURE FILTERING
 * ---------------------------------------------------------------------------
 * Mipmaps stay ON here, unlike the doll atlas. That is not an inconsistency:
 * the doll atlas packs many sub-rects into one sheet, so its lower mip levels
 * average across unrelated pieces and bleed a shoulder into a shin. The sky and
 * ground are whole images sampled edge-to-edge, and the ground is tiled at a
 * grazing angle where mipmapping is the difference between a floor and a field
 * of aliasing. The landmark atlas IS a sheet, so it gets the doll treatment.
 */

import * as THREE from 'three';

const LOADER = new THREE.TextureLoader();

/**
 * Which district each fighter belongs to. Only the launch four's gates are
 * built (WARD-MAP-PROPOSAL §3B — they cover all four elements), so the other
 * four borrow on theme rather than falling back to a default:
 *   shigure  AMEONNA, rain            -> the roof, in the rain
 *   tsukimi  TSUKIUSAGI, lantern-lit  -> the maze
 *   kazakiri TENGU, high and empty    -> the Still Quarter, the sparsest stage
 *   yumihari RYU, gold horizon        -> the Gatehouse, the only gold-lit stage
 * Each borrower graduates to its own gate when its rescue chapter ships.
 * Mirrored in pipeline/stages.mjs, which owns the art side of the same table.
 */
export const STAGE_FOR = {
    tetsuki: 'gatehouse', raiga: 'spotlight', yukiwari: 'still', mayoi: 'lantern',
    shigure: 'spotlight', tsukimi: 'lantern', kazakiri: 'still', yumihari: 'gatehouse',
};

/**
 * District titles for the story beat. Held here rather than read off the loaded
 * manifest because the intro plays the instant startMatch runs, while the new
 * stage is still fetching — reading `stage.manifest.name` at that moment names
 * the district you just LEFT. Same strings as pipeline/stages.mjs, which owns
 * the art side; if a district is ever renamed, both move together.
 */
export const STAGE_TITLES = {
    gatehouse: { name: 'The Gatehouse Yard', blurb: 'The exile district that still guards the door.' },
    spotlight: { name: 'The Spotlight Roof', blurb: 'Rooftops over a city that never stops looking up.' },
    still: { name: 'The Still Quarter', blurb: 'Snow that never melts, because nothing here ever changes.' },
    lantern: { name: 'The Lantern Maze', blurb: 'Alleys that do not keep the same shape twice.' },
};

/**
 * The chapter picks the stage, not a menu (WARD-MAP-PROPOSAL §3C). Story mode
 * does not exist yet, but the rule already works from the matchup alone: canon
 * rivals live at opposite gates, so a rival matchup IS the grudge chapter and
 * plays at the OPPONENT's gate — you travel the diameter of the Ward to fight
 * them. Everything else plays at home.
 */
export function stageForMatch(p1Key, p2Key, rivals) {
    const grudge = rivals?.[p1Key] === p2Key;
    return STAGE_FOR[grudge ? p2Key : p1Key] ?? 'gatehouse';
}

/** Shared soft dot for every mote system — one canvas, made once. */
let DOT = null;
function moteSprite() {
    if (DOT) return DOT;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    DOT = new THREE.CanvasTexture(c);
    DOT.colorSpace = THREE.SRGBColorSpace;
    return DOT;
}

const MOTE_BOX = { r: 19, top: 16 };

export class Stage {
    constructor(manifest, textures) {
        this.manifest = manifest;
        this.id = manifest.id;
        this.name = manifest.name;
        this.textures = textures;          // owned; disposed with the stage
        this.group = new THREE.Group();
        this.group.name = `stage:${manifest.id}`;
        this._t = 0;
        this._motes = null;

        const p = manifest.palette;
        const sky = manifest.sky;
        const skyR = sky.radius, skyH = sky.height;

        // --- sky -------------------------------------------------------------
        if (textures.sky) {
            const t = textures.sky;
            t.colorSpace = THREE.SRGBColorSpace;
            // Plain repeat, NOT mirrored. The plate is cross-faded into a true
            // wrap by stage-pack, so the join is seamless without buying it
            // with a mirror — mirroring made the Still Quarter's sky a
            // reflection down the centre line, which reads instantly as wrong.
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.ClampToEdgeWrapping;
            t.repeat.set(sky.repeat ?? 4, 1);
            // The sky is near perpendicular to the view, so anisotropy barely
            // engages and 4 is plenty. The ground is the grazing-angle surface;
            // see the measurements there.
            t.anisotropy = 4;
            const mesh = new THREE.Mesh(
                new THREE.CylinderGeometry(skyR, skyR, skyH, 64, 1, true),
                new THREE.MeshBasicMaterial({
                    map: t, side: THREE.BackSide,
                    fog: false, depthWrite: false,
                })
            );
            // Put the painted horizon on y=0. `horizon` is the fraction of the
            // image below the horizon line, so the cylinder's bottom sits that
            // far below the floor.
            mesh.position.y = skyH * 0.5 - manifest.horizon * skyH;
            mesh.renderOrder = -10;
            this.group.add(mesh);
            this.sky = mesh;
        }

        // --- ground ----------------------------------------------------------
        // Lambert, NOT Standard. The floor is the single most expensive surface
        // in the frame — it fills the bottom half of the screen and every pixel
        // of it ran the full PBR BRDF, measured at 4.3ms of a 7.1ms GPU frame
        // with a timer query. Nothing was buying that: the stage is lit by one
        // key, one rim and a hemisphere, the art is flat cel-shaded, and a
        // roughness/metalness response on packed earth is invisible next to the
        // texture itself. Lambert keeps the map, the tint, the vertex falloff,
        // the fog and — crucially — shadow receive.
        const groundMat = new THREE.MeshLambertMaterial({
            color: p.groundTint ?? 0xffffff,
        });
        if (textures.ground) {
            const t = textures.ground;
            t.colorSpace = THREE.SRGBColorSpace;
            // Also plain repeat: mirroring on both axes makes adjacent tiles
            // agree along their shared edges, which builds large radial
            // rosettes across the floor. stage-pack wraps this plate on both
            // axes so it tiles for real.
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            const rep = manifest.ground.repeat ?? 7;
            t.repeat.set(rep, rep);
            // Anisotropy 2, not 8 — and this is the single biggest GPU decision
            // in the stage. The floor is tiled 26x and seen at a grazing angle,
            // which is the worst case for minification: every pixel toward the
            // horizon covers many texels, so the sampler runs up to `anisotropy`
            // taps (times trilinear) to resolve it. Measured with a GPU timer
            // query on the Spotlight Roof, ground cost alone:
            //     8x -> 8.09ms   4x -> 6.42ms   2x -> 5.97ms   1x -> 4.77ms
            // 8x was spending a fifth of a 60Hz frame sharpening ground that
            // the distance falloff and fog have already dimmed to near-nothing.
            // 2x keeps the near floor — the part under the fighters, the part
            // anyone looks at — crisp, and 1x is where it starts to smear.
            t.anisotropy = 2;
            groundMat.map = t;
        } else {
            groundMat.color = new THREE.Color(p.fog);
        }
        // Radial falloff, baked into vertex colours.
        //
        // Two problems, one fix. MirroredRepeatWrapping buys seamless tiling at
        // the price of visible symmetry, and on a floor seen in perspective the
        // repeat reads as a kaleidoscope by about the third tile out — the
        // Gatehouse's forge embers came out in a perfect grid. Separately, an
        // evenly lit floor is the brightest thing in frame, which is backwards:
        // the fighters should be. Darkening with distance kills the visible
        // repetition where it is worst (far, foreshortened, many tiles per
        // pixel) and pulls the eye back to the arena, for one attribute and no
        // shader work. RingGeometry rather than CircleGeometry because a circle
        // has only a centre vertex and a rim — no radial subdivision to put a
        // shaped gradient on.
        const gGeo = new THREE.RingGeometry(0, skyR, 96, 12);
        const gp = gGeo.attributes.position;
        const gc = new Float32Array(gp.count * 3);
        for (let i = 0; i < gp.count; i++) {
            // still in the XY plane here — the mesh is rotated flat afterwards
            const d = Math.hypot(gp.getX(i), gp.getY(i));
            // Ramp starts at 16, not 10. The falloff is radial from the arena
            // CENTRE, but the ground nearest the camera is not near the centre —
            // the camera orbits at ~11 and looks across, so the bottom of the
            // frame is already 14-20 units out. Starting the fade at 10 dimmed
            // the closest, most-detailed floor in shot and left a black band
            // along the bottom edge. 16-33 leaves the whole play area and its
            // foreground lit and only kills the far field, which is what the
            // fade was for.
            const k = 1 - 0.88 * THREE.MathUtils.smoothstep(d, 16, 33);
            gc[i * 3] = gc[i * 3 + 1] = gc[i * 3 + 2] = k;
        }
        gGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
        groundMat.vertexColors = true;

        const ground = new THREE.Mesh(gGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.group.add(ground);
        this.ground = ground;

        // --- play boundary ---------------------------------------------------
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(8.9, 9.05, 96),
            new THREE.MeshBasicMaterial({
                color: p.ring ?? 0x9be8e0, transparent: true, opacity: 0.35,
                side: THREE.DoubleSide, depthWrite: false,
            })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.012;
        this.group.add(ring);

        // --- landmark ring ---------------------------------------------------
        if (textures.landmarks && manifest.landmarks?.layout?.length) {
            this.group.add(this._buildLandmarks(manifest.landmarks, textures.landmarks, p));
        }

        // --- motes -----------------------------------------------------------
        if (manifest.motes?.count) this.group.add(this._buildMotes(manifest.motes));
    }

    /**
     * Every landmark in the ring collapses into one BufferGeometry with atlas
     * UVs, so the whole skyline costs a single draw call. Built by hand rather
     * than with mergeGeometries because each quad needs its own UV window and
     * its own orientation, and building the arrays directly is both shorter and
     * allocation-free compared to making 16 PlaneGeometries and merging them.
     */
    _buildLandmarks(def, tex, palette) {
        tex.colorSpace = THREE.SRGBColorSpace;
        // Atlas sub-rects: mipmaps would average across neighbouring landmarks.
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 4;

        const [SW, SH] = def.size;
        const n = def.layout.length;
        const pos = new Float32Array(n * 4 * 3);
        const uv = new Float32Array(n * 4 * 2);
        const nrm = new Float32Array(n * 4 * 3);
        const idx = new Uint16Array(n * 6);

        def.layout.forEach((it, i) => {
            const rect = def.rects[it.key];
            if (!rect) return;
            const [rx, ry, rw, rh] = rect;
            const a = it.angle, r = it.radius, w = it.width, h = it.height;
            // Radial basis: `dir` points out from the arena, `right` runs along
            // the ring. The quad's normal is -dir, i.e. it faces the fight.
            const dx = Math.sin(a), dz = Math.cos(a);
            const rxv = Math.cos(a), rzv = -Math.sin(a);
            const cx = dx * r, cz = dz * r;
            const hw = w * 0.5;

            const corner = (sx, sy, o) => {
                pos[o] = cx + rxv * hw * sx;
                pos[o + 1] = (sy > 0 ? h : 0);
                pos[o + 2] = cz + rzv * hw * sx;
                nrm[o] = -dx; nrm[o + 1] = 0; nrm[o + 2] = -dz;
            };
            const b = i * 12;
            corner(-1, -1, b);       // bottom-left
            corner(1, -1, b + 3);    // bottom-right
            corner(-1, 1, b + 6);    // top-left
            corner(1, 1, b + 9);     // top-right

            // Atlas rect is top-left pixel space; texture v runs bottom-up.
            let u0 = rx / SW, u1 = (rx + rw) / SW;
            if (it.flip) { const t = u0; u0 = u1; u1 = t; }   // mirror for variety
            const v0 = 1 - (ry + rh) / SH, v1 = 1 - ry / SH;
            const ub = i * 8;
            uv[ub] = u0; uv[ub + 1] = v0;
            uv[ub + 2] = u1; uv[ub + 3] = v0;
            uv[ub + 4] = u0; uv[ub + 5] = v1;
            uv[ub + 6] = u1; uv[ub + 7] = v1;

            const vb = i * 4, ib = i * 6;
            idx[ib] = vb; idx[ib + 1] = vb + 1; idx[ib + 2] = vb + 2;
            idx[ib + 3] = vb + 2; idx[ib + 4] = vb + 1; idx[ib + 5] = vb + 3;
        });

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();

        // Unlit on purpose. These are 20-30 units out, well past the shadow box
        // and any meaningful falloff; lighting them makes them compete with the
        // fighters for attention. The tint is what pushes them back into the
        // stage, and fog does the rest.
        const mat = new THREE.MeshBasicMaterial({
            map: tex,
            color: palette.landmarkTint ?? 0x8b95a6,
            alphaTest: 0.5, transparent: false, side: THREE.DoubleSide, fog: true,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'landmarks';
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        return mesh;
    }

    _buildMotes(spec) {
        const n = spec.count;
        const pos = new Float32Array(n * 3);
        const phase = new Float32Array(n);
        const speed = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            pos[i * 3] = (Math.random() * 2 - 1) * MOTE_BOX.r;
            pos[i * 3 + 1] = Math.random() * MOTE_BOX.top;
            pos[i * 3 + 2] = (Math.random() * 2 - 1) * MOTE_BOX.r;
            phase[i] = Math.random() * Math.PI * 2;
            speed[i] = 0.65 + Math.random() * 0.7;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, MOTE_BOX.top / 2, 0), 40);

        const mat = new THREE.PointsMaterial({
            map: moteSprite(), color: spec.color, size: spec.size,
            sizeAttenuation: true, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, fog: false, opacity: 0.9,
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;      // the box always surrounds the camera
        points.renderOrder = 5;
        this._motes = { points, spec, pos, phase, speed, attr: geo.getAttribute('position') };
        return points;
    }

    /** Weather + the foxfire pulse. Cheap: a few hundred floats a frame. */
    update(dt) {
        this._t += dt;
        const m = this._motes;
        if (!m) return;
        const { spec, pos, phase, speed } = m;
        const n = spec.count;
        const rise = spec.rise, drift = spec.drift;
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            pos[o + 1] += rise * speed[i] * dt;
            pos[o] += Math.sin(this._t * 0.7 + phase[i]) * drift * dt;
            pos[o + 2] += Math.cos(this._t * 0.5 + phase[i]) * drift * dt;
            if (rise > 0 && pos[o + 1] > MOTE_BOX.top) { pos[o + 1] = 0; pos[o] = (Math.random() * 2 - 1) * MOTE_BOX.r; pos[o + 2] = (Math.random() * 2 - 1) * MOTE_BOX.r; }
            else if (rise < 0 && pos[o + 1] < 0) { pos[o + 1] = MOTE_BOX.top; pos[o] = (Math.random() * 2 - 1) * MOTE_BOX.r; pos[o + 2] = (Math.random() * 2 - 1) * MOTE_BOX.r; }
        }
        m.attr.needsUpdate = true;
        if (spec.kind === 'foxfire') {
            m.points.material.opacity = 0.55 + 0.35 * Math.sin(this._t * 1.6);
        }
    }

    /** Fog, background and light colours are part of the stage, not the scene. */
    attach(scene, lights) {
        const p = this.manifest.palette;
        scene.background = new THREE.Color(p.background);
        if (scene.fog) { scene.fog.color.setHex(p.fog); scene.fog.density = p.fogDensity; }
        else scene.fog = new THREE.FogExp2(p.fog, p.fogDensity);
        if (lights) {
            lights.key.color.setHex(p.key); lights.key.intensity = p.keyIntensity;
            lights.rim.color.setHex(p.rim); lights.rim.intensity = p.rimIntensity;
            lights.hemi.color.setHex(p.hemiSky);
            lights.hemi.groundColor.setHex(p.hemiGround);
            lights.hemi.intensity = p.hemiIntensity;
        }
        scene.add(this.group);
        return this;
    }

    dispose() {
        this.group.parent?.remove(this.group);
        this.group.traverse((o) => {
            if (!o.isMesh && !o.isPoints) return;
            o.geometry?.dispose();
            for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
                if (!mat) continue;
                // The shared mote sprite outlives every stage — do not dispose it.
                if (mat.map && mat.map !== DOT) mat.map.dispose();
                mat.dispose();
            }
        });
        this._motes = null;
    }

    /**
     * The void. What the arena was before stages existed, kept as the failure
     * mode: a missing or malformed manifest must degrade to a playable, legible
     * arena rather than to a black screen with two fighters floating in it.
     */
    static fallback() {
        return new Stage({
            id: 'void', name: 'The Unwritten', horizon: 0.25,
            palette: {
                background: 0x05050b, fog: 0x05050b, fogDensity: 0.035,
                key: 0xfff0e0, keyIntensity: 2.6, rim: 0x8a5cff, rimIntensity: 1.1,
                hemiSky: 0x2a2a4a, hemiGround: 0x0a0a12, hemiIntensity: 0.55,
                ring: 0x9be8e0, groundTint: 0x0a0a14,
            },
            motes: null,
            sky: { radius: 34, height: 40 },
            ground: { radius: 34, repeat: 7 },
            landmarks: null,
        }, {});
    }

    static async load(id) {
        const base = `./assets/stages/`;
        const res = await fetch(`${base}${id}.json`);
        if (!res.ok) throw new Error(`stage manifest ${id}: ${res.status}`);
        const manifest = await res.json();
        const want = [
            ['sky', manifest.sky?.file],
            ['ground', manifest.ground?.file],
            ['landmarks', manifest.landmarks?.file],
        ];
        const textures = {};
        // Load in parallel; a single missing plate degrades that ONE layer
        // rather than the stage (a stage with no landmarks still beats a void).
        await Promise.all(want.map(async ([slot, file]) => {
            if (!file) return;
            try { textures[slot] = await LOADER.loadAsync(base + file); }
            catch (e) { console.warn(`stage ${id}: ${slot} texture failed`, e); }
        }));
        return new Stage(manifest, textures);
    }
}
