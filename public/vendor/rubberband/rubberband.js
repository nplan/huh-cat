'use strict';

/**
 * Rubber Band Library 3.3.0 (breakfastquay.com/rubberband) compiled to
 * WebAssembly by Daninet/rubberband-wasm 3.3.0.
 * License: GNU GPL v2 or later (see LICENSE in this directory).
 * A commercial Rubber Band licence is required to ship this in a closed-source app.
 * Standalone wasm + this glue; nothing is fetched from a CDN at runtime.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RubberBand = api;
})(function () {
  // Offline R3. Rubber Band fixes pitch and formant scale once study()
  // starts in offline mode, so Rubber Band runs at pitch 1 and only time
  // varies, through a key-frame map. The pitch curve is then applied by a
  // variable-rate windowed-sinc resample of that stretched voice.
  // ThreadingNever because this wasm build is single-threaded.
  var FINER = 0x20000000;
  var THREAD_NEVER = 0x00010000;
  var FORMANT_PRESERVED = 0x01000000;
  var FLAGS = FINER | THREAD_NEVER;
  var BLOCK = 512;
  var KEY_FRAME_SEC = 0.01;
  var SINC_ZEROS = 16;
  var KAISER_BETA = 8;
  var KAISER_STEPS = 4096;

  var wasm = null;

  function refreshHeap() {
    wasm.heap.HEAP8 = new Uint8Array(wasm.exports.memory.buffer);
    wasm.heap.HEAP32 = new Uint32Array(wasm.exports.memory.buffer);
  }

  function malloc(size) {
    var ptr = wasm.exports.wasm_malloc(size);
    refreshHeap();
    return ptr;
  }

  function memWrite(dest, data) {
    refreshHeap();
    wasm.heap.HEAP8.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), dest);
  }

  function memWritePtr(dest, src) {
    refreshHeap();
    var buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, src, true);
    wasm.heap.HEAP8.set(buf, dest);
  }

  function memReadF32(src, length) {
    refreshHeap();
    return new Float32Array(wasm.heap.HEAP8.buffer, src, length).slice();
  }

  async function readBytes(source) {
    if (source instanceof ArrayBuffer) return source;
    if (ArrayBuffer.isView(source)) {
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    }
    var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNode && typeof source === 'string' && !/^https?:/i.test(source)) {
      var fs = require('fs');
      var buf = fs.readFileSync(source);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    var res = await fetch(source);
    if (!res.ok) throw new Error('Could not load Rubber Band (' + res.status + ')');
    return res.arrayBuffer();
  }

  function wasi(heap) {
    function fail() { return 52; }
    return {
      proc_exit: fail,
      fd_read: fail,
      fd_seek: fail,
      fd_close: fail,
      environ_sizes_get: fail,
      environ_get: fail,
      clock_time_get: fail,
      fd_write: function (fd, iov, iovcnt, pnum) {
        if (fd > 2) return 52;
        var num = 0;
        for (var i = 0; i < iovcnt; i++) {
          var len = heap.HEAP32[(iov + 4) >> 2];
          iov += 8;
          num += len;
        }
        heap.HEAP32[pnum >> 2] = num;
        return 0;
      }
    };
  }

  function besselI0(x) {
    var sum = 1;
    var term = 1;
    for (var k = 1; k < 30; k++) {
      var h = x / (2 * k);
      term *= h * h;
      sum += term;
    }
    return sum;
  }

  var kaiser = null;
  function kaiserTable() {
    if (kaiser) return kaiser;
    var norm = besselI0(KAISER_BETA);
    kaiser = new Float64Array(KAISER_STEPS + 2);
    for (var i = 0; i <= KAISER_STEPS + 1; i++) {
      var u = Math.min(1, i / KAISER_STEPS);
      kaiser[i] = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - u * u))) / norm;
    }
    return kaiser;
  }

  // out[n] = src read at position pos[n]. rate[n] is how fast pos moves
  // there; above 1 the sinc is widened so the shift up does not alias.
  function resample(src, pos, rate) {
    var tab = kaiserTable();
    var n = pos.length;
    var out = new Float32Array(n);
    var len = src.length;
    for (var i = 0; i < n; i++) {
      var p = pos[i];
      var cut = rate[i] > 1 ? 1 / rate[i] : 1;
      var half = Math.ceil(SINC_ZEROS / cut);
      var c = Math.floor(p);
      var acc = 0;
      var wsum = 0;
      for (var k = c - half + 1; k <= c + half; k++) {
        var x = p - k;
        var ua = (x < 0 ? -x : x) / half;
        if (ua >= 1) continue;
        var fi = ua * KAISER_STEPS;
        var ii = fi | 0;
        var w = tab[ii] + (tab[ii + 1] - tab[ii]) * (fi - ii);
        var a = x * cut * Math.PI;
        var h = (a === 0 ? 1 : Math.sin(a) / a) * w;
        if (k >= 0 && k < len) acc += src[k] * h;
        wsum += h;
      }
      out[i] = wsum > 0 ? acc / wsum : 0;
    }
    return out;
  }

  // One offline Rubber Band pass at pitch 1. Returns the stretched voice.
  function offlinePass(samples, sampleRate, timeRatio, keyFrames, formantScale) {
    var exp = wasm.exports;
    var flags = formantScale ? (FLAGS | FORMANT_PRESERVED) : FLAGS;
    var state = exp.rb_new(sampleRate, 1, flags, timeRatio, 1);
    if (!state) throw new Error('rubberband_new failed');
    exp.rb_set_time_ratio(state, timeRatio);
    if (formantScale) exp.rb_set_formant_scale(state, formantScale);
    exp.rb_set_expected_input_duration(state, samples.length);
    exp.rb_set_max_process_size(state, BLOCK);
    if (keyFrames.length) {
      var count = keyFrames.length;
      var fromPtr = malloc(count * 4);
      var toPtr = malloc(count * 4);
      refreshHeap();
      for (var k = 0; k < count; k++) {
        wasm.heap.HEAP32[(fromPtr >> 2) + k] = keyFrames[k][0];
        wasm.heap.HEAP32[(toPtr >> 2) + k] = keyFrames[k][1];
      }
      exp.rb_set_key_frame_map(state, count, fromPtr, toPtr);
      exp.wasm_free(fromPtr);
      exp.wasm_free(toPtr);
    }
    var cap = Math.max(BLOCK, 8192);
    var bufPtr = malloc(cap * 4);
    var chanPtr = malloc(4);
    memWritePtr(chanPtr, bufPtr);

    for (var off = 0; off < samples.length; off += cap) {
      var n = Math.min(cap, samples.length - off);
      memWrite(bufPtr, samples.subarray(off, off + n));
      exp.rb_study(state, chanPtr, n, off + n >= samples.length ? 1 : 0);
    }

    var chunks = [];
    var total = 0;
    function retrieve() {
      while (true) {
        var available = exp.rb_available(state);
        if (available < 1) break;
        var recv = exp.rb_retrieve(state, chanPtr, Math.min(cap, available));
        if (recv < 1) break;
        chunks.push(memReadF32(bufPtr, recv));
        total += recv;
      }
    }
    for (var at = 0; at < samples.length; at += BLOCK) {
      var m = Math.min(BLOCK, samples.length - at);
      memWrite(bufPtr, samples.subarray(at, at + m));
      exp.rb_process(state, chanPtr, m, at + m >= samples.length ? 1 : 0);
      retrieve();
    }
    retrieve();

    exp.rb_delete(state);
    exp.wasm_free(bufPtr);
    exp.wasm_free(chanPtr);

    var out = new Float32Array(total);
    var o = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], o);
      o += chunks[i].length;
    }
    return out;
  }

  /**
   * Offline stretch. timeRatio is output duration / input duration.
   * pitchAt(t) is target/source frequency at input fraction t in [0, 1]
   * (a number is a constant scale). The result is exactly
   * round(input.length * timeRatio) long, and output fraction t carries
   * pitchAt(t), so a contour drawn over the output lines up with it.
   *
   * Rubber Band stretches each stretch of input by timeRatio * pitchAt(t)
   * at pitch 1 (key frames every 10 ms), then the resample reads that back
   * pitchAt(t) times faster, which shifts pitch by pitchAt(t) and brings
   * the time back to timeRatio.
   *
   * keepVowel: formant scale is also fixed per offline pass. With a flat
   * pitch one pass at formant scale 1/pitch holds the vowel. With a
   * contour, a few passes at formant scales a few semitones apart are
   * blended sample by sample along the contour, then resampled.
   */
  function stretchMono(samples, sampleRate, timeRatio, pitchAt, options) {
    if (!wasm) throw new Error('Rubber Band is not loaded');
    if (!samples || samples.length === 0) return new Float32Array(0);
    var keepVowel = !!(options && options.keepVowel);
    var pitchOf = typeof pitchAt === 'function' ? pitchAt : function () { return pitchAt; };
    var n = samples.length;
    var p0 = pitchOf(0);
    var flat = true;
    for (var i = 1; i <= 64; i++) {
      if (Math.abs(pitchOf(i / 64) - p0) > 1e-9) { flat = false; break; }
    }

    // stretched[i] = position after Rubber Band for input sample i
    var stretchedAt = new Float64Array(n + 1);
    for (var x = 0; x < n; x++) {
      stretchedAt[x + 1] = stretchedAt[x] + timeRatio * pitchOf((x + 0.5) / n);
    }
    var stretchedLen = Math.max(1, Math.round(stretchedAt[n]));
    var ratio = stretchedLen / n;
    var keyFrames = [];
    if (!flat) {
      var step = Math.max(1, Math.round(KEY_FRAME_SEC * sampleRate));
      for (var kx = step; kx < n - step / 2; kx += step) {
        keyFrames.push([kx, Math.round(stretchedAt[kx])]);
      }
    }

    var stretched;
    if (!keepVowel) {
      stretched = offlinePass(samples, sampleRate, ratio, keyFrames, 0);
    } else if (flat) {
      stretched = offlinePass(samples, sampleRate, ratio, keyFrames, 1 / p0);
    } else {
      stretched = vowelBlend(samples, sampleRate, ratio, keyFrames, pitchOf, p0, stretchedAt);
    }

    var target = Math.max(1, Math.round(n * timeRatio));
    if (flat && p0 === 1) {
      if (stretched.length === target) return stretched;
      var same = new Float32Array(target);
      same.set(stretched.subarray(0, Math.min(stretched.length, target)));
      return same;
    }
    var pos = new Float64Array(target);
    var rate = new Float64Array(target);
    var fit = stretched.length / stretchedAt[n];
    for (var j = 0; j < target; j++) {
      var src = target === 1 ? 0 : (j / target) * n;
      var xi = Math.min(n - 1, Math.floor(src));
      var f = src - xi;
      pos[j] = (stretchedAt[xi] + (stretchedAt[xi + 1] - stretchedAt[xi]) * f) * fit;
      rate[j] = pitchOf(src / n);
    }
    return resample(stretched, pos, rate);
  }

  function vowelBlend(samples, sampleRate, ratio, keyFrames, pitchOf, p0, stretchedAt) {
    var n = samples.length;
    function semis(x) { return 12 * Math.log2(pitchOf(x / n) / p0); }
    var lo = Infinity;
    var hi = -Infinity;
    for (var i = 0; i <= 256; i++) {
      var v = semis((i / 256) * n);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    var gap = Math.max(3, (hi - lo) / 4);
    var g0 = Math.floor(lo / gap);
    var g1 = Math.ceil(hi / gap);
    var passes = {};
    for (var g = g0; g <= g1; g++) {
      passes[g] = offlinePass(samples, sampleRate, ratio, keyFrames, 1 / (p0 * Math.pow(2, (g * gap) / 12)));
    }
    var len = passes[g0].length;
    var mixed = new Float32Array(len);
    var scale = stretchedAt[n] / len;
    var x = 0;
    for (var y = 0; y < len; y++) {
      var at = y * scale;
      while (x < n - 1 && stretchedAt[x + 1] < at) x++;
      var u = semis(x) / gap;
      var a = Math.floor(u);
      var f = u - a;
      if (a < g0) { a = g0; f = 0; }
      if (a >= g1) { a = g1; f = 0; }
      var s0 = passes[a][y] || 0;
      var s1 = f > 0 ? (passes[a + 1][y] || 0) : 0;
      mixed[y] = s0 * (1 - f) + s1 * f;
    }
    return mixed;
  }

  async function load(source) {
    if (wasm) return api;
    var bytes = await readBytes(source);
    var heap = {};
    var instance;
    var compiled = await WebAssembly.compile(bytes);
    instance = await WebAssembly.instantiate(compiled, {
      env: {
        emscripten_notify_memory_growth: function () {
          heap.HEAP8 = new Uint8Array(instance.exports.memory.buffer);
          heap.HEAP32 = new Uint32Array(instance.exports.memory.buffer);
        }
      },
      wasi_snapshot_preview1: wasi(heap)
    });
    heap.HEAP8 = new Uint8Array(instance.exports.memory.buffer);
    heap.HEAP32 = new Uint32Array(instance.exports.memory.buffer);
    instance.exports._initialize();
    wasm = { exports: instance.exports, heap: heap };
    var warmup = new Float32Array(Math.round(0.25 * 44100));
    for (var i = 0; i < warmup.length; i += 50) warmup[i] = 0.2;
    stretchMono(warmup, 44100, 1, function (t) { return 1 + 0.1 * t; }, { keepVowel: false });
    return api;
  }

  function isReady() { return !!wasm; }

  var api = {
    load: load,
    isReady: isReady,
    stretchMono: stretchMono,
    version: '3.3.0'
  };
  return api;
});
