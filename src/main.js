import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { R, HL, HW, HEAD_X, FOOT_X, powerToSpeed, speedToPower } from './constants.js';
import { buildTable, buildRoom } from './table.js';
import { createBallMesh, ballIcon } from './balls.js';
import { createCue } from './cue.js';
import { World, rackPositions, newLog, updateLog, cueGeometry } from './physics.js';
import { Chalk, cueStrike, cueSpeedFor, minElevation, bridgeOptions, bridgeWobble, BRIDGES, armSpeedLimit, strokeError, tipPoint, TIP_R, MAX_TIP, muTip, miscueLimit } from './cuephys.js';
import { EightBall, groupBalls } from './rules.js';
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

// near/far kept tight for depth precision (camera never gets closer than ~0.3 m to anything but the cue butt)
const camera = new THREE.PerspectiveCamera(45, 1, 0.03, 20);
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

// foot spot sticker (the rack's apex goes here)
const spotMark = new THREE.Mesh(new THREE.CircleGeometry(0.009, 24).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe9e4d6, roughness: 0.9 }));
spotMark.position.set(FOOT_X, 0.0004, 0); spotMark.receiveShadow = true;
scene.add(spotMark);

// wooden rack frame (equilateral, inner edge touching the outer balls)
const RACK_IN = (8 * R) / (2 * Math.sqrt(3)) + R;   // inradius of the ball-centre triangle + one ball radius
const rackFrame = (() => {
  const tri = (rin) => { const rc = 2 * rin; return [0, 1, 2].map((k) => [Math.cos(Math.PI + (k * 2 * Math.PI) / 3) * rc, Math.sin(Math.PI + (k * 2 * Math.PI) / 3) * rc]); };
  const outer = new THREE.Shape(tri(RACK_IN + 0.016).map(([x, z]) => new THREE.Vector2(x, z)));
  outer.holes.push(new THREE.Path(tri(RACK_IN + 0.0005).map(([x, z]) => new THREE.Vector2(x, z))));
  const g = new THREE.ExtrudeGeometry(outer, { depth: 0.032, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 0.032, 0);
  const m = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ color: 0x4a2412, roughness: 0.35, clearcoat: 0.8, transparent: true }));
  m.castShadow = true; m.visible = false; scene.add(m);
  return m;
})();
const rackCentroidX = (8 * R * Math.sqrt(3)) / 3; // apex → centroid distance along +x

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
  tipPanel: $('tipPanel'), tipCanvas: $('tipCanvas'), elev: $('elev'), elevFill: $('elevFill'), elevMin: $('elevMin'), elevLabel: $('elevLabel'),
  bridgeBtn: $('bridgeBtn'), chalkBtn: $('chalkBtn'), downBtn: $('downBtn'), fine: $('fine'), fineTex: $('fineTex'),
  strokeCanvas: $('strokeCanvas'), report: $('report'), actBtn: $('actBtn'),
  chalkOv: $('chalkOv'), chalkCanvas: $('chalkCanvas'), chalkDone: $('chalkDone'), chalkTitle: $('chalkTitle'),
  menu: $('menu'), over: $('over'), loading: $('loading'), resume: $('resume'),
};

// ---------- game state ----------
let mode = null;            // 'cpu' | 'pvp' | 'practice'
let difficulty = 'medium';
let world = new World();
let game = null;
let state = 'menu';         // menu | rack | aim | stance | shooting | rolling | ai | over
let aimYaw = 0;
const cam = { yaw: 0, pitch: 0.24, dist: 1.15 };
const camS = { yaw: 0, pitch: 0.6, dist: 3, focus: new THREE.Vector3(), top: 0 };
let topView = false, guideOn = true;
const tip = { a: 0, b: 0 };   // where the tip addresses the cue ball, in ball radii (a right, b up)
let elevUser = 0, elevMin = 0, elev = 0; // butt elevation: chosen / forced by rail & balls / effective (rad)
let bridge = 'closed', bridgePref = 'closed', bridgeInfo = { allowed: ['closed'], len: 0.2 };
let setupKey = '';
let power = 0;              // CPU stroke animation only
let ballInHand = false, kitchen = false;
const camKick = { amp: 0, t: 9 };
let shot = null, log = null, before = null, settleT = 0, cueHideT = 0;
let ai = null;
let dragging = false;
let turnsPlayed = 0;
const keys = new Set();
// each human cue has its own chalked tip; the CPU chalks before every shot
const chalks = [new Chalk(), new Chalk()];
const aiChalk = new Chalk(); aiChalk.fill(1);
let chalkedOnce = [false, false];
let nerves = 0;
const sway = { t: 0, down: 0, yaw: 0, a: 0 };
const stroke = { id: null, y0: 0, x0: 0, pull0: 0, s: [], maxPull: 0, maxX: 0, trail: [], lastTrail: null, showT: 0 };
let rack = null;
let chalkUI = null;
let stanceCam = null;
let lastStroke = null; // debug: the measured contact stroke

// Stroke mapping: finger travel ↔ cue travel. 0.8 m of cue per screen height vertically (so a fast ~10 screen-
// heights/s flick is an 8 m/s break stroke); sideways drift maps to grip-hand drift at a lower gain.
const STROKE_SCALE = 0.8, LATERAL_SCALE = 0.12;
const ADDRESS = 0.012; // tip-to-ball gap when settled on the shot

const pIdx = () => (game ? game.cur : 0);
const myChalk = () => (humanTurn() ? chalks[mode === 'pvp' ? pIdx() : 0] : aiChalk);

function humanTurn() {
  if (!game) return true;
  return !game.player.isAI;
}

function setupRack(params) {
  world = new World();
  world.add(0, HEAD_X, 0);
  for (const p of rackPositions(params?.rng, params)) world.add(p.id, p.x, p.z);
  for (const id in ballMeshes) { ballMeshes[id].visible = true; ballMeshes[id].quaternion.identity(); }
  for (const b of world.balls) { // random initial orientation so numbers face different ways
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    b.q = [q.x, q.y, q.z, q.w];
  }
}

function newGame(m) {
  mode = m;
  const names = m === 'cpu' ? [{ name: 'You' }, { name: 'CPU', isAI: true }] : m === 'pvp' ? [{ name: 'Player 1' }, { name: 'Player 2' }] : [{ name: 'Practice' }, { name: '—' }];
  game = m === 'practice' ? null : new EightBall(names);
  const breaker = game ? (Math.random() < 0.5 ? 0 : 1) : 0;
  if (game) game.cur = breaker;
  chalks[0] = new Chalk(); chalks[1] = new Chalk(); chalkedOnce = [false, false];
  ballInHand = true; kitchen = true;
  aimYaw = 0; cam.yaw = 0; cam.pitch = camera.aspect < 1 ? 0.5 : 0.24; cam.dist = camera.aspect < 1 ? 1.35 : 1.15;
  camS.yaw = -0.6; camS.pitch = 0.7; camS.dist = 3.2;
  tip.a = tip.b = 0;
  turnsPlayed = 0;
  ui.menu.classList.add('hidden'); ui.over.classList.add('hidden');
  ui.hud.classList.remove('hidden'); ui.topbar.classList.remove('hidden'); ui.controls.classList.remove('hidden');
  ui.resume.classList.remove('hidden');
  $('btnGuide').style.display = m === 'practice' ? '' : 'none';
  // the player who doesn't break racks (in practice you rack your own)
  const racker = game ? game.players[1 - breaker] : { name: 'You' };
  setupRack();
  updateHUD();
  if (racker.isAI) {
    const q = { easy: 0.0009, medium: 0.0005, hard: 0.0002 }[difficulty];
    setupRack({ gap: q * Math.random(), loose: q, apex: [(Math.random() - 0.5) * 0.004, (Math.random() - 0.5) * 0.004] });
    toast('CPU racks · you break');
    startTurn(true);
  } else beginRack(racker.name, game && game.players[breaker].isAI);
}

