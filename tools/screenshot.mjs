// Headless screenshot harness: renders dist/index.html in Chromium (Playwright) and saves PNGs.
// Usage: npm run build && node tools/screenshot.mjs [--mode practice] [--cam yaw,pitch,dist] [--aim yaw] [--tip a,b] [--elev rad] [--stance]
//          [--shoot power] [--clean] [--q low] [--at 0,120,300] [--size 1280x720] [--out shots/name]
//   --cam    orbit camera (radians, radians, metres); applied instantly via window.__pool.setCam
//   --fixed  deterministic fake clock (recommended for animation frames; frames step at ~16 ms)
//   --clean  hide all HTML UI; --q low uses the low-graphics path (much faster under software GL)
//   --shoot  stroke the cue at this cue speed (m/s) after setup (rack + chalk are skipped); --at lists capture times (ms after the shot, or after setup if no shot)
// Output: <out>-<ms>.png per capture time. Uses software GL, so it is slow but deterministic enough for visual checks.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// Prefer a local playwright; fall back to a globally installed one (not a devDependency, to keep installs light).
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = createRequire(path.join(g, 'x.js'))('playwright'));
}

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), []));
const [w, h] = (args.size || '1280x720').split('x').map(Number);
const out = args.out || 'shots/shot';
const at = (args.at || '0').split(',').map(Number);
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
// --fixed: fake clock, so game time advances exactly by --at deltas regardless of how slow software GL renders
const fixed = !!args.fixed;
if (fixed) await page.clock.install();
const advance = async (ms) => (fixed ? page.clock.runFor(ms) : page.waitForTimeout(ms));
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto('file://' + path.resolve('dist/index.html') + (args.q ? '?q=' + args.q : ''));
if (fixed) { for (let i = 0; i < 50 && !(await page.evaluate(() => !!window.__pool)); i++) await page.clock.runFor(100); }
else await page.waitForFunction(() => !!window.__pool, null, { timeout: 30000 });
if (args.clean) await page.addStyleTag({ content: '.overlay,#hud,#topbar,#controls,#hint,#toast{display:none!important}' });
if (args.mode) await page.evaluate((m) => { window.__pool.newGame(m); window.__pool.quickRack(); window.__pool.chalkFull(); }, args.mode);
if (args.tip) await page.evaluate((t) => window.__pool.setTip(...t.split(',').map(Number)), args.tip);
if (args.elev) await page.evaluate((e) => window.__pool.setElev(+e), args.elev);
if (args.aim) await page.evaluate((y) => window.__pool.setAim(+y), args.aim);
if (args.cam) await page.evaluate((c) => window.__pool.setCam(...c.split(',').map(Number)), args.cam);
await advance(fixed ? 1500 : 400);
if (args.stance) await page.evaluate(() => window.__pool.stance());
if (args.shoot) await page.evaluate((v) => window.__pool.stroke(+v), args.shoot);
let tNow = 0;
for (const ms of at) {
  if (ms > tNow) { await advance(ms - tNow); tNow = ms; }
  const file = `${out}-${ms}.png`;
  // fixed clock: page.screenshot would wait forever for a frame, so read the WebGL canvas directly (no HTML UI)
  if (fixed) fs.writeFileSync(file, Buffer.from((await page.evaluate(() => window.__pool.snapshot())).split(',')[1], 'base64'));
  else await page.screenshot({ path: file, timeout: 120000 });
  console.log(file);
}
await browser.close();
