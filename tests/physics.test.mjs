// Sanity tests for the physics + rules + AI. Run: npm test
import assert from 'node:assert/strict';
import { World, rackPositions, newLog, updateLog } from '../src/physics.js';
import { EightBall } from '../src/rules.js';
import { planShot } from '../src/ai.js';
import { R, HEAD_X, FOOT_X } from '../src/constants.js';

const deg = (vx, vz) => (Math.atan2(vz, vx) * 180) / Math.PI;
const t = (name, fn) => { fn(); console.log('ok -', name); };

t('center-ball strike at 0.4R gives natural roll', () => {
  const w = new World(); const b = w.add(0, 0, 0); w.strike(1, 0, 2, 0, 0.4);
  assert.ok(Math.abs(b.vx + R * b.wz) < 1e-9);
});

t('30° cut: object ball ~30° (minus throw), cue ball ~90° away with stun', () => {
  const w = new World(); w.add(0, -0.1, 0); w.add(1, 0, R); w.strike(1, 0, 2);
  while (!w.events.length) w.step(1 / 1500);
  const c = w.ball(0), o = w.ball(1);
  const a = deg(o.vx, o.vz);
  assert.ok(a > 26 && a < 30, `object ${a}`);
  assert.ok(Math.abs(deg(c.vx, c.vz) - a + 90) < 6);
});

t('draw comes back, follow goes through', () => {
  for (const [b, check] of [[-0.45, (x) => x < -0.3], [0.4, (x) => x > 0.05]]) {
    const w = new World(); w.add(0, -0.5, 0.1); w.add(1, 0, 0.1); w.strike(1, 0, 2.5, 0, b);
    while (w.ball(1).active && w.ball(1).x < 0.5) w.step(1 / 1500); // stop before object ball rebounds
    for (let i = 0; i < 1500; i++) w.step(1 / 1500);
    assert.ok(check(w.ball(0).x), `b=${b} x=${w.ball(0).x}`);
  }
});

t('english changes cushion rebound', () => {
  const r = (a) => { const w = new World(); w.add(0, 0.5, 0); w.strike(0, 1, 1.5, a, 0); w.runUntilStopped(0.6, 1 / 1500); const c = w.ball(0); return deg(c.vx, c.vz); };
  assert.ok(r(0.4) < -95 && r(-0.4) > -85);
});

t('break spreads the rack and terminates', () => {
  const w = new World(); w.trackRotation = false; w.add(0, HEAD_X, 0);
  for (const p of rackPositions()) w.add(p.id, p.x, p.z);
  w.strike(1, 0, 7.5);
  const time = w.runUntilStopped(40, 1 / 1500);
  assert.ok(time < 40);
  for (const b of w.balls) if (b.active) assert.ok(Math.abs(b.x) < 1.27 && Math.abs(b.z) < 0.635);
});

t('CPU vs CPU games finish', () => {
  for (let g = 0; g < 3; g++) {
    const w = new World(); w.trackRotation = false; w.add(0, HEAD_X, 0);
    for (const p of rackPositions()) w.add(p.id, p.x, p.z);
    const game = new EightBall([{ name: 'A' }, { name: 'B' }]);
    let shots = 0;
    while (!game.over && shots < 200) {
      const plan = planShot(w, game, 'hard');
      const cb = w.ball(0);
      if (plan.place) { cb.x = plan.place.x; cb.z = plan.place.z; }
      const before = w.activeIds();
      w.strike(Math.cos(plan.yaw), Math.sin(plan.yaw), plan.V, plan.a, plan.b);
      const log = newLog();
      while (w.anyMoving()) { w.step(1 / 1500); for (const e of w.events) updateLog(log, e); w.events.length = 0; }
      const res = game.endShot(log, before);
      const spot = (id, x) => { const b = w.ball(id); b.active = true; b.pocketed = false; b.stop(); b.z = 0; b.x = x; while (w.balls.some((o) => o !== b && o.active && Math.hypot(o.x - b.x, o.z - b.z) < 2 * R)) b.x += 0.006; };
      if (log.pocketed.includes(0)) spot(0, HEAD_X);
      if (res.respot8) spot(8, FOOT_X);
      shots++;
    }
    assert.ok(game.over, 'game did not finish');
  }
});

// ---- 3D ball / cue physics ----
import { cueStrike, Chalk, miscueLimit, muTip, minElevation, cueSpeedFor } from '../src/cuephys.js';
import { PHYS } from '../src/constants.js';

t('level strike stays on the cloth', () => {
  const w = new World(); const b = w.add(0, 0, 0); w.strike(1, 0, 3, 0.3, -0.3);
  assert.equal(b.vy, 0); w.runUntilStopped(5, 1 / 1500); assert.equal(b.y, 0);
});

