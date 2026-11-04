import * as THREE from 'three';

// Post pipeline: scene -> 4x MSAA HDR target (+ resolved depth) -> XeGTAO at half resolution -> depth-aware blur -> composite
// (AO, ACES tone map and sRGB encode in one pass). A port of Intel's XeGTAO main pass (horizon search over 2 slices x 3 steps
// per side, thin-falloff weighting, cosine-weighted analytic integral); normals are rebuilt from depth, so there is no normal
// pre-pass, and the half-res linear-depth pre-filter plays the role of XeGTAO's depth MIP chain.
const VERT = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const HEAD = 'uniform sampler2D tDepth, tZ, tAO, tScene; uniform vec2 pr, pz, res, dir; uniform float radius, power, strength;\n';
const FETCH = /* glsl */`
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float Z(vec2 p) { return texelFetch(tZ, clamp(ivec2(p), ivec2(0), ivec2(res) - 1), 0).x; }
vec3 VP(vec2 p) { return vec3(((p + 0.5) / res * 2.0 - 1.0) * Z(p) / pr, Z(p)); }`;

const FRAG_Z = HEAD + `void main() {
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy) * 2, 0).x;
  gl_FragColor = vec4(pz.y / (d * 2.0 - 1.0 + pz.x), 0.0, 0.0, 1.0);
}`;

const FRAG_AO = HEAD + FETCH + /* glsl */`
#define SLICES 2
#define STEPS 3
void main() {
  vec2 ip = floor(gl_FragCoord.xy);
  vec3 P = VP(ip);
  float ssr = min(radius * pr.x * res.x * 0.5 / P.z, 60.0);
  if (ssr < 1.3) { gl_FragColor = vec4(1.0, P.z, 0.0, 1.0); return; }
  // view-space normal from the smaller depth difference on each axis
  vec3 l = VP(ip + vec2(-1, 0)), r = VP(ip + vec2(1, 0)), d = VP(ip + vec2(0, -1)), u = VP(ip + vec2(0, 1));
  vec3 N = normalize(cross(abs(l.z - P.z) < abs(r.z - P.z) ? P - l : r - P, abs(d.z - P.z) < abs(u.z - P.z) ? P - d : u - P));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;
  float n1 = ign(ip), n2 = fract(sin(dot(ip, vec2(12.9898, 78.233))) * 43758.5453);
  float fr = 0.615 * radius, fm = -1.0 / fr, fa = radius * (1.0 - 0.615) / fr + 1.0, minS = 1.3 / ssr, vis = 0.0;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + n1) / float(SLICES) * 3.14159265;
    vec2 om = vec2(cos(phi), sin(phi));
    vec3 dv = vec3(om, 0.0), ortho = dv - dot(dv, V) * V, axis = normalize(cross(ortho, V));
    vec3 pn = N - axis * dot(N, axis);
    float pnl = length(pn), cosN = clamp(dot(pn, V) / pnl, 0.0, 1.0);
    float n = sign(dot(ortho, pn)) * acos(cosN);
    float lh0 = cos(n + 1.5707963), lh1 = cos(n - 1.5707963), hc0 = lh0, hc1 = lh1;
    for (int k = 0; k < STEPS; k++) {
      float t = (float(k) + fract(n2 + float(s + k * SLICES) * 0.6180339887)) / float(STEPS);
      vec2 off = round((t * t + minS) * ssr * om);
      vec3 d0 = VP(ip + off) - P, d1 = VP(ip - off) - P;
      float l0 = length(d0), l1 = length(d1);
      hc0 = max(hc0, mix(lh0, dot(d0, V) / l0, clamp(l0 * fm + fa, 0.0, 1.0)));
      hc1 = max(hc1, mix(lh1, dot(d1, V) / l1, clamp(l1 * fm + fa, 0.0, 1.0)));
    }
    pnl = mix(pnl, 1.0, 0.05);
    float h0 = n + clamp(-acos(clamp(hc1, -1.0, 1.0)) - n, -1.5707963, 1.5707963);
    float h1 = n + clamp(acos(clamp(hc0, -1.0, 1.0)) - n, -1.5707963, 1.5707963);
    vis += pnl * ((cosN + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) + (cosN + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n))) * 0.25;
  }
  gl_FragColor = vec4(max(pow(clamp(vis / float(SLICES), 0.0, 1.0), power), 0.03), P.z, 0.0, 1.0);
}`;

