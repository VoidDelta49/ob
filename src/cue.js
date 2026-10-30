import * as THREE from 'three';

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
  let y = 0;
  for (const s of sections) {
    const geo = new THREE.CylinderGeometry(s.r1, s.r0, s.len, 28, 1);
    geo.translate(0, y + s.len / 2, 0);
    // transparent (opacity 1 normally) so the cue can fade in/out without a material/program switch
    const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ ...s.mat, transparent: true }));
    m.castShadow = true;
    group.add(m);
    y += s.len;
  }
  const tipMat = group.children[0].material;
  const leather = new THREE.Color(0x6b4a2f), chalkBlue = new THREE.Color(0x2f62b8);
  group.userData.setChalk = (c) => tipMat.color.copy(leather).lerp(chalkBlue, Math.max(0, Math.min(1, c)));
  let op = 1;
  group.userData.setOpacity = (o) => {
    if (o === op) return;
    op = o;
    group.traverse((m) => { if (m.isMesh) { m.material.opacity = o; m.material.depthWrite = o > 0.6; m.castShadow = o > 0.5; } });
  };
  return group;
}
