'use strict';
/**
 * Download: the current clip as a video file, made in the browser.
 *
 * Picture: the cat clip decoded frame by frame (WebCodecs via Mediabunny,
 * vendor/mediabunny, MPL-2.0, loaded here on first use), drawn to a
 * 1280x720 canvas at 30 fps with the same timing as playback (the clip is
 * stretched to the sound: rate = clip duration / sound duration), the
 * caption revealed letter by letter at the same times as on the page, and
 * a faint "huuuh.meme" at the bottom. After the sound, the last frame
 * holds HOLD seconds with the whole caption (what the page shows at the end).
 *
 * Sound: the exact rendered buffer the page plays (same params, same
 * render), padded with silence over the hold.
 *
 * Container / codecs, first that this browser can encode:
 *   MP4  H.264 + AAC   (Safari 26+, Chrome on macOS/Windows/Android/ChromeOS)
 *   MP4  H.264 + Opus  (Chrome on Linux, Firefox: no AAC encoder there)
 *   MOV  H.264 + PCM   (Safari 16.4-18: VideoEncoder but no AudioEncoder)
 * No WebCodecs video encoder: MediaRecorder fallback (real time, WebM or
 * MP4, sound captured from a media element; no AudioContext anywhere).
 *
 * No AudioContext is created here: the sound is already rendered.
 */
