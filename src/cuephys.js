// Cue-side physics: chalk on the tip, tip friction and the miscue limit, cue → ball momentum transfer,
// cue elevation forced by rails / balls, bridge choice and reach, stroke error. Pure (no DOM / Three.js).
import { R, M, HL, HW } from './constants.js';
import { CW, RAIL_W, CUSHION_H } from './table-geom.js';
import { cueGeometry } from './physics.js';

export const TIP_R = 0.0064;      // 13 mm tip
export const DOME_R = 0.0105;     // "dime" tip dome radius
export const CUE_M = 0.54;        // 19 oz cue
export const E_TIP = 0.75;        // tip–ball restitution (cue-ball/cue speed ≈ 1.33 on a centre hit)
export const CUE_LEN = 1.47;
export const RAIL_TOP = CUSHION_H + 0.004;
export const REACH = 0.85;        // furthest a bridge hand can be from the outer rail edge (one foot on the floor)
export const MAX_TIP = 0.75;      // tip offset (ball radii) the player is physically allowed to address

// Tip friction from local chalk coverage: bare leather ~0.22, well chalked ~0.65.
export const muTip = (cov) => 0.22 + 0.43 * cov;
// The tip force can lean at most atan(μ) from the contact normal. The normal is at asin(ρ) from the cue axis
// for tip offset ρ (ball radii), so the stroke miscues when tan(asin ρ) > μ  ⇔  ρ > μ/√(1+μ²).
export const miscueLimit = (mu) => mu / Math.sqrt(1 + mu * mu);

// Where the ball touches the tip for offset (a, b): the contact normal is at angle φ = asin ρ off the cue axis,
// so on a dome of radius DOME_R the contact is DOME_R·sin φ = DOME_R·ρ from the tip centre (in tip radii below).
export const tipPoint = (a, b) => [(a * DOME_R) / TIP_R, (b * DOME_R) / TIP_R];

// Chalk coverage map over the tip face, unit disc sampled on an N×N grid, values 0..1.
// Coordinates as seen from behind the cue: u = right, v = up (same frame as the tip offset a, b).
export class Chalk {
  constructor(n = 20) { this.n = n; this.c = new Float32Array(n * n); }
  idx(u, v) { const n = this.n; return [Math.round(((u + 1) / 2) * (n - 1)), Math.round(((v + 1) / 2) * (n - 1))]; }
  cellUV(i, j) { const n = this.n; return [(i / (n - 1)) * 2 - 1, (j / (n - 1)) * 2 - 1]; }
  inDisc(i, j) { const [u, v] = this.cellUV(i, j); return u * u + v * v <= 1.02; }
  // add (amount > 0) or remove (< 0) chalk with a Gaussian footprint
  brush(u, v, amount, sigma = 0.3) {
    const n = this.n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!this.inDisc(i, j)) continue;
      const [cu, cv] = this.cellUV(i, j);
      const g = Math.exp(-((cu - u) ** 2 + (cv - v) ** 2) / (2 * sigma * sigma));
      const k = j * n + i;
      this.c[k] = Math.max(0, Math.min(1, amount > 0 ? this.c[k] + amount * g * (1 - this.c[k]) : this.c[k] * (1 + amount * g)));
    }
  }
  sample(u, v, sigma = 0.18) {
    const n = this.n; let s = 0, w = 0;
    const m = Math.hypot(u, v); if (m > 0.97) { u *= 0.97 / m; v *= 0.97 / m; }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!this.inDisc(i, j)) continue;
      const [cu, cv] = this.cellUV(i, j);
      const g = Math.exp(-((cu - u) ** 2 + (cv - v) ** 2) / (2 * sigma * sigma));
      s += g * this.c[j * n + i]; w += g;
    }
    return w ? s / w : 0;
  }
  mean() {
    const n = this.n; let s = 0, k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (this.inDisc(i, j)) { s += this.c[j * n + i]; k++; }
    return s / k;
  }
  fill(v) { const n = this.n; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (this.inDisc(i, j)) this.c[j * n + i] = v; }
  // every hit compresses / transfers chalk where the ball touched, plus a little everywhere
  wear(a, b, vCue, miscue = false) {
    const [u, v] = tipPoint(a, b);
    this.brush(u, v, -(miscue ? 0.7 : 0.16 + 0.035 * vCue), 0.32);
    for (let k = 0; k < this.c.length; k++) this.c[k] *= 0.985;
  }
}

