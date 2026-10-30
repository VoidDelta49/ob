// Synthesised sounds (no assets): ball clicks, cushion thumps, cue tip, pocket drops.
let ctx = null;
let master = null;
let noise = null;
export let enabled = true;
export function setEnabled(v) { enabled = v; }

export function init() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function burst({ t = 0, vol, freq, q = 1, dur, type = 'bandpass', tone = 0, toneDur = dur }) {
  if (!ctx || !enabled) return;
  const now = ctx.currentTime + t;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f).connect(g).connect(master);
  src.start(now, Math.random() * 0.4);
  src.stop(now + dur + 0.02);
  if (tone) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(tone, now);
    o.frequency.exponentialRampToValueAtTime(tone * 0.7, now + toneDur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.5, now);
    og.gain.exponentialRampToValueAtTime(0.0001, now + toneDur);
    o.connect(og).connect(master);
    o.start(now); o.stop(now + toneDur + 0.02);
  }
}

let lastBall = 0;
export function ball(speed) {
  if (!ctx) return;
  const n = ctx.currentTime;
  if (n - lastBall < 0.012) return;
  lastBall = n;
  const v = Math.min(1, speed / 5);
  if (v < 0.01) return;
  burst({ vol: 0.15 + v * 1.1, freq: 3200 + Math.random() * 900, q: 2.5, dur: 0.035 + v * 0.02, tone: 2400 + Math.random() * 300, toneDur: 0.03 });
}
let lastCush = 0;
export function cushion(speed) {
  if (!ctx) return;
  const n = ctx.currentTime;
  if (n - lastCush < 0.02) return;
  lastCush = n;
  const v = Math.min(1, speed / 5);
  if (v < 0.02) return;
  burst({ vol: 0.25 + v * 0.8, freq: 260, q: 0.8, dur: 0.09, type: 'lowpass', tone: 110, toneDur: 0.07 });
}
export function cue(power) {
  burst({ vol: 0.2 + power * 0.7, freq: 1600, q: 1.2, dur: 0.03, tone: 900, toneDur: 0.02 });
}
export function pocket() {
  burst({ vol: 0.5, freq: 180, q: 0.7, dur: 0.14, type: 'lowpass', tone: 85, toneDur: 0.12 });
  burst({ t: 0.12, vol: 0.25, freq: 900, q: 1.5, dur: 0.05 });
  burst({ t: 0.21, vol: 0.12, freq: 1100, q: 1.5, dur: 0.04 });
}
