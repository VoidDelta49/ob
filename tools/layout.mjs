// Headless layout check: opens the built game at many screen sizes (phones both ways, tablets, laptops, wide monitors) and verifies that
// the interface scales with the screen: every control is fully on screen, no two controls overlap, and the menu / chalk cards fit without scrolling.
// Usage: npm run build && node tools/layout.mjs [--sizes 915x412,390x844] [--shots shots/layout]   (--shots saves a screenshot per size and state)
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
const SIZES = (args.sizes || '915x412,844x390,667x375,568x320,740x360,360x740,390x844,320x568,768x1024,1024x768,1280x720,1920x1080,2400x1080')
  .split(',').map((s) => s.split('x').map(Number));
if (args.shots) fs.mkdirSync(args.shots, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  FAIL - ' + msg); } };

// Reads the rectangle of every element in `ids` that is currently displayed.
const rects = (page, ids) => page.evaluate((ids) => Object.fromEntries(ids.flatMap((id) => {
  const el = document.getElementById(id);
  if (!el || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') return [];
  const r = el.getBoundingClientRect();
  return r.width && r.height ? [[id, { x: r.left, y: r.top, w: r.width, h: r.height }]] : [];
})), ids);
const inside = (r, W, H) => r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= W + 0.5 && r.y + r.h <= H + 0.5;
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;

async function checkControls(page, W, H, label) {
  const ids = ['hud', 'topbar', 'power', 'tipPanel', 'elev', 'cueBtns', 'fine', 'downBtn', 'hint', 'strokeCanvas'];
  const r = await rects(page, ids);
  for (const id of ['hud', 'topbar', 'tipPanel', 'elev', 'cueBtns', 'fine', 'downBtn']) check(!!r[id], `${label}: #${id} is shown`);
  for (const [id, box] of Object.entries(r)) check(inside(box, W, H), `${label}: #${id} fits on screen (${[box.x, box.y, box.w, box.h].map(Math.round)})`);
  const ks = Object.keys(r);
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
    if (ks[i] === 'hint' || ks[j] === 'hint') continue; // the hint floats over the 3D view only; checked against controls below
    check(!overlap(r[ks[i]], r[ks[j]]), `${label}: #${ks[i]} and #${ks[j]} overlap`);
  }
  if (r.hint) for (const id of ks) if (id !== 'hint' && id !== 'hud') check(!overlap(r.hint, r[id]), `${label}: hint overlaps #${id}`);
  // touch targets: nothing the player has to hit should be tiny
  for (const id of ['power', 'downBtn', 'fine', 'elev', 'tipPanel']) if (r[id]) check(Math.min(r[id].w, r[id].h) >= 24, `${label}: #${id} is a usable size (${Math.round(Math.min(r[id].w, r[id].h))}px)`);
  const fs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.pname')).fontSize));
  check(fs >= 9, `${label}: HUD text is readable (${fs.toFixed(1)}px)`);
  return r;
}

for (const [W, H] of SIZES) {
  console.log(`${W}x${H}`);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.resolve('dist/index.html') + '?q=low');
  await page.waitForFunction(() => !!window.__pool, null, { timeout: 60000 });
  const shot = async (n) => { if (args.shots) await page.screenshot({ path: `${args.shots}/${W}x${H}-${n}.png`, timeout: 120000 }); };

  // menu: the card is on screen and, with the help collapsed, needs no scrolling
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => { const c = document.querySelector('#menu .card'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, scroll: c.scrollHeight - c.clientHeight }; });
  check(inside(menu, W, H), `menu card fits on screen`);
  check(menu.scroll <= 1, `menu card needs no scrolling (${menu.scroll}px hidden)`);
  await shot('menu');

  // chalk card (opens automatically before the first shot)
  await page.click('[data-mode="practice"]');
  await page.evaluate(() => window.__pool.quickRack());
  await page.waitForFunction(() => window.__pool.state === 'aim', null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const chalk = await page.evaluate(() => { const c = document.querySelector('#chalkOv .chalkCard'), cv = document.getElementById('chalkCanvas'), b = document.getElementById('chalkDone'); const f = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; return { card: f(c), canvas: f(cv), done: f(b) }; });
  check(inside(chalk.card, W, H), 'chalk card fits on screen');
  check(inside(chalk.done, W, H), 'chalk Done button is on screen');
  check(Math.min(chalk.canvas.w, chalk.canvas.h) >= 120, `chalk tip is big enough to brush (${Math.round(Math.min(chalk.canvas.w, chalk.canvas.h))}px)`);
  await shot('chalk');
  await page.evaluate(() => window.__pool.chalkFull());
  await page.waitForTimeout(500);

  const rs = await checkControls(page, W, H, 'classic standing');
  check(!rs.power, 'classic standing: the power bar is not shown until you get down');
  await shot('classic');
  // get down: the power bar comes up, and its handle still maps drag distance to power at this scale
  await page.evaluate(() => window.__pool.stance());
  await page.waitForFunction(() => { const c = getComputedStyle(document.getElementById('power')); return c.visibility === 'visible' && +c.opacity > 0.9; }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  const rd = await checkControls(page, W, H, 'classic down');
  check(!!rd.power, 'classic down: the power bar is shown');
  await shot('classic-down');
  if (rd.power) {
    const pb = await page.locator('#power').boundingBox();
    await page.evaluate(() => { window.__pool.render = false; });
    const knob = await page.evaluate(() => document.getElementById('powerKnob').offsetHeight);
    const track = pb.height - knob;
    await page.mouse.move(pb.x + pb.width / 2, pb.y + knob / 2); await page.mouse.down();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + knob / 2 + track * 0.5, { steps: 8 });
    const pw = await page.evaluate(() => window.__pool.power);
    check(Math.abs(pw - 0.5) < 0.05, `power handle drag maps to power (${pw.toFixed(2)} for half the track)`);
    await page.mouse.move(pb.x + pb.width / 2, pb.y + knob / 2, { steps: 6 }); await page.mouse.up();
    await page.evaluate(() => { window.__pool.render = true; });
  }
  await page.evaluate(() => window.__pool.setControls('realistic'));
  await page.waitForTimeout(300);
  await checkControls(page, W, H, 'realistic');
  await shot('realistic');
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await page.close();
}
await browser.close();
console.log(fails ? `\n${fails} layout problem(s)` : '\nall layouts ok');
process.exit(fails ? 1 : 0);