function startTurn(first = false) {
  power = 0;
  tip.a = tip.b = 0; elevUser = 0; setupKey = '';
  if (!first) autoAim();
  stroke.id = null;
  if (humanTurn()) {
    state = 'aim';
    cam.yaw = aimYaw;
    nerves = pressure();
    if (game && mode === 'pvp' && !first) toast(`${game.player.name} to shoot`);
    showHint();
    const pi = mode === 'pvp' ? pIdx() : 0;
    if (!chalkedOnce[pi]) openChalk(true);
  } else {
    state = 'ai';
    ai = { phase: 'think', t: 0 };
    hint('CPU chalks up and studies the table…');
  }
  ui.controls.classList.toggle('disabled', !humanTurn());
  refreshCueSetup();
  updateHUD();
}

// Pressure: the 8-ball (or the opponent being on it) tightens the arm.
function pressure() {
  if (!game) return 0.1;
  const on = world.activeIds();
  const onEight = (pl) => pl.group && groupBalls(pl.group).every((n) => !on.has(n));
  return game.isBreak ? 0.15 : Math.min(1, 0.15 + (onEight(game.player) ? 0.6 : 0) + (onEight(game.other) ? 0.25 : 0));
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
  if (state === 'rack') return;
  if (state === 'stance') return hint(turnsPlayed < 3 ? 'Pull down to draw the cue back, push up through the ball — keep it straight' : '');
  if (state !== 'aim') return hint('');
  if (ballInHand) hint(kitchen ? 'Ball in hand (behind the head string) — drag the cue ball' : 'Ball in hand — drag the cue ball to place it');
  else if (turnsPlayed < 3) hint('Drag to aim · set tip & butt height · Get down to shoot');
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
  b.active = true; b.pocketed = false; b.offTable = false; b.fall = null; b.stop();
  const [px, pz] = freeSpot(id, x, z);
  b.x = px; b.z = pz;
  ballMeshes[id].visible = true;
}

// ---------- cue setup: forced elevation, bridge ----------
function refreshCueSetup(force = false) {
  const cb = world.ball(0);
  if (!cb || !cb.active) return;
  const key = [aimYaw.toFixed(4), tip.a.toFixed(3), tip.b.toFixed(3), cb.x.toFixed(4), cb.z.toFixed(4), elevUser.toFixed(3), bridgePref, turnsPlayed].join();
  if (key === setupKey && !force) return;
  setupKey = key;
  elevMin = minElevation(world, aimYaw, tip.a, tip.b);
  elev = Math.max(elevUser, elevMin);
  bridgeInfo = bridgeOptions(world, aimYaw, elev);
  bridge = bridgeInfo.allowed.includes(bridgePref) ? bridgePref : bridgeInfo.allowed[0];
  updateCueUI();
}

function updateCueUI() {
  const max = 1.35;
  ui.elevFill.style.height = `${(elev / max) * 100}%`;
  ui.elevMin.style.bottom = `${(elevMin / max) * 100}%`;
  ui.elevLabel.textContent = `${Math.round((elev * 180) / Math.PI)}°`;
  ui.elev.classList.toggle('forced', elevMin > elevUser + 0.003);
  ui.bridgeBtn.textContent = BRIDGES[bridge].name;
  ui.bridgeBtn.classList.toggle('locked', bridgeInfo.allowed.length < 2);
  ui.downBtn.textContent = state === 'stance' ? 'Stand up' : 'Get down';
  ui.downBtn.classList.toggle('down', state === 'stance');
  drawTipPanel();
}

// Ball-face view: where the tip sits on the cue ball, plus a close-up of the tip's chalk at the contact spot.
function drawTipPanel() {
  const c = ui.tipCanvas, g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  const bx = w * 0.4, by = h / 2, br = Math.min(w * 0.36, h * 0.45);
  const grd = g.createRadialGradient(bx - br * 0.3, by - br * 0.4, br * 0.1, bx, by, br);
  grd.addColorStop(0, '#fffdf6'); grd.addColorStop(0.45, '#eee8da'); grd.addColorStop(1, '#8f8676');
  g.fillStyle = grd; g.beginPath(); g.arc(bx, by, br, 0, 7); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.15)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(bx - br * 0.85, by); g.lineTo(bx + br * 0.85, by); g.moveTo(bx, by - br * 0.85); g.lineTo(bx, by + br * 0.85); g.stroke();
  const chalk = myChalk();
  if (mode === 'practice') { // practice aid: this tip's real miscue boundary
    g.setLineDash([3, 3]); g.strokeStyle = 'rgba(200,40,40,.7)'; g.beginPath();
    for (let k = 0; k <= 48; k++) {
      const th = (k / 48) * Math.PI * 2; let rho = 0.4;
      for (let it = 0; it < 6; it++) { const [u, v] = tipPoint(rho * Math.cos(th), rho * Math.sin(th)); rho = miscueLimit(muTip(chalk.sample(u, v))); }
      const px = bx + rho * Math.cos(th) * br, py = by - rho * Math.sin(th) * br;
      k ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.stroke(); g.setLineDash([]);
  }
  const tr = (TIP_R / R) * br, tx = bx + tip.a * br, ty = by - tip.b * br;
  g.fillStyle = 'rgba(47,98,184,.35)'; g.strokeStyle = '#2f62b8'; g.lineWidth = 2;
  g.beginPath(); g.arc(tx, ty, tr, 0, 7); g.fill(); g.stroke();
  // tip close-up: chalk map, contact spot marked
  const cx = w * 0.86, cy = h * 0.32, cr = Math.min(w * 0.12, h * 0.26);
  drawTipFace(g, chalk, cx, cy, cr);
  const [u, v] = tipPoint(tip.a, tip.b);
  g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx + u * cr, cy - v * cr, 3, 0, 7); g.stroke();
  g.fillStyle = 'rgba(243,234,216,.7)'; g.font = '10px system-ui'; g.textAlign = 'center';
  g.fillText('tip', cx, cy + cr + 12);
}

