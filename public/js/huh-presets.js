'use strict';

/**
 * Meme-page presets and the five sliders.
 *
 * presets.json (committed) is the shared source. The lab can override any
 * preset in this browser (localStorage 'huh-presets', { id: params }).
 * A preset holds full renderer params, so lab tuning is exact. The five
 * sliders are a simple map onto those params (fromSliders); every slider at
 * 0 is exactly the plain huh (HuhAudio.DEFAULTS). A preset shows on the
 * sliders as the nearest slider setting (toSliders). The first-pass presets
 * were authored as slider settings, so for them that is exact.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HuhPresets = api;
})(function () {
  var LOCAL_KEY = 'huh-presets';
  var SLIDERS = ['pitch', 'length', 'question', 'intensity', 'vowel'];
  // Semitones of pitch per unit of Intensity.
  var INTENSITY_PITCH = 1.5;
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
   *  pitch      pitchSemitones -6 .. +7 (plus a little from intensity)
   *  length     durationScale 0.55 .. 1.8 (geometric)
   *  question   - : flat to falling statement (peak early, fall up to
   *                 9 st; the huh itself rises ~5 st, so -1 nets a fall)
   *             + : questioning rise (up to 8 st, peak late, small fall)
   *  intensity  - : mumbled (quieter by up to 10 dB, soft 90 ms onset,
   *                 1.5 st lower)
   *             + : shouted (accent toward the peak, +4 dB into the
   *                 limiter, 1.5 st higher)
   *  vowel      HuhAudio vowel: -1 schwa .. +1 toward a
   */
  function fromSliders(s) {
    s = s || {};
    var P = num(s.pitch);
    var L = num(s.length);
    var Q = num(s.question);
    var I = num(s.intensity);
    var V = num(s.vowel);
    var p = {
      pitchSemitones: 0,
      durationScale: 1,
      peakAt: 0.7,
      riseSemitones: 0,
      fallSemitones: 0,
      gainDb: 0,
      attackMs: 0,
      accent: 0,
      vowel: V
    };
    p.pitchSemitones = (P >= 0 ? 7 * P : 6 * P) + INTENSITY_PITCH * I;
    p.durationScale = L >= 0 ? Math.pow(1.8, L) : Math.pow(0.55, -L);
    if (Q > 0) {
      p.riseSemitones = 8 * Q;
      p.fallSemitones = 1.5 * Q;
      p.peakAt = 0.7 + 0.22 * Q;
    } else if (Q < 0) {
      p.riseSemitones = 1 * -Q;
      p.fallSemitones = 9 * -Q;
      p.peakAt = 0.7 - 0.45 * -Q;
    }
    if (I > 0) {
      p.accent = 0.6 * I;
      p.gainDb = 4 * I;
    } else if (I < 0) {
      p.gainDb = -10 * -I;
      p.attackMs = 90 * -I;
    }
    // Round to the lab knob steps, so a slider setting is exactly
    // what the lab shows and saves (and all 0 is exactly the defaults).
    for (var k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) p[k] = round(p[k], DIGITS[k]);
    }
    return p;
  }

  function sq(x) { return x * x; }
  function pval(params, key, def) {
    var n = Number(params && params[key]);
    return isFinite(n) ? n : def;
  }

  /**
   * Nearest slider setting for full params. Each slider is fitted on its
   * own knobs (intensity before pitch, which it nudges), on a 0.01 grid.
   */
  function toSliders(params) {
    var out = { pitch: 0, length: 0, question: 0, intensity: 0, vowel: 0 };
    var vowel = Number(params && params.vowel);
    if (!isFinite(vowel) && typeof HuhAudio !== 'undefined' && HuhAudio.legacyVowel) vowel = HuhAudio.legacyVowel(params || {});
    out.vowel = round(num(vowel), 2);
    var dur = pval(params, 'durationScale', 1);
    var lenS = dur >= 1 ? Math.log(dur) / Math.log(1.8) : -Math.log(dur) / Math.log(0.55);
    out.length = round(clamp(lenS, -1, 1), 2);
    var rise = pval(params, 'riseSemitones', 0);
    var fall = pval(params, 'fallSemitones', 0);
    var peak = pval(params, 'peakAt', 0.7);
    var gain = pval(params, 'gainDb', 0);
    var attack = pval(params, 'attackMs', 0);
    var accent = pval(params, 'accent', 0);
    var bestQ = 0;
    var bestI = 0;
    var eQ = Infinity;
    var eI = Infinity;
    for (var i = -100; i <= 100; i++) {
      var v = i / 100;
      var f = fromSliders({ question: v, intensity: v });
      // semitones, peak position x 10 (0.1 ~ 1 st), dB, ms / 10, accent x 10
      var dq = sq(f.riseSemitones - rise) + sq(f.fallSemitones - fall) + sq(10 * (f.peakAt - peak));
      var di = sq(f.gainDb - gain) + sq((f.attackMs - attack) / 10) + sq(10 * (f.accent - accent));
      if (dq < eQ - 1e-12) { eQ = dq; bestQ = v; }
      if (di < eI - 1e-12) { eI = di; bestI = v; }
    }
    out.question = round(bestQ, 2);
    out.intensity = round(bestI, 2);
    var pitch = pval(params, 'pitchSemitones', 0) - INTENSITY_PITCH * out.intensity;
    out.pitch = round(clamp(pitch >= 0 ? pitch / 7 : pitch / 6, -1, 1), 2);
    return out;
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
    INTENSITY_PITCH: INTENSITY_PITCH,
    fromSliders: fromSliders,
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
