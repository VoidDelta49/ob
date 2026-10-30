// All units SI: metres, kilograms, seconds.
// Table: 9-ft regulation playing surface (100" x 50").
export const L = 2.54;
export const W = 1.27;
export const HL = L / 2;
export const HW = W / 2;

// Ball: 2 1/4" diameter, 6 oz.
export const R = 0.028575;
export const M = 0.17;
export const I = 0.4 * M * R * R; // solid sphere
export const G = 9.81;

export const PHYS = {
  muSlide: 0.2,      // ball–cloth sliding friction
  muRoll: 0.01,      // rolling resistance
  muSpin: 0.011,     // vertical-axis spin decay
  eBall: 0.95,       // ball–ball restitution
  muBall: 0.05,      // ball–ball friction (throw)
  eCushion: 0.86,    // cushion restitution at low speed (drops with speed)
  muCushion: 0.14,   // cushion friction
  cushionNose: 0.0363, // cushion nose height above bed (≈ 63.5% of ball diameter)
  stopSpeed: 0.006,
};

export const HEAD_X = -L / 4; // head string / head spot
export const FOOT_X = L / 4;  // foot spot

export const BALL_COLORS = {
  0: '#f4f1e6',
  1: '#f2b705', 2: '#1546a0', 3: '#c8161d', 4: '#4a1d78',
  5: '#f26313', 6: '#0d6b3c', 7: '#7b1a1c', 8: '#0d0d0f',
  9: '#f2b705', 10: '#1546a0', 11: '#c8161d', 12: '#4a1d78',
  13: '#f26313', 14: '#0d6b3c', 15: '#7b1a1c',
};

// Cue power (0..1) -> cue-ball speed (m/s). Non-linear for fine soft-shot control.
export const powerToSpeed = (p) => 0.08 + 7.6 * Math.pow(p, 1.6);
export const speedToPower = (v) => Math.pow(Math.max(0, v - 0.08) / 7.6, 1 / 1.6);
