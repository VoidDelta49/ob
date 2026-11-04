// Headless end-to-end check of the Classic controls with real pointer gestures (Playwright, software GL):
// spin ball drag / double-tap centre → power handle pull (detents) → cancel by returning to the top → release fires.
// Usage: npm run build && node tools/flow-classic.mjs [--out shots/classic] [--size 900x600]
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
const out = args.out || 'shots/classic';
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('file://' + path.resolve('dist/index.html') + '?q=low');
await page.waitForFunction(() => !!window.__pool, null, { timeout: 60000 });
const P = (f, a) => page.evaluate(f, a);
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   - ' : 'FAIL - ') + msg); if (!ok) fails++; };
const shot = async (n) => { await page.screenshot({ path: `${out}-${n}.png` }); };
const waitState = async (s, ms = 60000) => { try { await page.waitForFunction((s) => window.__pool.state === s, s, { timeout: ms }); return true; } catch { return false; } };

check((await P(() => window.__pool.controls)) === 'classic', 'Classic is the default control scheme');
check(await P(() => getComputedStyle(document.getElementById('menu').querySelector('#ctlSel')).display !== 'none'), 'Controls setting is in the menu');
await page.click('[data-mode="practice"]');
check(await waitState('aim', 20000), 'classic starts straight at the table (no racking / chalk)');
check(await P(() => document.getElementById('chalkOv').classList.contains('hidden')), 'no chalk overlay in classic');
check(await P(() => getComputedStyle(document.getElementById('power')).display !== 'none' && getComputedStyle(document.getElementById('downBtn')).display === 'none'), 'power bar shown, Get down hidden');
await page.waitForTimeout(1200);
await shot('1-aim');

// spin: drag to upper-left, then double-tap centre
const sb = await page.locator('#spin').boundingBox();
await P(() => { window.__pool.render = false; });
await page.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height * 0.3); await page.mouse.down(); await page.mouse.up();
let t = await P(() => window.__pool.tip);
check(t.a < -0.1 && t.b > 0.1 && Math.hypot(t.a, t.b) <= 0.5001, `spin dot sets english (a ${t.a.toFixed(2)}, b ${t.b.toFixed(2)})`);
await page.waitForTimeout(500);
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.mouse.down(); await page.mouse.up();
await page.mouse.down(); await page.mouse.up();
t = await P(() => window.__pool.tip);
check(t.a === 0 && t.b === 0, 'double-tap centres the spin');
await page.waitForTimeout(400);
await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height * 0.2); await page.mouse.down(); await page.mouse.up(); // follow (high)

// power: grab the handle, pull ~half way, check the readout, then return to the top = cancel
const pb = await page.locator('#power').boundingBox();
const track = pb.height - 36;
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18); await page.mouse.down();
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18 + track * 0.5, { steps: 12 });
let pw = await P(() => window.__pool.power);
check(Math.abs(pw - 0.5) < 0.06, `pulling the handle sets power (${pw.toFixed(2)})`);
await P(() => { window.__pool.render = true; });
await page.waitForTimeout(700);
await shot('2-half-pull');
await P(() => { window.__pool.render = false; });
await page.mouse.move(pb.x + pb.width / 2 + 40, pb.y + 18 + track * 0.9, { steps: 10 }); // drifting off the bar must not matter
pw = await P(() => window.__pool.power);
check(pw > 0.85, `drag keeps working outside the bar (${pw.toFixed(2)})`);
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18, { steps: 10 });
await page.mouse.up();
check((await P(() => window.__pool.state)) === 'aim' && (await P(() => window.__pool.power)) === 0, 'returning the handle to the top cancels the shot');

// aim at the nearest ball in practice, then a real pull and release
await P(() => { window.__pool.render = true; });
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18); await page.mouse.down();
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18 + track * 0.75, { steps: 14 });
await P(() => { window.__pool.render = true; });
await page.waitForTimeout(600);
await shot('3-full-pull');
await page.mouse.up();
const s = await P(() => ({ state: window.__pool.state, v: window.__pool.shot && window.__pool.shot.vCue }));
check(s.state === 'shooting' && s.v > 0.5, `release fires the stroke (cue ${s.v && s.v.toFixed(2)} m/s)`);
await page.waitForTimeout(500);
await shot('4-follow');
check(await waitState('aim', 120000), 'shot resolves, next turn');
check(await P(() => !document.getElementById('powerLast').classList.contains('none')), 'last power marker is shown');

// realistic mode via the setting
await P(() => window.__pool.setControls('realistic'));
check(await P(() => getComputedStyle(document.getElementById('power')).display === 'none' && getComputedStyle(document.getElementById('downBtn')).display !== 'none'), 'switching to Realistic swaps the controls');
await P(() => window.__pool.setControls('classic'));
check(await P(() => getComputedStyle(document.getElementById('power')).display !== 'none'), 'and back to Classic');
check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
process.exit(fails ? 1 : 0);