const FRAG_BLUR = HEAD + /* glsl */`
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy), hi = ivec2(res) - 1;
  vec2 c = texelFetch(tAO, ip, 0).xy;
  float sum = c.x * 0.2, wsum = 0.2;
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    vec2 s = texelFetch(tAO, clamp(ip + ivec2(dir) * i, ivec2(0), hi), 0).xy;
    float w = (0.2 - 0.04 * abs(float(i))) * clamp(1.0 - abs(s.y - c.y) / (0.06 * c.y), 0.0, 1.0);
    sum += s.x * w; wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, c.y, 0.0, 1.0);
}`;

const FRAG_OUT = HEAD + /* glsl */`
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec3 col = texelFetch(tScene, ip, 0).rgb;
  if (strength > 0.0) {
    float z = pz.y / (texelFetch(tDepth, ip, 0).x * 2.0 - 1.0 + pz.x);
    vec2 q = gl_FragCoord.xy * 0.5 - 0.5, f = fract(q);
    ivec2 b = ivec2(floor(q)), hi = ivec2(res) - 1;
    float sum = 0.0, wsum = 1e-4;
    for (int i = 0; i < 4; i++) { // bilateral upsample: bilinear weights, rejected across depth edges
      vec2 o = vec2(i & 1, i >> 1);
      vec2 s = texelFetch(tAO, clamp(b + ivec2(o), ivec2(0), hi), 0).xy;
      float w = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y) * (1e-3 + clamp(1.0 - abs(s.y - z) / (0.05 * z), 0.0, 1.0));
      sum += s.x * w; wsum += w;
    }
    col *= mix(1.0, sum / wsum, strength);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createPost(renderer) {
  if (!renderer.extensions.has('EXT_color_buffer_float')) return null; // HDR MSAA target needs it; caller falls back to direct rendering
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mk = (frag, u) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: u, depthTest: false, depthWrite: false });
  const tex = (v = null) => ({ value: v });
  const U = { tDepth: tex(), tZ: tex(), tAO: tex(), tScene: tex(), pr: tex(new THREE.Vector2()), pz: tex(new THREE.Vector2()), res: tex(new THREE.Vector2()),
    dir: tex(new THREE.Vector2()), radius: tex(0.11), power: tex(1.8), strength: tex(0) };
  const matZ = mk(FRAG_Z, U), matAO = mk(FRAG_AO, U), matBlur = mk(FRAG_BLUR, U), matOut = mk(FRAG_OUT, U);
  const quad = new THREE.Mesh(geo, matZ);
  quad.frustumCulled = false;
  const pscene = new THREE.Scene(); pscene.add(quad);
  const pcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const opts = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1) });
  const zRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, type: THREE.FloatType, format: THREE.RedFormat });
  const aoA = new THREE.WebGLRenderTarget(1, 1, { ...opts, type: THREE.HalfFloatType });
  const aoB = aoA.clone();
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(pscene, pcam); };

  return {
    setSize(w, h) {
      const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
      sceneRT.setSize(w, h); zRT.setSize(hw, hh); aoA.setSize(hw, hh); aoB.setSize(hw, hh);
      U.res.value.set(hw, hh);
    },
    render(scene, camera, ao) {
      const p = camera.projectionMatrix.elements;
      U.pr.value.set(p[0], p[5]); U.pz.value.set(p[10], p[14]);
      sceneRT.resolveDepthBuffer = ao; // the depth copy is only needed by AO
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      if (ao) {
        U.tDepth.value = sceneRT.depthTexture;
        pass(matZ, zRT); U.tZ.value = zRT.texture;
        pass(matAO, aoA);
        U.tAO.value = aoA.texture; U.dir.value.set(1, 0); pass(matBlur, aoB);
        U.tAO.value = aoB.texture; U.dir.value.set(0, 1); pass(matBlur, aoA);
        U.tAO.value = aoA.texture;
      }
      U.strength.value = ao ? 0.9 : 0;
      U.tScene.value = sceneRT.texture;
      pass(matOut, null);
    },
  };
}
