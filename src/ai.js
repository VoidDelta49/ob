// CPU opponent: generates geometric pot candidates (ghost-ball aiming, clear paths, cut/pocket angles),
// then verifies the best ones by running the real physics headless and picks the best outcome.
import { R, HL, HW, HEAD_X, FOOT_X, speedToPower, powerToSpeed } from './constants.js';
import { pockets } from './table-geom.js';
import { newLog, updateLog } from './physics.js';
import { groupOf, groupBalls } from './rules.js';

export const DIFFICULTY = {
  easy: { aimDeg: 1.1, power: 0.12, sims: 6 },
  medium: { aimDeg: 0.45, power: 0.06, sims: 14 },
  hard: { aimDeg: 0.12, power: 0.025, sims: 26 },
};

function segClear(ax, az, bx, bz, balls, ignore, clearance) {
  const ex = bx - ax, ez = bz - az;
  const l2 = ex * ex + ez * ez;
  for (const b of balls) {
    if (!b.active || ignore.includes(b.id)) continue;
    let t = ((b.x - ax) * ex + (b.z - az) * ez) / l2;
    if (t < 0 || t > 1) { if (t < 0 && Math.hypot(b.x - ax, b.z - az) > clearance) continue; if (t > 1 && Math.hypot(b.x - bx, b.z - bz) > clearance) continue; }
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(b.x - (ax + ex * t), b.z - (az + ez * t));
    if (d < clearance) return false;
  }
  return true;
}

