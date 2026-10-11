# Credits and sources

## Clips (`public/clips/`)
- **A–D** (`huh-07a`, `huh-07b`, `huh-08a`, `huh-08b`): Ben the Huh? Cat, the
  [Huh? Cat meme](https://knowyourmeme.com/memes/huh-cat). Meme footage, not
  free-licensed.
- **G** (the blaaah easter egg): "Cat Gags Smelling Sour Cream" (Belyash, Moscow,
  filmed 14 Nov 2020), ViralHog, https://www.youtube.com/watch?v=BCAhp-kpYqs
  (also https://viralhog.com/watch/file/232337040). Trimmed to 4.50–5.30 s
  (24 frames at 30 fps), a 720x720 square of the 720x1280 portrait frame
  (y = 20, the whole cat in every frame) centred in 1280x720, the sides filled
  with a blurred, darkened, scaled-up copy of the same footage; H.264 High (x264 CRF 20, like A–D), no audio
  track, faststart; poster `G.jpg` is its first frame.
  **License:** ViralHog footage, all rights reserved; ViralHog licenses it
  (licensing@viralhog.com). Like A–D it is used here as a meme; clear it with
  ViralHog before any commercial use.

## Sounds (`public/audio/`)
- **A.wav**: the huh from clip A (same source as the clip).
- **BLAH.wav** (the blaaah): made only from A.wav, with this project's own engine
  (no third-party audio): the huh's voiced part time-stretched (Rubber Band R3,
  formants kept) and given a falling pitch (TD-PSOLA); vowel moved to an open a
  with the v2 vowel shifter; a b (low-passed voice bar + a weak labial burst)
  and a dark l with an l→a formant glide in front; the huh's own h, recoloured
  to the a, as the breathy end. Same rights status as A.wav. Generator and
  alternatives: `huh-design/blaah/` (not in this repo).

## Code and fonts
- Rubber Band (rubberband-wasm 3.3.0, GPL): `public/vendor/rubberband/LICENSE`.
- Mediabunny: `public/vendor/mediabunny/`.
- Fonts (SIL OFL 1.1, licence next to each): Anton (the HUUUH? caption), Archivo Black (labels),
  DM Sans (UI, download watermark) in `public/fonts/*/`.
