# Huh?

Fine-tune Ben the [Huh? Cat](https://knowyourmeme.com/memes/huh-cat) for every occasion.

## Stack
- Static site in `public/`
- Hosted on **Cloudflare Pages** (preview deploys from branches → production from `main`)
- Source on GitHub

## Clips
Four standalone huhs in `public/clips/` (`huh-07a`, `huh-07b`, `huh-08a`, `huh-08b`) as A–D, plus
G, the sour-cream gag for the blaaah easter egg (tap Disgusted twice), with its own voice
`public/audio/BLAH.wav`. Sources and licenses: [CREDITS.md](CREDITS.md).

## Colours
One palette, Neon Alley, all in `public/css/theme.css` (CSS custom properties). `<meta name="theme-color">`
in the three pages repeats `--b1`; `favicon.ico`, `apple-touch-icon.png` and `og.jpg` are generated images in the same colours.

## Moods (presets): how to make new defaults

The defaults the meme page and /p play are `public/presets.json`. The lab (`/lab`) reads and writes exactly that format, so the round trip is: **lab Export → commit as `public/presets.json` → the defaults on the main page**.

1. Open `/lab`, pick a mood, move the knobs, press **Save**. Saved edits live in this browser only (localStorage `huh-presets`); the meme page in the same browser plays them on top of presets.json.
2. **Export presets.json** downloads (and copies) presets.json with your edits baked in. With no edits it is byte-identical to the deployed file.
3. Commit it as `public/presets.json`, push `dev`, check, then merge to `main`. Update the golden fingerprints (`MODE=save` on golden.js / golden-webkit.js) in the same change.

**Import** (Presets file card): pick a file, drop it on the card, or paste JSON. It accepts the presets.json format only: `version` 1, `presets[]` with known mood ids, every param present, numeric and inside the engine ranges (optional 2D vowel: `vowelX`, `vowelY`, `vowelStrength`); errors are listed and nothing changes. A valid file shows which moods would change, then **Merge into local edits** (other local edits stay) or **Replace all local edits**. Only params are imported (labels and clip captions come from the deployed presets.json). **Clear local edits** returns to presets.json.

**Tuning sets** (editor row, New / Old / v2 / C1 / C2 / C3) load one mood's values from another file in the same format into the knobs, like an edit (Save keeps it): `presets.json` (New), `presets-v1.json` (before 88beedb), `presets-v2.json` (88beedb), `presets-c1..c3.json` (candidates from the Annoyed/Amused/Scared fix). A/B plays Old then New.

## Local
```bash
npx --yes serve public
```

## Deploy
Connect this repo to Cloudflare Pages:
- Build command: *(none)*
- Output directory: `public`
