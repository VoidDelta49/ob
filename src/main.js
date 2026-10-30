import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { R, HL, HW, HEAD_X, FOOT_X, powerToSpeed } from './constants.js';
import { CW, RAIL_W } from './table-geom.js';
import { buildTable, buildRoom } from './table.js';
import { createBallMesh, ballIcon } from './balls.js';
import { createCue } from './cue.js';
import { World, rackPositions, newLog, updateLog } from './physics.js';
import { EightBall, groupBalls, SOLIDS, STRIPES } from './rules.js';
import { planShot } from './ai.js';
import * as sfx from './audio.js';

// ---------- renderer / scene ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0907);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.32;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 40);
const { cloth } = buildTable(scene, 0x145c35);
const { lamp } = buildRoom(scene);

// graphics quality (persisted); ?q=low forces low
let gfx = new URLSearchParams(location.search).get('q') || localStorage.getItem('ob-gfx') || 'high';
function applyGfx() {
  const hi = gfx === 'high';
  renderer.setPixelRatio(hi ? Math.min(window.devicePixelRatio, 2) : 1);
  renderer.shadowMap.enabled = hi;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  resize();
}

const CLOTHS = { green: 0x145c35, blue: 0x1a4f80, red: 0x5c1622 };

const ballMeshes = {};
for (let id = 0; id <= 15; id++) { ballMeshes[id] = createBallMesh(id); scene.add(ballMeshes[id]); }
const cue = createCue();
scene.add(cue);

// aim guide
const guideMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
const mkLine = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)); const l = new THREE.Line(g, guideMat); l.frustumCulled = false; scene.add(l); return l; };
const guideLine = mkLine(), obLine = mkLine(), cbLine = mkLine();
const ghost = new THREE.Mesh(new THREE.RingGeometry(R * 0.9, R, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, depthWrite: false }));
scene.add(ghost);
const setLine = (l, ax, az, bx, bz, y = 0.0025) => { const p = l.geometry.attributes.position; p.setXYZ(0, ax, y, az); p.setXYZ(1, bx, y, bz); p.needsUpdate = true; l.visible = true; };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const ui = {
  hud: $('hud'), p: [$('p0'), $('p1')], turn: $('turn'), toast: $('toast'), hint: $('hint'), topbar: $('topbar'), controls: $('controls'),
  spin: $('spin'), spinDot: $('spinDot'), fine: $('fine'), fineTex: $('fineTex'), power: $('power'), powerFill: $('powerFill'), powerLabel: $('powerLabel'),
  menu: $('menu'), over: $('over'), loading: $('loading'), resume: $('resume'),
};

// ---------- game state ----------
let mode = null;            // 'cpu' | 'pvp' | 'practice'
let difficulty = 'medium';
let world = new World();
let game = null;
let state = 'menu';         // menu | aim | shooting | rolling | ai | over
let aimYaw = 0;
const cam = { yaw: 0, pitch: 0.24, dist: 1.15 };
const camS = { yaw: 0, pitch: 0.6, dist: 3, focus: new THREE.Vector3(), top: 0 };
let topView = false, guideOn = true;
const spin = { a: 0, b: 0 };
let power = 0;
let ballInHand = false, kitchen = false;
let shot = null, log = null, before = null, settleT = 0, cueHideT = 0;
let ai = null;
let dragging = false;
let turnsPlayed = 0;
const keys = new Set();

function humanTurn() {
  if (!game) return true;
  return !game.player.isAI;
}

function setupRack() {
  world = new World();
  world.add(0, HEAD_X, 0);
  for (const p of rackPositions()) world.add(p.id, p.x, p.z);
  for (const id in ballMeshes) { ballMeshes[id].visible = true; ballMeshes[id].quaternion.identity(); }
  for (const b of world.balls) { // random initial orientation so numbers face different ways
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    b.q = [q.x, q.y, q.z, q.w];
  }
}

