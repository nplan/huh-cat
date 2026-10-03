'use strict';

/**
 * Browser-only granular pitch shift + time stretch.
 * Pitch (playback rate) and duration (hop ratio) are independent.
 * Contour is a two-segment raised-cosine curve over the output.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HuhAudio = api;
  }
})(function () {
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

  /** Raised-cosine blend. u=0 -> a, u=1 -> b, flat derivative at both ends. */
  function cosineInterp(a, b, u) {
    var t = clamp(u, 0, 1);
    var w = 0.5 * (1 - Math.cos(Math.PI * t));
    return a + (b - a) * w;
  }

  /**
   * Contour in semitones at normalized output time t.
   * Anchors: t=0 -> 0, t=peakAt -> +rise, t=1 -> rise-fall.
   * If peakAt is 0 or 1 the two anchors share an endpoint; t=0 stays 0 and
   * t=1 stays rise-fall, and the zero-length segment does not draw a line.
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

  function sampleAt(input, pos) {
    var n = input.length;
    if (n === 0 || pos < 0 || pos > n - 1) return 0;
    var i = pos | 0;
    if (i >= n - 1) return input[n - 1];
    var f = pos - i;
    return input[i] * (1 - f) + input[i + 1] * f;
  }

  /**
   * Overlap-add grains. Output hop is fixed; input hop is output hop * inLen/outLen
   * so durationScale does not change pitch. Each grain is resampled at
   * 2^((pitchSemitones + contour)/12) with a Hann window.
   */
  function renderMono(input, sampleRate, params) {
    var p = normalizeParams(params);
    var inLen = input.length;
    var sr = sampleRate;
    if (!(sr > 0) || !isFinite(sr)) {
      throw new Error('sampleRate must be positive');
    }
    var outLen = Math.max(1, Math.round(inLen * p.durationScale));
    if (inLen === 0) {
      return new Float32Array(1);
    }

    var grain = Math.round(0.04 * sr);
    if (grain < 8) grain = 8;
    if (grain % 2) grain += 1;

    var hopOut = Math.max(1, Math.round(grain / 4));
    var hopIn = hopOut * (inLen / outLen);

    var hann = new Float32Array(grain);
    for (var i = 0; i < grain; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / grain));
    }

    var output = new Float32Array(outLen);
    var weight = new Float32Array(outLen);
    var grainIndex = 0;

    for (var o = 0; o < outLen; o += hopOut, grainIndex++) {
      var center = (o + grain * 0.5) / outLen;
      var semis = p.pitchSemitones + contourAt(center, p);
      var rate = Math.pow(2, semis / 12);
      var inStart = grainIndex * hopIn;
      var limit = grain;
      if (o + limit > outLen) limit = outLen - o;
      for (var k = 0; k < limit; k++) {
        var s = sampleAt(input, inStart + k * rate);
        var w = hann[k];
        var oi = o + k;
        output[oi] += s * w;
        weight[oi] += w;
      }
    }

    var gain = Math.pow(10, p.gainDb / 20);
    var peak = 0;
    for (var n = 0; n < outLen; n++) {
      var wsum = weight[n];
      var sample = wsum > 1e-8 ? (output[n] / wsum) * gain : 0;
      output[n] = sample;
      var a = sample < 0 ? -sample : sample;
      if (a > peak) peak = a;
    }
    if (peak > 0.98) {
      var trim = 0.98 / peak;
      for (var m = 0; m < outLen; m++) output[m] *= trim;
    }
    return output;
  }

  function monoChannel(audioBuffer) {
    var n = audioBuffer.length;
    if (audioBuffer.numberOfChannels <= 1) {
      return audioBuffer.getChannelData(0);
    }
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
    if (typeof AudioContext === 'undefined') {
      throw new Error('AudioContext is not available');
    }
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

  return {
    DEFAULTS: DEFAULTS,
    RANGES: RANGES,
    contourAt: contourAt,
    renderMono: renderMono,
    renderHuh: renderHuh,
    play: play,
    loadWav: loadWav,
    ensureContext: ensureContext
  };
});
