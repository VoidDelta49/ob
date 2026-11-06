// SSRT-GI A/B: renders the same deterministic frame (seeded rack, fake clock) on High with GI off and on, and writes
// <out>.png = [GI off | GI on | (on - off) x gain]. Optional: --motion also renders a frame right after the camera or a ball moved
// (before the still-view accumulation) to check for noise and smearing.
// Usage: npm run build && node tools/gi.mjs [--size 800x600] [--dpr 1] [--cam yaw,pitch,dist] [--stance] [--cb x,z] [--gain 4] [--motion] [--touch] [--out shots/gi]
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  ({ chromium } = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'));
}

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), []));
const [w, h] = (args.size || '800x600').split('x').map(Number);
const out = args.out || 'shots/gi';
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: +(args.dpr || 1), hasTouch: !!args.touch, isMobile: !!args.touch });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('console:', m.text()); });
// seeded Math.random, reseeded right before the rack: three.js draws on Math.random for every material / target id it creates,
// so without the reseed a build that creates a few more objects at startup would get a different rack and camera
await page.addInitScript(() => { let s = 1; Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647); window.__seed = (v) => { s = v; }; });
await page.clock.install();
await page.goto('file://' + path.resolve(args.file || 'dist/index.html') + '?q=high');
for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__pool)); i++) await page.clock.runFor(100);
await page.addStyleTag({ content: '.overlay,#hud,#topbar,#controls,#hint,#toast{display:none!important}' });
await page.evaluate(() => { window.__seed(1); window.__pool.newGame('practice'); window.__pool.quickRack(); window.__pool.chalkFull(); });
if (args.cb) await page.evaluate((c) => { const [x, z] = c.split(',').map(Number); const b = window.__pool.world.ball(0); b.x = x; b.z = z; }, args.cb);
if (args.cam) await page.evaluate((c) => window.__pool.setCam(...c.split(',').map(Number)), args.cam);
await page.clock.runFor(1500);
if (args.stance) { await page.evaluate(() => window.__pool.stance()); await page.clock.runFor(2500); }
await page.evaluate(() => { window.__pool.render = false; });

const shot = (gi) => page.evaluate((v) => { window.__pool.gi = v; return window.__pool.snapshot(); }, gi);
const shots = [await shot(false), await shot(true)];
if (args.motion) {
  // mid-motion frame (GI on): the camera orbits and a ball slides for ~6 frames, each a full frame with history capped short
  await page.evaluate(() => { const p = window.__pool, b = p.world.ball(1); p.render = true; p.setCam(p.aim + 0.08, 0.3, 0.5); b.x -= 0.04; });
  await page.clock.runFor(100);
  shots.push(await page.evaluate(() => { window.__pool.render = false; return document.getElementById('c').toDataURL('image/png'); }));
}
const gain = +(args.gain || 4);
const png = await page.evaluate(async ([urls, gain]) => {
  const imgs = await Promise.all(urls.map((u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; })));
  const W = imgs[0].width, H = imgs[0].height, n = urls.length + 1;
  const c = document.createElement('canvas'); c.width = W * n; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  imgs.forEach((im, i) => g.drawImage(im, W * (i === 2 ? 3 : i), 0));
  const a = g.getImageData(0, 0, W, H).data, b = g.getImageData(W, 0, W, H).data, d = g.createImageData(W, H);
  let sum = [0, 0, 0];
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) { const v = b[i + k] - a[i + k]; sum[k] += v; d.data[i + k] = Math.max(0, Math.min(255, 128 + v * gain)); }
    d.data[i + 3] = 255;
  }
  g.putImageData(d, W * 2, 0);
  return { url: c.toDataURL('image/png'), mean: sum.map((s) => s / (W * H)) };
}, [shots, gain]);
fs.writeFileSync(out + '.png', Buffer.from(png.url.split(',')[1], 'base64'));
console.log(`gi on - off, mean sRGB delta r/g/b: ${png.mean.map((v) => v.toFixed(2)).join(' / ')}  -> ${out}.png [off | on | diff x${gain}${args.motion ? ' | moving frame' : ''}]`);
await browser.close();
