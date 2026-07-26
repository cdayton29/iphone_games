# Arcade

An offline-first PWA shelf for small games, built for an iPhone home screen. Pure HTML, CSS and vanilla JS — no build step, no dependencies, no network needed once it's installed.

## Files

```
index.html          hub shell + iOS standalone meta tags
styles.css          hub styling (dark / light)
hub.js              reads games.json, paints the shelf, runs the stage
games.json          the registry — the only file you edit to add a game
manifest.json       PWA manifest
sw.js               service worker; caches the hub AND every game in games.json
icons/              app icons (180 / 192 / 512 / maskable / favicon)
games/
  solitaire/  index.html  script.js  icon.png
  sudoku/     index.html  script.js  icon.png
```

## Deploying

**Keep the folders intact.** This is the one thing that goes wrong. Uploading files one at a time flattens `games/solitaire/index.html` into a bare `index.html`, and since several games share filenames, they overwrite each other. Always move the whole tree at once:

- **git:** `git add -A && git commit -m "deploy" && git push`
- **GitHub website:** Add file → Upload files, then drag the `games` and `icons` **folders** in as folders. The uploader preserves structure when you drag a directory; it can't when you pick files individually.
- **Netlify:** drag the unzipped `mini-arcade` folder onto the deploy area.

On GitHub Pages: Settings → Pages → Deploy from a branch → `main` / `(root)`. Your site lands at `https://<user>.github.io/<repo>/`.

**Locally**, service workers need HTTP, so `file://` won't do:

```bash
python3 -m http.server 8000
```

**On the iPhone:** open the URL in Safari → Share → Add to Home Screen. Launch from the icon and the address bar is gone. Leave it on the shelf for a few seconds the first time so the service worker can finish caching, then it plays with no signal at all.

## Adding a game

**1. Make the folder.** Anything self-contained works:

```
games/minesweeper/
  index.html      ← the entry point
  script.js       ← cached automatically by folder convention
  icon.png        ← 256×256 works well, and is optional
```

A single self-contained `index.html` with the CSS and JS inline is also fine — `script.js` is a convention the service worker looks for, not a requirement.

**2. Add one entry to `games.json`:**

```json
{
  "id": "minesweeper",
  "title": "Minesweeper",
  "subtitle": "Ten mines, no guessing",
  "icon": "games/minesweeper/icon.png",
  "path": "games/minesweeper/",
  "accent": "#7C9CFF",
  "glyph": "◆"
}
```

Only `id`, `title` and `path` are required. The rest:

| key | what it does |
| --- | --- |
| `icon` | image for the card. If the file is missing, the card falls back to `glyph` |
| `glyph` | a character shown in the icon well, tinted with `accent`. Defaults to the first letter of `title` |
| `subtitle` | one line under the title |
| `accent` | colour of the card's spine |
| `entry` | if your entry file isn't `index.html` |
| `assets` | extra files to cache: `["games/minesweeper/sprites.png"]` |

The registry can also be a bare `[ … ]` array instead of `{ "games": [ … ] }`; both are accepted.

**3. Bump the cache** in `sw.js`:

```js
const CACHE_NAME = 'arcade-v5';   // was arcade-v4
```

This is the step that makes iOS fetch the new files. Skip it and the phone will happily serve the old bundle forever. On the next launch the hub shows a "New version downloaded" pill; tapping Reload swaps it in — never mid-game.

`hub.js` never has to change. The hub reads `games.json` at launch and the service worker re-reads it at install, so those three steps are the whole process.

### What a game gets for free

- **Return to menu** — the floating Menu button lives in the hub, over the iframe, so it works no matter what the game does. A game can also ask to exit: `parent.postMessage({ type: 'arcade:exit' }, '*')`.
- **Theme** — the hub passes `?theme=dark` or `?theme=light` on the URL, and posts `{ type: 'theme', theme }` when it changes.
- **Deep links** — `.../#sudoku` opens straight into that game.
- **A clean teardown** — the iframe is destroyed on exit, so timers, audio and memory go with it.

Keep the top-left ~120px of your game's UI clear; that's where the Menu button sits.

## When something doesn't load

The stage tells you which file it went looking for and why. Common causes:

- **The folder structure got flattened on upload.** By far the most likely. Check that `games/<name>/index.html` really exists at that path in the repo, not nested inside some other directory.
- **A game opens to a blank screen.** Its `index.html` loaded but `script.js` didn't — the script is missing from the folder.
- **A card shows a letter instead of an icon.** `icon.png` isn't there. Harmless; set a `glyph` if you like the look, or fix the path.
- **Case mismatch.** GitHub Pages and Netlify are case-sensitive: `Solitaire/` ≠ `solitaire/`.
- **Changes aren't showing up.** You didn't bump `CACHE_NAME`, so the service worker is still serving the old copy.

Paths in `games.json` resolve against `hub.js`'s own folder, not the page URL, so both `/arcade` and `/arcade/` work, as do project subpaths.

## The two sample games

**Solitaire** — Klondike, draw one. Tap a card to pick it up, tap a pile to drop it. Double-tap sends a card to the foundations, Collect pulls up everything that's safe to send, and Undo goes back 200 moves. Long columns fan tighter so they always fit the screen.

**Sudoku** — puzzles are generated on the device, with a uniqueness check on every dig, so each one has exactly one solution. Four levels, pencil marks that clear themselves as you place digits, hints, and a Check that flags wrong entries for a couple of seconds.
