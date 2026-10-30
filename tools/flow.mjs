// Headless end-to-end check of the realism controls with real pointer gestures (Playwright, software GL):
// rack → lift swipe → chalk brushing → tip placement → get down → live stroke → shot resolves.
// Usage: npm run build && node tools/flow.mjs [--out shots/flow] [--size 900x600]
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = createRequire(path.join(g, 'x.js'))('playwright'));
}
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), []));
const [W, H] = (args.size || '900x600').split('x').map(Number);
const out = args.out || 'shots/flow';
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.resolve('dist/index.html') + '?q=low');
await page.waitForFunction(() => !!window.__pool, null, { timeout: 60000 });
const P = (f) => page.evaluate(f);
const shot = async (n) => { await page.screenshot({ path: `${out}-${n}.png`, timeout: 120000 }); console.log('  saved', `${out}-${n}.png`); };
const check = (ok, msg) => { console.log(ok ? 'ok -' : 'FAIL -', msg); if (!ok) process.exitCode = 1; };
const waitState = async (s, ms = 60000) => { try { await page.waitForFunction((s) => window.__pool.state === s, s, { timeout: ms }); return true; } catch { return false; } };

await page.click('button[data-mode="practice"]');
check((await P(() => window.__pool.state)) === 'rack', 'practice starts with racking');
await page.waitForTimeout(1500);
await shot('1-rack');
const a0 = await P(() => [...window.__pool.rack.apex]);
await page.mouse.move(W / 2, H / 2); await page.mouse.down(); await page.mouse.move(W / 2 - 60, H / 2, { steps: 6 }); await page.mouse.up();
const a1 = await P(() => [...window.__pool.rack.apex]);
check(Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) > 0.005, `dragging moves the rack (${a0.map((v) => v.toFixed(3))} → ${a1.map((v) => v.toFixed(3))})`);
await P(() => { const r = window.__pool.rack; r.apex[0] = 0.0; r.apex[1] = 0.0; });
for (let i = 0; i < 5 && (await P(() => window.__pool.rack.phase)) === 'set'; i++) await page.click('#actBtn');
check((await P(() => window.__pool.rack.phase)) === 'tight', 'Tighten closes the gaps');
await P(() => { const r = window.__pool.rack; r.apex[0] = 0.001; r.apex[1] = 0; });
await page.click('#actBtn');
check((await P(() => window.__pool.rack.phase)) === 'lift', 'Lift rack asks for a swipe');
await page.mouse.move(W / 2, H * 0.8); await page.mouse.down(); await page.mouse.move(W / 2 + 4, H * 0.3, { steps: 10 }); await page.mouse.up();
check(await waitState('aim', 20000), 'lifting the rack starts the break');
check(await P(() => !document.getElementById('chalkOv').classList.contains('hidden')), 'chalk is required before the first shot');

// brush the chalk over the tip in circles
const box = await page.locator('#chalkCanvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, rr = Math.min(box.width, box.height) * 0.3;
await P(() => { window.__pool.render = false; });
await page.mouse.move(cx + rr, cy); await page.mouse.down();
for (let k = 0; k < 120; k++) { const th = k * 0.45, r = rr * (0.25 + 0.75 * ((k * 7) % 10) / 10); await page.mouse.move(cx + r * Math.cos(th), cy + r * Math.sin(th)); }
await page.mouse.up();
await P(() => { window.__pool.render = true; });
const cov = await P(() => window.__pool.chalk);
await shot('2-chalk');
check(cov >= 0.5 && !(await page.locator('#chalkDone').isDisabled()), `brushing chalks the tip (coverage ${cov.toFixed(2)})`);
await page.click('#chalkDone');

// tip a little high via the ball-face panel
const tb = await page.locator('#tipCanvas').boundingBox();
await page.mouse.click(tb.x + tb.width * 0.4, tb.y + tb.height * 0.5 - tb.height * 0.45 * 0.3 * (tb.width / tb.width));
const t = await P(() => window.__pool.tip);
check(t.b > 0.15 && Math.abs(t.a) < 0.05, `tip placed high (a ${t.a.toFixed(2)}, b ${t.b.toFixed(2)})`);
const ev = await P(() => window.__pool.elev);
check(ev.elevMin > 0.02 && ev.elevMin < 0.12, `cue must clear the rail behind (min butt ${(ev.elevMin * 57.3).toFixed(1)}°, bridge ${ev.bridge})`);

await page.click('#downBtn');
check((await P(() => window.__pool.state)) === 'stance', 'Get down enters the stance');
await page.waitForTimeout(1500);
await shot('3-stance');
// stroke: back 15% of the screen, pause, then push through fast. Software GL renders at ~3 fps, which would
// space the input events seconds apart, so rendering is paused while the gesture is performed.
await P(() => { window.__pool.render = false; });
await page.waitForTimeout(500);
await page.mouse.move(W / 2, H * 0.4); await page.mouse.down();
await page.mouse.move(W / 2, H * 0.55, { steps: 8 });
await page.waitForTimeout(150);
for (let i = 1; i <= 8; i++) { await page.mouse.move(W / 2 + i * 0.5, H * 0.55 - i * H * 0.06); await page.waitForTimeout(8); }
await page.mouse.up();
await P(() => { window.__pool.render = true; });
const s = await P(() => ({ state: window.__pool.state, v: window.__pool.shot && window.__pool.shot.vCue }));
console.log('  stroke', JSON.stringify(await P(() => window.__pool.lastStroke)));
check(s.state === 'rolling' && s.v > 0.3, `live stroke strikes the ball (cue ${s.v && s.v.toFixed(2)} m/s)`);
await page.waitForTimeout(800);
await shot('4-break');
check(await waitState('aim', 120000), 'shot resolves, next turn');
await shot('5-after');
check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