function newGame(m) {
  mode = m;
  setupRack();
  const names = m === 'cpu' ? [{ name: 'You' }, { name: 'CPU', isAI: true }] : m === 'pvp' ? [{ name: 'Player 1' }, { name: 'Player 2' }] : [{ name: 'Practice' }, { name: '—' }];
  game = m === 'practice' ? null : new EightBall(names);
  if (game && m === 'pvp' && Math.random() < 0.5) game.cur = 1;
  ballInHand = true; kitchen = true;
  aimYaw = 0; cam.yaw = 0; cam.pitch = camera.aspect < 1 ? 0.5 : 0.24; cam.dist = camera.aspect < 1 ? 1.35 : 1.15;
  camS.yaw = -0.6; camS.pitch = 0.7; camS.dist = 3.2;
  spin.a = spin.b = 0; updateSpinDot();
  turnsPlayed = 0;
  ui.menu.classList.add('hidden'); ui.over.classList.add('hidden');
  ui.hud.classList.remove('hidden'); ui.topbar.classList.remove('hidden'); ui.controls.classList.remove('hidden');
  ui.resume.classList.remove('hidden');
  updateHUD();
  startTurn(true);
}

function startTurn(first = false) {
  power = 0; setPowerUI(0);
  spin.a = spin.b = 0; updateSpinDot();
  if (!first) autoAim();
  if (humanTurn()) {
    state = 'aim';
    cam.yaw = aimYaw;
    if (game && mode === 'pvp' && !first) toast(`${game.player.name} to shoot`);
    showHint();
  } else {
    state = 'ai';
    ai = { phase: 'think', t: 0 };
    hint('CPU is thinking…');
  }
  ui.controls.classList.toggle('disabled', !humanTurn());
  updateHUD();
}

function autoAim() {
  const cb = world.ball(0);
  const onTable = world.activeIds();
  const targets = game ? game.legalTargets(onTable) : [...onTable].filter((n) => n !== 0);
  let best = null;
  for (const id of targets) {
    const b = world.ball(id);
    const d = Math.hypot(b.x - cb.x, b.z - cb.z);
    if (!best || d < best.d) best = { d, b };
  }
  if (best) aimYaw = Math.atan2(best.b.z - cb.z, best.b.x - cb.x);
}

function showHint() {
  if (state !== 'aim') return hint('');
  if (ballInHand) hint(kitchen ? 'Ball in hand (behind the head string) — drag the cue ball' : 'Ball in hand — drag the cue ball to place it');
  else if (turnsPlayed < 2) hint(topView ? 'Tap the table to aim · pull power bar to shoot' : 'Drag to aim · pull the power bar down & release');
  else hint('');
}
function hint(t) { ui.hint.textContent = t; ui.hint.classList.toggle('hidden', !t); }

