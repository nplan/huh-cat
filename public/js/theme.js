/* Colour scheme switch. All colours are in css/theme.css; this only picks which set is on.
 * To change the site's scheme, edit the next line (0 Original, 1 Impact, 2 9GAG, 3 Gumroad, 4 Lime,
 * 5 Orange cobalt, 6 Mint purple, 7 Red cream, 8 Mono, 9 Night, 10 Swamp,
 * 11 Whiskas Purple, 12 Ginger Tabby, 13 Sheba Velvet, 14 Tiki Lagoon, 15 Hill's Clinic, 16 Neko Atsume,
 * 17 Maneki-neko, 18 Catnip, 19 Black Cat, 20 Felix Tuxedo, 21 Gumroad fixed, 22 Whiskas,
 * 23 Ben, 24 Rug, 25 Tangerine Grape, 26 Walnut Sky, 27 Peach Static). */
var HUH_SCHEME = 3;
(function () {
  // Dev preview: ?scheme=N (ignored on the production domain).
  var m = location.hostname !== 'huuuh.meme' && /[?&]scheme=(2[0-7]|1[0-9]|[0-9])\b/.exec(location.search);
  var n = m ? m[1] : String(HUH_SCHEME);
  var root = document.documentElement;
  root.setAttribute('data-scheme', n);
  // The browser bar follows the meme block colour (this script runs after theme.css has loaded).
  var c = getComputedStyle(root).getPropertyValue('--b1').trim();
  var t = document.querySelector('meta[name="theme-color"]');
  if (c && t) t.setAttribute('content', c);
  window.HuhTheme = { scheme: n, preview: !!m };
})();
