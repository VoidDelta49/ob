// Rigid-ball pool physics: sliding/rolling friction with full 3D spin, ball–ball impulses with
// friction (throw / spin transfer), cushion impulses at nose height, jaws and pocket capture.
import { R, M, I, G, PHYS, HL, HW, FOOT_X } from './constants.js';
import { cushionSegments, pockets } from './table-geom.js';

const SIN_T = (PHYS.cushionNose - R) / R;
const COS_T = Math.sqrt(1 - SIN_T * SIN_T);
const D = 2 * R;
const D2 = D * D;

export class Ball {
  constructor(id, x = 0, z = 0) {
    this.id = id;
    this.x = x; this.z = z;
    this.vx = 0; this.vz = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;
    this.q = [0, 0, 0, 1];
    this.active = true;
    this.pocketed = false;
    this.fall = null;
  }
  moving() {
    return this.vx !== 0 || this.vz !== 0 || this.wx !== 0 || this.wy !== 0 || this.wz !== 0;
  }
  stop() { this.vx = this.vz = this.wx = this.wy = this.wz = 0; }
}

export class World {
  constructor() {
    this.balls = [];
    this.events = [];
    this.trackRotation = true;
    this.recordEvents = true;
    this.acc = 0;
  }

  add(id, x, z) { const b = new Ball(id, x, z); this.balls.push(b); return b; }
  ball(id) { return this.balls.find((b) => b.id === id); }
  activeIds() { return new Set(this.balls.filter((b) => b.active).map((b) => b.id)); }
  anyMoving() { return this.balls.some((b) => b.active && b.moving()); }

  clone() {
    const w = new World();
    w.trackRotation = false;
    for (const b of this.balls) {
      const c = new Ball(b.id, b.x, b.z);
      c.vx = b.vx; c.vz = b.vz; c.wx = b.wx; c.wy = b.wy; c.wz = b.wz;
      c.active = b.active; c.pocketed = b.pocketed;
      w.balls.push(c);
    }
    return w;
  }

  // Cue strike. (dx,dz) aim direction, V cue-ball speed, (a,b) tip offset in ball radii:
  // a = right english (+) / left (-), b = follow (+) / draw (-).
  strike(dx, dz, V, a = 0, b = 0) {
    const cb = this.ball(0);
    let n = Math.hypot(dx, dz); dx /= n; dz /= n;
    // squirt: cue ball deflects slightly away from the side of the ball that was struck
    let sx = -dz, sz = dx;
    const sq = -a * 0.028;
    dx += sx * sq; dz += sz * sq;
    n = Math.hypot(dx, dz); dx /= n; dz /= n;
    sx = -dz; sz = dx;
    const c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
    const rx = R * (a * sx - c * dx), ry = R * b, rz = R * (a * sz - c * dz);
    const k = (5 * V) / (2 * R * R);
    cb.vx = V * dx; cb.vz = V * dz;
    cb.wx = k * (ry * dz);
    cb.wy = k * (rz * dx - rx * dz);
    cb.wz = k * (-ry * dx);
  }

