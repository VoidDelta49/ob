// Bundles the game (including three.js) into one self-contained dist/index.html.
import { build } from 'esbuild';
import fs from 'node:fs';

const out = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  target: 'es2020',
  alias: { 'three/addons': './node_modules/three/examples/jsm' },
});
const js = out.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const css = fs.readFileSync('style.css', 'utf8');
let html = fs.readFileSync('index.html', 'utf8');
html = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace('<link rel="stylesheet" href="style.css" />', () => `<style>${css}</style>`)
  .replace('<script type="module" src="src/main.js"></script>', () => `<script type="module">${js}</script>`);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB`);
