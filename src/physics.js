// Rigid-ball pool physics: sliding/rolling friction with full 3D spin, ball–ball impulses with
// friction (throw / spin transfer), cushion impulses at nose height, jaws and pocket capture.
// Balls can leave the cloth: an elevated cue drives the ball into the slate, which bounces it (jump shots);
// airborne balls fly ballistically (spin kept, no cloth friction), collide in 3D and can leave the table.
// y is the height of the ball's bottom above the cloth (0 = resting on the bed).
import { R, M, I, G, PHYS, HL, HW, FOOT_X } from './constants.js';
import { cushionSegments, pockets } from './table-geom.js';

const SIN_T = (PHYS.cushionNose - R) / R;
const COS_T = Math.sqrt(1 - SIN_T * SIN_T);
const D = 2 * R;
const D2 = D * D;

export class Ball {
  constructor(id, x = 0, z = 0) {
    this.id = id;
    this.x = x; this.z = z; this.y = 0;
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;
    this.q = [0, 0, 0, 1];
    this.active = true;
    this.pocketed = false;
    this.fall = null;
    this.offTable = false;
  }
  airborne() { return this.y > 0 || this.vy !== 0; }
  moving() {
    return this.vx !== 0 || this.vz !== 0 || this.vy !== 0 || this.y > 0 || this.wx !== 0 || this.wy !== 0 || this.wz !== 0;
  }
  stop() { this.vx = this.vz = this.vy = this.wx = this.wy = this.wz = 0; this.y = 0; }
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
      c.y = b.y; c.vx = b.vx; c.vy = b.vy; c.vz = b.vz; c.wx = b.wx; c.wy = b.wy; c.wz = b.wz;
      c.active = b.active; c.pocketed = b.pocketed; c.offTable = b.offTable;
      w.balls.push(c);
    }
    return w;
  }

  // Cue strike. (dx,dz) aim direction, V cue-ball speed, (a,b) tip offset in ball radii:
  // a = right english (+) / left (-), b = follow (+) / draw (-). elev = cue elevation (rad, butt raised).
  // The cue force acts along the cue axis d (tip friction holds it there; see cuephys.js for the miscue limit),
  // so v = V·d and ω = (r × M V d) / I. With elevation, d points down into the bed and the slate bounce on the
  // next step turns that into a hop (jump shot); side offset + elevation gives the horizontal-axis spin of a massé.
  strike(dx, dz, V, a = 0, b = 0, elev = 0) {
    const { d, r } = cueGeometry(dx, dz, a, b, elev);
    this.impulse(0, M * V * d[0], M * V * d[1], M * V * d[2], r[0], r[1], r[2]);
  }

  // Apply impulse J at contact point r (relative to the ball centre) to ball `id`.
  impulse(id, Jx, Jy, Jz, rx, ry, rz) {
    const cb = this.ball(id);
    cb.vx += Jx / M; cb.vy += Jy / M; cb.vz += Jz / M;
    cb.wx += (ry * Jz - rz * Jy) / I;
    cb.wy += (rz * Jx - rx * Jz) / I;
    cb.wz += (rx * Jy - ry * Jx) / I;
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
    for (const b of balls) {
      if (!b.active || !b.moving()) continue;
      if (b.airborne()) b.vy -= G * dt; // ballistic: gravity only, spin kept
      else this.friction(b, dt);
    }
    for (const b of balls) {
      if (!b.active) continue;
      b.x += b.vx * dt; b.z += b.vz * dt;
      if (b.vy !== 0) {
        b.y += b.vy * dt;
        if (b.y <= 0) { b.y = 0; if (b.vy < 0) this.slateImpact(b); else b.vy = 0; }
      }
    }

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

  // Ball lands on (or is driven into) the slate: restitution + Coulomb friction at the contact patch.
  slateImpact(b) {
    const vn = -b.vy;
    if (vn > PHYS.settleVy) {
      surfaceImpulse(b, 0, 1, 0, PHYS.eSlate, PHYS.muSlide);
      if (this.recordEvents && vn > 0.25) this.events.push({ type: 'slate', ball: b.id, speed: vn });
    }
    if (b.vy < PHYS.settleVy) { b.vy = 0; b.y = 0; }
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
    const dy = b.y - a.y;
    if (dy > D || dy < -D) return;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= D2 || d2 === 0) return;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const pen = (D - d) / 2;
    a.x -= nx * pen; a.z -= nz * pen;
    b.x += nx * pen; b.z += nz * pen;
    if (ny !== 0) { a.y = Math.max(0, a.y - ny * pen); b.y = Math.max(0, b.y + ny * pen); }

    const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny + (a.vz - b.vz) * nz;
    if (vn <= 0) return;

    // contact-point velocities: uA = vA + wA × (R n), uB = vB + wB × (−R n)
    const relx = a.vx - b.vx + R * ((a.wy + b.wy) * nz - (a.wz + b.wz) * ny);
    const rely = a.vy - b.vy + R * ((a.wz + b.wz) * nx - (a.wx + b.wx) * nz);
    const relz = a.vz - b.vz + R * ((a.wx + b.wx) * ny - (a.wy + b.wy) * nx);

    const Jn = ((1 + PHYS.eBall) * vn * M) / 2;
    a.vx -= (Jn / M) * nx; a.vy -= (Jn / M) * ny; a.vz -= (Jn / M) * nz;
    b.vx += (Jn / M) * nx; b.vy += (Jn / M) * ny; b.vz += (Jn / M) * nz;

    // tangential friction → collision-induced throw and spin transfer
    const tx = relx - vn * nx, ty = rely - vn * ny, tz = relz - vn * nz;
    const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tm > 1e-6) {
      const Jt = Math.min(PHYS.muBall * Jn, (tm * M) / 7);
      const ux = tx / tm, uy = ty / tm, uz = tz / tm;
      a.vx -= (Jt * ux) / M; a.vy -= (Jt * uy) / M; a.vz -= (Jt * uz) / M;
      b.vx += (Jt * ux) / M; b.vy += (Jt * uy) / M; b.vz += (Jt * uz) / M;
      // both balls receive dw = -(R Jt / I) (n × t)
      const s = -(R * Jt) / I;
      const cx = ny * uz - nz * uy, cy = nz * ux - nx * uz, cz = nx * uy - ny * ux;
      a.wx += s * cx; a.wy += s * cy; a.wz += s * cz;
      b.wx += s * cx; b.wy += s * cy; b.wz += s * cz;
    }
    if (this.recordEvents) this.events.push({ type: 'ball', a: a.id, b: b.id, speed: vn });
  }

  collideCushions(b) {
    // cheap reject: far from every rail
    if (Math.abs(b.x) < HL - R - 0.002 && Math.abs(b.z) < HW - R - 0.002) return;
    if (b.y > 0.002) { this.collideCushionsAir(b); return; }
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

  // Airborne ball vs the cushion nose, modelled as a horizontal line at nose height: full 3D normal, so a ball
  // arriving from above is deflected up / over instead of being stopped by a vertical wall.
  collideCushionsAir(b) {
    const dyv = R + b.y - PHYS.cushionNose;
    if (dyv >= R) return;
    for (const [p, q] of cushionSegments) {
      const ex = q[0] - p[0], ez = q[1] - p[1];
      let t = ((b.x - p[0]) * ex + (b.z - p[1]) * ez) / (ex * ex + ez * ez);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = p[0] + ex * t, cz = p[1] + ez * t;
      const dx = b.x - cx, dz = b.z - cz;
      const d2 = dx * dx + dz * dz + dyv * dyv;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dyv / d, nz = dz / d;
      b.x = cx + nx * R; b.z = cz + nz * R; b.y = Math.max(0, PHYS.cushionNose + ny * R - R);
      const vn = b.vx * nx + b.vy * ny + b.vz * nz;
      if (vn >= 0) continue;
      const speed = -vn;
      surfaceImpulse(b, nx, ny, nz, Math.max(0.55, PHYS.eCushion - 0.045 * Math.min(speed, 6)), PHYS.muCushion);
      if (this.recordEvents) this.events.push({ type: 'cushion', ball: b.id, speed });
      return;
    }
  }

  checkPocket(b) {
    let hit = null;
    for (const p of pockets) {
      const dx = b.x - p.x, dz = b.z - p.z;
      if (dx * dx + dz * dz < p.r * p.r) { hit = p; break; }
    }
    if (hit && b.y > 0.6 * R) return; // flying over the pocket
    if (!hit && b.y > 0.002 && (Math.abs(b.x) > HL + 0.002 || Math.abs(b.z) > HW + 0.002)) {
      // airborne and past the cushion nose, not over a pocket: it has left the playing surface
      b.active = false;
      b.offTable = true;
      b.fall = { off: true, t: 0, x0: b.x, y0: b.y, z0: b.z, vx: b.vx, vy: b.vy, vz: b.vz };
      b.stop();
      if (this.recordEvents) this.events.push({ type: 'offtable', ball: b.id });
      return;
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
    b.fall = { pocket: hit, t: 0, x0: b.x, y0: b.y, z0: b.z, vx: b.vx, vz: b.vz };
    b.stop();
    if (this.recordEvents) this.events.push({ type: 'pocket', ball: b.id, pocket: pockets.indexOf(hit) });
  }
}

// Unit cue axis d (pointing from the butt into the ball, downward when elevated) and tip contact point r
// relative to the ball centre for tip offset (a, b) in ball radii, measured in the plane normal to the cue.
// Squirt (cue-ball deflection away from the struck side) is applied to the horizontal aim first.
export function cueGeometry(dx, dz, a = 0, b = 0, elev = 0, squirt = true) {
  let n = Math.hypot(dx, dz); dx /= n; dz /= n;
  const sq = squirt ? -a * PHYS.squirt * Math.cos(elev) : 0;
  const sx0 = -dz, sz0 = dx;
  dx += sx0 * sq; dz += sz0 * sq;
  n = Math.hypot(dx, dz); dx /= n; dz /= n;
  const ce = Math.cos(elev), se = Math.sin(elev);
  const d = [dx * ce, -se, dz * ce];
  const s = [-dz, 0, dx];              // horizontal, to the shooter's right
  const u = [dx * se, ce, dz * se];    // s × d: "up" in the plane normal to the cue
  const c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
  const r = [0, 1, 2].map((i) => R * (a * s[i] + b * u[i] - c * d[i]));
  return { d, s, u, r };
}

// Impulse from a fixed surface with outward normal n at contact point −R n: restitution e on the normal
// component, Coulomb friction (capped at stopping the contact-point slip) on the tangential one.
function surfaceImpulse(b, nx, ny, nz, e, mu) {
  const rx = -R * nx, ry = -R * ny, rz = -R * nz;
  const ux = b.vx + (b.wy * rz - b.wz * ry);
  const uy = b.vy + (b.wz * rx - b.wx * rz);
  const uz = b.vz + (b.wx * ry - b.wy * rx);
  const vn = ux * nx + uy * ny + uz * nz;
  if (vn >= 0) return;
  const Jn = -(1 + e) * vn * M;
  let tx = ux - vn * nx, ty = uy - vn * ny, tz = uz - vn * nz;
  const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
  let Jx = Jn * nx, Jy = Jn * ny, Jz = Jn * nz;
  if (tm > 1e-7) {
    const Jt = Math.min(mu * Jn, (tm * M) / 3.5);
    tx /= tm; ty /= tm; tz /= tm;
    Jx -= Jt * tx; Jy -= Jt * ty; Jz -= Jt * tz;
  }
  b.vx += Jx / M; b.vy += Jy / M; b.vz += Jz / M;
  b.wx += (ry * Jz - rz * Jy) / I;
  b.wy += (rz * Jx - rx * Jz) / I;
  b.wz += (rx * Jy - ry * Jx) / I;
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
  return { firstHit: null, railAfterContact: false, pocketed: [], offTable: [], cushions: 0, miscue: false };
}
export function updateLog(log, ev) {
  if (ev.type === 'ball') {
    if (log.firstHit === null && (ev.a === 0 || ev.b === 0)) log.firstHit = ev.a === 0 ? ev.b : ev.a;
  } else if (ev.type === 'cushion') {
    log.cushions++;
    if (log.firstHit !== null) log.railAfterContact = true;
  } else if (ev.type === 'pocket') {
    log.pocketed.push(ev.ball);
  } else if (ev.type === 'offtable') {
    log.offTable.push(ev.ball);
  } else if (ev.type === 'miscue') {
    log.miscue = true;
  }
}

// Standard 8-ball rack: apex on the foot spot, 8 in the centre, one solid + one stripe in back corners.
// Rack quality: gap = mean clearance between neighbouring balls (m), loose = random per-ball wander (m),
// apex = apex ball offset from the foot spot [dx, dz] (m). A frozen rack transfers the break; gaps deaden it.
export function rackPositions(rng = Math.random, { gap = 0.00002, loose = 0.0001, apex = [0, 0] } = {}) {
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
  const g = 1 + gap / (2 * R);
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      const x = FOOT_X + apex[0] + row * R * Math.sqrt(3) * g;
      const z = apex[1] + (j - row / 2) * 2 * R * g;
      out.push({ id: order[k++], x: x + (rng() - 0.5) * 2 * loose, z: z + (rng() - 0.5) * 2 * loose });
    }
  }
  // the wander must not create overlaps: push overlapping pairs apart
  for (let it = 0; it < 20; it++) for (let i = 0; i < 15; i++) for (let j = i + 1; j < 15; j++) {
    const a = out[i], b = out[j]; const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d < 2 * R + 1e-6) { const p = (2 * R + 1e-6 - d) / 2; a.x -= (dx / d) * p; a.z -= (dz / d) * p; b.x += (dx / d) * p; b.z += (dz / d) * p; }
  }
  return out;
}