  simulate(dt, sub = 1 / 1500) {
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= sub) { this.step(sub); this.acc -= sub; }
  }

  // Fast headless run (used by the AI). Returns elapsed sim time.
  runUntilStopped(maxT = 25, sub = 1 / 700) {
    let t = 0;
    while (t < maxT && this.anyMoving()) { this.step(sub); t += sub; }
    return t;
  }

  step(dt) {
    const balls = this.balls;
    for (const b of balls) if (b.active && b.moving()) this.friction(b, dt);
    for (const b of balls) if (b.active) { b.x += b.vx * dt; b.z += b.vz * dt; }

    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.active) this.collideBalls(a, b);
      }
    }
    for (const b of balls) if (b.active) { this.collideCushions(b); this.checkPocket(b); }

    if (this.trackRotation) {
      for (const b of balls) if (b.active && b.moving()) integrateRotation(b, dt);
    }
  }

  friction(b, dt) {
    // velocity of the contact point with the cloth: u = v + w × (0,-R,0)
    const ux = b.vx + R * b.wz;
    const uz = b.vz - R * b.wx;
    const u = Math.hypot(ux, uz);
    if (u > 1e-4) {
      // sliding: kinetic friction opposes u; |u| decays at 7/2 μ g
      const dec = PHYS.muSlide * G * dt;
      const k = 3.5 * dec > u ? u / (3.5 * dec) : 1;
      const ex = ux / u, ez = uz / u;
      b.vx -= dec * k * ex;
      b.vz -= dec * k * ez;
      const wd = ((2.5 * PHYS.muSlide * G) / R) * dt * k;
      b.wx += wd * ez;
      b.wz -= wd * ex;
    } else {
      // rolling: small rolling resistance, spin locked to velocity
      const sp = Math.hypot(b.vx, b.vz);
      if (sp < PHYS.stopSpeed) { b.vx = b.vz = 0; }
      else {
        const ns = Math.max(0, sp - PHYS.muRoll * G * dt);
        b.vx *= ns / sp; b.vz *= ns / sp;
      }
      b.wx = b.vz / R;
      b.wz = -b.vx / R;
    }
    // vertical-axis (side) spin decays from the contact patch
    if (b.wy !== 0) {
      const d = ((2.5 * PHYS.muSpin * G) / R) * dt;
      b.wy = Math.abs(b.wy) <= d ? 0 : b.wy - Math.sign(b.wy) * d;
    }
  }

  collideBalls(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    if (dx > D || dx < -D || dz > D || dz < -D) return;
    const d2 = dx * dx + dz * dz;
    if (d2 >= D2 || d2 === 0) return;
    const d = Math.sqrt(d2);
    const nx = dx / d, nz = dz / d;
    const pen = (D - d) / 2;
    a.x -= nx * pen; a.z -= nz * pen;
    b.x += nx * pen; b.z += nz * pen;

    const vn = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
    if (vn <= 0) return;

    // contact-point velocities (rA = R n, rB = -R n); w × r for r=(rx,0,rz) = (wy rz, wz rx - wx rz, -wy rx)
    const relx = (a.vx + a.wy * R * nz) - (b.vx - b.wy * R * nz);
    const rely = (a.wz * R * nx - a.wx * R * nz) + (b.wz * R * nx - b.wx * R * nz);
    const relz = (a.vz - a.wy * R * nx) - (b.vz + b.wy * R * nx);

    const Jn = ((1 + PHYS.eBall) * vn * M) / 2;
    a.vx -= (Jn / M) * nx; a.vz -= (Jn / M) * nz;
    b.vx += (Jn / M) * nx; b.vz += (Jn / M) * nz;

    // tangential friction → collision-induced throw and spin transfer
    const tx = relx - vn * nx, ty = rely, tz = relz - vn * nz;
    const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tm > 1e-6) {
      const Jt = Math.min(PHYS.muBall * Jn, (tm * M) / 7);
      const ux = tx / tm, uy = ty / tm, uz = tz / tm;
      a.vx -= (Jt * ux) / M; a.vz -= (Jt * uz) / M;
      b.vx += (Jt * ux) / M; b.vz += (Jt * uz) / M;
      // both balls receive dw = -(R Jt / I) (n × t)
      const s = -(R * Jt) / I;
      const cx = -nz * uy, cy = nz * ux - nx * uz, cz = nx * uy;
      a.wx += s * cx; a.wy += s * cy; a.wz += s * cz;
      b.wx += s * cx; b.wy += s * cy; b.wz += s * cz;
    }
    if (this.recordEvents) this.events.push({ type: 'ball', a: a.id, b: b.id, speed: vn });
  }

  collideCushions(b) {
    // cheap reject: far from every rail
    if (Math.abs(b.x) < HL - R - 0.002 && Math.abs(b.z) < HW - R - 0.002) return;
    for (const [p, q] of cushionSegments) {
      const ex = q[0] - p[0], ez = q[1] - p[1];
      let t = ((b.x - p[0]) * ex + (b.z - p[1]) * ez) / (ex * ex + ez * ez);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = p[0] + ex * t, cz = p[1] + ez * t;
      const dx = b.x - cx, dz = b.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      b.x = cx + nx * R; b.z = cz + nz * R;
      const vn = b.vx * nx + b.vz * nz;
      if (vn >= 0) continue;
      this.cushionImpulse(b, nx, nz, vn);
    }
  }

  cushionImpulse(b, nx, nz, vn) {
    // contact point: on the cushion nose, above the ball's equator
    const rx = -R * COS_T * nx, ry = R * SIN_T, rz = -R * COS_T * nz;
    const vcx = b.vx + (b.wy * rz - b.wz * ry);
    const vcz = b.vz + (b.wx * ry - b.wy * rx);
    const speed = -vn;
    const e = Math.max(0.55, PHYS.eCushion - 0.045 * Math.min(speed, 6));
    const Jn = (1 + e) * speed * M;
    const tx = -nz, tz = nx;
    const vt = vcx * tx + vcz * tz;
    const Jt = -Math.sign(vt) * Math.min(PHYS.muCushion * Jn, (Math.abs(vt) * M) / 3.5);
    const Jx = Jn * nx + Jt * tx, Jz = Jn * nz + Jt * tz;
    b.vx += Jx / M; b.vz += Jz / M;
    // dw = r × J / I   (J has no vertical component)
    b.wx += (ry * Jz) / I;
    b.wy += (rz * Jx - rx * Jz) / I;
    b.wz += (-ry * Jx) / I;
    if (this.recordEvents) this.events.push({ type: 'cushion', ball: b.id, speed });
  }

  checkPocket(b) {
    let hit = null;
    for (const p of pockets) {
      const dx = b.x - p.x, dz = b.z - p.z;
      if (dx * dx + dz * dz < p.r * p.r) { hit = p; break; }
    }
    if (!hit && (Math.abs(b.x) > HL + 0.04 || Math.abs(b.z) > HW + 0.04)) {
      let best = Infinity;
      for (const p of pockets) {
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        if (d < best) { best = d; hit = p; }
      }
    }
    if (!hit) return;
    b.active = false;
    b.pocketed = true;
    b.fall = { pocket: hit, t: 0, x0: b.x, z0: b.z, vx: b.vx, vz: b.vz };
    b.stop();
    if (this.recordEvents) this.events.push({ type: 'pocket', ball: b.id, pocket: pockets.indexOf(hit) });
  }
}

