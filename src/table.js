import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HL, HW, L, W, R } from './constants.js';
import { patchMaterial, surfaceTexture, lumaHeight } from './surface.js';
import { CW, RAIL_W, CUSHION_H, cushions, pockets, boundaryOutline, pocketRims } from './table-geom.js';

export const BED_TOP = 0;
const RAIL_TOP = CUSHION_H + 0.004;
const FLOOR_Y = -0.79;

const toShape = (pts, ShapeCls = THREE.Shape) => new ShapeCls(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
const flat = (geo) => { geo.rotateX(-Math.PI / 2); return geo; };
// Static scenery is merged per material: every part sharing a material is one draw call (and one shadow draw per light).
const place = (geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => geo.applyMatrix4(new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
function merged(geos, mat, cast = false, receive = false) {
  const mixed = geos.some((g) => !g.index);
  const m = new THREE.Mesh(mergeGeometries(mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos), mat);
  m.castShadow = cast; m.receiveShadow = receive;
  return m;
}

// Visual-only rounding of the cushion jaw tips (the first two vertices of each cushion polygon); physics keeps the sharp polygon.
function roundVerts(poly, which, rad, seg = 5) {
  const n = poly.length, out = [];
  poly.forEach((v, i) => {
    if (!which.includes(i)) { out.push(v); return; }
    const a = poly[(i + n - 1) % n], b = poly[(i + 1) % n];
    const da = Math.hypot(a[0] - v[0], a[1] - v[1]), db = Math.hypot(b[0] - v[0], b[1] - v[1]);
    const t = Math.min(rad, da * 0.45, db * 0.45);
    const p0 = [v[0] + ((a[0] - v[0]) / da) * t, v[1] + ((a[1] - v[1]) / da) * t];
    const p1 = [v[0] + ((b[0] - v[0]) / db) * t, v[1] + ((b[1] - v[1]) / db) * t];
    for (let k = 0; k <= seg; k++) {
      const u = k / seg, w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
      out.push([w0 * p0[0] + w1 * v[0] + w2 * p1[0], w0 * p0[1] + w1 * v[1] + w2 * p1[1]]);
    }
  });
  return out;
}

// Pocket shaft wall: a vertical strip on the circle of radius r around (cx, cz), from angle a1 sweeping `delta`, between the y levels in
// `ys` (top to bottom). `lum` gives each level's brightness, so the shaft fades from dark leather into black as it drops away.
function shaftGeometry(cx, cz, r, a1, delta, ys, lum, steps = 32) {
  const pos = [], col = [], idx = [];
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i <= steps; i++) {
      const t = a1 + (delta * i) / steps;
      pos.push(cx + Math.cos(t) * r, ys[j], cz + Math.sin(t) * r);
      col.push(lum[j], lum[j] * 0.82, lum[j] * 0.7);
    }
  }
  for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < steps; i++) {
    const a = j * (steps + 1) + i, b = a + 1, c = a + steps + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

function canvasTex(w, h, draw, repeat = [1, 1], srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noiseFill(ctx, w, h, base, amp, seed = 1) {
  const img = ctx.createImageData(w, h);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < w * h; i++) {
    const n = (rnd() - 0.5) * amp;
    img.data[i * 4] = base[0] + n; img.data[i * 4 + 1] = base[1] + n; img.data[i * 4 + 2] = base[2] + n; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Plain-weave threads (8 px each, 64 per tile) over a fuzz of loose fibres: height drives parallax, normals and cavity AO.
function weaveSurface() {
  const N = 512, T = 8, h = new Float32Array(N * N), r = new Float32Array(N * N);
  let s = 5; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const warp = Math.sin(Math.PI * ((x % T) / T)), weft = Math.sin(Math.PI * ((y % T) / T));
    const over = (((x / T) | 0) + ((y / T) | 0)) & 1;
    const f = rnd();
    h[y * N + x] = 0.25 + 0.55 * (over ? 0.7 * warp + 0.3 * weft : 0.7 * weft + 0.3 * warp) + 0.2 * f;
    r[y * N + x] = 0.47 + 0.05 * f;
  }
  return surfaceTexture(N, N, h, r, 1.2);
}

function clothMaterial(color) {
  const map = canvasTex(256, 256, (ctx, w, h) => {
    noiseFill(ctx, w, h, [225, 225, 225], 22, 7);
    // faint weave
    ctx.globalAlpha = 0.05;
    for (let y = 0; y < h; y += 2) { ctx.fillStyle = y % 4 ? '#fff' : '#000'; ctx.fillRect(0, y, w, 1); }
  }, [14, 14]);
  return patchMaterial(new THREE.MeshStandardMaterial({ color, map, roughness: 0.94, metalness: 0, envMapIntensity: 0.15 }),
    { surf: weaveSurface(), depth: 0.0008, phong: [0.012, 12] });
}

function woodMaterial() {
  const map = canvasTex(1024, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3a160b'); g.addColorStop(0.5, '#4f1f0f'); g.addColorStop(1, '#341309');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 260; i++) {
      const y = rnd() * h, amp = 2 + rnd() * 10, f = 0.002 + rnd() * 0.01, ph = rnd() * 6;
      ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '20,6,2' : '110,48,22'},${0.08 + rnd() * 0.18})`;
      ctx.lineWidth = 0.5 + rnd() * 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, y + Math.sin(x * f + ph) * amp);
      ctx.stroke();
    }
  }, [1.5, 3]);
  // grain lines are pores: lower, rougher, and they shape the base normal under the varnish
  const h = lumaHeight(map.image, 10, 75), r = h.map((v) => 0.4 + (1 - v) * 0.3);
  return patchMaterial(new THREE.MeshPhysicalMaterial({ map, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.35 }),
    { surf: surfaceTexture(map.image.width, map.image.height, h, r, 1.2), depth: 0.0006, phong: [0.08, 70] });
}

export function buildTable(scene, clothColor = 0x1d6b40) {
  const group = new THREE.Group();
  const cloth = clothMaterial(clothColor);
  const wood = woodMaterial();

  // Bed (slate + cloth) with pocket cut-outs
  const bedShape = toShape(boundaryOutline(true));
  const bed = new THREE.Mesh(flat(new THREE.ExtrudeGeometry(bedShape, { depth: 0.03, bevelEnabled: false })), cloth);
  bed.position.y = BED_TOP - 0.03;
  bed.receiveShadow = true;
  group.add(bed);

  // Cushions (cloth-covered rubber), with a softened top edge
  group.add(merged(cushions.map((c) => flat(new THREE.ExtrudeGeometry(toShape(roundVerts(c, [0, 1], 0.008)), {
      depth: CUSHION_H - 0.004, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.0035, bevelOffset: -0.0035, bevelSegments: 3,
    }))), cloth, true, true));

  // Wood rails
  const X = HL + CW + RAIL_W, Z = HW + CW + RAIL_W;
  const railShape = toShape([[-X, -Z], [X, -Z], [X, Z], [-X, Z]]);
  railShape.holes.push(toShape(boundaryOutline(false), THREE.Path));
  const railDepth = RAIL_TOP + 0.07 - 0.008;
  const woodGeos = [flat(new THREE.ExtrudeGeometry(railShape, {
    depth: railDepth, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 4, curveSegments: 24,
  })).translate(0, -0.07, 0)];

  // Diamond sights (mother of pearl)
  const pearl = new THREE.MeshPhysicalMaterial({ color: 0xf4efe4, roughness: 0.25, clearcoat: 1, iridescence: 0.6, iridescenceIOR: 1.6 });
  const dGeo = new THREE.CylinderGeometry(1, 1, 0.002, 4);
  const mid = CW + RAIL_W * 0.5;
  const diamonds = [];
  const addDiamond = (x, z, rotY) => diamonds.push(place(dGeo.clone(), x, RAIL_TOP + 0.0045, z, 0, rotY, 0, 0.009, 1, 0.0055));
  for (let k = -3; k <= 3; k++) if (k !== 0) for (const s of [-1, 1]) addDiamond((k * L) / 8, s * (HW + mid), 0);
  for (let k = -1; k <= 1; k++) for (const s of [-1, 1]) addDiamond(s * (HL + mid), (k * W) / 4, Math.PI / 2);
  group.add(merged(diamonds, pearl));

  // Pockets: a real shaft through the rail and the apron. The wall is lined with dark leather that falls away to black, and a
  // leather lip follows the back of each opening exactly (the same arc the wood rail is cut with).
  const SHAFT_BOTTOM = -0.262;
  const shaftMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const lipMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1310, roughness: 0.42, clearcoat: 0.5 });
  const TOP = RAIL_TOP + 0.0015;
  const shafts = [], lips = [];
  for (const { p, a1, delta } of pocketRims()) {
    const r = p.r - 0.0015; // just inside the cut, so the liner sits in front of the wood and cloth edge
    // behind the table: the rail's cut wall, from the rail top to the underside of the bed
    shafts.push(shaftGeometry(p.x, p.z, r, a1, delta, [TOP, 0, -0.03], [0.07, 0.045, 0.02]));
    // below the bed: the full round shaft, down to its black floor
    shafts.push(shaftGeometry(p.x, p.z, r, 0, Math.PI * 2, [-0.03, -0.09, -0.17, SHAFT_BOTTOM], [0.02, 0.008, 0.002, 0]));
    // black floor, as a shaft "wall" of zero radius at the bottom: same attributes, so it merges with the shafts
    shafts.push(shaftGeometry(p.x, p.z, r, 0, Math.PI * 2, [SHAFT_BOTTOM + 0.001], [0]).setIndex(Array.from({ length: 31 }, (_, i) => [0, i + 1, i + 2]).flat()));
    // leather lip lying on the rail top along the opening, with round ends
    const lipR = p.r + 0.004, tube = 0.0065;
    lips.push(place(new THREE.TorusGeometry(lipR, tube, 10, 48, Math.abs(delta)), p.x, RAIL_TOP + 0.0005, p.z, Math.PI / 2, 0, Math.min(a1, a1 + delta)));
    for (const t of [a1, a1 + delta]) lips.push(new THREE.SphereGeometry(tube, 10, 8).translate(p.x + Math.cos(t) * lipR, RAIL_TOP + 0.0005, p.z + Math.sin(t) * lipR));
  }
  group.add(merged(shafts, shaftMat), merged(lips, lipMat, true));

  // Body: apron (open over each pocket, so the shafts really go down), legs
  const circle = (p, n = 40) => Array.from({ length: n }, (_, i) => [p.x + Math.cos((i / n) * Math.PI * 2) * p.r, p.z + Math.sin((i / n) * Math.PI * 2) * p.r]);
  const apronShape = toShape([[-(X - 0.03), -(Z - 0.03)], [X - 0.03, -(Z - 0.03)], [X - 0.03, Z - 0.03], [-(X - 0.03), Z - 0.03]]);
  for (const p of pockets) apronShape.holes.push(toShape(circle(p), THREE.Path));
  woodGeos.push(flat(new THREE.ExtrudeGeometry(apronShape, { depth: 0.2, bevelEnabled: false })).translate(0, -0.27, 0));
  const legGeo = new THREE.CylinderGeometry(0.075, 0.06, FLOOR_Y * -1 - 0.27, 24);
  for (const lx of [-(X - 0.2), 0, X - 0.2]) for (const sz of [-1, 1]) {
    woodGeos.push(legGeo.clone().translate(lx, (FLOOR_Y - 0.27) / 2, sz * (Z - 0.17)));
  }
  group.add(merged(woodGeos, wood, true, true));

  scene.add(group);
  return { group, cloth };
}

export function buildRoom(scene) {
  const floorTex = canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#1a110c'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(0,0,0,0.12)' : 'rgba(255,220,180,0.04)';
      ctx.fillRect(0, (i * h) / 8, w, h / 8 - 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, ((i + 1) * h) / 8 - 2, w, 2);
    }
  }, [6, 6]);
  const floor = new THREE.Mesh(flat(new THREE.PlaneGeometry(14, 14)), patchMaterial(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.6, metalness: 0 }),
    (() => { const h = lumaHeight(floorTex.image, 8, 14); return { surf: surfaceTexture(512, 512, h, h.map((v) => 0.8 - v * 0.3), 2), depth: 0.005 }; })()));
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);

  // Room box: its bottom face is sunk 0.2 m below the floor. If it sits at FLOOR_Y it is coplanar with
  // the floor plane and z-fights (shimmering stripes across the far floor).
  const walls = new THREE.Mesh(new THREE.BoxGeometry(14, 4.2, 14), new THREE.MeshStandardMaterial({ color: 0x241612, roughness: 0.9, side: THREE.BackSide }));
  walls.position.y = FLOOR_Y + 1.9;
  scene.add(walls);

  // Billiard lamp: long hood with three shades
  const lampY = 1.0;
  const lamp = new THREE.Group();
  const metal = new THREE.MeshPhysicalMaterial({ color: 0x0f3a24, roughness: 0.35, metalness: 0.6, clearcoat: 0.5 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a3e, roughness: 0.3, metalness: 1 });
  const brassGeos = [new THREE.BoxGeometry(1.9, 0.03, 0.05).translate(0, lampY + 0.14, 0)];
  for (const sx of [-0.8, 0.8]) brassGeos.push(new THREE.CylinderGeometry(0.006, 0.006, 2).translate(sx, lampY + 1.15, 0));
  lamp.add(merged(brassGeos, brass));
  metal.side = THREE.DoubleSide;
  const shades = [], bulbs = [], diffusers = [];
  const lights = [];
  for (const x of [-0.75, 0, 0.75]) {
    shades.push(new THREE.CylinderGeometry(0.07, 0.26, 0.2, 40, 1, true).translate(x, lampY + 0.04, 0));
    bulbs.push(new THREE.SphereGeometry(0.045, 20, 12).translate(x, lampY - 0.01, 0));
    diffusers.push(flat(new THREE.CircleGeometry(0.255, 40)).translate(x, lampY - 0.06, 0));
    const s = new THREE.SpotLight(0xfff0dc, 6, 4, Math.PI * 0.31, 0.85, 1.7);
    s.position.set(x, lampY - 0.03, 0);
    s.target.position.set(x, 0, 0);
    s.castShadow = true;
    s.shadow.mapSize.set(1536, 1536); s.shadow.focus = 0.92;
    s.shadow.camera.near = 0.3; s.shadow.camera.far = 3;
    s.shadow.bias = -0.0004;
    s.shadow.radius = 3; // penumbra half-width in shadow-map texels (see patchShadowFilter)
    scene.add(s, s.target);
    lights.push(s);
  }
  lamp.add(merged(shades, metal), merged(bulbs, new THREE.MeshBasicMaterial({ color: 0xfff1d6 })),
    merged(diffusers, new THREE.MeshBasicMaterial({ color: 0xffe9c4, transparent: true, opacity: 0.18, side: THREE.DoubleSide })));
  scene.add(lamp);

  scene.add(new THREE.HemisphereLight(0xffe8d0, 0x1a0f0a, 0.12));
  return { lights, lamp };
}
