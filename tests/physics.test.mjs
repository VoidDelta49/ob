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