// Strike the cue ball with the cue moving at vCue (m/s). Returns { V, miscue, mu, limit }.
// Clean hit: ball speed from the impulse–momentum balance with the ball's effective mass at the contact,
// 1/m_eff = (1 + 2.5ρ²)/M, so off-centre hits come off slower.
// Miscue: the tip slides; the force sits on the edge of the friction cone (atan μ from the normal) and only the
// normal approach speed is transferred, so the ball comes off weak and pushed away from the struck side.
export function cueStrike(world, dx, dz, { vCue, a = 0, b = 0, elev = 0, chalk = null, rng = Math.random }) {
  const rho = Math.min(0.98, Math.hypot(a, b));
  const [u, v] = tipPoint(a, b);
  const cov = chalk ? chalk.sample(u, v) : 1;
  const mu = muTip(cov) * (0.96 + 0.08 * rng());
  const limit = miscueLimit(mu);
  let V, miscue = false;
  if (rho <= limit) {
    V = ((1 + E_TIP) * vCue) / (1 + (M / CUE_M) * (1 + 2.5 * rho * rho));
    world.strike(dx, dz, V, a, b, elev);
  } else {
    miscue = true;
    const { d, r } = cueGeometry(dx, dz, a, b, elev);
    const nIn = r.map((x) => -x / R);
    const dn = d[0] * nIn[0] + d[1] * nIn[1] + d[2] * nIn[2]; // = cos φ
    let p = d.map((x, i) => x - dn * nIn[i]);
    const pl = Math.hypot(...p); p = p.map((x) => x / pl);
    const beta = Math.atan(mu);
    const f = nIn.map((x, i) => Math.cos(beta) * x + Math.sin(beta) * p[i]);
    const J = ((1 + 0.5 * E_TIP) * vCue * dn) / (1 / CUE_M + (1 + 2.5 * Math.sin(beta) ** 2) / M);
    world.impulse(0, J * f[0], J * f[1], J * f[2], r[0], r[1], r[2]);
    const cb = world.ball(0);
    V = Math.hypot(cb.vx, cb.vy, cb.vz);
  }
  if (chalk) chalk.wear(a, b, vCue, miscue);
  if (world.recordEvents && miscue) world.events.push({ type: 'miscue', speed: vCue });
  return { V, miscue, mu, limit };
}
// Cue speed needed for a clean hit to give cue-ball speed V.
export const cueSpeedFor = (V, rho = 0) => (V * (1 + (M / CUE_M) * (1 + 2.5 * rho * rho))) / (1 + E_TIP);

// Horizontal distance from the cue ball back along the cue line to the cushion nose (tN) and outer rail edge (tE).
export function railDistances(x, z, dx, dz) {
  const lim = (p, d, h) => (d > 1e-9 ? (p + h) / d : d < -1e-9 ? (h - p) / -d : Infinity);
  const tN = Math.min(lim(x, dx, HL), lim(z, dz, HW));
  return { tN, tE: tN + CW + RAIL_W };
}

const cueRadius = (t) => TIP_R + (0.0146 - TIP_R) * Math.min(1, t / CUE_LEN);