function drawTipFace(g, chalk, cx, cy, cr) {
  g.save();
  g.beginPath(); g.arc(cx, cy, cr, 0, 7); g.clip();
  g.fillStyle = '#6b4a2f'; g.fillRect(cx - cr, cy - cr, 2 * cr, 2 * cr);
  const n = chalk.n, cell = (2 * cr) / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = chalk.c[j * n + i]; if (c < 0.02) continue;
    const [u, v] = chalk.cellUV(i, j);
    g.fillStyle = `rgba(47,98,184,${Math.min(1, c * 1.1)})`;
    g.fillRect(cx + u * cr - cell / 2, cy - v * cr - cell / 2, cell + 0.6, cell + 0.6);
  }
  g.restore();
  g.strokeStyle = '#f3efe6'; g.lineWidth = Math.max(2, cr * 0.08); g.beginPath(); g.arc(cx, cy, cr, 0, 7); g.stroke();
}

// ---------- chalk ----------
function openChalk(required) {
  chalkUI = { required, last: null, down: false, x: 0, y: 0 };
  ui.chalkTitle.textContent = required ? 'Chalk your tip before you play' : 'Chalk up';
  ui.chalkOv.classList.remove('hidden');
  sizeChalk();
  drawChalk();
}
function sizeChalk() {
  const c = ui.chalkCanvas, r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
}
const chalkGeom = () => { const c = ui.chalkCanvas; return { cx: c.width / 2, cy: c.height / 2, cr: Math.min(c.width, c.height) * 0.32 }; };
function drawChalk() {
  if (!chalkUI) return;
  const c = ui.chalkCanvas, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const { cx, cy, cr } = chalkGeom();
  // ferrule + shaft receding behind the tip
  g.fillStyle = '#d9c39a'; g.beginPath(); g.arc(cx, cy, cr * 1.18, 0, 7); g.fill();
  g.fillStyle = '#f3efe6'; g.beginPath(); g.arc(cx, cy, cr * 1.07, 0, 7); g.fill();
  drawTipFace(g, myChalk(), cx, cy, cr);
  if (chalkUI.down) { // the chalk cube, face-on, where it touches the dome
    const s = cr * 0.9;
    g.save(); g.translate(chalkUI.x, chalkUI.y); g.rotate(0.25);
    g.fillStyle = 'rgba(40,86,170,.55)'; g.strokeStyle = 'rgba(160,190,240,.6)'; g.lineWidth = 2;
    g.beginPath(); g.roundRect(-s / 2, -s / 2, s, s, s * 0.12); g.fill(); g.stroke();
    g.restore();
  }
  const cov = myChalk().mean();
  ui.chalkDone.disabled = chalkUI.required && cov < 0.5;
  ui.chalkDone.textContent = ui.chalkDone.disabled ? 'Keep chalking…' : 'Done';
}
function chalkMove(e) {
  if (!chalkUI) return;
  const r = ui.chalkCanvas.getBoundingClientRect(), k = ui.chalkCanvas.width / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  chalkUI.x = x; chalkUI.y = y;
  const { cx, cy, cr } = chalkGeom();
  const u = (x - cx) / cr, v = -(y - cy) / cr;
  if (chalkUI.last && chalkUI.down && Math.hypot(u, v) < 1.25) {
    // brushing deposits chalk in proportion to how far the chalk slides over the dome; holding still does nothing
    const d = Math.hypot(u - chalkUI.last[0], v - chalkUI.last[1]);
    if (d > 0.002) { myChalk().brush(u, v, Math.min(0.2, d * 0.14), 0.3); sfx.chalk(d * 20); }
  }
  chalkUI.last = [u, v];
  drawChalk();
}
ui.chalkCanvas.addEventListener('pointerdown', (e) => { sfx.init(); ui.chalkCanvas.setPointerCapture(e.pointerId); chalkUI.down = true; chalkUI.last = null; chalkMove(e); });
ui.chalkCanvas.addEventListener('pointermove', chalkMove);
const chalkUp = () => { if (chalkUI) { chalkUI.down = false; chalkUI.last = null; drawChalk(); } };
ui.chalkCanvas.addEventListener('pointerup', chalkUp);
ui.chalkCanvas.addEventListener('pointercancel', chalkUp);
ui.chalkDone.onclick = () => {
  if (ui.chalkDone.disabled) return;
  chalkedOnce[mode === 'pvp' ? pIdx() : 0] = true;
  chalkUI = null; ui.chalkOv.classList.add('hidden');
  drawTipPanel();
};

