'use strict';
/* Small shared helpers for the round 4 concepts (no audio, no layout logic). */
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Keep the selected preset centred in a horizontal strip, without moving the page.
  function follow(sel) {
    var box = document.querySelector(sel);
    if (!box) return;
    function go() {
      var b = box.querySelector('[aria-pressed="true"]');
      if (!b || box.scrollWidth <= box.clientWidth) return;
      box.scrollTo({ left: b.offsetLeft - (box.clientWidth - b.offsetWidth) / 2, behavior: reduce ? 'auto' : 'smooth' });
    }
    new MutationObserver(go).observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] });
  }
  // A short buzz on press where the phone supports it (Android). iOS ignores it.
  function haptic(sel) {
    document.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest(sel) && navigator.vibrate) { try { navigator.vibrate(8); } catch (x) {} }
    }, true);
  }
  window.R4 = { follow: follow, haptic: haptic, reduce: reduce };
})();
