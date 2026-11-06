import * as THREE from 'three';

// Post pipeline: scene -> 4x MSAA HDR target (+ resolved depth) -> XeGTAO at half resolution -> depth-aware blur -> composite
// (AO, ACES tone map and sRGB encode in one pass). A port of Intel's XeGTAO main pass (horizon search over 2 slices x 3 steps
// per side, thin-falloff weighting, cosine-weighted analytic integral); normals are rebuilt from depth, so there is no normal
// pre-pass, and the half-res linear-depth pre-filter plays the role of XeGTAO's depth MIP chain.
//
// High also adds screen-space ray-traced diffuse GI (SSRT-GI, see the GI section below): the AO pass stores its depth-rebuilt
// normal, a sibling pass marches 1-2 cosine-weighted rays per pixel through the half-res depth at half (desktop) or quarter
// (phone) resolution and fetches the radiance of whatever they hit from this frame's HDR colour, a temporal pass reprojects and
// accumulates it, the AO blur (with a normal edge stop added) denoises it, and the composite upsamples it and adds GI x albedo
// (albedo from a second MSAA attachment of the scene pass) before tone mapping.
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
  // view-space normal from the smaller depth difference on each axis (kept in zw, octahedral, for the GI passes)
  vec3 l = VP(ip + vec2(-1, 0)), r = VP(ip + vec2(1, 0)), d = VP(ip + vec2(0, -1)), u = VP(ip + vec2(0, 1));
  vec3 N = normalize(cross(abs(l.z - P.z) < abs(r.z - P.z) ? P - l : r - P, abs(d.z - P.z) < abs(u.z - P.z) ? P - d : u - P));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;
  vec2 oct = N.xy / (abs(N.x) + abs(N.y) + abs(N.z));
  if (N.z < 0.0) oct = (1.0 - abs(oct.yx)) * vec2(oct.x >= 0.0 ? 1.0 : -1.0, oct.y >= 0.0 ? 1.0 : -1.0);
  float ssr = min(radius * pr.x * res.x * 0.5 / P.z, 60.0);
  if (ssr < 1.3) { gl_FragColor = vec4(1.0, P.z, oct); return; }
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
  gl_FragColor = vec4(max(pow(clamp(vis / float(SLICES), 0.0, 1.0), power), 0.03), P.z, oct);
}`;

// Separable 7-tap bilateral blur. AO: blurs .x with .y as depth, carries the normal (zw) through. GI (#define GI): blurs .rgb of
// tGI at trace resolution with depth and normal edge stops read from the half-res buffers, and writes depth to .a for the upsample.
const FRAG_BLUR = HEAD + /* glsl */`
#ifdef GI
#define DIM gres
#define VT vec3
#define FETCHV(q) texelFetch(tGI, q, 0)
#define VAL(s) s.rgb
#define DEPTH(s, q) GZ(q)
#else
#define DIM res
#define VT float
#define FETCHV(q) texelFetch(tAO, q, 0)
#define VAL(s) s.x
#define DEPTH(s, q) s.y
#endif
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy), hi = ivec2(DIM) - 1;
  vec4 c = FETCHV(ip);
  float cz = DEPTH(c, ip);
  VT sum = VAL(c) * 0.2; float wsum = 0.2;
#ifdef GI
  vec3 cn = GN(ip);
#endif
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    ivec2 q = clamp(ip + ivec2(dir) * i, ivec2(0), hi);
    vec4 s = FETCHV(q);
    float w = (0.2 - 0.04 * abs(float(i))) * clamp(1.0 - abs(DEPTH(s, q) - cz) / (0.06 * cz), 0.0, 1.0);
#ifdef GI
    float nd = max(dot(GN(q), cn), 0.0); nd *= nd; nd *= nd; w *= nd * nd; // normal edge stop: cos^8
#endif
    sum += VAL(s) * w; wsum += w;
  }
#ifdef GI
  gl_FragColor = vec4(sum / wsum, cz);
#else
  gl_FragColor = vec4(sum / wsum, cz, c.zw);
#endif
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
#ifdef GI
  { // GI: the same depth-aware bilinear upsample from trace resolution (.a = depth), then GI x albedo added as HDR indirect
    // diffuse. It is not multiplied by AO: AO removes the ambient the occluders block, GI is the light those occluders bounce back.
    float z = pz.y / (texelFetch(tDepth, ip, 0).x * 2.0 - 1.0 + pz.x);
    vec2 q = gl_FragCoord.xy * gup - 0.5, f = fract(q);
    ivec2 b = ivec2(floor(q)), hi = ivec2(gres) - 1;
    vec3 sum = vec3(0.0), best = vec3(0.0); float wsum = 1e-5, bd = 1e9;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(i & 1, i >> 1);
      vec4 s = texelFetch(tGI, clamp(b + ivec2(o), ivec2(0), hi), 0);
      float e = abs(s.a - z), w = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y) * clamp(1.0 - e / (0.05 * z), 0.0, 1.0);
      sum += s.rgb * w; wsum += w;
      if (e < bd) { bd = e; best = s.rgb; }
    }
    // thin silhouettes (the cue) can have no trace texel on their own surface: take the closest depth rather than the background
    col += (wsum > 0.02 ? sum / wsum : best) * texelFetch(tAlb, ip, 0).rgb * gstr;
  }
#endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------- SSRT-GI (High only; these shaders and targets are created the first time GI is switched on) ----------
// Trace resolution (gres) is the half-res AO grid (gs = 1) or a quarter of full res (gs = 2); GZ / GN read the half-res depth and
// normal under a trace texel. Distances are metres in the post passes' view space (+z forward, see VP).
const GI_HEAD = /* glsl */`uniform sampler2D tGI, tHist, tZp, tAlb; uniform vec2 gres; uniform int gs; uniform float gframe, gsteps, grays, gdist,
  gstr, gup, gvalid, gclamp, gmax; uniform mat4 reproj;
ivec2 GH(ivec2 g) { return min(g * gs + gs / 2, ivec2(res) - 1); }
float GZ(ivec2 g) { return texelFetch(tZ, GH(g), 0).x; }
vec3 OCT(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return normalize(n);
}
vec3 GN(ivec2 g) { return OCT(texelFetch(tAO, GH(g), 0).zw); }
`;

// Trace: per trace texel, grays (1-2) cosine-weighted rays about the depth-rebuilt normal, each a jittered quadratic march of
// gsteps (4-12) steps out to gdist metres, tested against the half-res depth with a thickness that grows along the ray. A hit
// counts only if the surface found lies above the origin's tangent plane (no self-hits from depth quantisation on grazing cloth)
// and faces the ray; its radiance is this frame's resolved HDR colour (GI is composited after lighting, so the current frame is
// already lit and nothing lags behind a moving ball). Misses and rays leaving the screen add no light: the environment term they
// would have fetched is already in the lit image (AO scales it), so the GI here is only the near-field bounce on top of it.
const FRAG_GI = HEAD + FETCH + GI_HEAD + /* glsl */`
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy);
  vec2 hp = vec2(GH(g));
  vec3 P = VP(hp);
  if (P.z > pz.y / (1.0 + pz.x) * 0.95) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; } // background (far plane)
  vec3 N = GN(g);
  vec3 T = normalize(cross(N, abs(N.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0))), B = cross(N, T);
  vec3 O = P + N * (0.002 + 0.002 * P.z);
  vec3 acc = vec3(0.0);
  vec2 fp = vec2(g) + 5.588238 * gframe;
  for (int r = 0; r < 2; r++) {
    if (float(r) >= grays) break;
    float u1 = ign(fp + vec2(float(r) * 37.0, 0.0)), u2 = fract(ign(fp.yx + vec2(11.0, float(r) * 23.0)) + 0.7548777 * gframe);
    float j = fract(ign(fp + vec2(71.0, 3.0 + float(r))) + 0.5698403 * gframe);
    float sr = sqrt(u1), ph = 6.2831853 * u2;
    vec3 D = T * (sr * cos(ph)) + B * (sr * sin(ph)) + N * sqrt(1.0 - u1);
    for (int k = 0; k < 12; k++) {
      if (float(k) >= gsteps) break;
      float t = (float(k) + j) / gsteps; t = t * t * gdist + 0.004;
      vec3 Q = O + D * t;
      vec2 ndc = Q.xy * pr / Q.z;
      if (Q.z < 0.05 || abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) break; // left the screen: no hit
      vec2 sp = floor((ndc * 0.5 + 0.5) * res);
      float dz = Q.z - Z(sp);
      if (dz > 0.0 && dz < 0.05 + 0.25 * t) {
        vec3 H = VP(sp);
        if (dot(H - P, N) > 0.004 + 0.002 * P.z && dot(OCT(texelFetch(tAO, ivec2(sp), 0).zw), D) < 0.1) {
          vec3 L = textureLod(tScene, ndc * 0.5 + 0.5, 0.0).rgb;
          acc += L * min(1.0, 3.0 / max(max(L.r, L.g), max(L.b, 1e-4))); // clamp specular glints (fireflies)
        }
        break;
      }
    }
  }
  gl_FragColor = vec4(acc / grays, 1.0);
}`;