// ---------- racking ----------
function seeded(seed) { let s = seed % 2147483647 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function beginRack(name, forOpponent) {
  rack = { seed: 1 + Math.floor(Math.random() * 1e9), gap: 0.0008 + Math.random() * 0.0008, loose: 0.0007, apex: [0.04 + Math.random() * 0.04, (Math.random() - 0.5) * 0.05], phase: 'set', lift: null, frameY: 0 };
  state = 'rack';
  layoutRack();
  rackFrame.visible = true; rackFrame.material.opacity = 1;
  ui.controls.classList.add('disabled');
  ui.actBtn.classList.remove('hidden'); ui.actBtn.textContent = 'Tighten';
  toast(`${name} racks${forOpponent ? ' for the CPU' : ''}`);
  hint('Drag the rack so the apex ball sits on the spot · tap Tighten to push the balls together');
}
function layoutRack() {
  const pos = rackPositions(seeded(rack.seed), { gap: rack.gap, loose: rack.loose, apex: rack.apex });
  for (const p of pos) { const b = world.ball(p.id); b.x = p.x; b.z = p.z; b.stop(); b.active = true; b.pocketed = false; }
}
function rackTighten() {
  // pushing the balls forward into the apex closes gaps, but a firm push also slides the whole rack forward
  rack.gap *= 0.45; rack.loose *= 0.6;
  rack.apex[0] += 0.0005 + Math.random() * 0.0015;
  layoutRack(); sfx.ball(0.4 + Math.random() * 0.3);
  if (rack.gap < 0.0002) { ui.actBtn.textContent = 'Lift rack'; rack.phase = 'tight'; hint('Tight. Check the apex is on the spot, then Lift rack'); }
}
function rackLiftStart() {
  const off = Math.hypot(...rack.apex);
  if (off > 0.005) { toast(`Apex is ${Math.round(off * 1000)} mm off the spot — drag the rack onto it`, true); return; }
  rack.phase = 'lift';
  ui.actBtn.classList.add('hidden');
  hint('Swipe up to lift the rack straight off the balls');
}
function rackLifted(dxPx, dyPx, ms) {
  const H = innerHeight;
  if (-dyPx < H * 0.12) return false;
  // a crooked or snatched lift drags the wooden frame across the balls
  const crooked = Math.abs(dxPx) / H, fast = ms < 160 ? (160 - ms) / 160 : 0;
  rack.loose += crooked * 0.008 + fast * 0.0006;
  rack.gap += crooked * 0.002;
  layoutRack();
  rack.phase = 'done'; rack.frameT = 0;
  const q = rack.gap + rack.loose;
  const verdict = q < 0.0004 ? 'frozen' : q < 0.0012 ? 'tight' : q < 0.003 ? 'a little loose' : 'loose';
  toast(`Rack ${verdict} · apex ${Math.round(Math.hypot(...rack.apex) * 1000)} mm off the spot`);
  setTimeout(() => { rackFrame.visible = false; rack = null; startTurn(true); }, 650);
  return true;
}
ui.actBtn.onclick = () => {
  if (!rack) return;
  if (rack.phase === 'set') rackTighten();
  else if (rack.phase === 'tight') rackLiftStart();
};

// ---------- shooting ----------
function shoot(p) { // CPU stroke: animate the cue, strike on contact
  if (state !== 'ai' || p < 0.01) return;
  const cb = world.ball(0);
  if (!cb.active) return;
  const natural = 0.02 + p * 0.24;
  const pullNow = Math.min(cueS.pull, natural + 0.03);
  const back = pullNow < natural * 0.6 ? { from: pullNow, dur: 0.12 + p * 0.12, pause: 0.05 } : null;
  const pull0 = Math.max(0.03, back ? natural : pullNow);
  const vCue = cueSpeedFor(powerToSpeed(p), Math.hypot(tip.a, tip.b));
  shot = { power: p, t: back ? -(back.dur + back.pause) : 0, back, pull0, vCue, dur: clamp((2 * pull0) / vCue, 0.06, 0.45), pose: cuePose(), struck: false, cpu: true };
  state = 'shooting';
  hint('');
  ui.controls.classList.add('disabled');
}

function strike() { // CPU contact
  aiChalk.fill(1);
  doStrike({ yaw: aimYaw, vCue: shot.vCue, a: tip.a, b: tip.b, elev, chalk: aiChalk, pose: shot.pose });
}

// Human contact: the live stroke reached the ball.
function humanStrike(vRaw, lateral, backswing) {
  const lim = armSpeedLimit(backswing, bridge);
  const vCue = Math.max(0.05, Math.min(vRaw, lim));
  const jab = vRaw > lim ? Math.min(1.5, (vRaw - lim) / lim) : 0;
  const wob = bridgeWobble(bridge, elev);
  const err = strokeError({ vCue, lateral, len: bridgeInfo.len, wobble: wob, nerves, jab });
  const pose = cuePose();
  const yaw = aimYaw + sway.yaw + err.yaw;
  let a = tip.a + sway.a + err.a, b = tip.b + err.b;
  const m = Math.hypot(a, b); if (m > 0.98) { a *= 0.98 / m; b *= 0.98 / m; }
  const res = doStrike({ yaw, vCue, a, b, elev, chalk: myChalk(), pose });
  const drift = ((yaw - aimYaw) * 180) / Math.PI;
  const rep = [`cue ${vCue.toFixed(1)} m/s${jab ? ' (snatched)' : ''}`, `ball ${res.V.toFixed(1)} m/s`, `tip ${fmtTip(a, b)}`, `line ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}°`];
  if (elev > 0.09) rep.push(`butt ${Math.round((elev * 180) / Math.PI)}°`);
  ui.report.textContent = rep.join(' · ');
  ui.report.classList.add('show');
  clearTimeout(humanStrike.t); humanStrike.t = setTimeout(() => ui.report.classList.remove('show'), 4200);
  stroke.lastTrail = stroke.trail.slice(); stroke.showT = 3;
}
const fmtTip = (a, b) => {
  const s = [];
  if (Math.abs(b) >= 0.05) s.push(`${Math.abs(b).toFixed(2)} ${b > 0 ? 'high' : 'low'}`);
  if (Math.abs(a) >= 0.05) s.push(`${Math.abs(a).toFixed(2)} ${a > 0 ? 'right' : 'left'}`);
  return s.length ? s.join(' ') : 'centre';
};

function doStrike({ yaw, vCue, a, b, elev: e, chalk, pose }) {
  before = world.activeIds();
  log = newLog();
  world.events.length = 0;
  world.acc = 0;
  const res = cueStrike(world, Math.cos(yaw), Math.sin(yaw), { vCue, a, b, elev: e, chalk });
  const p = speedToPower(res.V);
  if (res.miscue) { sfx.miscue(); toast('Miscue!', true, 1800); } else sfx.cue(p);
  shot = { ...(shot || {}), power: p, vCue, pose, struck: true, t: 0, miscue: res.miscue };
  shot.cb0 = { x: world.ball(0).x, z: world.ball(0).z };
  camKick.amp = Math.min(1, p * p); camKick.t = 0;
  ballInHand = false;
  if (game) game.kitchen = false;
  kitchen = false;
  state = 'rolling';
  settleT = 0;
  cueHideT = CUE_FT_HOLD + CUE_RETRACT;
  power = 0;
  turnsPlayed++;
  if (stanceCam) { cam.pitch = stanceCam.pitch; cam.dist = stanceCam.dist; stanceCam = null; }
  hint('');
  ui.controls.classList.add('disabled');
  updateCueUI();
  return res;
}

function endShot() {
  const scratched = log.pocketed.includes(0) || log.offTable.includes(0);
  if (scratched) respot(0, HEAD_X, 0);
  if (!game) {
    for (const id of log.offTable) if (id !== 0) respot(id, FOOT_X, 0);
    if (scratched) { ballInHand = true; toast(log.offTable.includes(0) ? 'Cue ball off the table' : 'Scratch', true); }
    else if (log.offTable.length) toast('Ball off the table — spotted', true);
    const left = world.balls.filter((b) => b.active && b.id !== 0).length;
    if (left === 0) { state = 'idle'; toast('Table cleared! Rack your own…'); setTimeout(() => { setupRack(); ballInHand = kitchen = true; updateHUD(); beginRack('You'); }, 1500); return; }
    updateHUD();
    startTurn();
    return;
  }
  const res = game.endShot(log, before);
  if (res.respot8) respot(8, FOOT_X, 0);
  for (const id of res.respot) respot(id, FOOT_X, 0);
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
  if (ai.phase === 'think' && ai.t > 0.9) {
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
    if (Math.abs(d) <= step) { aimYaw = ai.plan.yaw; ai.phase = 'set'; ai.t = 0; tip.a = ai.plan.a; tip.b = ai.plan.b; }
    else aimYaw += Math.sign(d) * step;
    cam.yaw = aimYaw;
    refreshCueSetup();
  } else if (ai.phase === 'set') {
    refreshCueSetup();
    power = ai.plan.power * Math.min(1, ai.t / 0.8);
    if (ai.t > 1.05) { aimYaw = ai.plan.yaw; shoot(ai.plan.power); }
  }
}
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- stance ----------
function enterStance() {
  if (state !== 'aim' || !humanTurn() || chalkUI) return;
  const cb = world.ball(0); if (!cb.active) return;
  refreshCueSetup(true);
  state = 'stance';
  stanceCam = { pitch: cam.pitch, dist: cam.dist };
  topView = false; $('btnView').classList.add('off');
  sway.down = 0;
  cueS.pull = Math.max(cueS.pull, ADDRESS);
  updateCueUI(); showHint();
}
function leaveStance() {
  if (state !== 'stance') return;
  state = 'aim'; stroke.id = null;
  if (stanceCam) { cam.pitch = stanceCam.pitch; cam.dist = stanceCam.dist; stanceCam = null; }
  updateCueUI(); showHint();
}
// the longer you stay down the steadier you get, until the arm starts to tire after ~6 s
function updateSway(dt) {
  sway.t += dt;
  if (state !== 'stance') { sway.yaw = sway.a = 0; return; }
  sway.down += dt;
  const settle = 0.35 + 0.65 * Math.exp(-sway.down / 0.9) + Math.max(0, sway.down - 6) * 0.08;
  const amp = 0.0011 * bridgeWobble(bridge, elev) * (0.5 + 1.5 * nerves) * settle;
  const t = sway.t;
  sway.yaw = (amp * (Math.sin(1.7 * t) + 0.5 * Math.sin(4.3 * t + 1.3))) / 1.5;
  sway.a = (amp / 0.0011) * 0.03 * Math.sin(2.3 * t + 0.4);
}

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
  if (state === 'rack' && rack) {
    if (rack.phase === 'lift') { drag = { type: 'lift', x: e.clientX, y: e.clientY, t: performance.now() }; return; }
    const pt = tablePoint(e.clientX, e.clientY);
    if (pt && (rack.phase === 'set' || rack.phase === 'tight')) { drag = { type: 'rack', last: pt }; return; }
  }
  if (state === 'stance' && humanTurn()) {
    if (stroke.id === null) {
      stroke.id = e.pointerId; stroke.y0 = e.clientY; stroke.x0 = e.clientX; stroke.pull0 = cueS.pull;
      stroke.s = [{ t: e.timeStamp || performance.now(), p: cueS.pull, x: e.clientX }]; stroke.maxPull = cueS.pull; stroke.maxX = e.clientX;
      stroke.trail = [[0, 0]];
    }
    drag = { type: 'stroke' };
    return;
  }
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
  if (canAim && topView && pt && mode === 'practice') {
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
  if (drag.type === 'stroke' && e.pointerId === stroke.id) strokeMove(e);
  else if (drag.type === 'rack') {
    const pt = tablePoint(e.clientX, e.clientY); if (!pt) return;
    rack.apex[0] = clamp(rack.apex[0] + pt.x - drag.last.x, -0.1, 0.12);
    rack.apex[1] = clamp(rack.apex[1] + pt.z - drag.last.z, -0.1, 0.1);
    // sliding the rack over the cloth lets the balls settle back a little
    rack.gap = Math.min(0.0016, rack.gap + Math.hypot(pt.x - drag.last.x, pt.z - drag.last.z) * 0.004);
    if (rack.phase === 'tight' && rack.gap > 0.0002) { rack.phase = 'set'; ui.actBtn.textContent = 'Tighten'; }
    drag.last = pt;
    layoutRack();
  } else if (drag.type === 'pinch' && pointers.size >= 2) {
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
    const n = Math.ceil(Math.hypot(tx - cb.x, tz - cb.z) / 0.005);
    const sx = cb.x, sz = cb.z;
    for (let i = 1; i <= n; i++) {
      const x = sx + ((tx - sx) * i) / n, z = sz + ((tz - sz) * i) / n;
      if (validCueSpot(x, z)) { cb.x = x; cb.z = z; } else if (validCueSpot(x, cb.z)) cb.x = x; else if (validCueSpot(cb.x, z)) cb.z = z;
    }
  }
});