let toastTimer = 0;
function toast(msg, foul = false, ms = 2600) {
  if (!msg) return;
  ui.toast.textContent = msg;
  ui.toast.classList.toggle('foul', foul);
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

function updateHUD() {
  const onTable = world.activeIds();
  if (!game) {
    ui.p[0].querySelector('.pname').innerHTML = 'Practice';
    const box = ui.p[0].querySelector('.pballs'); box.innerHTML = '';
    for (let n = 1; n <= 15; n++) { const ic = ballIcon(n, 18); if (!onTable.has(n)) ic.classList.add('potted'); box.appendChild(ic); }
    ui.p[0].classList.add('active');
    ui.p[1].classList.add('hidden');
    ui.turn.textContent = '';
    return;
  }
  ui.p[1].classList.remove('hidden');
  game.players.forEach((pl, i) => {
    const el = ui.p[i];
    el.classList.toggle('active', game.cur === i && !game.over);
    el.querySelector('.pname').innerHTML = `${pl.name}<small>${pl.group ? pl.group : game.open ? 'open table' : ''}</small>`;
    const box = el.querySelector('.pballs'); box.innerHTML = '';
    if (pl.group) {
      const g = groupBalls(pl.group);
      for (const n of g) { const ic = ballIcon(n, 18); if (!onTable.has(n)) ic.classList.add('potted'); box.appendChild(ic); }
      if (g.every((n) => !onTable.has(n))) box.appendChild(ballIcon(8, 18));
    }
  });
  ui.turn.textContent = game.isBreak ? 'Break' : game.open ? 'Open table' : '8-Ball';
}

// ---------- placement helpers ----------
function validCueSpot(x, z) {
  if (Math.abs(x) > HL - R - 0.002 || Math.abs(z) > HW - R - 0.002) return false;
  if (kitchen && x > HEAD_X) return false;
  for (const b of world.balls) if (b.active && b.id !== 0 && Math.hypot(b.x - x, b.z - z) < 2 * R + 0.001) return false;
  return true;
}
// nearest free spot along the long string through (x, z), as in spotting rules
function freeSpot(id, x, z) {
  for (let i = 0; i < 400; i++) {
    const tx = x + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.006;
    if (Math.abs(tx) > HL - R) continue;
    const ok = world.balls.every((b) => !b.active || b.id === id || Math.hypot(b.x - tx, b.z - z) >= 2 * R + 0.001);
    if (ok) return [tx, z];
  }
  return [x, z];
}
function respot(id, x, z) {
  const b = world.ball(id);
  b.active = true; b.pocketed = false; b.fall = null; b.stop();
  const [px, pz] = freeSpot(id, x, z);
  b.x = px; b.z = pz;
  ballMeshes[id].visible = true;
}

// ---------- shooting ----------
function shoot(p) {
  if (!(state === 'aim' || state === 'ai') || p < 0.01) return;
  const cb = world.ball(0);
  if (!cb.active) return;
  shot = { power: p, t: 0, pull: 0.02 + p * 0.24, dur: 0.2 - p * 0.09 };
  state = 'shooting';
  hint('');
  ui.controls.classList.add('disabled');
}

function strike() {
  before = world.activeIds();
  log = newLog();
  world.events.length = 0;
  world.acc = 0;
  world.strike(Math.cos(aimYaw), Math.sin(aimYaw), powerToSpeed(shot.power), spin.a, spin.b);
  sfx.cue(shot.power);
  ballInHand = false;
  if (game) game.kitchen = false;
  kitchen = false;
  state = 'rolling';
  settleT = 0;
  cueHideT = 0.45;
  power = 0; setPowerUI(0);
  turnsPlayed++;
}

function endShot() {
  const scratched = log.pocketed.includes(0);
  if (scratched) respot(0, HEAD_X, 0);
  if (!game) {
    if (scratched) { ballInHand = true; toast('Scratch', true); }
    const left = world.balls.filter((b) => b.active && b.id !== 0).length;
    if (left === 0) { toast('Table cleared! Re-racking…'); setTimeout(() => { setupRack(); ballInHand = kitchen = true; updateHUD(); startTurn(true); }, 1500); }
    updateHUD();
    startTurn();
    return;
  }
  const res = game.endShot(log, before);
  if (res.respot8) respot(8, FOOT_X, 0);
  updateHUD();
  if (res.over) {
    state = 'over';
    ui.controls.classList.add('disabled');
    const w = game.players[game.winner];
    setTimeout(() => {
      $('overTitle').textContent = mode === 'cpu' ? (w.isAI ? 'CPU wins' : 'You win!') : `${w.name} wins!`;
      $('overSub').textContent = res.msg.join(' · ');
      ui.over.classList.remove('hidden');
    }, 900);
    toast(res.msg.join(' · '), !!res.foul, 3000);
    return;
  }
  ballInHand = res.ballInHand;
  kitchen = false;
  if (res.msg.length) toast(res.msg.join(' · ') + (res.ballInHand ? ' — ball in hand' : ''), !!res.foul);
  startTurn();
}

// ---------- AI ----------
function updateAI(dt) {
  ai.t += dt;
  if (ai.phase === 'think' && ai.t > 0.6) {
    const t0 = performance.now();
    ai.plan = planShot(world, game, difficulty);
    ai.thinkMs = performance.now() - t0;
    if (ai.plan.place) {
      const cb = world.ball(0);
      cb.x = ai.plan.place.x; cb.z = ai.plan.place.z;
    }
    ai.phase = 'aim'; ai.t = 0;
    hint('');
  } else if (ai.phase === 'aim') {
    let d = wrapAngle(ai.plan.yaw - aimYaw);
    const step = Math.max(0.002, Math.min(Math.abs(d), (1.2 + Math.abs(d) * 3) * dt));
    if (Math.abs(d) <= step) { aimYaw = ai.plan.yaw; ai.phase = 'set'; ai.t = 0; spin.a = ai.plan.a; spin.b = ai.plan.b; updateSpinDot(); }
    else aimYaw += Math.sign(d) * step;
    cam.yaw = aimYaw;
  } else if (ai.phase === 'set') {
    power = ai.plan.power * Math.min(1, ai.t / 0.8);
    setPowerUI(power);
    if (ai.t > 1.05) { aimYaw = ai.plan.yaw; shoot(ai.plan.power); }
  }
}
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- input ----------
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);
function tablePoint(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const v = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(v, camera);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, out) ? out : null;
}