export function potCandidates(world, cx, cz, targets) {
  const out = [];
  for (const id of targets) {
    const ob = world.ball(id);
    if (!ob || !ob.active) continue;
    for (const p of pockets) {
      let dx = p.aim.x - ob.x, dz = p.aim.z - ob.z;
      const d2 = Math.hypot(dx, dz);
      dx /= d2; dz /= d2;
      // pocket acceptance angle
      const face = dx * p.facing.x + dz * p.facing.z;
      if (face < (p.corner ? Math.cos((52 * Math.PI) / 180) : Math.cos((58 * Math.PI) / 180))) continue;
      const gx = ob.x - dx * 2 * R, gz = ob.z - dz * 2 * R;
      let ax = gx - cx, az = gz - cz;
      const d1 = Math.hypot(ax, az);
      if (d1 < 1e-3) continue;
      ax /= d1; az /= d1;
      const cosCut = ax * dx + az * dz;
      if (cosCut < Math.cos((76 * Math.PI) / 180)) continue;
      if (!segClear(cx, cz, gx, gz, world.balls, [0, id], 2 * R * 0.98)) continue;
      if (!segClear(ob.x, ob.z, p.aim.x, p.aim.z, world.balls, [0, id], 2 * R * 0.98)) continue;
      // ghost ball must be on the table
      if (Math.abs(gx) > HL - R + 0.002 || Math.abs(gz) > HW - R + 0.002) continue;
      const score = (cosCut * cosCut * (0.6 + 0.4 * face)) / (0.25 + 0.35 * d1 + d2);
      // speed: object ball must arrive with some pace; cue loses energy to cloth before contact
      const vo = Math.sqrt(0.3 * 0.3 + 2 * 0.12 * d2) * 1.25;
      const vc = vo / (Math.max(0.25, cosCut) * 0.975);
      const V = Math.min(6.5, Math.sqrt(vc * vc + 2 * 0.45 * d1));
      out.push({ id, pocket: p, yaw: Math.atan2(az, ax), V, score, cosCut });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function simulate(world, shot) {
  const w = world.clone();
  const cb = w.ball(0);
  cb.x = shot.cx ?? cb.x; cb.z = shot.cz ?? cb.z;
  if (shot.cx !== undefined) { cb.active = true; cb.pocketed = false; }
  w.strike(Math.cos(shot.yaw), Math.sin(shot.yaw), shot.V, shot.a || 0, shot.b || 0);
  const log = newLog();
  let t = 0;
  const sub = 1 / 700;
  while (t < 25 && w.anyMoving()) {
    w.step(sub); t += sub;
    for (const e of w.events) updateLog(log, e);
    w.events.length = 0;
  }
  return { log, world: w };
}

function evaluate(game, before, res, targets) {
  const { log, world } = res;
  const p = game.player;
  if (log.pocketed.includes(0)) return -10;
  if (log.firstHit === null || !targets.includes(log.firstHit)) return -8;
  const potted = log.pocketed.filter((n) => n !== 0);
  const clearedBefore = p.group && groupBalls(p.group).every((n) => !before.has(n));
  if (potted.includes(8) && !(clearedBefore && !game.open)) return -20;
  if (potted.includes(8)) return 100;
  let good;
  if (game.open) good = potted.filter((n) => n !== 8);
  else good = potted.filter((n) => groupOf(n) === p.group);
  if (!good.length) {
    if (!log.railAfterContact) return -6;
    return 0;
  }
  const bad = game.open ? 0 : potted.filter((n) => groupOf(n) && groupOf(n) !== p.group).length;
  // position: how many follow-up pots are available from where the cue ball stopped
  const cb = world.ball(0);
  const onTable = world.activeIds();
  let nextTargets;
  if (game.open) nextTargets = [...onTable].filter((n) => n !== 0 && n !== 8 && (groupOf(n) === groupOf(good[0])));
  else {
    const mine = groupBalls(p.group).filter((n) => onTable.has(n));
    nextTargets = mine.length ? mine : [8];
  }
  const next = potCandidates(world, cb.x, cb.z, nextTargets);
  const pos = next.length ? Math.min(1.5, next[0].score * 1.6) + Math.min(next.length, 4) * 0.08 : 0;
  return 10 + good.length * 1.5 - bad * 1.2 + pos;
}

function validSpot(world, x, z) {
  if (Math.abs(x) > HL - R - 0.005 || Math.abs(z) > HW - R - 0.005) return false;
  for (const b of world.balls) if (b.active && b.id !== 0 && Math.hypot(b.x - x, b.z - z) < 2 * R + 0.004) return false;
  return true;
}

function choosePlacement(world, game, targets, rng) {
  let best = null;
  for (let i = 0; i < 160; i++) {
    const x = game.kitchen ? -HL + R + 0.02 + rng() * (HEAD_X + HL - R - 0.02) : (rng() * 2 - 1) * (HL - R - 0.01);
    const z = (rng() * 2 - 1) * (HW - R - 0.01);
    if (!validSpot(world, x, z)) continue;
    const c = potCandidates(world, x, z, targets);
    const s = c.length ? c[0].score + Math.min(c.length, 5) * 0.02 : -1;
    if (!best || s > best.s) best = { x, z, s };
  }
  return best || { x: HEAD_X, z: 0 };
}

export function planShot(world, game, difficulty = 'medium', rng = Math.random) {
  const cfg = DIFFICULTY[difficulty];
  const onTable = world.activeIds();
  const targets = game.legalTargets(onTable);
  const cb = world.ball(0);
  let place = null;
  let cx = cb.x, cz = cb.z;

  if (game.isBreak) {
    place = { x: HEAD_X, z: (rng() - 0.5) * 0.3 };
    const yaw = Math.atan2(0 - place.z, FOOT_X - place.x);
    return finalize({ place, yaw, V: 7.4, a: 0, b: -0.05 }, cfg, rng, 0.25);
  }

  if (game.ballInHand) {
    place = choosePlacement(world, game, targets, rng);
    cx = place.x; cz = place.z;
  }

  const cands = potCandidates(world, cx, cz, targets);
  let best = null;
  const variants = [
    { k: 1, b: 0 }, { k: 1.2, b: 0.25 }, { k: 1.25, b: -0.3 }, { k: 0.85, b: 0.1 }, { k: 1.6, b: 0 },
  ];
  let sims = 0;
  for (const c of cands.slice(0, 6)) {
    for (const v of variants) {
      if (sims >= cfg.sims * 2) break;
      const shot = { yaw: c.yaw, V: Math.min(7, c.V * v.k), a: 0, b: v.b, cx: place ? cx : undefined, cz: place ? cz : undefined };
      const res = simulate(world, shot);
      sims++;
      const val = evaluate(game, onTable, res, targets) + c.score * 0.5;
      if (!best || val > best.val) best = { ...shot, val };
    }
  }

  // Safety: no pot found — make legal contact and reach a rail
  if (!best || best.val < 5) {
    for (const id of targets) {
      const ob = world.ball(id);
      const base = Math.atan2(ob.z - cz, ob.x - cx);
      const dist = Math.hypot(ob.x - cx, ob.z - cz);
      for (const off of [0, 0.35, -0.35, 0.6, -0.6]) {
        const yaw = base + Math.asin(Math.max(-1, Math.min(1, (off * 2 * R) / dist)));
        for (const V of [1.4, 2.4]) {
          const shot = { yaw, V, a: 0, b: 0, cx: place ? cx : undefined, cz: place ? cz : undefined };
          const val = evaluate(game, onTable, simulate(world, shot), targets);
          if (!best || val > best.val) best = { ...shot, val };
        }
      }
    }
  }
  if (!best) best = { yaw: 0, V: 2, a: 0, b: 0 };
  return finalize({ place, yaw: best.yaw, V: best.V, a: best.a, b: best.b }, cfg, rng);
}

function finalize(shot, cfg, rng, extraNoise = 1) {
  const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  shot.yaw += (gauss() * cfg.aimDeg * Math.PI * extraNoise) / 180;
  const p = speedToPower(shot.V) * (1 + gauss() * cfg.power);
  shot.power = Math.max(0.03, Math.min(1, p));
  shot.V = powerToSpeed(shot.power);
  return shot;
}
