import * as THREE from 'three';

// ---------- procedural PBR surface data ----------
// One RGBA8 texture per surface: rg = tangent-space normal xy, b = height (1 = top), a = roughness multiplier / 2.
// Height is tileable (neighbours wrap), so the normals are too; mip-mapping is left to the GPU.
export function surfaceTexture(w, h, height, rough, strength) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const hx = height[y * w + ((x + 1) % w)] - height[y * w + ((x + w - 1) % w)];
    const hy = height[((y + 1) % h) * w + x] - height[((y + h - 1) % h) * w + x];
    const nx = -hx * strength, ny = -hy * strength, il = 1 / Math.hypot(nx, ny, 1);
    d[i * 4] = (nx * il * 0.5 + 0.5) * 255;
    d[i * 4 + 1] = (ny * il * 0.5 + 0.5) * 255;
    d[i * 4 + 2] = Math.max(0, Math.min(1, height[i])) * 255;
    d[i * 4 + 3] = Math.max(0, Math.min(1, rough ? rough[i] : 0.5)) * 255;
  }
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// Height (row 0 = v 0) from a canvas' luminance, flipped to match a flipY canvas texture sharing the same uv.
export function lumaHeight(canvas, lo = 0, hi = 255) {
  const { width: w, height: h } = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4;
    out[y * w + x] = Math.max(0, Math.min(1, ((px[s] * 0.3 + px[s + 1] * 0.59 + px[s + 2] * 0.11) - lo) / (hi - lo)));
  }
  return out;
}

// ---------- material patches ----------
const quality = []; // POM depth uniforms, zeroed on the low-graphics path
export function setSurfaceQuality(hi) { for (const u of quality) u.value = hi ? u.hi : 0; }

const PARS = /* glsl */`
#ifdef SURF
uniform sampler2D tSurf;
uniform float pomDepth;
vec2 pUv; vec4 pSurf; float pShadow = 1.0, pCavity = 1.0; mat3 pTBN;
mat3 surfTBN(vec3 p, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(p), q1 = dFdy(p); vec2 s0 = dFdx(uv), s1 = dFdy(uv);
  vec3 a = cross(q1, n), b = cross(n, q0);
  vec3 T = a * s0.x + b * s1.x, B = a * s0.y + b * s1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, n);
}
// Parallax occlusion mapping with a soft self-shadow ray towards the (distance-weighted) spot lights
void surfPOM(vec2 uv0) {
  vec3 N = normalize(vNormal);
  pTBN = surfTBN(-vViewPosition, N, uv0);
  vec2 dx = dFdx(uv0), dy = dFdy(uv0);
  pUv = uv0;
  if (pomDepth > 0.0) {
    vec3 P = -vViewPosition, V = normalize(vViewPosition);
    vec3 Vt = vec3(dot(V, pTBN[0]), dot(V, pTBN[1]), dot(V, N));
    vec3 q0 = dFdx(P), q1 = dFdy(P);
    float upm = sqrt((dot(dx, dx) + dot(dy, dy)) / max(dot(q0, q0) + dot(q1, q1), 1e-12)); // uv per metre
    float fade = smoothstep(0.08, 0.3, Vt.z);   // flatten at grazing angles, where steps would show
    float nl = mix(14.0, 5.0, Vt.z), dl = 1.0 / nl;
    vec2 duv = -(Vt.xy / max(Vt.z, 0.2)) * (pomDepth * fade * upm) * dl;
    float ld = 0.0, hv = 1.0 - textureGrad(tSurf, uv0, dx, dy).b, pl = 0.0, ph = hv;
    vec2 uv = uv0, pu = uv0;
    for (int i = 0; i < 14; i++) {
      if (ld >= hv || float(i) >= nl) break;
      pu = uv; pl = ld; ph = hv;
      uv += duv; ld += dl;
      hv = 1.0 - textureGrad(tSurf, uv, dx, dy).b;
    }
    float after = hv - ld, before = ph - pl;
    pUv = mix(uv, pu, clamp(after / min(after - before, -1e-5), 0.0, 1.0));
    // self-shadow: march from the hit point up towards the light, tracking how far the relief pokes above the ray
    vec3 Lv = vec3(0.0);
    #if NUM_SPOT_LIGHTS > 0
    for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
      vec3 d = spotLights[i].position - P;
      Lv += d * inversesqrt(dot(d, d)) / dot(d, d);
    }
    #endif
    Lv = normalize(Lv);
    vec3 Lt = vec3(dot(Lv, pTBN[0]), dot(Lv, pTBN[1]), dot(Lv, N));
    float h0 = textureGrad(tSurf, pUv, dx, dy).b;
    if (Lt.z > 0.12) {
      vec2 stp = (Lt.xy / Lt.z) * (pomDepth * fade * upm) * ((1.0 - h0) / 6.0);
      float occ = 0.0;
      for (int k = 1; k <= 6; k++) {
        float r = h0 + (1.0 - h0) * float(k) / 6.0;
        occ = max(occ, (textureGrad(tSurf, pUv + stp * float(k), dx, dy).b - r) * (1.0 - float(k) / 7.0));
      }
      pShadow = 1.0 - clamp(occ * 5.0, 0.0, 0.85) * fade;
    }
    pCavity = mix(1.0, mix(0.55, 1.0, h0), fade);
  }
  pSurf = textureGrad(tSurf, pUv, dx, dy);
}
#endif
#ifdef PHONG
uniform vec2 phong; // x: weight, y: shininess
void phongAdd(const in IncidentLight l, const in vec3 N, const in vec3 V, inout ReflectedLight rl) {
  float nl = saturate(dot(N, l.direction));
  float s = pow(max(dot(reflect(-l.direction, N), V), 0.0), phong.y);
  rl.directSpecular += l.color * (s * nl * phong.x * (phong.y + 2.0) * 0.159155);
}
#endif
`;