// Live stroke: the cue follows the finger 1:1 (scaled). Contact happens when the tip reaches the ball;
// cue speed is the finger's speed over the last ~40 ms, drift is the sideways travel since the forward stroke began.
function strokeMove(e) {
  // coalesced events keep full input resolution on phones that batch touch moves per frame
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ce of evs.length ? evs : [e]) { strokeSample(ce); if (stroke.id === null) return; }
}
function strokeSample(e) {
  const H = innerHeight, now = e.timeStamp || performance.now();
  const pull = clamp(stroke.pull0 + ((e.clientY - stroke.y0) * STROKE_SCALE) / H, -0.05, bridgeInfo.len);
  const prev = stroke.s[stroke.s.length - 1];
  stroke.s.push({ t: now, p: pull, x: e.clientX });
  if (stroke.s.length > 80) stroke.s.shift();
  stroke.trail.push([((e.clientX - stroke.x0) * STROKE_SCALE) / H, pull - stroke.pull0]);
  if (stroke.trail.length > 400) stroke.trail.shift();
  if (pull > stroke.maxPull) { stroke.maxPull = pull; stroke.maxX = e.clientX; }
  if (prev.p > 0 && pull <= 0) {
    let k = stroke.s.length - 2;
    while (k > 0 && now - stroke.s[k].t < 40) k--;
    const s0 = stroke.s[k], dt = Math.max(0.004, (now - s0.t) / 1000);
    const v = Math.max(0, (s0.p - pull) / dt);
    const lateral = ((e.clientX - stroke.maxX) * LATERAL_SCALE) / H;
    stroke.id = null; drag = null;
    cueS.pull = 0;
    lastStroke = { v, lateral, back: stroke.maxPull, samples: stroke.s.slice(-12) };
    humanStrike(v, lateral, Math.max(0, stroke.maxPull));
    return;
  }
  // pulled back then re-settled: a new backswing starts the drift measurement again
  if (pull < stroke.maxPull - 0.03 && prev.p < pull) { stroke.maxPull = pull; stroke.maxX = e.clientX; }
  cueS.pull = Math.max(0.0015, pull);
}
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (drag && drag.type === 'lift' && rack && rack.phase === 'lift') rackLifted(e.clientX - drag.x, e.clientY - drag.y, performance.now() - drag.t);
  if (e.pointerId === stroke.id) stroke.id = null;
  if (pointers.size === 0) { drag = null; dragging = false; }
  else if (drag && drag.type === 'pinch') drag = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (state !== 'stance') cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 0.35, 3.4); }, { passive: false });

// fine aim strip (works standing and down on the shot)
let fineDrag = null, fineOffset = 0;
ui.fine.addEventListener('pointerdown', (e) => { sfx.init(); ui.fine.setPointerCapture(e.pointerId); fineDrag = e.clientX; });
ui.fine.addEventListener('pointermove', (e) => {
  if (fineDrag === null) return;
  const dx = e.clientX - fineDrag; fineDrag = e.clientX;
  if ((state === 'aim' || state === 'stance') && humanTurn()) { aimYaw += dx * 0.00035; cam.yaw = aimYaw; }
  fineOffset = (fineOffset + dx) % 12;
  ui.fineTex.style.transform = `translateX(${fineOffset}px)`;
});
ui.fine.addEventListener('pointerup', () => (fineDrag = null));
ui.fine.addEventListener('pointercancel', () => (fineDrag = null));

