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

## Local
```bash
npx --yes serve public
```

## Deploy
Connect this repo to Cloudflare Pages:
- Build command: *(none)*
- Output directory: `public`