// Lowest cue elevation (rad) at which the cue clears the rail behind the cue ball and any balls under the cue.
export function minElevation(world, yaw, a = 0, b = 0) {
  const cb = world.ball(0);
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const { tN } = railDistances(cb.x, cb.z, dx, dz);
  const others = world.balls.filter((o) => o.active && o.id !== 0);
  for (let e = 0; e <= 1.45; e += 0.0044) {
    const { d, r } = cueGeometry(dx, dz, a, b, e, false);
    const px = cb.x + r[0], py = R + cb.y + r[1], pz = cb.z + r[2];
    if (py < TIP_R * 0.6) continue; // tip would be in the cloth
    const ce = Math.cos(e) || 1e-9;
    const hAt = (th) => py + (th / ce) * Math.sin(e) - cueRadius(th / ce); // cue underside at horizontal dist th
    // rail profile: nose → cushion top → wood rail
    const th0 = Math.max(0, tN - Math.hypot(r[0], r[2]));
    let ok = hAt(th0) >= 0.039 && hAt(th0 + CW) >= CUSHION_H && hAt(th0 + CW + RAIL_W) >= RAIL_TOP;
    for (const o of others) {
      if (!ok) break;
      // closest approach between the ball centre and the cue axis behind the contact point
      const ox = o.x - px, oy = R + o.y - py, oz = o.z - pz;
      const t = -(ox * d[0] + oy * d[1] + oz * d[2]);
      if (t <= 0 || t > CUE_LEN) continue;
      const qx = ox + t * d[0], qy = oy + t * d[1], qz = oz + t * d[2];
      if (Math.hypot(qx, qy, qz) < R + cueRadius(t) + 0.001) ok = false;
    }
    if (ok) return e;
  }
  return 1.45;
}

// Bridges: wobble scales all stroke errors; vMax caps cue speed; maxElev is how high the bridge can hold the cue.
export const BRIDGES = {
  closed: { name: 'Closed', wobble: 1.0, vMax: 9, maxElev: 0.45 },
  open: { name: 'Open', wobble: 1.12, vMax: 8.5, maxElev: 1.35 },
  rail: { name: 'Rail', wobble: 1.3, vMax: 7.5, maxElev: 0.9 },
  mech: { name: 'Mech', wobble: 1.7, vMax: 4.5, maxElev: 0.7 },
};

// Which bridges are physically possible for this cue-ball position / aim, and the bridge length (max backswing).
export function bridgeOptions(world, yaw, elev) {
  const cb = world.ball(0);
  const { tN, tE } = railDistances(cb.x, cb.z, Math.cos(yaw), Math.sin(yaw));
  let len = 0.2, allowed;
  if (tE - 0.12 > REACH) { allowed = ['mech']; len = 0.18; }   // can't reach even with a short bridge
  else if (tN < 0.2) { allowed = ['rail', 'mech']; len = Math.max(0.07, Math.min(0.2, tN + 0.05)); }
  else { allowed = ['closed', 'open', 'mech']; if (tE - len > REACH) len = Math.max(0.1, tE - REACH); }
  const fits = allowed.filter((k) => BRIDGES[k].maxElev >= elev - 1e-6);
  return { allowed: fits.length ? fits : ['open'], len, tN, tE, reachOK: !(tE - 0.12 > REACH) };
}

export function bridgeWobble(kind, elev) {
  return BRIDGES[kind].wobble * (1 + 1.2 * Math.max(0, elev - 0.3));
}

// Arm limit: reaching speed v over backswing d needs v²/2d of acceleration; ~160 m/s² is a strong stroke.
export const armSpeedLimit = (backswing, kind) => Math.min(BRIDGES[kind].vMax, Math.sqrt(2 * 160 * Math.max(0.005, backswing)));

const gauss = (rng) => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };

// Stroke error at contact. lateral = sideways grip-hand drift (m) during the forward stroke; the cue pivots at the
// bridge (grip ≈ 0.9 m behind it), so the cue axis turns by −lateral/0.9 and the tip shifts by −lateral·len/0.9.
export function strokeError({ vCue, lateral = 0, len = 0.2, wobble = 1, nerves = 0, jab = 0, rng = Math.random }) {
  const k = wobble * (1 + 1.5 * nerves) * (1 + jab);
  return {
    yaw: -lateral / 0.9 + gauss(rng) * k * (0.0003 + 0.00012 * vCue),
    a: (-lateral * len) / 0.9 / R + gauss(rng) * k * (0.01 + 0.004 * vCue),
    b: gauss(rng) * k * (0.01 + 0.004 * vCue),
  };
}