// opts.surf: surfaceTexture to use (POM + normal + roughness + cavity AO); opts.depth: relief depth in metres
// opts.phong: [weight, shininess] adds a Phong specular lobe on top of the GGX one
export function patchMaterial(mat, { surf, depth = 0.001, phong } = {}) {
  const depthU = { value: depth, hi: depth };
  if (surf) quality.push(depthU);
  mat.onBeforeCompile = (sh) => {
    let f = sh.fragmentShader;
    const defs = (surf ? '#define SURF\n' : '') + (phong ? '#define PHONG\n' : '');
    f = f.replace('#include <common>', defs + '#include <common>')
      .replace('#include <roughnessmap_pars_fragment>', '#include <roughnessmap_pars_fragment>\n' + PARS);
    if (surf) {
      sh.uniforms.tSurf = { value: surf }; sh.uniforms.pomDepth = depthU;
      f = f.replace('#include <map_fragment>', `surfPOM(vMapUv);
        { vec4 c = textureGrad(map, pUv, dFdx(vMapUv), dFdy(vMapUv)); diffuseColor *= c; }`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(roughness * pSurf.a * 2.0, 0.04, 1.0);')
        .replace('#include <normal_fragment_maps>', `{ vec3 tn = vec3(pSurf.rg * 2.0 - 1.0, 0.0); tn.z = sqrt(max(1.0 - dot(tn.xy, tn.xy), 0.01)); normal = normalize(pTBN * tn); }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directDiffuse *= pShadow; reflectedLight.directSpecular *= mix(1.0, pShadow, 0.7);
        reflectedLight.indirectDiffuse *= pCavity;`);
    }
    if (phong) {
      sh.uniforms.phong = { value: new THREE.Vector2(...phong) };
      f = f.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin
        .replace(/RE_Direct\( directLight,/g, 'phongAdd( directLight, geometryNormal, geometryViewDir, reflectedLight ); RE_Direct( directLight,'));
    }
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => `${surf ? 's' : ''}${phong ? 'p' : ''}`;
  return mat;
}

// ---------- smooth shadows ----------
// Replaces three's blocky 3x3 PCF-soft with a noise-rotated Vogel-disk filter. Fully lit / fully shadowed texels (the vast
// majority) exit after 5 taps; only penumbrae pay for the full 16, and the per-pixel rotation turns banding into fine grain.
export function patchShadowFilter() {
  const c = THREE.ShaderChunk.shadowmap_pars_fragment;
  const a = c.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )'), b = c.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )');
  THREE.ShaderChunk.shadowmap_pars_fragment = c.slice(0, a) + /* glsl */`#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texel = shadowRadius / shadowMapSize;
			float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
			vec2 cs = vec2(cos(rot), sin(rot));
			mat2 rm = mat2(cs.x, cs.y, -cs.y, cs.x);
			float z = shadowCoord.z;
			shadow = texture2DCompare(shadowMap, shadowCoord.xy, z);
			vec2 o = rm * vec2(0.8, 0.0) * texel;
			float e = shadow + texture2DCompare(shadowMap, shadowCoord.xy + o, z) + texture2DCompare(shadowMap, shadowCoord.xy - o, z)
				+ texture2DCompare(shadowMap, shadowCoord.xy + o.yx * vec2(-1.0, 1.0), z) + texture2DCompare(shadowMap, shadowCoord.xy + o.yx * vec2(1.0, -1.0), z);
			if (e > 0.01 && e < 4.99) {
				shadow = 0.0;
				for (int i = 0; i < 16; i++) {
					float fi = float(i) + 0.5, r = sqrt(fi / 16.0), th = fi * 2.3999632;
					shadow += texture2DCompare(shadowMap, shadowCoord.xy + rm * (vec2(cos(th), sin(th)) * r) * texel, z);
				}
				shadow *= 1.0 / 16.0;
			} else shadow = e * 0.2;

		` + c.slice(b);
}