// tip placement on the ball face
const canSetUp = () => (state === 'aim' || state === 'stance') && humanTurn() && stroke.id === null;
const setTipFromEvent = (e) => {
  const c = ui.tipCanvas, r = c.getBoundingClientRect();
  const br = Math.min(c.width * 0.36, c.height * 0.45) * (r.width / c.width);
  let a = (e.clientX - r.left - r.width * 0.4) / br, b = -(e.clientY - r.top - r.height / 2) / br;
  const m = Math.hypot(a, b); if (m > MAX_TIP) { a *= MAX_TIP / m; b *= MAX_TIP / m; }
  if (m < 0.03) a = b = 0;
  tip.a = a; tip.b = b;
  refreshCueSetup(); drawTipPanel();
};
ui.tipCanvas.addEventListener('pointerdown', (e) => { if (!canSetUp()) return; ui.tipCanvas.setPointerCapture(e.pointerId); ui.tipCanvas.dataset.d = '1'; setTipFromEvent(e); });
ui.tipCanvas.addEventListener('pointermove', (e) => { if (ui.tipCanvas.dataset.d === '1') setTipFromEvent(e); });
ui.tipCanvas.addEventListener('pointerup', () => (ui.tipCanvas.dataset.d = ''));
ui.tipCanvas.addEventListener('pointercancel', () => (ui.tipCanvas.dataset.d = ''));

// butt elevation
const setElevFromEvent = (e) => {
  const r = ui.elev.getBoundingClientRect();
  elevUser = clamp((r.bottom - e.clientY) / r.height, 0, 1) * 1.35;
  refreshCueSetup();
};
ui.elev.addEventListener('pointerdown', (e) => { if (!canSetUp()) return; ui.elev.setPointerCapture(e.pointerId); ui.elev.dataset.d = '1'; setElevFromEvent(e); });
ui.elev.addEventListener('pointermove', (e) => { if (ui.elev.dataset.d === '1') setElevFromEvent(e); });
ui.elev.addEventListener('pointerup', () => (ui.elev.dataset.d = ''));
ui.elev.addEventListener('pointercancel', () => (ui.elev.dataset.d = ''));

function cycleBridge() {
  if (!canSetUp()) return;
  const al = bridgeInfo.allowed;
  if (al.length < 2) { toast(al[0] === 'mech' ? 'Too far to reach — mechanical bridge only' : al[0] === 'rail' ? 'Cue ball near the rail — rail bridge' : 'Only an open bridge holds the cue this high'); return; }
  bridgePref = al[(al.indexOf(bridge) + 1) % al.length];
  refreshCueSetup(true);
}
ui.bridgeBtn.onclick = cycleBridge;
ui.chalkBtn.onclick = () => { if (canSetUp()) { leaveStance(); openChalk(false); } };
ui.downBtn.onclick = () => (state === 'stance' ? leaveStance() : enterStance());

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  sfx.init();
  if (e.code === 'KeyT') toggleTop();
  if (e.code === 'KeyG' && mode === 'practice') toggleGuide();
  if (e.code === 'KeyM') toggleSound();
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'Escape') openMenu();
  if (e.code === 'Space') { e.preventDefault(); state === 'stance' ? leaveStance() : enterStance(); }
  if (canSetUp() && !chalkUI) {
    const st = 0.06;
    if (e.code === 'KeyW') tip.b += st;
    if (e.code === 'KeyS') tip.b -= st;
    if (e.code === 'KeyA') tip.a -= st;
    if (e.code === 'KeyD') tip.a += st;
    if (e.code === 'KeyX') tip.a = tip.b = 0;
    const m = Math.hypot(tip.a, tip.b); if (m > MAX_TIP) { tip.a *= MAX_TIP / m; tip.b *= MAX_TIP / m; }
    if (e.code === 'KeyQ') elevUser = clamp(Math.max(elevUser, elev) + 0.035, 0, 1.35);
    if (e.code === 'KeyE') elevUser = clamp(Math.min(elevUser, elev) - 0.035, 0, 1.35);
    if (e.code === 'KeyB') cycleBridge();
    if (e.code === 'KeyC') ui.chalkBtn.onclick();
    refreshCueSetup();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
function handleKeys(dt) {
  if (!(state === 'aim' || state === 'stance') || !humanTurn()) return;
  const fine = keys.has('ShiftLeft') || keys.has('ShiftRight') || state === 'stance' ? 0.08 : 1;
  if (keys.has('ArrowLeft')) aimYaw -= 0.9 * fine * dt;
  if (keys.has('ArrowRight')) aimYaw += 0.9 * fine * dt;
  if (state === 'aim' && keys.has('ArrowUp')) cam.pitch = clamp(cam.pitch + 0.8 * dt, 0.03, 1.45);
  if (state === 'aim' && keys.has('ArrowDown')) cam.pitch = clamp(cam.pitch - 0.8 * dt, 0.03, 1.45);
  cam.yaw = aimYaw;
}

// ---------- fullscreen ----------
// Browsers only allow requestFullscreen inside a user gesture, so it is requested when a game starts (button
// click) and re-requested on the next tap/click/key while playing if we dropped out (phones lose it easily).
// iPhone Safari has no element fullscreen at all; there the button is hidden (Add to Home Screen gives standalone).
const fsRoot = document.documentElement;
const fsSupported = !!(fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen) && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true);
const fsActive = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const coarsePointer = matchMedia('(pointer: coarse)').matches;
let fsWanted = false, fsSelfExit = false;
function enterFullscreen() {
  if (!fsSupported || fsActive()) return;
  try {
    const r = fsRoot.requestFullscreen ? fsRoot.requestFullscreen({ navigationUI: 'hide' }) : fsRoot.webkitRequestFullscreen();
    if (r && r.catch) r.catch(() => {});
  } catch {}
}
function exitFullscreen() {
  if (!fsActive()) return;
  fsSelfExit = true;
  try { const r = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen(); if (r && r.catch) r.catch(() => {}); } catch {}
}
function toggleFullscreen() {
  fsWanted = !fsActive();
  if (fsWanted) enterFullscreen(); else exitFullscreen();
}
function onFsChange() {
  const on = fsActive();
  // Leaving via Esc on desktop means "I don't want fullscreen" — stop re-requesting. On touch devices an exit is
  // usually an accidental edge swipe / back gesture, so keep re-entering on the next tap.
  if (!on && !fsSelfExit && !coarsePointer) fsWanted = false;
  fsSelfExit = false;
  $('btnFs').classList.toggle('off', !on);
  resize();
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
const fsGesture = (e) => {
  if (!fsWanted || state === 'menu' || fsActive()) return;
  if (e.type === 'keydown' && (e.code === 'Escape' || e.code === 'KeyF')) return;
  enterFullscreen();
};
// pointerup/click/keydown are activation-granting events on every engine (touch pointerdown is not)
for (const ev of ['pointerup', 'click', 'keydown']) window.addEventListener(ev, fsGesture, true);

// buttons
function toggleTop() { if (state === 'stance') return; topView = !topView; $('btnView').classList.toggle('off', !topView); showHint(); }
function toggleGuide() { guideOn = !guideOn; $('btnGuide').classList.toggle('off', !guideOn); }
function toggleSound() { sfx.setEnabled(!sfx.enabled); $('btnSound').classList.toggle('off', !sfx.enabled); }
function openMenu() { if (state === 'menu') return; ui.menu.classList.remove('hidden'); }
$('btnView').onclick = toggleTop;
$('btnGuide').onclick = toggleGuide;
$('btnSound').onclick = toggleSound;
$('btnMenu').onclick = openMenu;
$('btnFs').onclick = toggleFullscreen;
if (!fsSupported) $('btnFs').style.display = 'none';
$('btnFs').classList.add('off');
$('btnView').classList.add('off');
ui.resume.onclick = () => ui.menu.classList.add('hidden');
document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { sfx.init(); fsWanted = true; enterFullscreen(); newGame(b.dataset.mode); }));
$('diff').onchange = (e) => (difficulty = e.target.value);
$('gfx').value = gfx;
$('gfx').onchange = (e) => { gfx = e.target.value; try { localStorage.setItem('ob-gfx', gfx); } catch {} applyGfx(); };
$('clothSel').onchange = (e) => cloth.color.set(CLOTHS[e.target.value]);
$('again').onclick = () => { fsWanted = true; enterFullscreen(); newGame(mode); };
$('toMenu').onclick = () => { ui.over.classList.add('hidden'); ui.menu.classList.remove('hidden'); ui.resume.classList.add('hidden'); state = 'menu'; };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- per-frame updates ----------
const FLOOR = -0.79;
function updateBalls(dt) {
  for (const b of world.balls) {
    const m = ballMeshes[b.id];
    if (b.active) {
      m.position.set(b.x, R + b.y, b.z);
      m.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      m.visible = true;
    } else if (b.fall && b.fall.off) { // jumped off the table: ballistic to the floor, then gone
      const f = b.fall;
      f.t += dt;
      const y = Math.max(FLOOR, R + f.y0 + f.vy * f.t - 4.905 * f.t * f.t);
      m.position.set(f.x0 + f.vx * f.t, y, f.z0 + f.vz * f.t);
      if (f.t > 2.2) { m.visible = false; b.fall = null; }
    } else if (b.fall) {
      const f = b.fall;
      f.t += dt;
      const p = f.pocket;
      const k = Math.min(1, f.t / 0.14);
      const x = f.x0 + (p.x - f.x0) * k, z = f.z0 + (p.z - f.z0) * k;
      const y = R + (f.y0 || 0) - Math.max(0, f.t - 0.04) ** 2 * 7;
      m.position.set(x, y, z);
      if (y < -0.13) { m.visible = false; b.fall = null; }
    } else if (b.pocketed || b.offTable) m.visible = false;
  }
}

