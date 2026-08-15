/**
 * Regression test for the hitstop input-buffer fix.
 *
 * Before the fix, step() returned early during hitstop without calling
 * control() -- the only place prevInput advances and bufferedBtn is set. A
 * press-and-release entirely inside the freeze was therefore swallowed. This
 * asserts the tap survives, and that a freeze with no input still ends clean.
 *
 * Headless: the engine is renderer-agnostic by contract, so no Three.js here.
 */
import assert from 'node:assert/strict';
import { CombatEngine, Btn } from './src/CombatEngine.js';
import { CHARACTERS, MOVES } from './src/moves.js';

const roster = Object.values(CHARACTERS ?? {});
assert.ok(roster.length >= 2, 'need two characters to build an engine');

function freshEngine() {
  return new CombatEngine(roster[0], roster[1], { moves: MOVES, seed: 12345 });
}

// --- 1. A tap that begins AND ends inside hitstop must still buffer ---------
{
  const e = freshEngine();
  e.hitstop = 10;                       // simulate a heavy hit's freeze
  const f = e.fighters[0];
  f.bufferedBtn = 0;
  f.bufferAge = 0;
  f.prevInput = 0;

  e.step([Btn.HEAVY, 0]);               // press, inside the freeze
  assert.equal(f.bufferedBtn, Btn.HEAVY, 'press during hitstop must reach the buffer');

  e.step([0, 0]);                       // release, still inside the freeze
  assert.equal(f.bufferedBtn, Btn.HEAVY, 'buffer must survive the release');
  assert.ok(f.bufferAge > 0, 'buffer must not have expired during the freeze');
  console.log('ok  tap inside hitstop is captured and held');
}

// --- 2. The buffer must NOT age while frozen --------------------------------
{
  const e = freshEngine();
  e.hitstop = 16;                       // a super's freeze
  const f = e.fighters[0];
  f.prevInput = 0;

  e.step([Btn.LIGHT, 0]);
  const ageAfterPress = f.bufferAge;
  for (let i = 0; i < 12; i++) e.step([0, 0]);   // hold the freeze open
  assert.equal(f.bufferAge, ageAfterPress, 'buffer age must be frozen with the sim');
  assert.equal(f.bufferedBtn, Btn.LIGHT, 'input must still be waiting when the freeze lifts');
  console.log('ok  buffer does not expire during a long freeze');
}

// --- 3. Hitstop still counts down and releases the sim ----------------------
{
  const e = freshEngine();
  e.hitstop = 3;
  const before = e.frame;
  e.step([0, 0]); e.step([0, 0]); e.step([0, 0]);
  assert.equal(e.hitstop, 0, 'hitstop must drain');
  assert.equal(e.frame, before + 3, 'frame counter advances during freeze');
  console.log('ok  hitstop drains and the sim resumes');
}

// --- 4. Determinism: same (seed, inputs) -> same state ----------------------
{
  const run = () => {
    const e = freshEngine();
    const seq = [Btn.HEAVY, 0, Btn.LIGHT, 0, Btn.LIGHT, Btn.SUPER, 0, 0];
    for (let i = 0; i < 240; i++) e.step([seq[i % seq.length], seq[(i + 3) % seq.length]]);
    return JSON.stringify(e.fighters.map((f) => [f.health, f.meter, f.pos.x, f.state, f.bufferedBtn]));
  };
  assert.equal(run(), run(), 'engine must replay identically from (seed, inputs)');
  console.log('ok  replay determinism contract still holds');
}

console.log('\n4/4 hitstop-buffer checks passed');
