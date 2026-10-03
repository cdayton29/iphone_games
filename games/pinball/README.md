# Space Cadet Pinball — PWA

Your Windows *3D Pinball Space Cadet* game files, running in any modern browser as an
installable, offline-capable Progressive Web App. The original `pinball.exe` isn't used;
the game engine is the open-source decompilation
([k4zmu2a/SpaceCadetPinball](https://github.com/k4zmu2a/SpaceCadetPinball), web port by
[alula](https://github.com/alula/SpaceCadetPinball)) compiled to WebAssembly, with your
`PINBALL.DAT`, sounds and music embedded in `SpaceCadetPinball.js`.

## Run it

**Locally (quickest):**
```
python3 serve.py          # then open http://localhost:8000
```
Any static web server works (`npx serve`, nginx, etc.). You can also just double-click
`index.html` — the game runs from disk too, but install/offline caching needs a server.

**On a phone / other devices:** upload this folder to any HTTPS static host (GitHub Pages,
Netlify, Cloudflare Pages, Vercel, your own server). Installing as an app needs HTTPS (or
`localhost`).

## Install as an app
- **Chrome / Edge (desktop or Android):** the install icon in the address bar, or menu → *Install app*.
- **iPhone / iPad (Safari):** Share → *Add to Home Screen*.

After the first load, everything is cached by the service worker, so it runs fully offline.

## Controls
| Action | Keyboard | Touch |
|---|---|---|
| Left / right flipper | `Z` / `/` | tap and hold the left / right half of the screen |
| Launch ball (plunger) | hold `Space` | hold **Launch** |
| Nudge table | `X`, `.`, `↑` | **Nudge** |
| New game / pause | `F2` / `F3` | **New** / **Pause** |

**Mobile (compact) layout** — the default on the web:
- During play only the table and the **Ball** and **Score** boxes are shown. In portrait they sit in a
  slim strip above a full-width table; in landscape beside a full-height table. The layout avoids the
  notch / home indicator.
- **Pause** (touch button or `F3`) opens an opaque pause screen with **Resume**, **New Game**,
  **High Scores**, and the full *Game / Options / Help* menus.
- To get the original look with the side panel and always-visible menu, choose
  *Options → Graphics → Compact Layout* while paused. Menu text size is *Options → Graphics → UI Scale*.

Mouse: left/right buttons work the flippers.
High scores and options are saved in the browser (IndexedDB) and survive restarts.

## Files
- `index.html` – app shell: loader, touch controls, save persistence, service-worker registration
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA manifest, offline cache, icons
- `SpaceCadetPinball.js` – the compiled engine with the game data embedded (single file)
- `build-source/emscripten-pwa.patch` – changes applied to alula/SpaceCadetPinball to build it

## Rebuilding
```
git clone https://github.com/alula/SpaceCadetPinball && cd SpaceCadetPinball
git apply emscripten-pwa.patch
cp <your game files, minus pinball.exe> game_resources/
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release && emmake make   # from a build/ dir
```
The patch adds the compact layout (`render.cpp`), exports `callMain`/FS/IDBFS and a `web_key()` hook for the touch controls, and
builds a single self-contained JS file (`SINGLE_FILE` + `--embed-file`), and works around an Emscripten 3.1.6 quirk that drops `main(argc, argv)`.
If you change any game file, bump `VERSION` in `sw.js` so installed copies update.
