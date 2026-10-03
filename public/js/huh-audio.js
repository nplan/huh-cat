'use strict';

/**
 * huh lab renderer.
 * Rubber Band realtime R3 does the time stretch and the pitch shift
 * independently. The contour is setPitchScale about every 10 ms
 * (OptionPitchHighConsistency). OptionFormantPreserved keeps the vowel.
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
  if (typeof require === 'function') {
    RubberBand = require('../vendor/rubberband/rubberband.js');
  }

  var DEFAULTS = {
    pitchSemitones: 0,
    durationScale: 1,
    peakAt: 0.7,
    riseSemitones: 0,
    fallSemitones: 0,
    gainDb: 0,
    attackMs: 0,
    accent: 0,
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
    accent: [0, 1]
  };

  var sharedCtx = null;
  var activeSource = null;

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
    if (src.keepVowel === undefined || src.keepVowel === null) out.keepVowel = DEFAULTS.keepVowel;
    else out.keepVowel = !!src.keepVowel;
    return out;
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

  function renderMono(input, sampleRate, params) {
    var p = normalizeParams(params);
    var rb = rubberband();
    if (!rb.isReady()) throw new Error('Rubber Band is not loaded');
    if (!(sampleRate > 0) || !isFinite(sampleRate)) throw new Error('sampleRate must be positive');
    if (!input || input.length === 0) return new Float32Array(1);
    var voiced = trimSilence(input, sampleRate);
    var rendered = rb.stretchMono(voiced, sampleRate, p.durationScale, function (t) {
      return Math.pow(2, (p.pitchSemitones + contourAt(t, p)) / 12);
    }, { keepVowel: p.keepVowel });
    return applyGain(rendered, sampleRate, p);
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

  function ensureContext() {
    if (typeof AudioContext === 'undefined') throw new Error('AudioContext is not available');
    if (!sharedCtx) sharedCtx = new AudioContext();
    if (sharedCtx.state === 'suspended') sharedCtx.resume();
    return sharedCtx;
  }

  function play(buffer) {
    var ctx = ensureContext();
    if (activeSource) {
      try { activeSource.stop(0); } catch (e) {}
      try { activeSource.disconnect(); } catch (e2) {}
      activeSource = null;
    }
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    activeSource = src;
    src.onended = function () {
      if (activeSource === src) activeSource = null;
    };
    return src;
  }

  function loadWav(url) {
    var ctx = ensureContext();
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
      return res.arrayBuffer();
    }).then(function (bytes) {
      return ctx.decodeAudioData(bytes.slice(0));
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
    renderMono: renderMono,
    previewMono: previewMono,
    renderHuh: renderHuh,
    play: play,
    loadWav: loadWav,
    loadEngine: loadEngine,
    ensureContext: ensureContext
  };
});