// Cue pose: anchored at the tip contact point on the cue ball, along the real cue axis (elevation included).
const CUE_FT_HOLD = 0.4, CUE_RETRACT = 0.45;
const cueS = { pull: 0.4, shown: false, idle: 0, fade: 1, wasStruck: false };
function cuePose() {
  const cb = world.ball(0);
  const yaw = aimYaw + sway.yaw;
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const { d, r } = cueGeometry(dx, dz, tip.a + sway.a, tip.b, elev, false);
  const contact = new THREE.Vector3(cb.x + r[0], R + cb.y + r[1], cb.z + r[2]);
  return { contact, back: new THREE.Vector3(-d[0], -d[1], -d[2]), dx, dz, elev };
}
const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

function updateCue(dt) {
  const cb = world.ball(0);
  const struck = state === 'rolling' && shot && shot.struck && cueHideT > 0;
  const show = struck || (cb.active && (state === 'aim' || state === 'stance' || state === 'shooting' || state === 'ai'));
  if (!struck && cueS.wasStruck) cueS.shown = false;
  cueS.wasStruck = struck;
  cue.userData.setChalk(myChalk().mean() * 1.3);
  if (!show) { cue.visible = cueS.shown = false; return; }
  if (!cueS.shown) { cueS.shown = true; cueS.pull = 0.45; cueS.fade = 0; }
  cue.visible = true;
  cueS.fade = Math.min(1, cueS.fade + dt * 4);

  let pose, pull, opacity = 1;
  if (state === 'shooting') {
    pose = shot.pose;
    shot.t += dt;
    const f = Math.max(0, Math.min(1, shot.t / shot.dur));
    pull = shot.pull0 * (1 - f * f);
    if (shot.t < 0) {
      const u = Math.min(1, (shot.t + shot.back.dur + shot.back.pause) / shot.back.dur);
      pull = shot.back.from + (shot.pull0 - shot.back.from) * easeInOut(u);
    }
    cueS.pull = pull;
    if (f >= 1) { pull = 0; strike(); }
  } else if (struck) {
    pose = shot.pose;
    shot.t += dt;
    // follow-through: tip keeps going at v_cue and decays over 2.5–20 cm; a miscue skids off to the side
    const d = 0.025 + 0.17 * Math.min(1, shot.vCue / 6);
    let s = d * (1 - Math.exp((-shot.t * shot.vCue) / d));
    if (cb.active && !shot.miscue) s = Math.min(s, Math.max(0, (cb.x - shot.cb0.x) * pose.dx + (cb.z - shot.cb0.z) * pose.dz - 0.002));
    s = Math.min(s, Math.max(0, pose.contact.y - 0.007) / Math.max(0.03, Math.sin(pose.elev)));
    pull = -s;
    const u = Math.min(1, Math.max(0, shot.t - CUE_FT_HOLD) / CUE_RETRACT);
    if (u > 0) { const e = easeInOut(u); pull += e * 0.1; opacity = 1 - e; }
    cueHideT -= dt;
  } else if (state === 'stance') {
    pose = cuePose();
    if (stroke.id === null) cueS.pull += (ADDRESS - cueS.pull) * (1 - Math.exp(-dt * 5));
    pull = cueS.pull;
  } else {
    pose = cuePose();
    const target = state === 'ai' ? 0.02 + power * 0.24 : 0.06;
    cueS.idle += dt;
    const breathe = humanTurn() ? 0.003 * (1 - Math.cos(cueS.idle * 2.1)) : 0;
    cueS.pull += (target + breathe - cueS.pull) * (1 - Math.exp(-dt * (cueS.pull > target + 0.05 ? 9 : 28)));
    pull = cueS.pull;
  }

  cue.userData.setOpacity(struck ? opacity : cueS.fade);
  cue.position.copy(pose.contact).addScaledVector(pose.back, 0.0015 + pull);
  cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pose.back);
}

