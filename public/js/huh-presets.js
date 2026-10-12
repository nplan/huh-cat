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
  // The name of the plain, unmodified huh (preset id 'original', which share
  // links carry, never changes). Used by the meme page, /p and the lab.
  var PLAIN_LABEL = 'Classic';
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
    // The Vowel slider is the line through the huh; moving it replaces a
    // full 2D vowel with that point on the line.
    if (key === 'vowel') { delete out.vowelX; delete out.vowelY; delete out.vowelStrength; }
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
    var H = typeof HuhAudio !== 'undefined' ? HuhAudio : null;
    var has2D = !!(H && H.vowel2D && H.vowel2D(params || {}));
    var vowel = Number(params && params.vowel);
    if ((has2D || !isFinite(vowel)) && H && H.legacyVowel) vowel = H.legacyVowel(params || {});
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
    out.exact.vowel = !has2D && Math.abs(out.vowel - vowel) < 1e-6;
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

  // ---- import validation (lab Import): the presets.json format exactly ----
  var FILE_KEYS = ['version', 'note', 'presets', 'clips'];
  var PARAM_KEYS = ['pitchSemitones', 'durationScale', 'peakAt', 'riseSemitones', 'fallSemitones', 'gainDb', 'attackMs', 'accent', 'vowel'];
  var V2D_RANGES = { vowelX: [0, 1], vowelY: [0, 1], vowelStrength: [0, 1] };
  function audioRanges() {
    var H = (typeof window !== 'undefined' && window.HuhAudio) || null;
    if (!H && typeof require === 'function') { try { H = require('./huh-audio.js'); } catch (e) { H = null; } }
    return H ? H.RANGES : null;
  }

  /**
   * Check a parsed presets file against base (the loaded presets.json).
   * Returns { ok, errors: [..], warnings: [..], params: { id: params } }.
   * Accepts exactly the presets.json format: version 1, presets[] with
   * known ids, every param present, numeric and inside the engine's ranges
   * (2D vowel keys optional). Only params are imported; label/emoji/clip
   * text that differs from base is reported as a warning.
   */
  function validate(data, base) {
    var errors = [];
    var warnings = [];
    var out = {};
    var ranges = audioRanges();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['Not a presets file: expected a JSON object like presets.json.'], warnings: warnings, params: out };
    if (data.version !== 1) errors.push('version must be 1 (got ' + JSON.stringify(data.version) + ').');
    Object.keys(data).forEach(function (k) { if (FILE_KEYS.indexOf(k) < 0) errors.push('Unknown top-level key "' + k + '".'); });
    if (!Array.isArray(data.presets) || !data.presets.length) {
      errors.push('presets must be a non-empty array.');
      return { ok: false, errors: errors, warnings: warnings, params: out };
    }
    var known = {};
    ((base && base.presets) || []).forEach(function (p) { known[p.id] = p; });
    var seen = {};
    data.presets.forEach(function (p, i) {
      var where = 'presets[' + i + ']';
      if (!p || typeof p !== 'object') { errors.push(where + ' is not an object.'); return; }
      var id = p.id;
      if (typeof id !== 'string' || !known[id]) { errors.push(where + ': unknown mood id ' + JSON.stringify(id) + ' (known: ' + Object.keys(known).join(', ') + ').'); return; }
      where = id;
      if (seen[id]) { errors.push(id + ' appears twice.'); return; }
      seen[id] = true;
      if (typeof p.label !== 'string') errors.push(where + ': label must be a string.');
      else if (p.label !== known[id].label) warnings.push(where + ': label "' + p.label + '" differs from presets.json ("' + known[id].label + '"); only params are imported.');
      var params = p.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) { errors.push(where + ': params must be an object.'); return; }
      var bad = false;
      Object.keys(params).forEach(function (k) {
        if (PARAM_KEYS.indexOf(k) < 0 && !V2D_RANGES[k]) { errors.push(where + ': unknown param "' + k + '".'); bad = true; }
      });
      PARAM_KEYS.concat(Object.keys(V2D_RANGES)).forEach(function (k) {
        if (!(k in params)) {
          if (!V2D_RANGES[k]) { errors.push(where + ': missing param ' + k + '.'); bad = true; }
          return;
        }
        var v = params[k];
        var r = V2D_RANGES[k] || (ranges && ranges[k]);
        if (typeof v !== 'number' || !isFinite(v)) { errors.push(where + ': ' + k + ' must be a number (got ' + JSON.stringify(v) + ').'); bad = true; return; }
        if (r && (v < r[0] || v > r[1])) { errors.push(where + ': ' + k + ' = ' + v + ' is outside ' + r[0] + ' .. ' + r[1] + '.'); bad = true; }
      });
      var v2 = ['vowelX', 'vowelY'].filter(function (k) { return k in params; }).length;
      if (v2 === 1) { errors.push(where + ': vowelX and vowelY go together.'); bad = true; }
      if (!bad) out[id] = params;
    });
    if (base && data.clips && JSON.stringify(data.clips) !== JSON.stringify(base.clips)) warnings.push('clips (caption settings) differ from presets.json; only mood params are imported.');
    return { ok: errors.length === 0, errors: errors, warnings: warnings, params: errors.length ? {} : out };
  }

  // ---- Space plays (meme page, /p, lab) ---------------------------------
  // Space always means Play, also on a focused button (a mood, a cat, a
  // tab), whose own Space activation (it fires on keyup) is cancelled; Enter
  // still activates the focused button and Tab still moves focus. Text
  // fields, selects and editable text keep Space, and so do checkboxes and
  // radios (Space is their only toggle key). Sliders have no Space action,
  // so Space plays there too.
  var NATIVE_INPUTS = ['range', 'button', 'submit', 'reset', 'color', 'file', 'image'];
  function keepsSpace(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    if (tag === 'input') return NATIVE_INPUTS.indexOf((t.type || '').toLowerCase()) < 0;
    return tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
  }
  function isSpace(e) { return e.key === ' ' || e.code === 'Space'; }
  function spaceToPlay(play, win) {
    var w = win || window;
    w.addEventListener('keydown', function (e) {
      if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey || keepsSpace(e.target)) return;
      e.preventDefault();
      if (!e.repeat) play(e);
    }, true);
    w.addEventListener('keyup', function (e) {
      if (!isSpace(e) || keepsSpace(e.target)) return;
      e.preventDefault();
    }, true);
  }

  return {
    spaceToPlay: spaceToPlay,
    keepsSpace: keepsSpace,
    validate: validate,
    PLAIN_LABEL: PLAIN_LABEL,
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
