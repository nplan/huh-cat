'use strict';

/**
 * huh lab renderer.
 * Rubber Band offline R3 does the time stretch and the flat pitch shift over
 * the whole clip. Offline mode cannot move pitch during a pass, so a
 * rise/fall contour is applied afterwards by TD-PSOLA (pitch-synchronous
 * grains re-spaced by the contour ratio), which keeps the formants, so
 * the vowel does not slide with the pitch. The h passes through.
 * keepVowel holds the vowel with Rubber Band's formant scale.
 * vowelX / vowelY / vowelStrength move the vowel on the IPA chart before
 * Rubber Band (huh-vowel.js, clip A only). The default is the huh's own
 * vowel, which skips that stage entirely.
 * vowelScale (u length) stretches only the input after the h|u boundary
 * (first steady voicing). Pitch follows the output timeline, so peakAt and
 * the lab diagram match what plays.
 * Leading silence is trimmed first, so attack and accent sit on the voice.
 * Attack fades the start in. Accent ducks the ends toward the peak.
 * Then gainDb, then a peak limiter at 0.98.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HuhAudio = api;
})(function () {
  var RubberBand = null;
  var HuhVowel = null;
  if (typeof require === 'function') {
    try { HuhVowel = require('./huh-vowel.js'); } catch (e) { HuhVowel = null; }
    RubberBand = require('../vendor/rubberband/rubberband.js');
  }
  if (!HuhVowel && typeof window !== 'undefined' && window.HuhVowel) HuhVowel = window.HuhVowel;
  // The huh's own vowel on the chart (HuhVowel.ORIGIN). The default vowel.
  var VOWEL_HOME = HuhVowel ? HuhVowel.ORIGIN : { x: 0.842, y: 0.692 };

  var DEFAULTS = {
    pitchSemitones: 0,
    durationScale: 1,
    peakAt: 0.7,
    riseSemitones: 0,
    fallSemitones: 0,
    gainDb: 0,
    attackMs: 0,
    accent: 0,
    vowelScale: 1,
    vowelX: VOWEL_HOME.x,
    vowelY: VOWEL_HOME.y,
    vowelStrength: 1,
    keepVowel: false
  };

  var RANGES = {
    pitchSemitones: [-8, 12],
    durationScale: [0.45, 1.8],
    peakAt: [0, 1],
    riseSemitones: [0, 12],
    fallSemitones: [0, 14],
    gainDb: [-12, 6],
    attackMs: [0, 400],
    accent: [0, 1],
    vowelScale: [0.3, 1.5],
    vowelX: [0, 1],
    vowelY: [0, 1],
    vowelStrength: [0, 1]
  };

  var sharedCtx = null;
  var activeSource = null;
  var playToken = 0;

  function rubberband() {
    if (RubberBand) return RubberBand;
    if (typeof window !== 'undefined' && window.RubberBand) return window.RubberBand;
    throw new Error('Rubber Band is not loaded');
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : value > hi ? hi : value;
  }

  function normalizeParams(params) {
    var src = params || {};
    var out = {};
    for (var key in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      if (key === 'keepVowel') continue;
      var range = RANGES[key];
      var n = Number(src[key]);
      if (!isFinite(n)) n = DEFAULTS[key];
      out[key] = clamp(n, range[0], range[1]);
    }
    // Pad blends can land a hair off the defaults; snap so the default
    // render path (no analysis, even stretch) is taken.
    if (Math.abs(out.vowelScale - 1) < 1e-6) out.vowelScale = 1;
    if (src.keepVowel === undefined || src.keepVowel === null) out.keepVowel = DEFAULTS.keepVowel;
    else out.keepVowel = !!src.keepVowel;
    return out;
  }

  var MIX_KEYS = [
    'pitchSemitones',
    'durationScale',
    'peakAt',
    'riseSemitones',
    'fallSemitones',
    'gainDb',
    'attackMs',
    'accent',
    'vowelScale'
  ];

  function cornerParam(corners, id, key) {
    var corner = corners && corners[id];
    if (!corner) return DEFAULTS[key];
    var n = Number(corner[key]);
    if (!isFinite(n)) return DEFAULTS[key];
    return n;
  }

  function bilinearParam(tx, ty, corners, key) {
    var unbotheredDry = cornerParam(corners, 'unbotheredDry', key);
    var annoyedDry = cornerParam(corners, 'annoyedDry', key);
    var unbotheredShocked = cornerParam(corners, 'unbotheredShocked', key);
    var annoyedShocked = cornerParam(corners, 'annoyedShocked', key);
    return (1 - tx) * (1 - ty) * unbotheredDry
      + tx * (1 - ty) * annoyedDry
      + (1 - tx) * ty * unbotheredShocked
      + tx * ty * annoyedShocked;
  }

  /**
   * Bilinear blend of the four corners, then pin the center to DEFAULTS.
   * x is -1 unbothered .. +1 annoyed. y is -1 dry .. +1 shocked.
   * keepVowel is not mixed.
   */
  function mixParams(x, y, corners) {
    var nx = Number(x);
    var ny = Number(y);
    if (!isFinite(nx)) nx = 0;
    if (!isFinite(ny)) ny = 0;
    nx = clamp(nx, -1, 1);
    ny = clamp(ny, -1, 1);
    var tx = (nx + 1) / 2;
    var ty = (ny + 1) / 2;
    var pin = (1 - Math.abs(nx)) * (1 - Math.abs(ny));
    var out = {};
    for (var i = 0; i < MIX_KEYS.length; i++) {
      var key = MIX_KEYS[i];
      var blended = bilinearParam(tx, ty, corners, key);
      var atCenter = bilinearParam(0.5, 0.5, corners, key);
      var value = blended + (DEFAULTS[key] - atCenter) * pin;
      var range = RANGES[key];
      out[key] = clamp(value, range[0], range[1]);
    }
    if (Math.abs(out.vowelScale - 1) < 1e-6) out.vowelScale = 1;
    var vowel = mixVowel(tx, ty, pin, corners);
    out.vowelX = vowel.x;
    out.vowelY = vowel.y;
    out.vowelStrength = vowel.strength;
    out.keepVowel = false;
    return out;
  }

  function cornerVowel(corners, id) {
    var corner = corners && corners[id];
    var x = corner ? Number(corner.vowelX) : NaN;
    var y = corner ? Number(corner.vowelY) : NaN;
    var s = corner ? Number(corner.vowelStrength) : NaN;
    return {
      x: isFinite(x) ? clamp(x, 0, 1) : VOWEL_HOME.x,
      y: isFinite(y) ? clamp(y, 0, 1) : VOWEL_HOME.y,
      strength: isFinite(s) ? clamp(s, 0, 1) : DEFAULTS.vowelStrength
    };
  }

  // log(F1'/F1), log(F2'/F2) of a corner's vowel, strength included.
  function vowelShift(v) {
    if (!HuhVowel) return [0, 0];
    var r = HuhVowel.ratiosAt(v.x, v.y);
    return [v.strength * Math.log(r[0]), v.strength * Math.log(r[1])];
  }

  /**
   * The vowel blends in log F1 / log F2 (how far each corner moves the
   * formants, strength included), bilinear like the other knobs with the
   * center pinned to the huh's own vowel, then goes back to a chart point
   * at strength 1. Corners without a vowel count as the huh's own vowel.
   */
  function mixVowel(tx, ty, pin, corners) {
    var home = { x: VOWEL_HOME.x, y: VOWEL_HOME.y, strength: DEFAULTS.vowelStrength };
    if (!HuhVowel) return home;
    var ids = ['unbotheredDry', 'annoyedDry', 'unbotheredShocked', 'annoyedShocked'];
    var w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    var center = [0.25, 0.25, 0.25, 0.25];
    var d1 = 0;
    var d2 = 0;
    for (var i = 0; i < 4; i++) {
      var sh = vowelShift(cornerVowel(corners, ids[i]));
      var k = w[i] - center[i] * pin;
      d1 += k * sh[0];
      d2 += k * sh[1];
    }
    if (Math.abs(d1) < 1e-6 && Math.abs(d2) < 1e-6) return home;
    return vowelFromShift(d1, d2);
  }

  function vowelFromShift(d1, d2) {
    var at = HuhVowel.chartAt(VOWEL_HOME.x, VOWEL_HOME.y);
    var pt = HuhVowel.chartPoint(at[0] * Math.exp(d1), at[1] * Math.exp(d2));
    return { x: clamp(pt.x, 0, 1), y: clamp(pt.y, 0, 1), strength: 1 };
  }

  /**
   * The chart point that is actually rendered: strength moves the target
   * toward the huh's own vowel in log F1 / log F2. Null means no change.
   */
  function vowelPoint(params) {
    var p = normalizeParams(params);
    if (!HuhVowel || !(p.vowelStrength > 0)) return null;
    if (Math.abs(p.vowelX - VOWEL_HOME.x) < 1e-6 && Math.abs(p.vowelY - VOWEL_HOME.y) < 1e-6) return null;
    if (p.vowelStrength >= 1) return { x: p.vowelX, y: p.vowelY };
    var sh = vowelShift({ x: p.vowelX, y: p.vowelY, strength: p.vowelStrength });
    if (Math.abs(sh[0]) < 1e-6 && Math.abs(sh[1]) < 1e-6) return null;
    var v = vowelFromShift(sh[0], sh[1]);
    return { x: v.x, y: v.y };
  }

  function cosineInterp(a, b, u) {
    var t = clamp(u, 0, 1);
    var w = 0.5 * (1 - Math.cos(Math.PI * t));
    return a + (b - a) * w;
  }

  /**
   * Contour in semitones at normalized time t.
   * Anchors: t=0 -> 0, t=peakAt -> +rise, t=1 -> rise-fall.
   * Raised cosine on each side. If peakAt is 0 or 1 the anchors share an
   * endpoint: t=0 stays 0 and t=1 stays rise-fall.
   */
  function contourAt(t, params) {
    var p = normalizeParams(params);
    var x = clamp(Number(t) || 0, 0, 1);
    var rise = p.riseSemitones;
    var end = rise - p.fallSemitones;
    var peak = p.peakAt;
    if (x <= 0) return 0;
    if (x >= 1) return end;
    if (peak <= 0) return cosineInterp(rise, end, x);
    if (peak >= 1) return cosineInterp(0, rise, x);
    if (x < peak) return cosineInterp(0, rise, x / peak);
    return cosineInterp(rise, end, (x - peak) / (1 - peak));
  }

  /** 0 at the ends, 1 at peakAt, raised cosine on each side. */
  function accentShape(t, peakAt) {
    var x = clamp(Number(t) || 0, 0, 1);
    var peak = clamp(Number(peakAt) || 0, 0, 1);
    if (peak <= 0) return cosineInterp(1, 0, x);
    if (peak >= 1) return cosineInterp(0, 1, x);
    if (x < peak) return cosineInterp(0, 1, x / peak);
    return cosineInterp(1, 0, (x - peak) / (1 - peak));
  }

  function trimSilence(input, sampleRate) {
    var thresh = 0.02;
    var start = 0;
    var end = input.length - 1;
    while (start < end && Math.abs(input[start]) < thresh) start++;
    while (end > start && Math.abs(input[end]) < thresh) end--;
    var pad = Math.round(0.015 * sampleRate);
    start = Math.max(0, start - pad);
    end = Math.min(input.length - 1, end + pad);
    if (end - start < Math.round(0.05 * sampleRate)) return input;
    return input.subarray(start, end + 1);
  }

  function applyGain(buffer, sampleRate, params) {
    var gain = Math.pow(10, params.gainDb / 20);
    var attackSamples = Math.round(params.attackMs * 0.001 * sampleRate);
    attackSamples = Math.min(Math.max(0, attackSamples), Math.round(buffer.length * 0.98));
    var out = new Float32Array(buffer.length);
    var peak = 0;
    var last = Math.max(1, buffer.length - 1);
    for (var i = 0; i < buffer.length; i++) {
      var attack = 1;
      if (attackSamples > 0 && i < attackSamples) {
        var u = i / attackSamples;
        attack = u * u;
      }
      var bump = accentShape(i / last, params.peakAt);
      var shaped = bump * bump * bump;
      var accent = (1 - params.accent) + params.accent * shaped;
      var s = buffer[i] * attack * accent * gain;
      if (!isFinite(s)) s = 0;
      out[i] = s;
      var a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    if (peak > 0.98) {
      var trim = 0.98 / peak;
      for (var j = 0; j < out.length; j++) out[j] *= trim;
    }
    return out;
  }


  function envelopeAt(t, params, durationSec) {
    var p = normalizeParams(params);
    var x = clamp(Number(t) || 0, 0, 1);
    var dur = Number(durationSec);
    if (!(dur > 0)) dur = 0.39;
    var attackFrac = Math.min(0.98, (p.attackMs * 0.001) / dur);
    var attack = 1;
    if (attackFrac > 0 && x < attackFrac) {
      var u = x / attackFrac;
      attack = u * u;
    }
    var bump = accentShape(x, p.peakAt);
    var shaped = bump * bump * bump;
    var accent = (1 - p.accent) + p.accent * shaped;
    return attack * accent;
  }

  // ---- voice analysis: f0, periodicity, and the h|u boundary ----

  // Lowpass then keep every factor-th sample (for the f0 search only).
  function decimate(x, factor) {
    if (factor <= 1) return x;
    var taps = 8 * factor + 1;
    var mid = (taps - 1) / 2;
    var cut = 0.45 / factor;
    var h = new Float64Array(taps);
    var sum = 0;
    for (var i = 0; i < taps; i++) {
      var d = i - mid;
      var sinc = d === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * d) / (Math.PI * d);
      h[i] = sinc * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)));
      sum += h[i];
    }
    var out = new Float32Array(Math.floor(x.length / factor));
    for (var o = 0; o < out.length; o++) {
      var c = o * factor;
      var acc = 0;
      for (var k = 0; k < taps; k++) {
        var at = c + k - mid;
        if (at >= 0 && at < x.length) acc += x[at] * h[k];
      }
      out[o] = acc / sum;
    }
    return out;
  }

  var VOICED_AP = 0.3;
  var VOICED_FLOOR_DB = 30;
  var VOICED_RUN = 4;

  /**
   * YIN f0 and aperiodicity every 5 ms on a ~11 kHz copy of the voice.
   * boundary is the first sample of the "u": the start of the first run of
   * VOICED_RUN voiced frames (aperiodicity under VOICED_AP and within
   * VOICED_FLOOR_DB of the loudest frame), moved back a quarter window.
   * boundary is null when no voiced run is found.
   */
  function analyzeVoice(voiced, sampleRate, tuning) {
    var apLimit = tuning && tuning.ap ? tuning.ap : VOICED_AP;
    var floorDb = tuning && tuning.floorDb ? tuning.floorDb : VOICED_FLOOR_DB;
    var needRun = tuning && tuning.run ? tuning.run : VOICED_RUN;
    var factor = Math.max(1, Math.round(sampleRate / 11025));
    var rate = sampleRate / factor;
    var y = decimate(voiced, factor);
    var win = Math.round(0.03 * rate);
    var hop = Math.round(0.005 * rate);
    var minLag = Math.max(2, Math.floor(rate / 600));
    var maxLag = Math.ceil(rate / 60);
    var frames = [];
    var d = new Float64Array(maxLag + 2);
    for (var start = 0; start + win + maxLag + 1 <= y.length; start += hop) {
      var e = 0;
      for (var i = 0; i < win; i++) e += y[start + i] * y[start + i];
      var run = 0;
      d[0] = 1;
      for (var tau = 1; tau <= maxLag + 1; tau++) {
        var acc = 0;
        for (var j = 0; j < win; j++) {
          var q = y[start + j] - y[start + j + tau];
          acc += q * q;
        }
        run += acc;
        d[tau] = run > 0 ? acc * tau / run : 1;
      }
      var best = -1;
      for (var t = minLag; t <= maxLag; t++) {
        if (d[t] < 0.25 && d[t] < d[t - 1] && d[t] <= d[t + 1]) { best = t; break; }
      }
      if (best < 0) {
        var bv = Infinity;
        for (var t2 = minLag; t2 <= maxLag; t2++) if (d[t2] < bv) { bv = d[t2]; best = t2; }
      }
      var a0 = d[best - 1];
      var b0 = d[best];
      var c0 = d[best + 1];
      var den = a0 - 2 * b0 + c0;
      var shift = den > 0 ? 0.5 * (a0 - c0) / den : 0;
      if (shift > 0.5) shift = 0.5;
      if (shift < -0.5) shift = -0.5;
      frames.push({
        center: (start + win / 2) * factor,
        f0: rate / (best + shift),
        ap: Math.max(0, b0),
        db: 10 * Math.log10(e / win + 1e-12)
      });
    }
    var loud = -Infinity;
    for (var f = 0; f < frames.length; f++) if (frames[f].db > loud) loud = frames[f].db;
    for (var g = 0; g < frames.length; g++) {
      frames[g].voiced = frames[g].ap < apLimit && frames[g].db > loud - floorDb;
    }
    var boundary = null;
    for (var k = 0; k + needRun <= frames.length; k++) {
      var all = true;
      for (var r = 0; r < needRun; r++) if (!frames[k + r].voiced) { all = false; break; }
      if (all) {
        boundary = Math.max(0, Math.round(frames[k].center - 0.25 * win * factor));
        break;
      }
    }
    return { frames: frames, boundary: boundary, length: voiced.length, sampleRate: sampleRate };
  }

  // Pitch contour: TD-PSOLA on the Rubber Band output (Rubber Band runs at
  // the flat pitchSemitones). Each voiced pitch period is re-spaced by the
  // local contour ratio without resampling, so the formants (the vowel)
  // stay where they are while the pitch rises and falls. Unvoiced parts
  // (the h) are copied through (constant-overlap Hann grains, ratio 1).
  var PSOLA_AP = 0.6;
  var PSOLA_FLOOR_DB = 40;
  var PSOLA_GAP_SEC = 0.04;
  var PSOLA_ISLAND_SEC = 0.025;
  var PSOLA_UNVOICED_SEC = 0.005;

  function periodCorr(x, p, k, hw) {
    var s = 0;
    var ea = 0;
    var eb = 0;
    for (var j = -hw; j < hw; j++) {
      var a = x[p + j] || 0;
      var b = x[k + j] || 0;
      s += a * b;
      ea += a * a;
      eb += b * b;
    }
    return s / Math.sqrt(ea * eb + 1e-20);
  }

  function pitchMarks(y, sampleRate) {
    var n = y.length;
    var fr = analyzeVoice(y, sampleRate).frames;
    var count = fr.length;
    var T = new Float64Array(n);
    if (count) {
      var loud = -Infinity;
      for (var i = 0; i < count; i++) if (fr[i].db > loud) loud = fr[i].db;
      var v = [];
      var f0 = [];
      for (var i2 = 0; i2 < count; i2++) {
        v.push(fr[i2].ap < PSOLA_AP && fr[i2].db > loud - PSOLA_FLOOR_DB);
        var w = [];
        for (var j = -2; j <= 2; j++) if (fr[i2 + j]) w.push(fr[i2 + j].f0);
        w.sort(function (a, b) { return a - b; });
        f0.push(w[w.length >> 1]);
      }
      var step = count > 1 ? (fr[1].center - fr[0].center) / sampleRate : 0.005;
      // Fill short unvoiced gaps inside voicing, then drop short voiced islands.
      var a0 = 0;
      while (a0 < count) {
        if (v[a0]) { a0++; continue; }
        var b0 = a0;
        while (b0 < count && !v[b0]) b0++;
        if (a0 > 0 && b0 < count && (b0 - a0) * step <= PSOLA_GAP_SEC) for (var q0 = a0; q0 < b0; q0++) v[q0] = true;
        a0 = b0;
      }
      a0 = 0;
      while (a0 < count) {
        if (!v[a0]) { a0++; continue; }
        var b1 = a0;
        while (b1 < count && v[b1]) b1++;
        if ((b1 - a0) * step < PSOLA_ISLAND_SEC) for (var q1 = a0; q1 < b1; q1++) v[q1] = false;
        a0 = b1;
      }
      for (var f = 0; f < count; f++) {
        if (!v[f]) continue;
        var lo = f === 0 ? 0 : Math.round((fr[f - 1].center + fr[f].center) / 2);
        var hi = f === count - 1 ? n : Math.round((fr[f].center + fr[f + 1].center) / 2);
        for (var s0 = Math.max(0, lo); s0 < Math.min(n, hi); s0++) T[s0] = sampleRate / f0[f];
      }
    }
    // 1 ms energy (first mark of a voiced run) and a 4x decimated copy (coarse search).
    var e = new Float64Array(n);
    var ew = Math.max(1, Math.round(0.001 * sampleRate));
    var run = 0;
    for (var i3 = 0; i3 < n + ew; i3++) {
      if (i3 < n) run += y[i3] * y[i3];
      if (i3 - ew >= 0) run -= y[i3 - ew] * y[i3 - ew];
      var c = i3 - (ew >> 1);
      if (c >= 0 && c < n) e[c] = run;
    }
    var yd = new Float64Array(Math.ceil(n / 4));
    for (var i4 = 0; i4 < n; i4++) yd[i4 >> 2] += y[i4] * 0.25;

    var marks = [];
    var voiced = [];
    var tu = Math.round(PSOLA_UNVOICED_SEC * sampleRate);
    var t = 0;
    while (t < n) {
      if (T[t] > 0) {
        var end = t;
        while (end < n && T[end] > 0) end++;
        var p = t;
        var best = -1;
        var first = Math.min(end, t + Math.round(T[t]));
        for (var k = t; k < first; k++) if (e[k] > best) { best = e[k]; p = k; }
        var last = marks.length ? marks[marks.length - 1] : -1;
        if (last >= 0 && p - last > 1.5 * tu) {
          for (var u = last + tu; u < p - 0.5 * tu; u += tu) { marks.push(u); voiced.push(false); }
        }
        while (p < end) {
          if (!marks.length || p > marks[marks.length - 1]) { marks.push(p); voiced.push(true); }
          // Next mark: the shift that best matches this period's waveform.
          var P = T[p];
          var pred = p + P;
          var from = Math.max(p + 1, Math.round(pred - 0.3 * P));
          var to = Math.min(n - 1, Math.round(pred + 0.3 * P));
          if (from >= end) break;
          var hw = Math.round(P) >> 1;
          var hw4 = Math.max(2, hw >> 2);
          var p4 = Math.round(p / 4);
          var cb = -Infinity;
          var ck = Math.round(pred);
          for (var k4 = Math.ceil(from / 4); k4 <= Math.floor(to / 4); k4++) {
            var cc = periodCorr(yd, p4, k4, hw4);
            if (cc > cb) { cb = cc; ck = k4 * 4; }
          }
          var bp = ck;
          var bv = -Infinity;
          for (var k5 = Math.max(p + 1, ck - 4); k5 <= Math.min(n - 1, ck + 4); k5++) {
            var c5 = periodCorr(y, p, k5, hw);
            if (c5 > bv) { bv = c5; bp = k5; }
          }
          if (bp >= end) break;
          p = bp;
        }
        t = end;
      } else {
        var lastU = marks.length ? marks[marks.length - 1] : -tu;
        var mq = Math.max(t, lastU + tu);
        if (mq < n && T[mq] === 0) { marks.push(mq); voiced.push(false); }
        t = mq + 1;
        while (t < n && T[t] === 0 && t < mq + tu) t++;
      }
    }
    return { marks: marks, voiced: voiced, unvoicedStep: tu };
  }

  function psolaContour(y, sampleRate, ratioAt) {
    var n = y.length;
    var pm = pitchMarks(y, sampleRate);
    var marks = pm.marks;
    var K = marks.length;
    if (K < 3) return y;
    var out = new Float64Array(n);
    var ts = marks[0];
    var k = 0;
    while (ts < n) {
      while (k + 1 < K && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
      var a = marks[k];
      var L = k > 0 ? a - marks[k - 1] : (k + 1 < K ? marks[k + 1] - a : pm.unvoicedStep);
      var R = k + 1 < K ? marks[k + 1] - a : L;
      var r = pm.voiced[k] ? ratioAt(ts / n) : 1;
      // Grains come r times as often, so 1/sqrt(r) keeps the level.
      var amp = 1 / Math.sqrt(r);
      var c = Math.round(ts);
      for (var d = -L + 1; d < R; d++) {
        var src = a + d;
        var dst = c + d;
        if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
        var w = d < 0 ? 0.5 + 0.5 * Math.cos(Math.PI * d / L) : 0.5 + 0.5 * Math.cos(Math.PI * d / R);
        out[dst] += y[src] * w * amp;
      }
      ts += R / r;
    }
    var res = new Float32Array(n);
    for (var i = 0; i < n; i++) res[i] = i < marks[0] ? y[i] : out[i];
    return res;
  }

  var analysisCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  // The trimmed voice is a subarray of the decoded clip, so cache on the clip.
  function cachedAnalysis(input, voiced, sampleRate) {
    var key = voiced.byteOffset + ':' + voiced.length + ':' + sampleRate;
    var slot = analysisCache ? analysisCache.get(input) : null;
    if (slot && slot.key === key) return slot;
    slot = { key: key, voice: analyzeVoice(voiced, sampleRate) };
    if (analysisCache) analysisCache.set(input, slot);
    return slot;
  }

  var U_RAMP_SEC = 0.015;

  /** Output fraction where the u starts, or null. info is HuhAudio.analyzeClip. */
  function boundaryAt(params, info) {
    if (!info || info.boundary === null || !(info.length > 0)) return null;
    var p = normalizeParams(params);
    var b = info.boundary;
    var n = info.length;
    var ramp = Math.round(U_RAMP_SEC * info.sampleRate);
    var r = Math.min(ramp, n - b);
    var outLen = b + r * (1 + p.vowelScale) / 2 + Math.max(0, n - b - r) * p.vowelScale;
    return outLen > 0 ? b / outLen : null;
  }

  /**
   * Runs the clip analysis (the h|u boundary) ahead of time so a later
   * render with a u length (for example inside a Play tap) skips it.
   */
  function prepareClip(audioBuffer) {
    var input = monoChannel(audioBuffer);
    var rate = audioBuffer.sampleRate;
    cachedAnalysis(input, trimSilence(input, rate), rate);
  }

  /** Analysis of the trimmed clip: boundary (samples into it) and length. */
  function analyzeClip(audioBuffer) {
    var input = monoChannel(audioBuffer);
    var rate = audioBuffer.sampleRate;
    var voiced = trimSilence(input, rate);
    var slot = cachedAnalysis(input, voiced, rate);
    return {
      boundary: slot.voice.boundary,
      boundarySec: slot.voice.boundary === null ? null : slot.voice.boundary / rate,
      length: voiced.length,
      sampleRate: rate
    };
  }

  function renderMono(input, sampleRate, params) {
    var p = normalizeParams(params);
    var rb = rubberband();
    if (!rb.isReady()) throw new Error('Rubber Band is not loaded');
    if (!(sampleRate > 0) || !isFinite(sampleRate)) throw new Error('sampleRate must be positive');
    if (!input || input.length === 0) return new Float32Array(1);
    var trimmed = trimSilence(input, sampleRate);
    var voiced = trimmed;
    // The vowel stage runs only off the default vowel (and only on clip A,
    // whose formant tracks huh-vowel.js carries; other clips pass through).
    var vp = vowelPoint(p);
    if (vp) voiced = HuhVowel.shiftVowel(trimmed, sampleRate, vp.x, vp.y, 1);
    var options = { keepVowel: p.keepVowel };
    if (p.vowelScale !== 1) {
      var slot = cachedAnalysis(input, trimmed, sampleRate);
      if (slot.voice.boundary !== null) {
        options.split = {
          at: slot.voice.boundary,
          after: p.vowelScale,
          ramp: Math.round(U_RAMP_SEC * sampleRate)
        };
      }
    }
    var rendered;
    if (p.riseSemitones === 0 && p.fallSemitones === 0) {
      rendered = rb.stretchMono(voiced, sampleRate, p.durationScale, function (t) {
        return Math.pow(2, (p.pitchSemitones + contourAt(t, p)) / 12);
      }, options);
    } else {
      // Contour: Rubber Band at the flat pitch, then PSOLA moves the pitch
      // along the contour with the formants held (no vowel slide).
      var flat = Math.pow(2, p.pitchSemitones / 12);
      rendered = rb.stretchMono(voiced, sampleRate, p.durationScale, function () { return flat; }, options);
      rendered = psolaContour(rendered, sampleRate, function (t) {
        return Math.pow(2, contourAt(t, p) / 12);
      });
    }
    return applyGain(rendered, sampleRate, p);
  }

  /**
   * Runs the vowel stage once and drops the result, so the first real
   * vowel render is not the slow one (JIT and FFT tables). Call at load.
   */
  function warmVowel(audioBuffer) {
    if (!HuhVowel || !audioBuffer) return false;
    var voiced = trimSilence(monoChannel(audioBuffer), audioBuffer.sampleRate);
    HuhVowel.shiftVowel(voiced, audioBuffer.sampleRate, 0.3, 0.3, 1);
    return true;
  }

  function previewMono(input, sampleRate, params) {
    var p = normalizeParams(params);
    if (!input || input.length === 0) return new Float32Array(1);
    var voiced = trimSilence(input, sampleRate);
    var outLen = Math.max(1, Math.round(voiced.length * p.durationScale));
    var stretched = new Float32Array(outLen);
    var last = voiced.length - 1;
    for (var i = 0; i < outLen; i++) {
      var src = outLen === 1 ? 0 : (i / (outLen - 1)) * last;
      var i0 = Math.floor(src);
      var f = src - i0;
      var a = voiced[i0];
      var b = voiced[Math.min(last, i0 + 1)];
      stretched[i] = a + (b - a) * f;
    }
    return applyGain(stretched, sampleRate, p);
  }

  function monoChannel(audioBuffer) {
    var n = audioBuffer.length;
    if (audioBuffer.numberOfChannels <= 1) return audioBuffer.getChannelData(0);
    var mixed = new Float32Array(n);
    var chs = audioBuffer.numberOfChannels;
    for (var c = 0; c < chs; c++) {
      var data = audioBuffer.getChannelData(c);
      for (var i = 0; i < n; i++) mixed[i] += data[i];
    }
    var inv = 1 / chs;
    for (var j = 0; j < n; j++) mixed[j] *= inv;
    return mixed;
  }

  function audioBufferFromMono(samples, sampleRate) {
    var length = Math.max(1, samples.length);
    var offline = new OfflineAudioContext(1, 1, sampleRate);
    var buf = offline.createBuffer(1, length, sampleRate);
    buf.getChannelData(0).set(samples.subarray(0, length));
    return buf;
  }

  function renderHuh(audioBuffer, params) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('renderHuh expects an AudioBuffer');
    }
    var rendered = renderMono(monoChannel(audioBuffer), audioBuffer.sampleRate, params);
    return audioBufferFromMono(rendered, audioBuffer.sampleRate);
  }

  function gestureContext() {
    var Ctor = null;
    if (typeof AudioContext !== 'undefined') Ctor = AudioContext;
    else if (typeof webkitAudioContext !== 'undefined') Ctor = webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext is not available');
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctor();
    try {
      var resumed = sharedCtx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {});
    } catch (err) {}
    return sharedCtx;
  }

  function ensureContext() {
    if (!sharedCtx || sharedCtx.state === 'closed') throw new Error('AudioContext is created on Play');
    return sharedCtx;
  }

  // Do not call this from a page-load or document pointerdown path.
  // Closing the context iOS unlocked makes the next buffer silent.
  function replaceContext() {
    throw new Error('AudioContext stays the one created on Play');
  }

  function resumeForGesture() {
    if (!sharedCtx || sharedCtx.state === 'closed') return null;
    try { sharedCtx.resume(); } catch (err) {}
    return sharedCtx;
  }

  function bufferOnContext(ctx, audioBuffer) {
    if (!ctx) throw new Error('bufferOnContext needs an AudioContext');
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('bufferOnContext expects an AudioBuffer');
    }
    var channels = audioBuffer.numberOfChannels;
    var srcRate = audioBuffer.sampleRate;
    var dstRate = ctx.sampleRate > 0 ? ctx.sampleRate : srcRate;
    var dstLen = audioBuffer.length;
    if (srcRate > 0 && dstRate !== srcRate) {
      dstLen = Math.max(1, Math.round(audioBuffer.length * dstRate / srcRate));
    }
    var copy = ctx.createBuffer(channels, dstLen, dstRate);
    for (var c = 0; c < channels; c++) {
      var src = audioBuffer.getChannelData(c);
      var dst = copy.getChannelData(c);
      if (dstLen === src.length) {
        dst.set(src);
        continue;
      }
      var last = Math.max(0, src.length - 1);
      for (var i = 0; i < dstLen; i++) {
        var pos = dstLen === 1 ? 0 : (i / (dstLen - 1)) * last;
        var i0 = Math.floor(pos);
        var frac = pos - i0;
        var a = src[i0] || 0;
        var b = src[Math.min(last, i0 + 1)] || 0;
        dst[i] = a + (b - a) * frac;
      }
    }
    return copy;
  }

  function stopActive() {
    if (!activeSource) return;
    var src = activeSource;
    activeSource = null;
    try { src.stop(0); } catch (err) {}
    try { src.disconnect(); } catch (err2) {}
  }

  function peakAbs(audioBuffer) {
    var peak = 0;
    var channels = audioBuffer.numberOfChannels || 1;
    for (var c = 0; c < channels; c++) {
      var data = audioBuffer.getChannelData(c);
      for (var i = 0; i < data.length; i++) {
        var a = data[i] < 0 ? -data[i] : data[i];
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  function silentBuffer(ctx) {
    var rate = ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
    var frames = Math.max(128, Math.round(rate * 0.02));
    return ctx.createBuffer(1, frames, rate);
  }

  // Call this synchronously from the Play click or touch.
  // source.start(0) runs before this function returns.
  function playBufferInGesture(buffer) {
    var token = ++playToken;
    var ctx = gestureContext();
    stopActive();
    var silent = !(buffer && typeof buffer.getChannelData === 'function' && buffer.length > 0);
    var playBuf = silent ? silentBuffer(ctx) : bufferOnContext(ctx, buffer);
    var src = ctx.createBufferSource();
    src.buffer = playBuf;
    src.connect(ctx.destination);
    src.start(0);
    activeSource = src;
    src.onended = function () {
      if (activeSource === src) activeSource = null;
    };
    return {
      token: token,
      ctx: ctx,
      source: src,
      started: true,
      silent: silent,
      duration: playBuf.duration,
      peak: peakAbs(playBuf),
      error: null
    };
  }

  function startBufferIfCurrent(token, buffer) {
    if (token !== playToken) return null;
    var ctx = sharedCtx;
    if (!ctx || ctx.state === 'closed') throw new Error('audio context closed');
    if (!buffer || typeof buffer.getChannelData !== 'function' || !(buffer.length > 0)) {
      throw new Error('no audio buffer');
    }
    try {
      var resumed = ctx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {});
    } catch (err) {}
    stopActive();
    var playBuf = bufferOnContext(ctx, buffer);
    var src = ctx.createBufferSource();
    src.buffer = playBuf;
    src.connect(ctx.destination);
    src.start(0);
    activeSource = src;
    src.onended = function () {
      if (activeSource === src) activeSource = null;
    };
    return {
      token: token,
      ctx: ctx,
      source: src,
      started: true,
      silent: false,
      duration: playBuf.duration,
      peak: peakAbs(playBuf),
      error: null
    };
  }

  function currentPlayToken() {
    return playToken;
  }

  function play() {
    throw new Error('Play the voice with the audio element');
  }


  function peakOf(audioBuffer) {
    return peakAbs(audioBuffer);
  }

  function encodeWav(audioBuffer) {
    var samples = monoChannel(audioBuffer);
    var rate = audioBuffer.sampleRate > 0 ? Math.round(audioBuffer.sampleRate) : 44100;
    var n = samples.length;
    var bytes = new ArrayBuffer(44 + n * 2);
    var view = new DataView(bytes);
    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, n * 2, true);
    var offset = 44;
    for (var i = 0; i < n; i++) {
      var s = samples[i];
      if (!isFinite(s)) s = 0;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      var q = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      if (q < -32768) q = -32768;
      if (q > 32767) q = 32767;
      view.setInt16(offset, q, true);
      offset += 2;
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }

  function wavSampleRate(bytes) {
    if (!bytes || bytes.byteLength < 28) return 44100;
    try {
      var view = new DataView(bytes);
      var rate = view.getUint32(24, true);
      if (rate >= 8000 && rate <= 192000) return rate;
    } catch (err) {}
    return 44100;
  }

  function offlineAt(rate) {
    var Ctor = null;
    if (typeof OfflineAudioContext !== 'undefined') Ctor = OfflineAudioContext;
    else if (typeof webkitOfflineAudioContext !== 'undefined') Ctor = webkitOfflineAudioContext;
    if (!Ctor) throw new Error('OfflineAudioContext is not available');
    try { return new Ctor(1, 1, rate); }
    catch (err) { return new Ctor(1, 1, 44100); }
  }

  function decodePcmWav(bytes) {
    var view = new DataView(bytes);
    if (view.byteLength < 44) throw new Error('wav too small');
    var channels = view.getUint16(22, true) || 1;
    var rate = view.getUint32(24, true) || 44100;
    var bits = view.getUint16(34, true) || 16;
    var offset = 12;
    var dataOffset = 44;
    var dataSize = view.byteLength - 44;
    while (offset + 8 <= view.byteLength) {
      var id = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      var size = view.getUint32(offset + 4, true);
      if (id === 'data') {
        dataOffset = offset + 8;
        dataSize = size;
        break;
      }
      offset += 8 + size + (size & 1);
    }
    var width = Math.max(1, bits >> 3);
    var frames = Math.floor(dataSize / (width * channels));
    var mono = new Float32Array(Math.max(1, frames));
    for (var i = 0; i < frames; i++) {
      var acc = 0;
      for (var c = 0; c < channels; c++) {
        var pos = dataOffset + (i * channels + c) * width;
        var s = 0;
        if (bits === 16) {
          var sample = view.getInt16(pos, true);
          s = sample < 0 ? sample / 32768 : sample / 32767;
        } else if (bits === 8) {
          s = (view.getUint8(pos) - 128) / 128;
        } else if (bits === 32) {
          s = view.getFloat32(pos, true);
        }
        acc += s;
      }
      mono[i] = acc / channels;
    }
    return audioBufferFromMono(mono, rate);
  }

  function decodeWavOffline(bytes) {
    var copy = bytes.slice(0);
    var rate = wavSampleRate(bytes);
    var offline;
    try { offline = offlineAt(rate); }
    catch (err) { return Promise.resolve(decodePcmWav(bytes)); }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function ok(buf) {
        if (settled) return;
        settled = true;
        resolve(buf);
      }
      function bad(err) {
        if (settled) return;
        settled = true;
        try { resolve(decodePcmWav(bytes)); }
        catch (err2) { reject(err || err2 || new Error('decodeAudioData failed')); }
      }
      var pending;
      try { pending = offline.decodeAudioData(copy, ok, bad); }
      catch (err3) { bad(err3); return; }
      if (pending && typeof pending.then === 'function') pending.then(ok, bad);
    });
  }

  function fetchWavBytes(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
      return res.arrayBuffer();
    });
  }

  function decodeOnContext(ctx, bytes) {
    if (!ctx || ctx.state === 'closed') throw new Error('decode needs the playing AudioContext');
    var copy = bytes.slice(0);
    return new Promise(function (resolve, reject) {
      var settled = false;
      function ok(buf) {
        if (settled) return;
        settled = true;
        resolve(buf);
      }
      function bad(err) {
        if (settled) return;
        settled = true;
        reject(err || new Error('decodeAudioData failed'));
      }
      var pending;
      try {
        pending = ctx.decodeAudioData(copy, ok, bad);
      } catch (err) {
        bad(err);
        return;
      }
      if (pending && typeof pending.then === 'function') pending.then(ok, bad);
    });
  }

  function loadWav(url) {
    return fetchWavBytes(url).then(function (bytes) {
      return decodeWavOffline(bytes);
    });
  }

  function loadEngine(source) {
    return rubberband().load(source);
  }

  return {
    DEFAULTS: DEFAULTS,
    RANGES: RANGES,
    contourAt: contourAt,
    accentShape: accentShape,
    envelopeAt: envelopeAt,
    analyzeClip: analyzeClip,
    prepareClip: prepareClip,
    boundaryAt: boundaryAt,
    _analyzeVoice: analyzeVoice,
    _psolaContour: psolaContour,
    vowelPoint: vowelPoint,
    warmVowel: warmVowel,
    VOWEL_HOME: VOWEL_HOME,
    renderMono: renderMono,
    previewMono: previewMono,
    renderHuh: renderHuh,
    play: play,
    loadWav: loadWav,
    loadEngine: loadEngine,
    ensureContext: ensureContext,
    replaceContext: replaceContext,
    resumeForGesture: resumeForGesture,
    bufferOnContext: bufferOnContext,
    mixParams: mixParams,
    playBufferInGesture: playBufferInGesture,
    startBufferIfCurrent: startBufferIfCurrent,
    currentPlayToken: currentPlayToken,
    fetchWavBytes: fetchWavBytes,
    decodeOnContext: decodeOnContext,
    decodeWavOffline: decodeWavOffline,
    encodeWav: encodeWav,
    peakOf: peakOf
  };
});
