# Otep Billiards — realistic 3D 8-ball in the browser

A pool game built with Three.js and a pool physics engine written for this project. It needs no build
step and no game engine: open `index.html` from any static server.

**Play:** https://voiddelta49.github.io/ob/ (once GitHub Pages is enabled for this repo)

## Features
- **Real-scale table**: a 9-ft table (2.54 × 1.27 m) with 57.15 mm, 170 g balls. Corner and side pockets have angled jaws, and the cushion noses sit at regulation height.
- **Physics**: balls slide, then roll, under the right friction. Spin is tracked on all three axes (follow, draw, stun, side spin). Ball–ball friction produces cut-induced throw and spin transfer. The cushion contact point sits above the ball's equator, so cushions add spin, and their bounce weakens at higher speed. Side spin also deflects the cue ball slightly (squirt). Balls only drop when their centre is over the hole, so they can rattle off the jaws.
- **8-ball rules**: the table is open after the break, and the first legal pot assigns groups. Fouls are a scratch, no ball hit, hitting the wrong ball first, or no rail after contact. A foul gives the opponent ball in hand. Potting the 8 early or on a foul loses, and an 8 potted on the break is re-spotted.
- **CPU opponent** (easy / medium / hard): it finds candidate shots with ghost-ball aiming, then runs the real physics headless to check each one. It weighs both potting the ball and where the cue ball ends up.
- **2-player hot-seat** and **practice** modes.
- **Rendering**: PBR rendering with procedural cloth, wood and ball textures, a three-shade lamp with soft shadows, and a mechanical cue that lifts its butt to clear the rail. Sounds are synthesised in the browser.
- **Mobile-friendly controls**: drag to aim, a fine-aim strip, a pull-down power bar, and a spin selector.

## Controls
| | Mouse / touch | Keyboard |
|---|---|---|
| Aim | drag on table · fine-aim strip | ← / → (Shift = fine) |
| Camera tilt / zoom | drag up/down · wheel / pinch | ↑ / ↓ |
| Top view | ⬒ button (tap table to aim) | T |
| Spin | tap the cue ball widget | W A S D, X to reset |
| Shoot | pull power bar down, release | hold Space, release |
| Ball in hand | drag the cue ball | |

## Run locally
```sh
npx serve .          # or: python3 -m http.server
npm install && npm test        # physics / rules / AI sanity tests
npm run build                  # single-file offline build -> dist/index.html
```

## Layout
```
src/constants.js   dimensions & physical coefficients
src/table-geom.js  pockets, cushions, jaws (shared by physics/render/AI)
src/physics.js     ball state, friction, collisions, pocket capture
src/rules.js       8-ball referee
src/ai.js          CPU shot planner
src/table.js       table, room and lamp meshes
src/balls.js       ball textures / HUD icons
src/cue.js         cue stick
src/audio.js       synthesised SFX
src/main.js        game loop, camera, input, HUD
```
