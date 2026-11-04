import * as THREE from 'three';
import { HL, HW, L, W, R } from './constants.js';
import { CW, RAIL_W, CUSHION_H, cushions, pockets, boundaryOutline, pocketRims } from './table-geom.js';

export const BED_TOP = 0;
const RAIL_TOP = CUSHION_H + 0.004;
const FLOOR_Y = -0.79;

const toShape = (pts, ShapeCls = THREE.Shape) => new ShapeCls(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
const flat = (geo) => { geo.rotateX(-Math.PI / 2); return geo; };

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

function clothMaterial(color) {
  const map = canvasTex(256, 256, (ctx, w, h) => {
    noiseFill(ctx, w, h, [225, 225, 225], 22, 7);
    // faint weave
    ctx.globalAlpha = 0.05;
    for (let y = 0; y < h; y += 2) { ctx.fillStyle = y % 4 ? '#fff' : '#000'; ctx.fillRect(0, y, w, 1); }
  }, [14, 7]);
  const bump = canvasTex(256, 256, (ctx, w, h) => noiseFill(ctx, w, h, [128, 128, 128], 90, 3), [28, 14], false);
  return new THREE.MeshStandardMaterial({ color, map, bumpMap: bump, bumpScale: 0.4, roughness: 0.94, metalness: 0, envMapIntensity: 0.15 });
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
  return new THREE.MeshPhysicalMaterial({ map, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.35 });
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
  for (const c of cushions) {
    const geo = flat(new THREE.ExtrudeGeometry(toShape(roundVerts(c, [0, 1], 0.008)), {
      depth: CUSHION_H - 0.004, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.0035, bevelOffset: -0.0035, bevelSegments: 3,
    }));
    const m = new THREE.Mesh(geo, cloth);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }

  // Wood rails
  const X = HL + CW + RAIL_W, Z = HW + CW + RAIL_W;
  const railShape = toShape([[-X, -Z], [X, -Z], [X, Z], [-X, Z]]);
  railShape.holes.push(toShape(boundaryOutline(false), THREE.Path));
  const railDepth = RAIL_TOP + 0.07 - 0.008;
  const rails = new THREE.Mesh(flat(new THREE.ExtrudeGeometry(railShape, {
    depth: railDepth, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 4, curveSegments: 24,
  })), wood);
  rails.position.y = -0.07;
  rails.castShadow = true; rails.receiveShadow = true;
  group.add(rails);

  // Diamond sights (mother of pearl)
  const pearl = new THREE.MeshPhysicalMaterial({ color: 0xf4efe4, roughness: 0.25, clearcoat: 1, iridescence: 0.6, iridescenceIOR: 1.6 });
  const dGeo = new THREE.CylinderGeometry(1, 1, 0.002, 4);
  const mid = CW + RAIL_W * 0.5;
  const addDiamond = (x, z, rotY) => {
    const d = new THREE.Mesh(dGeo, pearl);
    d.scale.set(0.009, 1, 0.0055);
    d.rotation.y = rotY;
    d.position.set(x, RAIL_TOP + 0.0045, z);
    group.add(d);
  };
  for (let k = -3; k <= 3; k++) if (k !== 0) for (const s of [-1, 1]) addDiamond((k * L) / 8, s * (HW + mid), 0);
  for (let k = -1; k <= 1; k++) for (const s of [-1, 1]) addDiamond(s * (HL + mid), (k * W) / 4, Math.PI / 2);

  // Pockets: a real shaft through the rail and the apron. The wall is lined with dark leather that falls away to black, and a
  // leather lip follows the back of each opening exactly (the same arc the wood rail is cut with).
  const SHAFT_BOTTOM = -0.262;
  const shaftMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const lipMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1310, roughness: 0.42, clearcoat: 0.5 });
  const TOP = RAIL_TOP + 0.0015;
  for (const { p, a1, delta } of pocketRims()) {
    const r = p.r - 0.0015; // just inside the cut, so the liner sits in front of the wood and cloth edge
    // behind the table: the rail's cut wall, from the rail top to the underside of the bed
    group.add(new THREE.Mesh(shaftGeometry(p.x, p.z, r, a1, delta, [TOP, 0, -0.03], [0.07, 0.045, 0.02]), shaftMat));
    // below the bed: the full round shaft, down to its black floor
    group.add(new THREE.Mesh(shaftGeometry(p.x, p.z, r, 0, Math.PI * 2, [-0.03, -0.09, -0.17, SHAFT_BOTTOM], [0.02, 0.008, 0.002, 0]), shaftMat));
    const floor = new THREE.Mesh(flat(new THREE.CircleGeometry(r, 32)), floorMat);
    floor.position.set(p.x, SHAFT_BOTTOM + 0.001, p.z);
    group.add(floor);
    // leather lip lying on the rail top along the opening, with round ends
    const lipR = p.r + 0.004, tube = 0.0065;
    const lip = new THREE.Mesh(new THREE.TorusGeometry(lipR, tube, 10, 48, Math.abs(delta)), lipMat);
    lip.rotation.x = Math.PI / 2;
    lip.rotation.z = Math.min(a1, a1 + delta);
    lip.position.set(p.x, RAIL_TOP + 0.0005, p.z);
    lip.castShadow = true;
    group.add(lip);
    for (const t of [a1, a1 + delta]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(tube, 10, 8), lipMat);
      cap.position.set(p.x + Math.cos(t) * lipR, RAIL_TOP + 0.0005, p.z + Math.sin(t) * lipR);
      group.add(cap);
    }
  }

  // Body: apron (open over each pocket, so the shafts really go down), legs
  const bodyMat = wood;
  const circle = (p, n = 40) => Array.from({ length: n }, (_, i) => [p.x + Math.cos((i / n) * Math.PI * 2) * p.r, p.z + Math.sin((i / n) * Math.PI * 2) * p.r]);
  const apronShape = toShape([[-(X - 0.03), -(Z - 0.03)], [X - 0.03, -(Z - 0.03)], [X - 0.03, Z - 0.03], [-(X - 0.03), Z - 0.03]]);
  for (const p of pockets) apronShape.holes.push(toShape(circle(p), THREE.Path));
  const apron = new THREE.Mesh(flat(new THREE.ExtrudeGeometry(apronShape, { depth: 0.2, bevelEnabled: false })), bodyMat);
  apron.position.y = -0.27;
  apron.castShadow = true;
  group.add(apron);
  const legGeo = new THREE.CylinderGeometry(0.075, 0.06, FLOOR_Y * -1 - 0.27, 24);
  for (const lx of [-(X - 0.2), 0, X - 0.2]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.set(lx, (FLOOR_Y - 0.27) / 2, sz * (Z - 0.17));
    leg.castShadow = true;
    group.add(leg);
  }

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
  const floor = new THREE.Mesh(flat(new THREE.PlaneGeometry(14, 14)), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.6, metalness: 0 }));
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
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.03, 0.05), brass);
  bar.position.y = lampY + 0.14;
  lamp.add(bar);
  for (const sx of [-0.8, 0.8]) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 2), brass);
    rod.position.set(sx, lampY + 1.15, 0);
    lamp.add(rod);
  }
  const lights = [];
  for (const x of [-0.75, 0, 0.75]) {
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.26, 0.2, 40, 1, true), metal);
    shade.position.set(x, lampY + 0.04, 0);
    shade.material.side = THREE.DoubleSide;
    lamp.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 12), new THREE.MeshBasicMaterial({ color: 0xfff1d6 }));
    bulb.position.set(x, lampY - 0.01, 0);
    lamp.add(bulb);
    const diffuser = new THREE.Mesh(flat(new THREE.CircleGeometry(0.255, 40)), new THREE.MeshBasicMaterial({ color: 0xffe9c4, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
    diffuser.position.set(x, lampY - 0.06, 0);
    lamp.add(diffuser);
    const s = new THREE.SpotLight(0xfff0dc, 6, 4, Math.PI * 0.31, 0.85, 1.7);
    s.position.set(x, lampY - 0.03, 0);
    s.target.position.set(x, 0, 0);
    s.castShadow = true;
    s.shadow.mapSize.set(1024, 1024);
    s.shadow.camera.near = 0.3; s.shadow.camera.far = 3;
    s.shadow.bias = -0.0004;
    s.shadow.radius = 4;
    scene.add(s, s.target);
    lights.push(s);
  }
  scene.add(lamp);

  scene.add(new THREE.HemisphereLight(0xffe8d0, 0x1a0f0a, 0.12));
  return { lights, lamp };
}