const pointers = new Map();
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  sfx.init();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: cam.dist };
    return;
  }
  const canAim = state === 'aim' && humanTurn();
  const pt = tablePoint(e.clientX, e.clientY);
  const cb = world.ball(0);
  if (canAim && ballInHand && pt && Math.hypot(pt.x - cb.x, pt.z - cb.z) < Math.max(0.09, cam.dist * 0.07)) {
    drag = { type: 'place', ox: cb.x - pt.x, oz: cb.z - pt.z };
    return;
  }
  if (canAim && topView && pt) {
    drag = { type: 'aimTop' };
    aimYaw = Math.atan2(pt.z - cb.z, pt.x - cb.x);
    return;
  }
  drag = { type: 'orbit', x: e.clientX, y: e.clientY };
  dragging = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) return;
  if (drag.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    cam.dist = clamp(drag.dist0 * (drag.d0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))), 0.35, 3.4);
  } else if (drag.type === 'orbit') {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    const fine = e.shiftKey ? 0.15 : 1;
    if (state === 'aim' && humanTurn() && !topView) { aimYaw += dx * 0.0042 * fine; cam.yaw = aimYaw; }
    else if (!topView) cam.yaw += dx * 0.005;
    if (!topView) cam.pitch = clamp(cam.pitch - dy * 0.004, 0.03, 1.45);
  } else if (drag.type === 'aimTop') {
    const pt = tablePoint(e.clientX, e.clientY);
    const cb = world.ball(0);
    if (pt && Math.hypot(pt.x - cb.x, pt.z - cb.z) > 0.01) aimYaw = Math.atan2(pt.z - cb.z, pt.x - cb.x);
  } else if (drag.type === 'place') {
    const pt = tablePoint(e.clientX, e.clientY);
    if (!pt) return;
    const cb = world.ball(0);
    let tx = clamp(pt.x + drag.ox, -HL + R + 0.003, kitchen ? HEAD_X : HL - R - 0.003);
    let tz = clamp(pt.z + drag.oz, -HW + R + 0.003, HW - R - 0.003);
    // slide toward target in small steps so the ball never jumps through others
    const n = Math.ceil(Math.hypot(tx - cb.x, tz - cb.z) / 0.005);
    const sx = cb.x, sz = cb.z;
    for (let i = 1; i <= n; i++) {
      const x = sx + ((tx - sx) * i) / n, z = sz + ((tz - sz) * i) / n;
      if (validCueSpot(x, z)) { cb.x = x; cb.z = z; } else if (validCueSpot(x, cb.z)) cb.x = x; else if (validCueSpot(cb.x, z)) cb.z = z;
    }
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) { drag = null; dragging = false; }
  else if (drag && drag.type === 'pinch') drag = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 0.35, 3.4); }, { passive: false });

