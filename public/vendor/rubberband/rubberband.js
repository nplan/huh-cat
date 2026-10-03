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
  // Realtime R3 so setPitchScale can move during the pass (offline freezes
  // pitch at study()). HighConsistency is the mode Rubber Band documents for
  // a pitch envelope. ThreadingNever because this wasm build is single-threaded.
  var REALTIME = 0x00000001;
  var FINER = 0x20000000;
  var HIGH_CONSISTENCY = 0x04000000;
  var THREAD_NEVER = 0x00010000;
  var FORMANT_PRESERVED = 0x01000000;
  var FLAGS = REALTIME | FINER | HIGH_CONSISTENCY | THREAD_NEVER;

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

  /**
   * Realtime stretch. timeRatio is output duration / input duration.
   * pitchAt(t) is target/source frequency at input fraction t in [0, 1]
   * (a number is treated as a constant scale). Pitch is updated about every
   * 2 ms via rubberband_set_pitch_scale. The engine's start delay is
   * trimmed and the silent flush tail is cut so the result length is
   * round(input.length * timeRatio).
   */
  function stretchMono(samples, sampleRate, timeRatio, pitchAt, options) {
    if (!wasm) throw new Error('Rubber Band is not loaded');
    if (!samples || samples.length === 0) return new Float32Array(0);
    var keepVowel = !options || options.keepVowel !== false;
    var pitchOf = typeof pitchAt === 'function' ? pitchAt : function () { return pitchAt; };
    var startPitch = pitchOf(0);
    var exp = wasm.exports;
    var flags = keepVowel ? (FLAGS | FORMANT_PRESERVED) : FLAGS;
    var state = exp.rb_new(sampleRate, 1, flags, timeRatio, startPitch);
    if (!state) throw new Error('rubberband_new failed');
    exp.rb_set_time_ratio(state, timeRatio);
    exp.rb_set_pitch_scale(state, startPitch);
    // Formant scale 0 is automatic. With OptionFormantPreserved, Rubber Band
    // treats that as 1/pitchScale and keeps the vowel as the pitch moves.
    // An explicit scale of 1 overrides the option and shifts formants (chipmunk).
    if (typeof exp.rb_set_formant_scale === 'function') exp.rb_set_formant_scale(state, 0);
    var pad = exp.rb_get_preferred_start_pad(state);
    var delay = exp.rb_get_start_delay(state);
    var required = exp.rb_get_samples_required(state) || 2048;
    var step = Math.max(1, Math.round(0.002 * sampleRate));
    if (step > required) step = required;
    var cap = Math.max(step, pad, required);
    var bufPtr = malloc(cap * 4);
    var chanPtr = malloc(4);
    memWritePtr(chanPtr, bufPtr);

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
    function feed(data, final) {
      var off = 0;
      while (off < data.length) {
        var count = Math.min(step, data.length - off);
        var end = final && off + count >= data.length;
        memWrite(bufPtr, data.subarray(off, off + count));
        exp.rb_process(state, chanPtr, count, end ? 1 : 0);
        off += count;
        retrieve();
      }
    }

    if (pad > 0) feed(new Float32Array(pad), false);
    var read = 0;
    while (read < samples.length) {
      var count = Math.min(step, samples.length - read);
      var t = samples.length <= 1 ? 0 : (read + count * 0.5) / samples.length;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      exp.rb_set_pitch_scale(state, pitchOf(t));
      var last = read + count >= samples.length;
      memWrite(bufPtr, samples.subarray(read, read + count));
      exp.rb_process(state, chanPtr, count, last ? 1 : 0);
      read += count;
      retrieve();
    }

    exp.rb_delete(state);
    exp.wasm_free(bufPtr);
    exp.wasm_free(chanPtr);

    var raw = new Float32Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      raw.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    var trimmed = delay > 0 ? raw.subarray(Math.min(delay, raw.length)) : raw;
    var target = Math.max(1, Math.round(samples.length * timeRatio));
    if (trimmed.length === target) return new Float32Array(trimmed);
    var out = new Float32Array(target);
    out.set(trimmed.subarray(0, Math.min(trimmed.length, target)), 0);
    return out;
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
    stretchMono(warmup, 44100, 1, function (t) { return 1 + 0.1 * t; });
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
