// Pure table geometry shared by physics, rendering and AI. Coordinates are (x, z) on the bed plane.
import { HL, HW } from './constants.js';

export const CW = 0.05;          // cushion width (nose -> rail)
export const RAIL_W = 0.13;      // wood rail width
export const CUSHION_H = 0.046;  // cushion top height above bed
const CORNER_C = 0.082;          // corner mouth: distance from corner to jaw point along each rail (~116 mm mouth)
const CORNER_JAW_END = 0.012;    // where corner jaw meets the rail back line
const SIDE_M = 0.068;            // side mouth half-width (~136 mm mouth)
const SIDE_THROAT = 0.0555;      // side jaw end half-width

export const pockets = [];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  pockets.push({
    x: sx * (HL + 0.03), z: sz * (HW + 0.03), r: 0.07, corner: true, sx, sz,
    // point slightly past the centre of the mouth, used for aiming
    aim: { x: sx * (HL - CORNER_C / 2 + 0.012), z: sz * (HW - CORNER_C / 2 + 0.012) },
    facing: { x: sx / Math.SQRT2, z: sz / Math.SQRT2 },
  });
}
for (const sz of [-1, 1]) {
  pockets.push({
    x: 0, z: sz * (HW + 0.06), r: 0.065, corner: false, sx: 0, sz,
    aim: { x: 0, z: sz * (HW + 0.012) },
    facing: { x: 0, z: sz },
  });
}

// Cushion polygons: [nose start, nose end, jaw end, jaw end] — first 3 edges + closing edge are playable.
export const cushions = [];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  const p = [
    [SIDE_M, HW], [HL - CORNER_C, HW], [HL - CORNER_JAW_END, HW + CW], [SIDE_THROAT, HW + CW],
  ].map(([x, z]) => [x * sx, z * sz]);
  cushions.push(p);
}
for (const sx of [-1, 1]) {
  cushions.push([
    [sx * HL, -(HW - CORNER_C)], [sx * HL, HW - CORNER_C],
    [sx * (HL + CW), HW - CORNER_JAW_END], [sx * (HL + CW), -(HW - CORNER_JAW_END)],
  ]);
}

// Collision segments: nose + both jaws of each cushion.
export const cushionSegments = [];
for (const c of cushions) {
  cushionSegments.push([c[0], c[1]], [c[1], c[2]], [c[3], c[0]]);
}
// Pocket back walls are handled by capture; segment endpoints act as rounded jaw tips.

// Outline of the cloth bed / rail opening at the cushion back line, with pocket bites.
// inward=true  -> bed outline (pocket circles cut away)
// inward=false -> wood rail opening (bulges out around pockets)
export function boundaryOutline(inward, arcSteps = 18) {
  const X = HL + CW, Z = HW + CW;
  const pts = [];
  const arc = (p, a, b, outward) => {
    const a1 = Math.atan2(a[1] - p.z, a[0] - p.x);
    const a2 = Math.atan2(b[1] - p.z, b[0] - p.x);
    let delta = ((a2 - a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI); // ccw sweep
    const mid = a1 + delta / 2;
    const midOut = Math.cos(mid) * p.facing.x + Math.sin(mid) * p.facing.z > 0;
    if (midOut !== outward) delta -= 2 * Math.PI; // use the other way round
    for (let i = 0; i <= arcSteps; i++) {
      const t = a1 + (delta * i) / arcSteps;
      pts.push([p.x + Math.cos(t) * p.r, p.z + Math.sin(t) * p.r]);
    }
  };
  const corner = (sx, sz, verticalFirst) => {
    const p = pockets.find((q) => q.corner && q.sx === sx && q.sz === sz);
    const dz = sz * Z - p.z;
    const pH = [p.x - sx * Math.sqrt(p.r * p.r - dz * dz), sz * Z];
    const dx = sx * X - p.x;
    const pV = [sx * X, p.z - sz * Math.sqrt(p.r * p.r - dx * dx)];
    if (verticalFirst) arc(p, pV, pH, !inward); else arc(p, pH, pV, !inward);
  };
  const side = (sz, leftFirst) => {
    const p = pockets.find((q) => !q.corner && q.sz === sz);
    const dz = sz * Z - p.z;
    const h = Math.sqrt(p.r * p.r - dz * dz);
    const a = [-h, sz * Z], b = [h, sz * Z];
    if (leftFirst) arc(p, a, b, !inward); else arc(p, b, a, !inward);
  };
  corner(-1, -1, true);
  side(-1, true);
  corner(1, -1, false);
  corner(1, 1, true);
  side(1, false);
  corner(-1, 1, false);
  return pts;
}