// fine aim strip
let fineDrag = null, fineOffset = 0;
ui.fine.addEventListener('pointerdown', (e) => { sfx.init(); ui.fine.setPointerCapture(e.pointerId); fineDrag = e.clientX; });
ui.fine.addEventListener('pointermove', (e) => {
  if (fineDrag === null) return;
  const dx = e.clientX - fineDrag; fineDrag = e.clientX;
  if (state === 'aim' && humanTurn()) { aimYaw += dx * 0.00035; cam.yaw = aimYaw; }
  fineOffset = (fineOffset + dx) % 12;
  ui.fineTex.style.transform = `translateX(${fineOffset}px)`;
});
ui.fine.addEventListener('pointerup', () => (fineDrag = null));
ui.fine.addEventListener('pointercancel', () => (fineDrag = null));

// spin
const setSpinFromEvent = (e) => {
  const r = ui.spin.getBoundingClientRect();
  let x = ((e.clientX - r.left) / r.width) * 2 - 1, y = ((e.clientY - r.top) / r.height) * 2 - 1;
  const m = Math.hypot(x, y);
  if (m > 0.85) { x *= 0.85 / m; y *= 0.85 / m; }
  spin.a = (x / 0.85) * 0.5; spin.b = (-y / 0.85) * 0.5;
  if (Math.hypot(spin.a, spin.b) < 0.04) spin.a = spin.b = 0;
  updateSpinDot();
};
ui.spin.addEventListener('pointerdown', (e) => { if (state !== 'aim') return; ui.spin.setPointerCapture(e.pointerId); setSpinFromEvent(e); ui.spin.dataset.d = '1'; });
ui.spin.addEventListener('pointermove', (e) => { if (ui.spin.dataset.d === '1') setSpinFromEvent(e); });
ui.spin.addEventListener('pointerup', () => (ui.spin.dataset.d = ''));
function updateSpinDot() {
  ui.spinDot.style.left = `${50 + (spin.a / 0.5) * 42.5}%`;
  ui.spinDot.style.top = `${50 - (spin.b / 0.5) * 42.5}%`;
}

// power bar
let powerDrag = null;
function setPowerUI(p) {
  ui.powerFill.style.height = `${p * 100}%`;
  ui.powerLabel.textContent = p > 0.005 ? `${Math.round(p * 100)}%` : 'PULL';
}
ui.power.addEventListener('pointerdown', (e) => {
  if (state !== 'aim' || !humanTurn()) return;
  sfx.init();
  ui.power.setPointerCapture(e.pointerId);
  powerDrag = { y0: e.clientY, h: ui.power.getBoundingClientRect().height };
});
ui.power.addEventListener('pointermove', (e) => {
  if (!powerDrag) return;
  power = clamp((e.clientY - powerDrag.y0) / (powerDrag.h * 0.85), 0, 1);
  setPowerUI(power);
});
const powerRelease = () => {
  if (!powerDrag) return;
  powerDrag = null;
  if (power > 0.015) shoot(power); else { power = 0; setPowerUI(0); }
};
ui.power.addEventListener('pointerup', powerRelease);
ui.power.addEventListener('pointercancel', () => { powerDrag = null; power = 0; setPowerUI(0); });

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.repeat && e.code !== 'Space') return;
  keys.add(e.code);
  sfx.init();
  if (e.code === 'KeyT') toggleTop();
  if (e.code === 'KeyG') toggleGuide();
  if (e.code === 'KeyM') toggleSound();
  if (e.code === 'Escape') openMenu();
  if (e.code === 'Space') e.preventDefault();
  if (state === 'aim') {
    const st = 0.08;
    if (e.code === 'KeyW') spin.b = clamp(spin.b + st, -0.5, 0.5);
    if (e.code === 'KeyS') spin.b = clamp(spin.b - st, -0.5, 0.5);
    if (e.code === 'KeyA') spin.a = clamp(spin.a - st, -0.5, 0.5);
    if (e.code === 'KeyD') spin.a = clamp(spin.a + st, -0.5, 0.5);
    if (e.code === 'KeyX') spin.a = spin.b = 0;
    const m = Math.hypot(spin.a, spin.b); if (m > 0.5) { spin.a *= 0.5 / m; spin.b *= 0.5 / m; }
    updateSpinDot();
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space' && state === 'aim' && humanTurn()) { if (power > 0.015) shoot(power); else { power = 0; setPowerUI(0); } }
});
function handleKeys(dt) {
  if (state !== 'aim' || !humanTurn()) return;
  const fine = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 0.08 : 1;
  if (keys.has('ArrowLeft')) aimYaw -= 0.9 * fine * dt;
  if (keys.has('ArrowRight')) aimYaw += 0.9 * fine * dt;
  if (keys.has('ArrowUp')) cam.pitch = clamp(cam.pitch + 0.8 * dt, 0.03, 1.45);
  if (keys.has('ArrowDown')) cam.pitch = clamp(cam.pitch - 0.8 * dt, 0.03, 1.45);
  if (keys.has('Space')) { power = Math.min(1, power + dt * 0.55); setPowerUI(power); }
  cam.yaw = aimYaw;
}