(function () {
  var W = 1280;
  var H = 720;
  var FPS = 30;
  var HOLD = 0.5;
  var MB_URL = '/vendor/mediabunny/mediabunny.min.mjs';
  var mbReady = null;

  function loadMB() {
    if (!mbReady) {
      mbReady = import(MB_URL).catch(function (e) { mbReady = null; throw e; });
    }
    return mbReady;
  }

  function userError(msg, cause) {
    var e = new Error(msg + (cause && cause.message ? ' (' + cause.message + ')' : ''));
    e.userMessage = msg;
    return e;
  }

  // ---- caption / watermark drawing (same geometry as the page) ----------
  function captionPainter(ctx, cap, conf) {
    var text = (cap && cap.text ? cap.text : 'huuuh?').toUpperCase();
    var times = cap && cap.times ? cap.times : [];
    var fam = '"Anton", Impact, sans-serif';
    ctx.font = '100px ' + fam;
    var adv100 = [];
    var natural = 0;
    for (var i = 0; i < text.length; i++) {
      var a = ctx.measureText(text.charAt(i)).width + 2; // letter-spacing 0.02em
      adv100.push(a);
      natural += a;
    }
    var size = HuhMeme.captionSize(W, H, natural, conf);
    var k = size / 100;
    var width = natural * k;
    ctx.font = size + 'px ' + fam;
    var m = ctx.measureText(text);
    var asc = m.fontBoundingBoxAscent || size * 0.88;
    var desc = m.fontBoundingBoxDescent || size * 0.24;
    var top = conf.y === 'bottom' ? H * 0.94 - size : H * 0.05;
    var baseline = top + (size - (asc + desc)) / 2 + asc;
    var x0 = conf.align === 'left' ? W * 0.04 : conf.align === 'center' ? (W - width) / 2 : W * 0.96 - width;
    var xs = [];
    var x = x0;
    for (var j = 0; j < text.length; j++) { xs.push(x); x += adv100[j] * k; }
    return function (t) {
      ctx.save();
      ctx.font = size + 'px ' + fam;
      ctx.textBaseline = 'alphabetic';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = size * 0.13;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      for (var n = 0; n < text.length; n++) {
        if (!(t + 0.012 >= (times[n] === undefined ? 0 : times[n]))) continue;
        ctx.strokeText(text.charAt(n), xs[n], baseline);
      }
      for (var q = 0; q < text.length; q++) {
        if (!(t + 0.012 >= (times[q] === undefined ? 0 : times[q]))) continue;
        ctx.fillText(text.charAt(q), xs[q], baseline);
      }
      ctx.restore();
    };
  }

  function drawWatermark(ctx) {
    ctx.save();
    var size = Math.round(H * 0.032);
    ctx.font = '600 ' + size + 'px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fillText('huuuh.meme', W / 2, H - Math.round(H * 0.03));
    ctx.restore();
  }

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('100px "Anton"'),
      document.fonts.load('600 24px "Inter"')
    ]).catch(function () {});
  }

  function slug(s) {
    return String(s || 'huh').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'huh';
  }

  function paddedSamples(buf, seconds) {
    var src = buf.getChannelData(0);
    var total = Math.max(src.length, Math.round(seconds * buf.sampleRate));
    var out = new Float32Array(total);
    out.set(src);
    return out;
  }

  // AAC encoders put priming samples (about 1024-2112) in front of the sound
  // and the MP4 gets no edit list for them, so players start the sound that
  // much late. Measure the delay once: encode a click, decode it, see where
  // it lands. The video is then started that much later (see below).
  var aacDelayPromise = null;
  function measureAacDelay(sr) {
    if (aacDelayPromise) return aacDelayPromise;
    aacDelayPromise = new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      setTimeout(function () { finish(0); }, 3000);
      try {
        var n = Math.round(sr * 0.4), at = Math.round(sr * 0.1);
        var pcm = new Float32Array(n);
        for (var i = 0; i < 64; i++) pcm[at + i] = (i % 2 ? -0.9 : 0.9);
        var chunks = [], config = null;
        var enc = new AudioEncoder({
          output: function (c, meta) { chunks.push(c); if (meta && meta.decoderConfig) config = meta.decoderConfig; },
          error: function () { finish(0); }
        });
        enc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: 1, bitrate: 128000 });
        enc.encode(new AudioData({ format: 'f32', sampleRate: sr, numberOfFrames: n, numberOfChannels: 1, timestamp: 0, data: pcm }));
        enc.flush().then(function () {
          enc.close();
          if (!config || !chunks.length) return finish(0);
          var out = [];
          var dec = new AudioDecoder({
            output: function (d) {
              var buf = new Float32Array(d.numberOfFrames);
              d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
              out.push(buf);
              d.close();
            },
            error: function () { finish(0); }
          });
          dec.configure(config);
          chunks.forEach(function (c) { dec.decode(c); });
          return dec.flush().then(function () {
            dec.close();
            var all = [], k = 0, best = 0, bi = 0;
            out.forEach(function (b) { for (var j = 0; j < b.length; j++, k++) { var a = Math.abs(b[j]); if (a > best) { best = a; bi = k; } } });
            var d = (bi - at - 32) / sr;
            finish(best > 0.1 && d > 0.002 && d < 0.2 ? d : 0);
          });
        }).catch(function () { finish(0); });
      } catch (e) { finish(0); }
    });
    return aacDelayPromise;
  }

  // ---- WebCodecs path ----------------------------------------------------
  function renderWebCodecs(opts, MB) {
    var entry = opts.entry;
    var soundDur = entry.duration;
    var sr = entry.buffer.sampleRate;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { alpha: false });
    var input, sink, track, output, videoSource, audioSource, isMov;
    var lead = 0; // s the picture starts late to match AAC priming
    var paint;
    return fontsReady().then(function () {
      paint = captionPainter(ctx, entry.caption, opts.clipConfig);
      return Promise.all([
        MB.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: W, height: H }),
        MB.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 1, sampleRate: sr })
      ]);
    }).then(function (codecs) {
      var vCodec = codecs[0];
      var aCodec = codecs[1];
      if (!vCodec) throw userError('This browser cannot encode video.');
      if (!aCodec) {
        // No AudioEncoder (Safari before 26): uncompressed sound in a MOV.
        aCodec = 'pcm-s16';
        isMov = true;
      }
      input = new MB.Input({ source: new MB.UrlSource(opts.clipUrl), formats: MB.ALL_FORMATS });
      output = new MB.Output({
        format: isMov ? new MB.MovOutputFormat({ fastStart: 'in-memory' }) : new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new MB.BufferTarget()
      });
      videoSource = new MB.CanvasSource(canvas, { codec: vCodec, bitrate: MB.QUALITY_HIGH, keyFrameInterval: 1 });
      audioSource = new MB.AudioSampleSource({ codec: aCodec, bitrate: 128000 });
      output.addVideoTrack(videoSource, { frameRate: FPS });
      output.addAudioTrack(audioSource);
      opts.info = { video: vCodec, audio: aCodec, container: isMov ? 'mov' : 'mp4' };
      return aCodec === 'aac' ? measureAacDelay(sr) : 0;
    }).then(function (d) {
      lead = d || 0;
      opts.info.audioLead = Math.round(lead * 1000);
      return input.getPrimaryVideoTrack();
    }).then(function (t) {
      track = t;
      if (!track) throw userError('Could not read the cat clip.');
      return Promise.all([track.computeDuration(), track.getFirstTimestamp(), output.start()]);
    }).then(function (r) {
      var clipDur = opts.clipDuration > 0 ? opts.clipDuration : r[0];
      var first = r[1] || 0;
      var lastStart = Math.max(first, first + r[0] - 1 / FPS);
      var rate = clipDur / soundDur;
      var frames = Math.ceil((soundDur + HOLD) * FPS);
      var stamps = [];
      for (var i = 0; i < frames; i++) {
        var t = i / FPS;
        stamps.push(Math.min(first + Math.min(t, soundDur) * rate, lastStart + 0.001));
      }
      sink = new MB.VideoSampleSink(track);
      var it = sink.samplesAtTimestamps(stamps);
      var n = 0;
      function step() {
        return it.next().then(function (res) {
          if (res.done) return null;
          var sample = res.value;
          var t = n / FPS;
          if (sample) {
            sample.draw(ctx, 0, 0, W, H);
            sample.close();
          }
          paint(t >= soundDur ? Infinity : t);
          drawWatermark(ctx);
          // Frame 0 also covers the AAC lead, so picture and sound line up.
          var at = n === 0 ? 0 : lead + t;
          var dur = n === 0 ? lead + 1 / FPS : 1 / FPS;
          return videoSource.add(at, dur).then(function () {
            n++;
            if (opts.onProgress) opts.onProgress(Math.min(0.95, n / frames * 0.95));
            return step();
          });
        });
      }
      return step().then(function () { return frames; });
    }).then(function (frames) {
      var data = paddedSamples(entry.buffer, frames / FPS + lead);
      var s = new MB.AudioSample({ data: data, format: 'f32', numberOfChannels: 1, sampleRate: sr, timestamp: 0 });
      return audioSource.add(s).then(function () { s.close(); });
    }).then(function () {
      videoSource.close();
      audioSource.close();
      return output.finalize();
    }).then(function () {
      if (input && input.dispose) try { input.dispose(); } catch (e) {}
      var type = isMov ? 'video/quicktime' : 'video/mp4';
      var name = 'huuuh-' + slug(opts.name) + '-' + String(opts.clip || 'a').toLowerCase() + (isMov ? '.mov' : '.mp4');
      if (opts.onProgress) opts.onProgress(1);
      return new File([output.target.buffer], name, { type: type });
    });
  }

  // ---- MediaRecorder fallback (no WebCodecs encoder) -----------------
  function seekTo(v, t) {
    return new Promise(function (resolve) {
      var done = function () { v.removeEventListener('seeked', done); resolve(); };
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  function renderRecorder(opts) {
    var entry = opts.entry;
    var soundDur = entry.duration;
    if (typeof MediaRecorder === 'undefined') return Promise.reject(userError('This browser cannot make video files. Try a current Chrome, Safari or Firefox.'));
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { alpha: false });
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = opts.clipUrl;
    var frames = [];
    var paint;
    return fontsReady().then(function () {
      paint = captionPainter(ctx, entry.caption, opts.clipConfig);
      return new Promise(function (resolve, reject) {
        v.addEventListener('loadeddata', resolve, { once: true });
        v.addEventListener('error', function () { reject(userError('Could not read the cat clip.')); }, { once: true });
      });
    }).then(function () {
      // Export only (not playback): step through the clip's frames.
      var count = Math.max(1, Math.round(v.duration * FPS));
      var i = 0;
      function grab() {
        if (i >= count) return Promise.resolve();
        return seekTo(v, Math.min(v.duration - 0.001, (i + 0.5) / FPS)).then(function () {
          var c = document.createElement('canvas');
          c.width = 640;
          c.height = 360;
          c.getContext('2d').drawImage(v, 0, 0, 640, 360);
          frames.push(c);
          i++;
          if (opts.onProgress) opts.onProgress(i / count * 0.3);
          return grab();
        });
      }
      return grab();
    }).then(function () {
      var a = document.createElement('audio');
      a.src = entry.url;
      a.preload = 'auto';
      var cap = a.captureStream ? a.captureStream() : a.mozCaptureStream ? a.mozCaptureStream() : null;
      if (!cap) throw userError('This browser cannot make video files with sound. Try a current Chrome, Safari or Firefox.');
      var stream = canvas.captureStream(FPS);
      var types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
      var type = '';
      for (var k = 0; k < types.length; k++) if (MediaRecorder.isTypeSupported(types[k])) { type = types[k]; break; }
      var chunks = [];
      var clipDur = v.duration;
      var rate = clipDur / soundDur;
      return new Promise(function (resolve, reject) {
        a.addEventListener('canplaythrough', function () {
          cap.getAudioTracks().forEach(function (tr) { stream.addTrack(tr); });
          var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
          rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
          rec.onstop = function () {
            var mime = (rec.mimeType || type || 'video/webm').split(';')[0];
            var ext = mime === 'video/mp4' ? '.mp4' : '.webm';
            resolve(new File(chunks, 'huuuh-' + slug(opts.name) + '-' + String(opts.clip || 'a').toLowerCase() + ext, { type: mime }));
          };
          rec.onerror = function (e) { reject(e.error || new Error('recorder error')); };
          var t0 = 0;
          var endAt = 0;
          function draw() {
            var t = endAt ? soundDur + (performance.now() - endAt) / 1000 : a.currentTime;
            var idx = Math.min(frames.length - 1, Math.floor(Math.min(t, soundDur) * rate * FPS));
            ctx.drawImage(frames[idx], 0, 0, W, H);
            paint(t >= soundDur ? Infinity : t);
            drawWatermark(ctx);
            if (opts.onProgress) opts.onProgress(0.3 + 0.7 * Math.min(1, t / (soundDur + HOLD)));
            if (endAt && performance.now() - endAt > HOLD * 1000) { rec.stop(); return; }
            requestAnimationFrame(draw);
          }
          a.addEventListener('ended', function () { endAt = performance.now(); });
          rec.start();
          t0 = performance.now();
          var p = a.play();
          if (p && p.catch) p.catch(reject);
          draw();
        }, { once: true });
        a.load();
      });
    });
  }

  function hasWebCodecs() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  }

  /**
   * opts: clip, clipUrl, entry (render cache entry: buffer, duration, caption,
   * url), clipConfig, name, clipDuration (playback's video.duration),
   * onProgress(f). Resolves a File.
   */
  function render(opts) {
    var force = /[?&]export=mr\b/.test(location.search) || window.HUH_EXPORT_MODE === 'recorder';
    if (!opts.entry || !opts.entry.buffer) return Promise.reject(userError('The sound is not ready yet.'));
    if (hasWebCodecs() && !force) {
      return loadMB().then(function (MB) {
        return renderWebCodecs(opts, MB);
      }).catch(function (err) {
        if (err && err.userMessage) throw err;
        console.warn('WebCodecs export failed, trying MediaRecorder', err);
        return renderRecorder(opts);
      });
    }
    return renderRecorder(opts);
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  function download(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /**
   * iPhone / iPad: the share sheet (Save Video puts it in Photos). It needs
   * a fresh tap if rendering took longer than the tap's activation:
   * resolves 'needs-tap' and the page asks for a second tap.
   * Elsewhere: a normal download. Resolves 'shared' | 'downloaded' |
   * 'cancelled' | 'needs-tap'.
   */
  function deliver(file, fromTap) {
    var canShareFile = false;
    try { canShareFile = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) {}
    if (isIOS() && canShareFile) {
      if (!fromTap && navigator.userActivation && !navigator.userActivation.isActive) return Promise.resolve('needs-tap');
      return navigator.share({ files: [file], title: 'HUUUH?' }).then(function () { return 'shared'; }, function (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        if (err && err.name === 'NotAllowedError' && !fromTap) return 'needs-tap';
        download(file);
        return 'downloaded';
      });
    }
    download(file);
    return Promise.resolve('downloaded');
  }

  window.HuhExport = { render: render, deliver: deliver, HOLD: HOLD, FPS: FPS, W: W, H: H, _loadMB: loadMB };
})();
