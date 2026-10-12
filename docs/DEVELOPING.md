# Developing HUUUH?

Static site in `public/`, no build step. Hosted on Cloudflare Pages: branch `dev` is the preview, `main` is production (huuuh.meme). Pages settings: build command none, output directory `public`.

Run locally: `npx --yes serve public` (or any static server). Locally there are no `_redirects` rewrites, so named mood links are `/p.html#annoyed`.

## Colours
One palette, Neon Alley, all in `public/css/theme.css` (CSS custom properties). `<meta name="theme-color">` repeats `--b1`; `favicon.ico`, `apple-touch-icon.png` and `og.jpg` are generated images in the same colours.

## Cache busting
Every reference to `js/` and `css/` carries `?v=N`; bump it on every change (`_headers` caches them for a year). HTML and `presets.json` are always revalidated.

## Moods (presets): how to make new defaults

The defaults the meme page and /p play are `public/presets.json`. The lab (`/lab`) reads and writes exactly that format, so the round trip is: **lab Export → commit as `public/presets.json` → the defaults on the main page**.

1. Open `/lab`, pick a mood, move the knobs, press **Save**. Saved edits live in this browser only (localStorage `huh-presets`); the meme page in the same browser plays them on top of presets.json.
2. **Export presets.json** downloads (and copies) presets.json with your edits baked in. With no edits it is byte-identical to the deployed file.
3. Commit it as `public/presets.json`, push `dev`, check, then merge to `main`. Update the golden fingerprints (`MODE=save` on golden.js / golden-webkit.js) in the same change.

**Import** (Presets file card): pick a file, drop it on the card, or paste JSON. It accepts the presets.json format only: `version` 1, `presets[]` with known mood ids, every param present, numeric and inside the engine ranges (optional 2D vowel: `vowelX`, `vowelY`, `vowelStrength`); errors are listed and nothing changes. A valid file shows which moods would change, then **Merge into local edits** (other local edits stay) or **Replace all local edits**. Only params are imported (labels and clip captions come from the deployed presets.json). **Reset local to default** returns to presets.json.

**Compare** (editor row, Default / Local / Imported) applies one source to all moods so you can A/B by ear with the same mood selected: **Default** is `presets.json`, **Local** your saved edits (localStorage `huh-presets`), **Imported** the last imported file (kept in localStorage `huh-lab-imported`, survives reload). Sources that do not exist yet are disabled. Default and Imported are read-only: Save while viewing them makes that mood a Local edit and switches to Local. **Use imported as local** replaces Local with the imported file; **Reset local to default** (asks first) deletes the local edits. Picker tiles mark the moods that differ from Default.

**Named links**: every mood has a clean link from its id, `https://huuuh.meme/<mood>` (`/classic`, `/confused`, `/shocked`, `/annoyed`, `/disgusted`, `/suspicious`, `/amused`, `/scared`, `/bored`, `/offended`, `/curious`, and the egg `/blaaah`). `public/_redirects` rewrites each one (200) to the share page (`p.html`, the page `/p?h=` uses), which plays that mood's unmodified preset from presets.json on its usual cat (the egg on its gag clip); Make your own opens the main page with that mood selected. Unknown paths still get `404.html`. The main page's address bar stays plain `/`; Copy link gives the name link for an unmodified mood on its usual cat and a `/p?h=` share link otherwise. Locally (no rewrites) the name link is `/p.html#annoyed`. The lab opens a preset with `/lab#annoyed`. When a mood is added to presets.json, add its two lines to `_redirects` and its URL to `sitemap.xml` (the egg stays out of the sitemap).

## Analytics
Cloudflare Web Analytics (cookieless page views), via the beacon snippet in each HTML page (the token is public by design). Auto install is off on the zone, so the snippet is the only beacon.

## Tests
The browser test suites (headless Chrome + WebKit via Playwright: main page, share page, lab, easter egg, golden render fingerprints, export) live outside this repo. When `presets.json` changes, the golden fingerprints are re-saved in the same change.

