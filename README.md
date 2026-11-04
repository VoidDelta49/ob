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
- **Two control schemes** (menu → *Controls*, remembered between visits):
  - **Classic** (default): drag to aim, set english on the spin ball, then tap **Get down**, which brings up the power bar (it isn't there while you stand), and pull the handle down and release. Every 10 % is a click you can hear and feel (haptics on phones), full power is a hard stop, the cue strains and trembles near the top, the bar drains in step with the cue stroke, and a marker keeps your last power so you can repeat a shot. The table is racked for you and the aim guide is available in every mode.
  - **Realistic**: there's no power bar and no aim line (the aim line is a practice-only aid). You chalk, rack, choose a bridge, place the tip on the ball, raise the butt, get down, and stroke the cue with your finger. Your finger speed sets the cue speed. The details below describe this scheme.
- **Chalk and miscues**: the tip carries a chalk map. Tip friction μ comes from the chalk at the exact spot the ball touches. A dome tip touches off-centre for english, so dry edges miscue on spin shots. The miscue limit is ρ = μ/√(1+μ²): ≈0.55R when chalked, ≈0.21R bare. Every hit wears chalk off where the ball landed.
- **3D ball flight**: an elevated cue drives the ball into the slate, so jump shots, massé curves and small hops on firm level-ish shots come from the physics. Airborne balls collide in 3D, fly over balls and can leave the table (foul).
- **Body constraints**: rails and balls behind the cue force a minimum butt elevation. Near a rail you get a rail bridge, out of reach the mechanical bridge. Shakier bridges, a higher butt, snatching the stroke (more speed than the backswing allows) and nerves on the 8-ball all add error. Sideways finger drift turns the cue about the bridge.
- **Racking**: the player who isn't breaking racks. Drag the rack onto the spot, tighten it, then lift it straight off.

## Controls
**Classic**
| | Mouse / touch | Keyboard |
|---|---|---|
| Aim | drag on table · fine-aim strip | ← / → (Shift = fine) |
| Spin | drag the dot on the ball (bottom-left) · double-tap to centre | W A S D, X to centre |
| Power / shoot | Get down first; then grab the handle on the power bar, pull down, release · pull back to the top to cancel | hold Space, release |
| Camera tilt / zoom | drag up/down · wheel / pinch | ↑ / ↓ |
| Top view / aim guide | ⬒ button (tap table to aim) · ⌖ button | T · G |
| Ball in hand | drag the cue ball | |

**Realistic**
| | Mouse / touch | Keyboard |
|---|---|---|
| Rack | drag rack onto the spot · Tighten · swipe up to lift | |
| Chalk | brush over the tip (required before your first shot) · Chalk button | C |
| Aim (standing) | drag on table · fine-aim strip | ← / → (Shift = fine) |
| Tip on ball | drag on the ball-face panel | W A S D, X to centre |
| Butt elevation | drag the slider up/down (relative, fine; double-tap levels; red mark = forced minimum) · Classic, down on the shot: drag up/down on the table | Q / E (Shift = finer) · ↑ / ↓ while down |
| Bridge | Bridge button (cycles what the position allows) | B |
| Get down / stand up | Get down button | Space |
| Stroke | down on the shot: pull finger down = backswing, push up through the ball | |
| Camera tilt / zoom | drag up/down · wheel / pinch | ↑ / ↓ |
| Top view | ⬒ button (look only; tap-to-aim in practice) | T |
| Ball in hand | drag the cue ball | |
| Fullscreen | automatic on game start · ⛶ button | F |

## Run locally
```sh
npx serve .          # or: python3 -m http.server
npm install && npm test        # physics / rules / AI sanity tests
npm run shot -- --ctl realistic --fixed --q low --mode practice --aim 0 --shoot 4 --at 0,120,250,500 --out shots/stroke
                               # --shoot = cue speed m/s; also --tip a,b --elev rad --stance
node tools/flow.mjs            # end-to-end (Realistic): rack, chalk, stroke with real pointer gestures (after npm run build)
node tools/flow-classic.mjs    # end-to-end (Classic): spin ball, power bar only when down, handle detents / cancel / release
node tools/layout.mjs          # layout at 13 screen sizes: everything on screen, nothing overlapping, power bar only when down
                               # headless render to PNGs (needs Playwright; see tools/screenshot.mjs)
npm run build                  # single-file offline build -> dist/index.html
```

## Layout
```
src/constants.js   dimensions & physical coefficients
src/table-geom.js  pockets, cushions, jaws (shared by physics/render/AI)
src/physics.js     ball state (3D: hops, jumps, flight), friction, collisions, slate bounce, pocket capture
src/cuephys.js     chalk map, tip friction & miscue, cue→ball transfer, forced elevation, bridges, stroke error
src/rules.js       8-ball referee
src/ai.js          CPU shot planner
src/table.js       table, room and lamp meshes
src/balls.js       ball textures / HUD icons
src/cue.js         cue stick
tools/screenshot.mjs  headless Playwright renderer (fake clock for animation frames)
tools/flow.mjs     headless gesture walkthrough of rack → chalk → stroke (Realistic)
tools/flow-classic.mjs  headless gesture walkthrough of the Classic spin ball + power bar
tools/layout.mjs        headless check that the UI scales: fits and doesn't overlap at phone, tablet and desktop sizes
src/audio.js       synthesised SFX
sw.js              cache blocker: service worker that revalidates every game file on each load (offline fallback)
src/main.js        game loop, camera, input, HUD
```