// Temporal: reproject the trace texel into the previous frame with the camera matrices, reject on a depth mismatch (moved balls,
// disocclusion), clip the history to the 3x3 neighbourhood mean +- gclamp sigma of this frame's raw trace (a ball moving past still
// cloth), then blend exponentially with weight 1/n, n = accumulated frame count capped at gmax (small while anything moves,
// larger for the extra frames run once the view is still). .a carries n.
const FRAG_GIT = HEAD + FETCH + GI_HEAD + /* glsl */`
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy), hi = ivec2(gres) - 1;
  vec3 cur = texelFetch(tGI, g, 0).rgb, m1 = vec3(0.0), m2 = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    vec3 c = texelFetch(tGI, clamp(g + ivec2(i % 3 - 1, i / 3 - 1), ivec2(0), hi), 0).rgb;
    m1 += c; m2 += c * c;
  }
  m1 /= 9.0;
  vec3 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec4 clip = reproj * vec4(VP(vec2(GH(g))), 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  vec3 h = cur; float n = 1.0;
  if (gvalid > 0.5 && clip.w > 0.0 && all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
    float zp = texelFetch(tZp, min(ivec2(uv * res), ivec2(res) - 1), 0).x;
    if (abs(zp - clip.w) < 0.03 * clip.w) {
      vec4 H = textureLod(tHist, uv, 0.0);
      h = clamp(H.rgb, m1 - gclamp * sd, m1 + gclamp * sd);
      n = min(H.a + 1.0, gmax);
    }
  }
  gl_FragColor = vec4(mix(h, cur, 1.0 / n), n);
}`;

