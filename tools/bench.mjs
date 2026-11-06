// GPU cost probe: renders dist/index.html headless (software GL) and reports the mean ms per frame, plus a PNG of the frame.
// Software GL timings are not phone timings, but fragment cost scales with the same things (pixels x shader work), so they
// rank changes reliably. Usage: npm run build && node tools/bench.mjs [--q high] [--size 390x844] [--dpr 2] [--n 6] [--out shots/bench] [--cam yaw,pitch,dist] [--stance] [--file dist/index.html]
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let chromium; // local playwright, else the global one (as in tools/screenshot.mjs)
try { ({ chromium } = await import('playwright')); } catch {
  ({ chromium } = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'));
}

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), []));
const [w, h] = (args.size || '390x844').split('x').map(Number);
const out = args.out || 'shots/bench';
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: +(args.dpr || 2), hasTouch: !!args.touch, isMobile: !!args.touch });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.addInitScript(() => { let s = 1; Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647); }); // same rack every run
await page.clock.install(); // fake clock: the same camera / rack state every run, so PNGs can be diffed between builds
await page.goto('file://' + path.resolve(args.file || 'dist/index.html') + '?q=' + (args.q || 'high') + (args.extra ? '&' + args.extra : ''));
for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__pool)); i++) await page.clock.runFor(100);
await page.addStyleTag({ content: '.overlay,#hud,#topbar,#controls,#hint,#toast{display:none!important}' });
await page.evaluate(() => { window.__pool.newGame('practice'); window.__pool.quickRack(); window.__pool.chalkFull(); });
if (args.cam) await page.evaluate((c) => window.__pool.setCam(...c.split(',').map(Number)), args.cam);
await page.clock.runFor(1500);
if (args.stance) { await page.evaluate(() => window.__pool.stance()); await page.clock.runFor(2500); }
await page.evaluate(() => { window.__pool.render = false; });
await page.evaluate(() => window.__pool.bench(2));
const ms = await page.evaluate(([n]) => window.__pool.bench(n), [+(args.n || 6)]);
const msS = await page.evaluate(([n]) => window.__pool.bench(n, true), [+(args.n || 6)]);
fs.writeFileSync(out + '.png', Buffer.from((await page.evaluate(() => window.__pool.snapshot())).split(',')[1], 'base64'));
console.log(`${args.q || 'high'} ${w}x${h}@${args.dpr || 2}: ${ms.toFixed(1)} ms/frame, ${msS.toFixed(1)} ms with shadow maps  -> ${out}.png`);
await browser.close();
