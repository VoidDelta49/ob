// Headless end-to-end check of the Classic (power bar) controls with real pointer gestures (Playwright, software GL).
// Classic keeps all the realism (rack, chalk, tip/butt, bridge, stance); only the shot input differs.
// Checks: default scheme, rack + chalk required, tip panel, stance + aiming while down (drag, fine strip, keys),
// power handle pull / drift / cancel / release, report, and switching to Realistic in the menu.
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
const shot = async (n) => { await page.screenshot({ path: `${out}-${n}.png`, timeout: 120000 }); };
const waitState = async (s, ms = 60000) => { try { await page.waitForFunction((s) => window.__pool.state === s, s, { timeout: ms }); return true; } catch { return false; } };
const shown = (id) => P((id) => getComputedStyle(document.getElementById(id)).display !== 'none', id);

check((await P(() => window.__pool.controls)) === 'classic', 'Classic is the default control scheme');
await page.click('[data-mode="practice"]');
check((await P(() => window.__pool.state)) === 'rack', 'classic still starts with racking');
await P(() => window.__pool.quickRack());
check(await waitState('aim', 20000), 'rack lifted, ready to break');
check(await P(() => !document.getElementById('chalkOv').classList.contains('hidden')), 'chalk is still required before the first shot');
await P(() => window.__pool.chalkFull());
check((await shown('power')) && (await shown('tipPanel')) && (await shown('elev')) && (await shown('downBtn')) && !(await shown('strokeCanvas')), 'power bar + tip panel + butt slider + Get down are all there');
await page.waitForTimeout(1000);
await shot('1-aim');

// tip placed high via the ball-face panel
const tb = await page.locator('#tipCanvas').boundingBox();
await P(() => { window.__pool.render = false; });
await page.mouse.click(tb.x + tb.width * 0.4, tb.y + tb.height * 0.5 - tb.height * 0.45 * 0.3);
const t = await P(() => window.__pool.tip);
check(t.b > 0.15 && Math.abs(t.a) < 0.06, `tip placed high (a ${t.a.toFixed(2)}, b ${t.b.toFixed(2)})`);

// get down, then aim while down: drag on the table, the fine strip, and the arrow keys
await P(() => { window.__pool.render = true; });
await page.click('#downBtn');
check((await P(() => window.__pool.state)) === 'stance', 'Get down enters the stance with the power bar');
await page.waitForTimeout(900);
await shot('2-stance');
await P(() => { window.__pool.render = false; });
const yaw0 = await P(() => window.__pool.aim);
await page.mouse.move(W / 2, H * 0.4); await page.mouse.down(); await page.mouse.move(W / 2 + 80, H * 0.4, { steps: 8 }); await page.mouse.up();
let yaw1 = await P(() => window.__pool.aim);
check(Math.abs(yaw1 - yaw0) > 0.05 && (await P(() => window.__pool.state)) === 'stance', `dragging the table aims while down (${((yaw1 - yaw0) * 57.3).toFixed(2)}°), still in stance`);
const fb = await page.locator('#fine').boundingBox();
await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2); await page.mouse.down(); await page.mouse.move(fb.x + fb.width / 2 - 60, fb.y + fb.height / 2, { steps: 6 }); await page.mouse.up();
const yaw2 = await P(() => window.__pool.aim);
check(Math.abs(yaw2 - yaw1) > 0.005 && Math.abs(yaw2 - yaw1) < 0.05, `fine strip trims the aim while down (${((yaw2 - yaw1) * 57.3).toFixed(2)}°)`);
await page.keyboard.down('ArrowRight'); await page.waitForTimeout(400); await page.keyboard.up('ArrowRight');
const yaw3 = await P(() => window.__pool.aim);
check(yaw3 > yaw2, 'arrow keys nudge the aim while down');

// power: pull to ~55 %, drift off the bar, cancel by returning to the top
const pb = await page.locator('#power').boundingBox();
const track = pb.height - 36;
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18); await page.mouse.down();
await page.mouse.move(pb.x + pb.width / 2 + 40, pb.y + 18 + track * 0.55, { steps: 12 });
const pw = await P(() => window.__pool.power);
check(Math.abs(pw - 0.55) < 0.06, `pulling the handle sets power while down, even off the bar (${pw.toFixed(2)})`);
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18, { steps: 10 }); await page.mouse.up();
check((await P(() => window.__pool.state)) === 'stance' && (await P(() => window.__pool.power)) === 0, 'handle back at the top cancels');

// real shot
await P(() => { window.__pool.render = true; });
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18); await page.mouse.down();
await page.mouse.move(pb.x + pb.width / 2, pb.y + 18 + track * 0.7, { steps: 14 });
await page.waitForTimeout(500);
await shot('3-pull');
await page.mouse.up();
const s = await P(() => ({ state: window.__pool.state, v: window.__pool.shot && window.__pool.shot.vCue }));
check(s.state === 'shooting' && s.v > 0.5, `release fires the stroke (cue ${s.v && s.v.toFixed(2)} m/s)`);
check(await waitState('rolling', 20000), 'the cue strikes the ball');
check(await P(() => document.getElementById('report').textContent.includes('m/s')), 'stroke report is shown (bridge / nerves / chalk applied)');
await page.waitForTimeout(500);
await shot('4-after');
check(await waitState('aim', 120000), 'shot resolves, next turn');
check(await P(() => !document.getElementById('powerLast').classList.contains('none')), 'last power marker is shown');

// the setting swaps only the shot input
await P(() => window.__pool.setControls('realistic'));
check(!(await shown('power')) && (await shown('tipPanel')) && (await shown('downBtn')), 'Realistic: power bar gone, tip panel + Get down stay');
await P(() => window.__pool.setControls('classic'));
check(await shown('power'), 'and back to Classic');
check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
process.exit(fails ? 1 : 0);