// buttons
function toggleTop() { topView = !topView; $('btnView').classList.toggle('off', !topView); showHint(); }
function toggleGuide() { guideOn = !guideOn; $('btnGuide').classList.toggle('off', !guideOn); }
function toggleSound() { sfx.setEnabled(!sfx.enabled); $('btnSound').classList.toggle('off', !sfx.enabled); }
function openMenu() { if (state === 'menu') return; ui.menu.classList.remove('hidden'); }
$('btnView').onclick = toggleTop;
$('btnGuide').onclick = toggleGuide;
$('btnSound').onclick = toggleSound;
$('btnMenu').onclick = openMenu;
$('btnView').classList.add('off');
ui.resume.onclick = () => ui.menu.classList.add('hidden');
document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { sfx.init(); newGame(b.dataset.mode); }));
$('diff').onchange = (e) => (difficulty = e.target.value);
$('gfx').value = gfx;
$('gfx').onchange = (e) => { gfx = e.target.value; try { localStorage.setItem('ob-gfx', gfx); } catch {} applyGfx(); };
$('clothSel').onchange = (e) => cloth.color.set(CLOTHS[e.target.value]);
$('again').onclick = () => newGame(mode);
$('toMenu').onclick = () => { ui.over.classList.add('hidden'); ui.menu.classList.remove('hidden'); ui.resume.classList.add('hidden'); state = 'menu'; };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- per-frame updates ----------
function updateBalls(dt) {
  for (const b of world.balls) {
    const m = ballMeshes[b.id];
    if (b.active) {
      m.position.set(b.x, R, b.z);
      m.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      m.visible = true;
    } else if (b.fall) {
      const f = b.fall;
      f.t += dt;
      const p = f.pocket;
      const k = Math.min(1, f.t / 0.14);
      const x = f.x0 + (p.x - f.x0) * k, z = f.z0 + (p.z - f.z0) * k;
      const y = R - Math.max(0, f.t - 0.04) ** 2 * 7;
      m.position.set(x, y, z);
      if (y < -0.13) { m.visible = false; b.fall = null; }
    } else if (b.pocketed) m.visible = false;
  }
}

