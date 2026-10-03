'use strict';

/**
 * huh lab renderer.
 * Rubber Band realtime R3 does the time stretch and the pitch shift
 * independently. Offline mode freezes pitch at study(), so the contour is
 * Rubber Band's time-varying pitch API: setPitchScale every ~50 ms with
 * OptionPitchHighConsistency. The start delay is trimmed and the flush tail
 * is cut so the length is the input length times durationScale.
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
    gainDb: 0
  };

  var RANGES = {
    pitchSemitones: [-8, 12],
    durationScale: [0.45, 1.8],
    peakAt: [0, 1],
    riseSemitones: [0, 12],
    fallSemitones: [0, 14],
    gainDb: [-12, 6]
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
      var range = RANGES[key];
      var n = Number(src[key]);
      if (!isFinite(n)) n = DEFAULTS[key];
      out[key] = clamp(n, range[0], range[1]);
    }
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

  function applyGain(buffer, gainDb) {
    var gain = Math.pow(10, gainDb / 20);
    var out = new Float32Array(buffer.length);
    var peak = 0;
    for (var i = 0; i < buffer.length; i++) {
      var s = buffer[i] * gain;
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

  function renderMono(input, sampleRate, params) {
    var p = normalizeParams(params);
    var rb = rubberband();
    if (!rb.isReady()) throw new Error('Rubber Band is not loaded');
    if (!(sampleRate > 0) || !isFinite(sampleRate)) throw new Error('sampleRate must be positive');
    if (!input || input.length === 0) return new Float32Array(1);
    var rendered = rb.stretchMono(input, sampleRate, p.durationScale, function (t) {
      return Math.pow(2, (p.pitchSemitones + contourAt(t, p)) / 12);
    });
    return applyGain(rendered, p.gainDb);
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
    renderMono: renderMono,
    renderHuh: renderHuh,
    play: play,
    loadWav: loadWav,
    loadEngine: loadEngine,
    ensureContext: ensureContext
  };
});
