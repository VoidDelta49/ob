import * as THREE from 'three';
import { R, BALL_COLORS } from './constants.js';

const geo = new THREE.SphereGeometry(R, 48, 32);

function ballTexture(id) {
  const w = 1024, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const color = BALL_COLORS[id];
  const ivory = '#f4f1e6';
  if (id === 0) {
    ctx.fillStyle = ivory; ctx.fillRect(0, 0, w, h);
    // measle-style dots so spin is readable
    ctx.fillStyle = '#c0262b';
    for (const u of [0, 0.25, 0.5, 0.75]) {
      ctx.beginPath(); ctx.arc(u * w + 0.5, h / 2, 9, 0, Math.PI * 2); ctx.fill();
      if (u === 0) { ctx.beginPath(); ctx.arc(w, h / 2, 9, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.fillRect(0, 0, w, 10); ctx.fillRect(0, h - 10, w, 10);
  } else {
    const stripe = id >= 9;
    ctx.fillStyle = stripe ? ivory : color; ctx.fillRect(0, 0, w, h);
    if (stripe) { ctx.fillStyle = color; ctx.fillRect(0, h * 0.29, w, h * 0.42); }
    for (const u of [0.25, 0.75]) {
      const cx = u * w, cy = h / 2;
      ctx.fillStyle = ivory;
      ctx.beginPath(); ctx.ellipse(cx, cy, 52, 52, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = `bold ${id >= 10 ? 50 : 60}px Georgia, 'Times New Roman', serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(id), cx, cy + 3);
      if (id === 6 || id === 9) ctx.fillRect(cx - 12, cy + 30, 24, 4);
    }
  }
  // very subtle wear
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 6;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function createBallMesh(id) {
  const mat = new THREE.MeshPhysicalMaterial({
    map: ballTexture(id), roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.0,
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// 2D ball icon for the HUD
export function ballIcon(id, size = 22) {
  const c = document.createElement('canvas');
  const s = size * 2;
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const r = s / 2 - 1;
  ctx.save();
  ctx.beginPath(); ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2); ctx.clip();
  const color = BALL_COLORS[id];
  ctx.fillStyle = id >= 9 ? '#f4f1e6' : color; ctx.fillRect(0, 0, s, s);
  if (id >= 9) { ctx.fillStyle = color; ctx.fillRect(0, s * 0.22, s, s * 0.56); }
  if (id > 0) {
    ctx.fillStyle = '#f4f1e6';
    ctx.beginPath(); ctx.arc(s / 2, s / 2, r * 0.48, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = `bold ${Math.round(r * 0.62)}px Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(id), s / 2, s / 2 + 1);
  }
  const g = ctx.createRadialGradient(s * 0.35, s * 0.3, 1, s / 2, s / 2, r);
  g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.35, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  ctx.restore();
  c.style.width = c.style.height = size + 'px';
  c.className = 'ball-icon';
  return c;
}