function integrateRotation(b, dt) {
  const wx = b.wx, wy = b.wy, wz = b.wz;
  const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (w < 1e-9) return;
  const h = (w * dt) / 2;
  const s = Math.sin(h) / w;
  const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(h);
  const [x, y, z, qw] = b.q;
  // q = dq ⊗ q (world-frame angular velocity)
  let nx = dw * x + dx * qw + dy * z - dz * y;
  let ny = dw * y - dx * z + dy * qw + dz * x;
  let nz = dw * z + dx * y - dy * x + dz * qw;
  let nw = dw * qw - dx * x - dy * y - dz * z;
  const n = Math.hypot(nx, ny, nz, nw);
  b.q[0] = nx / n; b.q[1] = ny / n; b.q[2] = nz / n; b.q[3] = nw / n;
}

// Shot log helpers shared by game loop and AI.
export function newLog() {
  return { firstHit: null, railAfterContact: false, pocketed: [], cushions: 0 };
}
export function updateLog(log, ev) {
  if (ev.type === 'ball') {
    if (log.firstHit === null && (ev.a === 0 || ev.b === 0)) log.firstHit = ev.a === 0 ? ev.b : ev.a;
  } else if (ev.type === 'cushion') {
    log.cushions++;
    if (log.firstHit !== null) log.railAfterContact = true;
  } else if (ev.type === 'pocket') {
    log.pocketed.push(ev.ball);
  }
}

// Standard 8-ball rack: apex on the foot spot, 8 in the centre, one solid + one stripe in back corners.
export function rackPositions(rng = Math.random) {
  const solids = [1, 2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  shuffle(solids); shuffle(stripes);
  const order = new Array(15).fill(null);
  order[4] = 8; // row 3 middle
  const flip = rng() < 0.5;
  order[10] = flip ? solids.pop() : stripes.pop();
  order[14] = flip ? stripes.pop() : solids.pop();
  const rest = shuffle([...solids, ...stripes]);
  for (let i = 0; i < 15; i++) if (order[i] === null) order[i] = rest.pop();
  const out = [];
  const gap = 1.0004; // racks are tight but not perfectly frozen
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      const x = FOOT_X + row * R * Math.sqrt(3) * gap;
      const z = (j - row / 2) * 2 * R * gap;
      out.push({ id: order[k++], x: x + (rng() - 0.5) * 0.0002, z: z + (rng() - 0.5) * 0.0002 });
    }
  }
  return out;
}
