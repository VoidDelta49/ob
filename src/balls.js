import * as THREE from 'three';
import { R, BALL_COLORS } from './constants.js';
import { patchMaterial } from './surface.js';

// One 4x4 atlas holds all 16 ball skins (1024x512 cells), so every ball draws in a single instanced call.
// Each skin sits inside a 16 px gutter of itself (wrapped across u, edge rows stretched across v) so mipmaps never bleed.
const CW = 1024, CH = 512, GUT = 16, IW = CW - 2 * GUT, IH = CH - 2 * GUT;

function drawSkin(ctx, id, w, h) {
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
}

function ballAtlas() {
  const atlas = document.createElement('canvas');
  atlas.width = CW * 4; atlas.height = CH * 4;
  const actx = atlas.getContext('2d');
  const skin = document.createElement('canvas');
  skin.width = IW; skin.height = IH;
  const sctx = skin.getContext('2d');
  for (let id = 0; id < 16; id++) {
    sctx.clearRect(0, 0, IW, IH);
    drawSkin(sctx, id, IW, IH);
    const x = (id % 4) * CW + GUT, y = (id >> 2) * CH + GUT;
    actx.save();
    actx.beginPath(); actx.rect(x - GUT, y - GUT, CW, CH); actx.clip();
    for (const ox of [-IW, 0, IW]) actx.drawImage(skin, x + ox, y); // u wraps into the side gutters
    actx.restore();
    // pole rows stretched into the v gutters (full cell width, gutters included)
    actx.drawImage(atlas, x - GUT, y, CW, 1, x - GUT, y - GUT, CW, GUT);
    actx.drawImage(atlas, x - GUT, y + IH - 1, CW, 1, x - GUT, y + IH, CW, GUT);
  }
  // very subtle wear
  const img = actx.getImageData(0, 0, atlas.width, atlas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 6;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  actx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(atlas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// All 16 balls as one InstancedMesh (instance index = ball number): 1 draw call, plus 1 per shadow-casting light.
export function createBallSet() {
  const mat = new THREE.MeshPhysicalMaterial({
    map: ballAtlas(), roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.0,
  });
  patchMaterial(mat, { phong: [0.2, 380] }); // tight Phong hot-spots of the three bulbs on top of the GGX + clearcoat lobes
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    base(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCell;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = (vec2(mod(aCell, 4.0), floor(aCell / 4.0)) * vec2(${CW}.0, ${CH}.0) + vec2(${GUT}.0) + vMapUv * vec2(${IW}.0, ${IH}.0))
          / vec2(${CW * 4}.0, ${CH * 4}.0);`);
  };
  mat.customProgramCacheKey = () => 'ball';
  const geo = new THREE.SphereGeometry(R, 48, 32);
  // canvas row 0 is the top (flipY): cell row k from the top sits at v-row 3 - k from the bottom
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: 16 }, (_, id) => (id % 4) + (3 - (id >> 2)) * 4)), 1));
  const mesh = new THREE.InstancedMesh(geo, mat, 16);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false; // instances move every frame; the cached bounds would go stale
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
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
  c.style.width = c.style.height = `calc(${size} * var(--u, 1px))`; // scales with the UI
  c.className = 'ball-icon';
  return c;
}