function updateCue(dt) {
  const cb = world.ball(0);
  const show = cb.active && (state === 'aim' || state === 'shooting' || state === 'ai' || cueHideT > 0);
  cue.visible = show;
  if (!show) return;
  let pull;
  if (state === 'shooting') {
    shot.t += dt;
    const f = Math.min(1, shot.t / shot.dur);
    pull = shot.pull * (1 - f * f) - 0.006 * f;
    if (f >= 1) { pull = -0.006; strike(); }
  } else if (state === 'rolling') {
    cueHideT -= dt;
    pull = -0.006 - (0.45 - cueHideT) * 0.05;
  } else pull = 0.02 + power * 0.24;

  const dx = Math.cos(aimYaw), dz = Math.sin(aimYaw);
  // elevate the butt enough to clear the rail behind the cue ball
  let tRail = Infinity;
  if (dx > 1e-6) tRail = Math.min(tRail, (cb.x + HL + CW + RAIL_W * 0.6) / dx);
  if (dx < -1e-6) tRail = Math.min(tRail, (HL + CW + RAIL_W * 0.6 - cb.x) / -dx);
  if (dz > 1e-6) tRail = Math.min(tRail, (cb.z + HW + CW + RAIL_W * 0.6) / dz);
  if (dz < -1e-6) tRail = Math.min(tRail, (HW + CW + RAIL_W * 0.6 - cb.z) / -dz);
  const elev = Math.max(0.045, Math.atan2(0.075 - R, Math.max(0.05, tRail - 0.03)));
  const sx = -dz, sz = dx;
  const c = Math.sqrt(Math.max(0, 1 - spin.a * spin.a - spin.b * spin.b));
  const contact = new THREE.Vector3(cb.x + (sx * spin.a - dx * c) * R, R + spin.b * R, cb.z + (sz * spin.a - dz * c) * R);
  const back = new THREE.Vector3(-dx * Math.cos(elev), Math.sin(elev), -dz * Math.cos(elev));
  cue.position.copy(contact).addScaledVector(back, 0.003 + pull);
  cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), back);
}

function updateGuide() {
  const cb = world.ball(0);
  const show = guideOn && cb.active && (state === 'aim' || (state === 'ai' && ai && ai.phase !== 'think'));
  guideLine.visible = obLine.visible = cbLine.visible = ghost.visible = false;
  if (!show) return;
  const dx = Math.cos(aimYaw), dz = Math.sin(aimYaw);
  let tHit = Infinity, hitBall = null;
  for (const b of world.balls) {
    if (!b.active || b.id === 0) continue;
    const mx = b.x - cb.x, mz = b.z - cb.z;
    const t = mx * dx + mz * dz;
    if (t <= 0) continue;
    const perp2 = mx * mx + mz * mz - t * t;
    if (perp2 >= 4 * R * R) continue;
    const th = t - Math.sqrt(4 * R * R - perp2);
    if (th < tHit) { tHit = th; hitBall = b; }
  }
  const lim = (pos, d, h) => (d > 1e-9 ? (h - pos) / d : d < -1e-9 ? (-h - pos) / d : Infinity);
  const tx = lim(cb.x, dx, HL - R), tz = lim(cb.z, dz, HW - R);
  const tWall = Math.min(tx, tz);
  if (hitBall && tHit < tWall) {
    const gx = cb.x + dx * tHit, gz = cb.z + dz * tHit;
    setLine(guideLine, cb.x, cb.z, gx, gz);
    ghost.position.set(gx, 0.002, gz); ghost.visible = true;
    let nx = hitBall.x - gx, nz = hitBall.z - gz; const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
    const cosc = dx * nx + dz * nz;
    const len = 0.12 + 0.35 * cosc;
    setLine(obLine, hitBall.x, hitBall.z, hitBall.x + nx * len, hitBall.z + nz * len);
    let tx2 = dx - cosc * nx, tz2 = dz - cosc * nz; const tl = Math.hypot(tx2, tz2);
    if (tl > 1e-4) { tx2 /= tl; tz2 /= tl; const cl = 0.3 * tl; setLine(cbLine, gx, gz, gx + tx2 * cl, gz + tz2 * cl); }
  } else {
    const wx = cb.x + dx * tWall, wz = cb.z + dz * tWall;
    setLine(guideLine, cb.x, cb.z, wx, wz);
    ghost.position.set(wx, 0.002, wz); ghost.visible = true;
    const rx = tx < tz ? -dx : dx, rz = tx < tz ? dz : -dz;
    setLine(cbLine, wx, wz, wx + rx * 0.3, wz + rz * 0.3);
  }
}

