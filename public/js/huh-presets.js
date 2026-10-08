'use strict';

/**
 * Meme-page presets and the four sliders (Pitch, Length, Question, Vowel).
 *
 * presets.json (committed) is the shared source. The lab can override any
 * preset in this browser (localStorage 'huh-presets', { id: params }).
 * A preset holds full renderer params (including gain, attack and accent,
 * which no slider controls), so lab tuning is exact. Each slider is a
 * simple map onto its own params (fromSliders / applySlider); every slider
 * at 0 is exactly the plain huh (HuhAudio.DEFAULTS). A preset shows on the
 * sliders as the nearest slider setting (nearest / toSliders), with an
 * exact flag per slider.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HuhPresets = api;
})(function () {
  var LOCAL_KEY = 'huh-presets';
  var SLIDERS = ['pitch', 'length', 'question', 'vowel'];
  // Decimal places of the lab knob steps.
  var DIGITS = {
    pitchSemitones: 1,
    durationScale: 2,
    peakAt: 2,
    riseSemitones: 1,
    fallSemitones: 1,
    gainDb: 1,
    attackMs: 0,
    accent: 2,
    vowel: 2
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? clamp(n, -1, 1) : 0;
  }
  function round(v, k) {
    var m = Math.pow(10, k);
    var r = Math.round(v * m) / m;
    return r === 0 ? 0 : r;
  }

  /**
   * Slider values (each -1 .. 1, 0 = plain huh) to renderer params.
   *  pitch      pitchSemitones -6 .. +7
   *  length     durationScale 0.55 .. 1.8 (geometric)
   *  question   - : flat to falling statement (peak early, fall up to
   *                 9 st; the huh itself rises ~5 st, so -1 nets a fall)
   *             + : questioning rise (up to 8 st, peak late, small fall)
   *  vowel      HuhAudio vowel: -1 schwa .. +1 toward a
   * gain, attack and accent stay at their defaults (lab-only knobs).
   */
  function fromSliders(s) {
    s = s || {};
    var P = num(s.pitch);
    var L = num(s.length);
    var Q = num(s.question);
    var V = num(s.vowel);
    var p = {
      pitchSemitones: P >= 0 ? 7 * P : 6 * P,
      durationScale: L >= 0 ? Math.pow(1.8, L) : Math.pow(0.55, -L),
      peakAt: 0.7,
      riseSemitones: 0,
      fallSemitones: 0,
      gainDb: 0,
      attackMs: 0,
      accent: 0,
      vowel: V
    };
    if (Q > 0) {
      p.riseSemitones = 8 * Q;
      p.fallSemitones = 1.5 * Q;
      p.peakAt = 0.7 + 0.22 * Q;
    } else if (Q < 0) {
      p.riseSemitones = 1 * -Q;
      p.fallSemitones = 9 * -Q;
      p.peakAt = 0.7 - 0.45 * -Q;
    }
    // Round to the lab knob steps, so a slider setting is exactly
    // what the lab shows and saves (and all 0 is exactly the defaults).
    for (var k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) p[k] = round(p[k], DIGITS[k]);
    }
    return p;
  }

  // The params each slider controls.
  var CONTROLS = {
    pitch: ['pitchSemitones'],
    length: ['durationScale'],
    question: ['riseSemitones', 'fallSemitones', 'peakAt'],
    vowel: ['vowel']
  };

  function copyParams(params) {
    var out = {};
    for (var k in params || {}) {
      if (Object.prototype.hasOwnProperty.call(params, k)) out[k] = params[k];
    }
    return out;
  }

  /**
   * params with one slider moved: only that slider's params change, so
   * everything else (including gain, attack, accent) is kept.
   */
  function applySlider(params, key, value) {
    var out = copyParams(params);
    var keys = CONTROLS[key];
    if (!keys) return out;
    var one = {};
    one[key] = value;
    var f = fromSliders(one);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = f[keys[i]];
    return out;
  }

  function sq(x) { return x * x; }
  function pval(params, key, def) {
    var n = Number(params && params[key]);
    return isFinite(n) ? n : def;
  }
  function matches(params, key, value) {
    var f = applySlider({}, key, value);
    var keys = CONTROLS[key];
    for (var i = 0; i < keys.length; i++) {
      var def = keys[i] === 'peakAt' ? 0.7 : keys[i] === 'durationScale' ? 1 : 0;
      if (Math.abs(f[keys[i]] - pval(params, keys[i], def)) > 1e-6) return false;
    }
    return true;
  }
  // Rounded guess, or a neighbour on the 0.01 grid that maps back exactly.
  function settle(params, key, guess) {
    var g = round(clamp(guess, -1, 1), 2);
    var tries = [g, round(g - 0.01, 2), round(g + 0.01, 2)];
    for (var i = 0; i < tries.length; i++) {
      if (tries[i] >= -1 && tries[i] <= 1 && matches(params, key, tries[i])) return tries[i];
    }
    return g;
  }

  /**
   * Nearest slider setting for full params, with exact[key] true when
   * that slider maps back to the params exactly. Pitch is the total pitch.
   */
  function nearest(params) {
    var out = { pitch: 0, length: 0, question: 0, vowel: 0, exact: {} };
    var vowel = Number(params && params.vowel);
    if (!isFinite(vowel) && typeof HuhAudio !== 'undefined' && HuhAudio.legacyVowel) vowel = HuhAudio.legacyVowel(params || {});
    if (!isFinite(vowel)) vowel = 0;
    out.vowel = round(num(vowel), 2);
    var pitch = pval(params, 'pitchSemitones', 0);
    out.pitch = settle(params, 'pitch', pitch >= 0 ? pitch / 7 : pitch / 6);
    var dur = pval(params, 'durationScale', 1);
    var lenS = dur >= 1 ? Math.log(dur) / Math.log(1.8) : -Math.log(dur) / Math.log(0.55);
    out.length = settle(params, 'length', isFinite(lenS) ? lenS : 0);
    var rise = pval(params, 'riseSemitones', 0);
    var fall = pval(params, 'fallSemitones', 0);
    var peak = pval(params, 'peakAt', 0.7);
    var bestQ = 0;
    var eQ = Infinity;
    for (var i = -100; i <= 100; i++) {
      var v = i / 100;
      var f = fromSliders({ question: v });
      // semitones, peak position x 10 (0.1 ~ 1 st)
      var dq = sq(f.riseSemitones - rise) + sq(f.fallSemitones - fall) + sq(10 * (f.peakAt - peak));
      if (dq < eQ - 1e-12) { eQ = dq; bestQ = v; }
    }
    out.question = round(bestQ, 2);
    out.exact.pitch = matches(params, 'pitch', out.pitch);
    out.exact.length = matches(params, 'length', out.length);
    out.exact.question = matches(params, 'question', out.question);
    out.exact.vowel = Math.abs(out.vowel - vowel) < 1e-6;
    return out;
  }

  function toSliders(params) {
    var n = nearest(params);
    return { pitch: n.pitch, length: n.length, question: n.question, vowel: n.vowel };
  }

  function isPlain(sliders) {
    for (var i = 0; i < SLIDERS.length; i++) if (num(sliders[SLIDERS[i]]) !== 0) return false;
    return true;
  }

  function readOverrides() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
      if (raw && typeof raw === 'object') return raw;
    } catch (e) {}
    return {};
  }

  function writeOverrides(map) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(map || {}));
  }

  function clearOverrides() {
    try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
  }

  function copy(o) {
    return JSON.parse(JSON.stringify(o));
  }

  /**
   * presets.json with this browser's lab overrides applied.
   * Each preset gets local: true when overridden.
   */
  function merge(base, overrides) {
    var data = copy(base || { presets: [] });
    var ov = overrides || {};
    (data.presets || []).forEach(function (p) {
      if (ov[p.id] && typeof ov[p.id] === 'object') {
        p.params = copy(ov[p.id]);
        p.local = true;
      }
    });
    return data;
  }

  /** Fetch presets.json (no stale cache). Resolves { base, data }. */
  function load(url) {
    return fetch(url || 'presets.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('presets.json: HTTP ' + r.status);
      return r.json();
    }).then(function (base) {
      return { base: base, data: merge(base, readOverrides()) };
    });
  }

  /** presets.json text with the overrides baked in (lab Export). */
  function exportJson(base, overrides) {
    var data = merge(base, overrides);
    (data.presets || []).forEach(function (p) { delete p.local; });
    return JSON.stringify(data, null, 2) + '\n';
  }

  return {
    LOCAL_KEY: LOCAL_KEY,
    SLIDERS: SLIDERS,
    CONTROLS: CONTROLS,
    fromSliders: fromSliders,
    applySlider: applySlider,
    nearest: nearest,
    toSliders: toSliders,
    isPlain: isPlain,
    readOverrides: readOverrides,
    writeOverrides: writeOverrides,
    clearOverrides: clearOverrides,
    merge: merge,
    load: load,
    exportJson: exportJson
  };
});