function updateGuide() {
  const cb = world.ball(0);
  // aim guide is a practice-mode training aid only; in matches you sight the shot yourself
  const show = mode === 'practice' && guideOn && cb.active && (state === 'aim' || state === 'stance');
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

// Last stroke, as the grip hand travelled: forward/back vertical, sideways drift magnified 4×.
function drawStroke(dt) {
  const c = ui.strokeCanvas;
  const live = state === 'stance' && stroke.id !== null;
  stroke.showT = Math.max(0, stroke.showT - dt);
  const tr = live ? stroke.trail : stroke.showT > 0 ? stroke.lastTrail : null;
  c.classList.toggle('hidden', !(state === 'stance' || stroke.showT > 0));
  const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
  const cx = c.width / 2, y0 = c.height * 0.15, k = (c.height * 0.7) / Math.max(0.05, bridgeInfo.len);
  g.strokeStyle = 'rgba(214,167,74,.35)'; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(cx, 4); g.lineTo(cx, c.height - 4); g.stroke(); g.setLineDash([]);
  g.fillStyle = 'rgba(243,234,216,.8)'; g.beginPath(); g.arc(cx, y0, 4, 0, 7); g.fill(); // the ball
  if (!tr || tr.length < 2) return;
  g.strokeStyle = '#f0d48a'; g.lineWidth = 2; g.beginPath();
  tr.forEach(([x, p], i) => { const px = cx + x * 4 * k, py = y0 + (p + stroke.pull0) * k; i ? g.lineTo(px, py) : g.moveTo(px, py); });
  g.stroke();
}

const tmpV = new THREE.Vector3(), lookV = new THREE.Vector3(), topPos = new THREE.Vector3(), upV = new THREE.Vector3();
function updateCamera(dt) {
  const cb = world.ball(0);
  const focusTarget = tmpV.set(cb.active ? cb.x : 0, R, cb.active ? cb.z : 0);
  if (state === 'rolling' || state === 'over') focusTarget.copy(camS.focus);
  if (state === 'menu') { focusTarget.set(0, 0, 0); cam.yaw += dt * 0.06; }
  if (state === 'rack') { focusTarget.set(FOOT_X + 0.06, R, 0); cam.yaw = 0; cam.pitch = 1.05; cam.dist = camera.aspect < 1 ? 1.1 : 0.85; }
  if (state === 'stance') { cam.pitch = Math.max(0.2, elev + 0.17); cam.dist = 0.55; cam.yaw = aimYaw; }
  const k = 1 - Math.exp(-dt * 7);
  const kYaw = ((state === 'aim' || state === 'stance') && (dragging || fineDrag !== null)) || state === 'ai' || state === 'stance' ? 1 - Math.exp(-dt * 30) : k;
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

  const aspect = camera.aspect;
  const portrait = aspect < 1;
  const ex = HL + 0.23, ez = HW + 0.23;
  const tf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const [sh, sv] = portrait ? [ez, ex] : [ex, ez];
  const height = Math.max(sv / tf, sh / (tf * aspect)) * 1.1;
  topPos.set(0, height, 0.0001);
  const t = camS.top;
  camKick.t += dt;
  const kt = camKick.t / 0.05;
  if (kt < 12) orbitPos.addScaledVector(new THREE.Vector3(dx, 0.35, dz), -0.01 * camKick.amp * kt * Math.exp(1 - kt));
  camera.position.lerpVectors(orbitPos, topPos, t);
  lookV.lerpVectors(orbitLook, new THREE.Vector3(0, 0, 0), t);
  upV.set(0, 1, 0).lerp(portrait ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, -1), t).normalize();
  camera.up.copy(upV);
  camera.lookAt(lookV);
  lamp.visible = camera.position.y < 0.95;
}

function updateRackFrame(dt) {
  if (!rackFrame.visible || !rack) return;
  if (rack.phase === 'done') { rack.frameT += dt; rackFrame.material.opacity = Math.max(0, 1 - rack.frameT / 0.5); }
  const lift = rack.phase === 'done' ? rack.frameT * 0.5 : 0;
  rackFrame.position.set(FOOT_X + rack.apex[0] + rackCentroidX, lift, rack.apex[1]);
}

function processEvents() {
  for (const e of world.events) {
    if (log) updateLog(log, e);
    if (e.type === 'ball') sfx.ball(e.speed);
    else if (e.type === 'cushion') sfx.cushion(e.speed);
    else if (e.type === 'slate') sfx.slate(e.speed);
    else if (e.type === 'pocket') { sfx.pocket(); setTimeout(updateHUD, 250); }
    else if (e.type === 'offtable') { toast('Off the table!', true, 1500); setTimeout(updateHUD, 250); }
  }
  world.events.length = 0;
}

// ---------- loop ----------
let last = performance.now();
let firstFrame = true;
let renderOn = true; // debug: headless tests switch rendering off so gestures arrive in real time
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const paused = state !== 'menu' && !ui.menu.classList.contains('hidden');
  if (!paused) handleKeys(dt);
  if (!paused && state === 'ai' && ai) updateAI(dt);
  if (!paused && (state === 'aim' || state === 'stance')) refreshCueSetup();
  updateSway(paused ? 0 : dt);
  if (!paused && state === 'rolling') {
    world.simulate(dt);
    processEvents();
    const falling = world.balls.some((b) => b.fall);
    if (!world.anyMoving() && !falling) {
      settleT += dt;
      if (settleT > 0.35) endShot();
    } else settleT = 0;
  }
  ui.controls.classList.toggle('disabled', !((state === 'aim' || state === 'stance') && humanTurn()));
  updateBalls(dt);
  updateCue(dt);
  updateGuide();
  updateRackFrame(dt);
  drawStroke(dt);
  updateCamera(dt);
  if (renderOn) renderer.render(scene, camera);
  if (firstFrame) { firstFrame = false; ui.loading.classList.add('hidden'); }
  requestAnimationFrame(frame);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 58 : 45;
  camera.updateProjectionMatrix();
  if (chalkUI) { sizeChalk(); drawChalk(); }
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
window.__pool = {
  fastForward: () => { if (state !== 'rolling') return; while (world.anyMoving()) { world.step(1 / 1500); processEvents(); } },
  get world() { return world; }, get game() { return game; }, get state() { return state; }, get rack() { return rack; },
  newGame, shoot, setAim: (y) => { aimYaw = y; cam.yaw = y; },
  set render(v) { renderOn = v; }, get tip() { return { ...tip } }, get lastStroke() { return lastStroke; }, get chalk() { return myChalk().mean(); }, get cue() { return cue; }, get shot() { return shot; }, get elev() { return { elev, elevMin, bridge, allowed: bridgeInfo.allowed } },
  snapshot: () => { renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
  setCam: (yaw, pitch, dist) => { cam.yaw = camS.yaw = yaw; cam.pitch = camS.pitch = pitch; cam.dist = camS.dist = dist; }, toggleTop,
  // realism helpers: chalk the tip fully, place the tip / butt, get down, strike with a given cue speed and drift
  chalkFull: () => { for (const c of chalks) c.fill(1); chalkedOnce = [true, true]; chalkUI = null; ui.chalkOv.classList.add('hidden'); },
  setTip: (a, b) => { tip.a = a; tip.b = b; refreshCueSetup(true); }, setElev: (e) => { elevUser = e; refreshCueSetup(true); },
  stance: enterStance, stroke: (vCue, lateral = 0, back = 0.15) => { if (state !== 'stance') enterStance(); if (state === 'stance') humanStrike(vCue, lateral, back); },
  quickRack: () => { if (rack) { rack.apex = [0, 0]; rack.gap = 0.0001; rack.loose = 0.0001; layoutRack(); rack.phase = 'lift'; rackLifted(0, -innerHeight * 0.3, 400); } },
};