const tmpV = new THREE.Vector3(), lookV = new THREE.Vector3(), topPos = new THREE.Vector3(), upV = new THREE.Vector3();
function updateCamera(dt) {
  const cb = world.ball(0);
  const focusTarget = tmpV.set(cb.active ? cb.x : 0, R, cb.active ? cb.z : 0);
  if (state === 'rolling' || state === 'over') focusTarget.copy(camS.focus);
  if (state === 'menu') { focusTarget.set(0, 0, 0); cam.yaw += dt * 0.06; }
  const k = 1 - Math.exp(-dt * 7);
  const kYaw = (state === 'aim' && (dragging || fineDrag !== null)) || state === 'ai' ? 1 - Math.exp(-dt * 30) : k;
  camS.yaw += wrapAngle(cam.yaw - camS.yaw) * kYaw;
  camS.pitch += (cam.pitch - camS.pitch) * k;
  camS.dist += (cam.dist - camS.dist) * k;
  camS.focus.lerp(focusTarget, k);
  camS.top += ((topView ? 1 : 0) - camS.top) * (1 - Math.exp(-dt * 6));

  const dx = Math.cos(camS.yaw), dz = Math.sin(camS.yaw);
  const h = camS.dist * Math.cos(camS.pitch);
  const orbitPos = new THREE.Vector3(camS.focus.x - dx * h, camS.focus.y + camS.dist * Math.sin(camS.pitch) + 0.02, camS.focus.z - dz * h);
  const ahead = 0.12 + camS.dist * 0.18;
  const orbitLook = new THREE.Vector3(camS.focus.x + dx * ahead, R, camS.focus.z + dz * ahead);

  // top view framing
  const aspect = camera.aspect;
  const portrait = aspect < 1;
  const ex = HL + CW + RAIL_W + 0.05, ez = HW + CW + RAIL_W + 0.05;
  const tf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const [sh, sv] = portrait ? [ez, ex] : [ex, ez];
  const height = Math.max(sv / tf, sh / (tf * aspect)) * 1.1;
  topPos.set(0, height, 0.0001);
  const t = camS.top;
  camera.position.lerpVectors(orbitPos, topPos, t);
  lookV.lerpVectors(orbitLook, new THREE.Vector3(0, 0, 0), t);
  upV.set(0, 1, 0).lerp(portrait ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, -1), t).normalize();
  camera.up.copy(upV);
  camera.lookAt(lookV);
  lamp.visible = camera.position.y < 0.95;
}

function processEvents() {
  for (const e of world.events) {
    if (log) updateLog(log, e);
    if (e.type === 'ball') sfx.ball(e.speed);
    else if (e.type === 'cushion') sfx.cushion(e.speed);
    else if (e.type === 'pocket') { sfx.pocket(); setTimeout(updateHUD, 250); }
  }
  world.events.length = 0;
}

// ---------- loop ----------
let last = performance.now();
let firstFrame = true;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const paused = state !== 'menu' && !ui.menu.classList.contains('hidden');
  if (!paused) handleKeys(dt);
  if (!paused && state === 'ai' && ai) updateAI(dt);
  if (!paused && state === 'rolling') {
    world.simulate(dt);
    processEvents();
    const falling = world.balls.some((b) => b.fall);
    if (!world.anyMoving() && !falling) {
      settleT += dt;
      if (settleT > 0.35) endShot();
    } else settleT = 0;
  }
  updateBalls(dt);
  updateCue(dt);
  updateGuide();
  updateCamera(dt);
  renderer.render(scene, camera);
  if (firstFrame) { firstFrame = false; ui.loading.classList.add('hidden'); }
  requestAnimationFrame(frame);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 58 : 45;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
applyGfx();

// attract mode behind the menu
setupRack();
camS.focus.set(0, 0, 0); cam.yaw = -0.5; cam.pitch = 0.55; cam.dist = 2.6; camS.yaw = -0.5; camS.pitch = 0.55; camS.dist = 2.6;
state = 'menu';
requestAnimationFrame(frame);

// expose for debugging / automated tests
window.__pool = { fastForward: () => { if (state !== 'rolling') return; while (world.anyMoving()) { world.step(1 / 1500); processEvents(); } }, get world() { return world; }, get game() { return game; }, get state() { return state; }, newGame, shoot, setAim: (y) => { aimYaw = y; cam.yaw = y; }, toggleTop };