// Programs only see the ShaderChunk text at compile time. setAlbedoOutput(true) (High) makes every built-in material also write
// its linear diffuse albedo to colour attachment 1; on a single-attachment target that write is discarded. main.js calls it
// before it flags the materials for recompile, and High's programs differ from Medium/Low's in their shadow-map type anyway,
// so they are never shared from the program cache.
const CHUNK = { pars: THREE.ShaderChunk.dithering_pars_fragment, out: THREE.ShaderChunk.opaque_fragment };
export function setAlbedoOutput(on) {
  THREE.ShaderChunk.dithering_pars_fragment = on ? '#define GI_ALBEDO\nlayout(location = 1) out highp vec4 gAlbedo;\n' + CHUNK.pars : CHUNK.pars;
  THREE.ShaderChunk.opaque_fragment = on ? CHUNK.out + '\n#ifdef GI_ALBEDO\ngAlbedo = diffuseColor;\n#endif\n' : CHUNK.out;
}

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
  let W = 1, H = 1;

  // ---- GI state, built on first use (High with GI on); Medium / Low never create these targets or compile these shaders ----
  let cfg = null, G = null;
  function buildGI() {
    const u = { ...U, tGI: tex(), tHist: tex(), tZp: tex(), tAlb: tex(), gres: tex(new THREE.Vector2()), gs: tex(1), gframe: tex(0), gsteps: tex(8),
      grays: tex(1), gdist: tex(0.35), gstr: tex(1), gup: tex(0.5), gvalid: tex(0), gclamp: tex(1.5), gmax: tex(6), reproj: tex(new THREE.Matrix4()) };
    const gi = (frag) => mk('#define GI\n' + frag.replace(HEAD, HEAD + GI_HEAD), u);
    const lin = { ...opts, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    const scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, count: 2, depthTexture: new THREE.DepthTexture(1, 1) });
    scene.textures[1].type = THREE.UnsignedByteType; // albedo: linear RGBA8 is plenty for a term this subtle
    const g = {
      u, scene, mTrace: mk(FRAG_GI, u), mTemporal: mk(FRAG_GIT, u), mBlur: gi(FRAG_BLUR), mOut: gi(FRAG_OUT),
      z: [zRT, zRT.clone()], hist: [new THREE.WebGLRenderTarget(1, 1, lin), new THREE.WebGLRenderTarget(1, 1, lin)],
      t1: new THREE.WebGLRenderTarget(1, 1, { ...opts, type: THREE.HalfFloatType }), t2: null,
      zi: 0, hi: 0, frame: 0, pending: 0, valid: false, view: new THREE.Matrix4(), proj: new THREE.Matrix4(),
    };
    g.t2 = g.t1.clone();
    return g;
  }
  function disposeGI() {
    if (!G) return;
    for (const t of [G.scene, G.z[1], ...G.hist, G.t1, G.t2]) t.dispose();
    for (const m of [G.mTrace, G.mTemporal, G.mBlur, G.mOut]) m.dispose();
    G = null;
  }
  function sizeGI() {
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2), gs = cfg.quarter ? 2 : 1, gw = Math.ceil(hw / gs), gh = Math.ceil(hh / gs);
    G.scene.setSize(W, H); G.z[1].setSize(hw, hh);
    for (const t of [...G.hist, G.t1, G.t2]) t.setSize(gw, gh);
    G.u.gres.value.set(gw, gh); G.u.gs.value = gs; G.u.gup.value = 0.5 / gs;
    G.valid = false; G.pending = 0;
  }
  const _m = new THREE.Matrix4(), FLIP = new THREE.Matrix4().makeScale(1, 1, -1);
  // trace -> temporal -> 2x blur, then the composite. `still`: an accumulation-only frame (nothing on screen changed).
  function runGI(camera, still) {
    const u = G.u;
    u.gframe.value = G.frame = (G.frame + 1) % 1024;
    u.gsteps.value = cfg.steps; u.grays.value = cfg.rays; u.gstr.value = cfg.strength ?? 1;
    u.gvalid.value = G.valid ? 1 : 0;
    u.gclamp.value = still ? 6 : 1.5; u.gmax.value = still ? 16 : 6;
    // previous-frame clip from this frame's flipped view space: prevProj * prevView * camWorld * flip(z)
    u.reproj.value.multiplyMatrices(G.proj, G.view).multiply(_m.multiplyMatrices(camera.matrixWorld, FLIP));
    G.view.copy(camera.matrixWorldInverse); G.proj.copy(camera.projectionMatrix);
    u.tZ.value = G.z[G.zi].texture; u.tZp.value = still ? u.tZ.value : G.z[G.zi ^ 1].texture;
    u.tAO.value = aoA.texture; // blurred AO; zw still holds the normal
    pass(G.mTrace, G.t1);
    const hPrev = G.hist[G.hi], hCur = G.hist[G.hi ^ 1]; G.hi ^= 1;
    u.tGI.value = G.t1.texture; u.tHist.value = hPrev.texture;
    pass(G.mTemporal, hCur);
    u.tGI.value = hCur.texture; u.dir.value.set(1, 0); pass(G.mBlur, G.t2);
    u.tGI.value = G.t2.texture; u.dir.value.set(0, 1); pass(G.mBlur, G.t1);
    u.tGI.value = G.t1.texture; u.tAlb.value = G.scene.textures[1];
    G.valid = true;
  }

  return {
    setSize(w, h) {
      W = w; H = h;
      const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
      sceneRT.setSize(w, h); zRT.setSize(hw, hh); aoA.setSize(hw, hh); aoB.setSize(hw, hh);
      U.res.value.set(hw, hh);
      if (G) sizeGI();
    },
    // GI settings: null switches GI off (and frees its targets), else { quarter, rays, steps, strength }.
    setGI(c) {
      const prev = cfg;
      cfg = c ? { ...c } : null;
      if (!cfg) { disposeGI(); if (prev) sceneRT.setSize(W, H); return; }
      if (!G) { G = buildGI(); sceneRT.dispose(); sizeGI(); } else if (!prev || prev.quarter !== cfg.quarter) sizeGI();
    },
    // Accumulation frames still owed after the last full frame. While > 0 the caller should call accumulate() each frame.
    get pending() { return G ? G.pending : 0; },
    get gi() { return !!G; },
    render(scene, camera, ao) {
      const gi = ao && G;
      const p = camera.projectionMatrix.elements;
      U.pr.value.set(p[0], p[5]); U.pz.value.set(p[10], p[14]);
      const target = gi ? G.scene : sceneRT;
      target.resolveDepthBuffer = ao; // the depth copy is only needed by AO
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      if (ao) {
        U.tDepth.value = target.depthTexture;
        if (gi) { G.zi ^= 1; U.tZ.value = G.z[G.zi].texture; pass(matZ, G.z[G.zi]); } else { U.tZ.value = zRT.texture; pass(matZ, zRT); }
        pass(matAO, aoA);
        U.tAO.value = aoA.texture; U.dir.value.set(1, 0); pass(matBlur, aoB);
        U.tAO.value = aoB.texture; U.dir.value.set(0, 1); pass(matBlur, aoA);
        U.tAO.value = aoA.texture;
      }
      U.strength.value = ao ? 0.9 : 0;
      U.tScene.value = target.texture;
      if (gi) { runGI(camera, false); G.pending = 8; }
      pass(gi ? G.mOut : matOut, null);
    },
    // One accumulation-only frame: the scene, depth and AO from the last full frame are reused; only the GI passes and the
    // composite run. Returns false (and does nothing) once the owed frames are done.
    accumulate(camera) {
      if (!G || G.pending <= 0 || !G.valid) return false;
      G.pending--;
      runGI(camera, true);
      pass(G.mOut, null);
      return true;
    },
  };
}
