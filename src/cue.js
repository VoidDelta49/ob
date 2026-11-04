import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Two-piece cue, built tip-first along +Y. Total ≈ 1.47 m.
export function createCue() {
  const group = new THREE.Group();
  const sections = [
    { len: 0.011, r0: 0.0064, r1: 0.0064, mat: { color: 0x6b4a2f, roughness: 0.95 } },              // leather tip (tinted by chalk)
    { len: 0.022, r0: 0.0064, r1: 0.0066, mat: { color: 0xf3efe6, roughness: 0.3 } },               // ferrule
    { len: 0.70, r0: 0.0066, r1: 0.0106, mat: { color: 0xe2c690, roughness: 0.35, clearcoat: 0.6 } }, // maple shaft
    { len: 0.018, r0: 0.0109, r1: 0.0109, mat: { color: 0xc9c9c9, roughness: 0.2, metalness: 1 } },   // joint
    { len: 0.38, r0: 0.0110, r1: 0.0131, mat: { color: 0x2a120a, roughness: 0.25, clearcoat: 1 } },  // forearm
    { len: 0.012, r0: 0.0132, r1: 0.0132, mat: { color: 0xb08a3e, roughness: 0.3, metalness: 1 } },   // ring
    { len: 0.25, r0: 0.0133, r1: 0.0139, mat: { color: 0x161616, roughness: 0.85 } },                // wrap
    { len: 0.012, r0: 0.0139, r1: 0.0139, mat: { color: 0xb08a3e, roughness: 0.3, metalness: 1 } },   // ring
    { len: 0.07, r0: 0.0140, r1: 0.0146, mat: { color: 0x5a1610, roughness: 0.25, clearcoat: 1 } },  // butt sleeve
    { len: 0.01, r0: 0.0146, r1: 0.0138, mat: { color: 0x0a0a0a, roughness: 0.7 } },                 // bumper
  ];
  // One merged mesh: colour and roughness / metalness / clearcoat are per-vertex attributes, so the whole cue is
  // a single draw call (and a single shadow draw per light) instead of ten.
  const geos = [];
  let y = 0;
  for (const s of sections) {
    const geo = new THREE.CylinderGeometry(s.r1, s.r0, s.len, 28, 1);
    geo.translate(0, y + s.len / 2, 0);
    const n = geo.attributes.position.count, c = new THREE.Color(s.mat.color);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
    geo.setAttribute('pbr', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [s.mat.roughness, s.mat.metalness || 0, s.mat.clearcoat || 0]).flat(), 3));
    geos.push(geo);
    y += s.len;
  }
  const tipVerts = geos[0].attributes.position.count;
  // transparent (opacity 1 normally) so the cue can fade in/out without a material/program switch
  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, clearcoat: 1, transparent: true });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 pbr;\nvarying vec3 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPbr;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = vPbr.z;');
  };
  const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
  mesh.castShadow = true;
  group.add(mesh);
  const col = mesh.geometry.attributes.color;
  const leather = new THREE.Color(0x6b4a2f), chalkBlue = new THREE.Color(0x2f62b8), tint = new THREE.Color();
  let chalk = -1;
  group.userData.setChalk = (c) => {
    c = Math.max(0, Math.min(1, c));
    if (c === chalk) return;
    chalk = c;
    tint.copy(leather).lerp(chalkBlue, c);
    for (let i = 0; i < tipVerts; i++) col.setXYZ(i, tint.r, tint.g, tint.b); // the tip's vertices come first
    col.needsUpdate = true;
  };
  let op = 1;
  group.userData.setOpacity = (o) => {
    if (o === op) return;
    op = o;
    mat.opacity = o; mat.depthWrite = o > 0.6; mesh.castShadow = o > 0.5;
  };
  group.userData.key = () => chalk + op * 2; // anything that changes how the cue looks
  return group;
}