t('elevated strike jumps a blocking ball', () => {
  const w = new World(); const c = w.add(0, -0.5, 0); w.add(1, -0.32, 0);
  w.strike(1, 0, 4.5, 0, 0, (45 * Math.PI) / 180);
  let maxY = 0, hit = false;
  for (let i = 0; i < 1500 * 0.6; i++) { w.step(1 / 1500); maxY = Math.max(maxY, c.y); if (w.events.some((e) => e.type === 'ball')) hit = true; w.events.length = 0; }
  // hop height = (e·V·sinθ)²/2g minus slate friction losses
  const h = (PHYS.eSlate * 4.5 * Math.sin(Math.PI / 4)) ** 2 / (2 * 9.81);
  assert.ok(Math.abs(maxY - h) < 0.01, `maxY ${maxY} vs ${h}`);
  assert.ok(!hit && c.x > -0.25, `hit=${hit} x=${c.x}`);
});

t('massé curves toward the side struck', () => {
  for (const a of [-0.4, 0.4]) {
    const w = new World(); const c = w.add(0, -0.8, 0); w.strike(1, 0, 2, a, 0, (70 * Math.PI) / 180);
    w.runUntilStopped(0.8, 1 / 1500); // before it reaches a rail
    assert.ok(Math.sign(c.z) === Math.sign(a) && Math.abs(c.z) > 0.2, `a=${a} z=${c.z}`);
  }
});

t('miscue limit: ρ = μ/√(1+μ²) ≈ 0.55R chalked, ≈ 0.21R bare', () => {
  assert.ok(Math.abs(miscueLimit(muTip(1)) - 0.545) < 0.01);
  assert.ok(Math.abs(miscueLimit(muTip(0)) - 0.215) < 0.01);
  const run = (cov, a) => { const w = new World(); w.add(0, 0, 0); const ch = new Chalk(); ch.fill(cov); return cueStrike(w, 1, 0, { vCue: 2, a, chalk: ch, rng: () => 0.5 }); };
  assert.ok(!run(1, 0.45).miscue && run(0, 0.45).miscue && run(1, 0.62).miscue);
  const clean = run(1, 0), weak = run(1, 0.62);
  assert.ok(Math.abs(clean.V - 2 * 1.75 / (1 + 0.17 / 0.54)) < 1e-9 && weak.V < 0.75 * clean.V);
  assert.ok(Math.abs(cueSpeedFor(clean.V) - 2) < 1e-9);
});

t('chalk wears where the ball touches the tip', () => {
  const ch = new Chalk(); ch.fill(1);
  for (let i = 0; i < 6; i++) ch.wear(0, 0, 3);
  assert.ok(ch.sample(0, 0) < 0.5 && ch.sample(0.8, 0) > ch.sample(0, 0) + 0.2);
});

t('cue must be jacked up over the rail and over balls', () => {
  const w = new World(); w.add(0, 0, -(0.635 - R)); // frozen to the near side rail, shooting away from it
  const e = minElevation(w, Math.PI / 2, 0, 0.3);
  assert.ok(e > 0.15 && e < 0.45, `rail ${e}`);
  const w2 = new World(); w2.add(0, 0, 0); w2.add(1, -0.08, 0);
  const w3 = new World(); w3.add(0, 0, 0);
  assert.ok(minElevation(w2, 0) > 0.3 && minElevation(w3, 0) < 0.06);
});

t('ball jumped over the rail leaves the table', () => {
  const w = new World(); w.add(0, 0.9, 0); w.strike(1, 0, 6, 0, 0, 0.9);
  let off = false; for (let i = 0; i < 3000 && w.anyMoving(); i++) { w.step(1 / 1500); if (w.events.some((e) => e.type === 'offtable')) off = true; w.events.length = 0; }
  assert.ok(off && w.ball(0).offTable);
});

t('rules: balls off the table', () => {
  const g = new EightBall([{ name: 'A' }, { name: 'B' }]); g.isBreak = false; g.open = false; g.players[0].group = 'solids'; g.players[1].group = 'stripes';
  const on = new Set([0, 1, 2, 8, 9]);
  const r1 = g.endShot({ ...newLog(), firstHit: 1, railAfterContact: true, offTable: [9] }, on);
  assert.ok(r1.foul === 'Ball off the table' && r1.respot.includes(9) && r1.ballInHand);
  const r2 = g.endShot({ ...newLog(), firstHit: 9, railAfterContact: true, offTable: [0] }, on);
  assert.ok(r2.foul === 'Cue ball off the table' && r2.ballInHand);
  const g2 = new EightBall([{ name: 'A' }, { name: 'B' }]); g2.isBreak = false; g2.open = false; g2.players[0].group = 'solids';
  const r3 = g2.endShot({ ...newLog(), firstHit: 8, railAfterContact: true, offTable: [8] }, new Set([0, 8, 9]));
  assert.ok(r3.over && g2.winner === 1);
});
