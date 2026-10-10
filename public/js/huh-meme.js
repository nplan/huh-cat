'use strict';

/**
 * Shared meme player: renders the huh for a params object (Rubber Band,
 * cached as WAV blob URLs), plays it on the page's hidden <audio> element,
 * keeps the muted cat video in sync through playbackRate only (never a
 * seek during playback) and reveals the caption letter by letter.
 * Used by the main page (index.html) and the share player (p.html).
 *
 * Also: share codes (HuhMeme.encode / decode) and the caption layout the
 * download export draws with (HuhMeme.captionLayout).
 *
 * Sync (first-play fix): the video starts when the audio clock is seen
 * moving (audio.currentTime >= 15 ms), not on the 'playing' event. 'playing'
 * only means the element left the paused state; when the audio output
 * still has to open (first play of a page on a phone, or after the output
 * went idle), it fires well before any sound comes out, and the video then
 * ran ahead of the sound. Any offset left at the start is pulled in with a
 * held catch-up playbackRate (few rate changes, see correct()). If the
 * rewind to 0 issued before the sound never completes, it is issued once
 * more. The video decoder is also warmed once at load (muted play + pause
 * before any user play).
 *
 * Every clip has its first frame as a jpg (clips/X.jpg), used twice: as the
 * video poster and as an <img class="still"> laid over the video. iOS Safari
 * does not paint a muted video before the first user play, and once a
 * switched-to clip has some data it drops the native poster and shows its
 * (black, unpainted) video layer. So the still stays on top until the video
 * has presented a frame in a user play (requestVideoFrameCallback; else a
 * timeupdate past 0), and comes back on every clip switch. Warm-up frames do
 * not count: the warm-up's play starts playback, after which iOS never shows
 * the poster again, and its pause + rewind leaves the layer black. All four jpgs
 * are preloaded so a switch never flashes black.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HuhMeme = api;
})(function () {
  var CLIPS = ['A', 'B', 'C', 'D'];
  var POSTER_V = 1;
  function posterUrl(c) { return '/clips/' + c + '.jpg?v=' + POSTER_V; }
  // The video starts once the sound clock has passed this (s). Chrome reports
  // a few ms (0.009...) while its output is still starting and then holds it;
  // 15 ms is past that stutter and still well inside the first video frame.
  var SOUND_STARTED = 0.015;
  // ...and that first value can then hold for ~80 ms while the output really
  // starts. The caption waits until the clock has moved on by CLOCK_MOVED from
  // that first value (or CLOCK_WAIT_MS passed), so the first letter does not
  // show before the sound is heard and then stall.
  var CLOCK_MOVED = 0.008;
  var CLOCK_WAIT_MS = 200;
  // Blink (desktop / Android Chrome) shows that hold on every play: a picture
  // started on the first value ran ~16 ms ahead of the heard sound (measured
  // against the real output). So on Blink the picture waits until the clock has
  // moved VIDEO_MOVED past its first value, and catch-up (correct()) steps in
  // from CATCHUP_FROM and closes to CATCHUP_DONE (Blink changes playbackRate
  // cheaply). WebKit is unchanged: its clock moves from the first value, its
  // picture trails slightly, and each rate change can flush its video pipeline.
  // navigator.userAgentData exists only in Blink (not WebKit, nor iOS Chrome).
  var BLINK = typeof navigator !== 'undefined' && !!navigator.userAgentData;
  var VIDEO_MOVED = BLINK ? 0.008 : 0;
  var CATCHUP_FROM = BLINK ? 0.006 : 0.030;
  var CATCHUP_DONE = BLINK ? 0.003 : 0.012;
  // Order of params in a share code. Never reorder; add new keys at the end
  // (older codes then leave them at their defaults).
  var KEYS = ['pitchSemitones', 'durationScale', 'peakAt', 'riseSemitones', 'fallSemitones',
    'gainDb', 'attackMs', 'accent', 'vowel', 'keepVowel', 'vowelX', 'vowelY', 'vowelStrength'];
  var CODE_VERSION = '1';

  // ---- share codes ---------------------------------------------------
  // v1: "1" + clip, preset field, then the full params snapshot, joined by
  // "_" (all URL-safe, nothing to escape). Example:
  //   1B_shocked_3.9_.89_.9_7.2_1.4_2.8_0_.42_.6
  // preset field: preset id (the sound is that preset's params, snapshot
  // below), "-id" = custom based on that preset, "-" = custom. Numbers are
  // JS shortest round-trip decimals (exact), "0." shortened to ".", and
  // trailing values equal to the defaults dropped. The full 2D vowel
  // (vowelX, vowelY, vowelStrength) is appended only when there is one, so
  // 1D codes are unchanged; older pages ignore the extra fields and use the
  // vowel field, which holds the nearest point on the 1D line.
  function numStr(n) {
    if (typeof n === 'boolean') return n ? '1' : '0';
    var s = String(n);
    if (s.indexOf('e') >= 0) s = String(Number(n.toFixed(12)));
    return s.replace(/^(-?)0\./, '$1.');
  }

  function encode(state) {
    var H = HuhAudio;
    var p = H.normalizeParams(state.params || {});
    var d = H.normalizeParams({});
    var DEF2D = { vowelX: '', vowelY: '', vowelStrength: '1' };
    var vals = KEYS.map(function (k) { return p[k] === undefined ? '' : numStr(p[k]); });
    var defs = KEYS.map(function (k) { return k in DEF2D ? DEF2D[k] : numStr(d[k]); });
    var n = vals.length;
    while (n > 0 && (vals[n - 1] === '' || vals[n - 1] === defs[n - 1])) n--;
    var clip = CLIPS.indexOf(state.clip) >= 0 ? state.clip : 'A';
    var id = state.presetId && /^[a-z0-9][a-z0-9-]{0,31}$/.test(state.presetId) ? state.presetId : '';
    var base = !id && state.basedOn && /^[a-z0-9][a-z0-9-]{0,31}$/.test(state.basedOn) ? state.basedOn : '';
    var field = id || ('-' + base);
    return [CODE_VERSION + clip, field].concat(vals.slice(0, n)).join('_');
  }

  /** { clip, presetId, basedOn, params } or null if the code is not valid. */
  function decode(code) {
    if (typeof code !== 'string' || code.length > 300) return null;
    var parts = code.split('_');
    var head = parts[0] || '';
    if (head.charAt(0) !== CODE_VERSION || head.length !== 2) return null;
    var clip = head.charAt(1);
    if (CLIPS.indexOf(clip) < 0) return null;
    var field = parts.length > 1 ? parts[1] : '-';
    var presetId = null;
    var basedOn = null;
    if (field.charAt(0) === '-') {
      basedOn = field.slice(1) || null;
      if (basedOn && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(basedOn)) basedOn = null;
    } else if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(field)) {
      presetId = field;
    } else {
      return null;
    }
    var raw = {};
    for (var i = 0; i < KEYS.length; i++) {
      var s = parts[i + 2];
      if (s === undefined || s === '') continue;
      if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
      var n = Number(s.replace(/^(-?)\./, '$10.'));
      if (!isFinite(n)) return null;
      raw[KEYS[i]] = KEYS[i] === 'keepVowel' ? n !== 0 : n;
    }
    return { clip: clip, presetId: presetId, basedOn: basedOn, params: HuhAudio.normalizeParams(raw) };
  }

  function codeFromLocation(loc) {
    var q = (loc || window.location).search || '';
    var m = /[?&]h=([^&#]*)/.exec(q);
    if (!m) return null;
    var code;
    try { code = decodeURIComponent(m[1]); } catch (e) { return null; }
    return decode(code);
  }

  function sameParams(a, b) {
    return JSON.stringify(HuhAudio.normalizeParams(a)) === JSON.stringify(HuhAudio.normalizeParams(b));
  }

  // ---- caption layout (DOM and canvas share the numbers) ----------------
  function clipConfigOf(clipText, clip) {
    var c = clipText && clipText[clip] && clipText[clip].text;
    return {
      y: c && c.y === 'bottom' ? 'bottom' : 'top',
      align: c && (c.align === 'left' || c.align === 'center') ? c.align : 'right',
      width: c && c.width > 0 ? Math.min(0.92, c.width) : 0.44
    };
  }

  /**
   * Font size for a caption whose natural width at 100px is natural100, in
   * a w x h picture: the clip's share of the width, at most 22% of the height.
   */
  function captionSize(w, h, natural100, conf) {
    var size = Math.min(h * 0.22, 100 * (w * conf.width) / (natural100 || 1));
    return Math.max(10, Math.floor(size));
  }

  // ---- player ----------------------------------------------------------
  /**
   * opts: video, audio, caption, stage (elements), getParams() -> params,
   * base (path prefix for assets, default ''), onStatus(text),
   * onPlayState(playing).
   */
  function create(opts) {
    var video = opts.video;
    var audio = opts.audio;
    var caption = opts.caption;
    var stage = opts.stage;
    var base = opts.base || '';
    var getParams = opts.getParams;
    var onStatus = opts.onStatus || function () {};
    var onPlayState = opts.onPlayState || function () {};
    // Show the whole caption before the first play (the still is a meme).

    var srcClip = /\/clips\/([A-D])\.mp4/.exec(video.getAttribute('src') || '');
    var clip = srcClip ? srcClip[1] : 'A';
    var still = opts.still || (stage && stage.querySelector('.still'));
    var frameCb = 0;
    var clipText = {};
    var captionSpans = [];
    var captionTimes = [];
    var captionShown = !!opts.captionBeforePlay;
    var clockRunning = false;
    var firstClock = -1;
    var holdClock = -1;
    var holdSince = 0;
    var active = false;
    var waitingForSound = false;
    var correcting = false;
    var nextAim = 0;
    var videoStartAt = 0;
    var reseeked = false;
    var stats = { plays: 0, reseeks: 0, corrections: 0 }; // for tests
    var rafId = 0;
    var playStamp = 0;
    var current = null;
    var queued = null;
    var baseRate = 1;
    var debounceTimer = 0;
    var engineLoaded = false;
    var rawClip = null;
    var cache = {};
    var cacheOrder = [];
    var warmed = false;
    var warming = false;

    var engineReady = HuhAudio.loadEngine(base + 'vendor/rubberband/rubberband.wasm');
    engineReady.then(function () { engineLoaded = true; }, function () {});
    var bytesReady = HuhAudio.fetchWavBytes(base + 'audio/A.wav');
    var rawReady = Promise.all([bytesReady, engineReady]).then(function (parts) {
      return HuhAudio.decodeWavOffline(parts[0]);
    }).then(function (buf) {
      rawClip = buf;
      return buf;
    });

    if (!audio.getAttribute('src')) audio.src = base + 'audio/A.wav';
    video.muted = true;
    video.controls = false;

    function keyOf(params) {
      return JSON.stringify(HuhAudio.normalizeParams(params));
    }

    function renderEntry(params) {
      var key = keyOf(params);
      var hit = cache[key];
      if (hit) return hit;
      var buf = HuhAudio.renderHuh(rawClip, params);
      var entry = { key: key, url: URL.createObjectURL(HuhAudio.encodeWav(buf)), duration: buf.duration, buffer: buf, params: HuhAudio.normalizeParams(params) };
      try {
        entry.caption = HuhAudio.captionTiming(buf.getChannelData(0), buf.sampleRate, params);
      } catch (e) {
        entry.caption = null;
      }
      cache[key] = entry;
      cacheOrder.push(key);
      while (cacheOrder.length > 40) {
        var old = cacheOrder[0];
        if ((current && current.key === old) || (queued && queued.key === old)) break;
        cacheOrder.shift();
        URL.revokeObjectURL(cache[old].url);
        delete cache[old];
      }
      return entry;
    }

    function setSound(entry) {
      if (current === entry) return;
      current = entry;
      audio.src = entry.url;
      if (!active) setCaption(entry, captionShown);
    }

    function setCaption(entry, allOn) {
      var cap = entry && entry.caption;
      caption.textContent = '';
      captionSpans = [];
      captionTimes = cap ? cap.times.slice() : [];
      if (!cap) return;
      for (var i = 0; i < cap.text.length; i++) {
        var sp = document.createElement('span');
        sp.textContent = cap.text.charAt(i);
        if (allOn) sp.className = 'on';
        caption.appendChild(sp);
        captionSpans.push(sp);
      }
      fitCaption();
    }

    function showCaptionAt(t) {
      for (var i = 0; i < captionSpans.length; i++) {
        var cls = t + 0.012 >= captionTimes[i] ? 'on' : '';
        if (captionSpans[i].className !== cls) captionSpans[i].className = cls;
      }
    }

    function placeCaption() {
      var c = clipConfigOf(clipText, clip);
      caption.className = 'caption meme ' + c.y + ' ' + c.align;
      fitCaption();
    }

    function fitCaption() {
      var w = stage.clientWidth;
      var h = stage.clientHeight;
      if (!w || !h || !captionSpans.length) return;
      caption.style.fontSize = '100px';
      var natural = caption.scrollWidth || 1;
      caption.style.fontSize = captionSize(w, h, natural, clipConfigOf(clipText, clip)) + 'px';
    }
    window.addEventListener('resize', fitCaption);
    if (document.fonts && document.fonts.load) {
      document.fonts.load('48px "Anton"').then(fitCaption, function () {});
    }

    function renderNow(swapNow) {
      if (!rawClip || !engineLoaded) return false;
      var entry;
      try {
        entry = renderEntry(getParams());
      } catch (e) {
        console.error(e);
        return false;
      }
      if (!swapNow && active && !audio.paused && !audio.ended) {
        queued = entry;
        return false;
      }
      queued = null;
      var changed = current !== entry;
      setSound(entry);
      return changed;
    }

    function flushQueued() {
      if (!queued) return;
      var q = queued;
      queued = null;
      setSound(q);
    }

    function scheduleRender(ms) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = 0;
        engineReady.then(function () { renderNow(false); });
      }, ms);
    }

    function currentSoundDuration() {
      if (current && current.duration > 0) return current.duration;
      var d = audio.duration;
      return isFinite(d) && d > 0 ? d : 0;
    }

    function applyRate() {
      var picture = video.duration;
      var sound = currentSoundDuration();
      if (!(isFinite(picture) && picture > 0 && sound > 0)) return;
      var rate = picture / sound;
      if (isFinite(rate) && rate > 0) {
        baseRate = rate;
        video.playbackRate = rate;
      }
    }

    function setActive(on) {
      if (active === on) return;
      active = on;
      onPlayState(on);
    }

    function finish() {
      setActive(false);
      waitingForSound = false;
      showCaptionAt(Infinity);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      video.pause();
      flushQueued();
    }

    // Start the picture once the sound is really running (see SOUND_STARTED).
    function soundGo(at) {
      if (!active || !waitingForSound || audio.paused || !isFinite(at) || at < SOUND_STARTED) return;
      if (VIDEO_MOVED > 0) {
        if (holdClock < 0) { holdClock = at; holdSince = performance.now(); return; }
        if (at - holdClock < VIDEO_MOVED && performance.now() - holdSince < CLOCK_WAIT_MS) return;
      }
      startVideo();
    }

    function startVideo() {
      waitingForSound = false;
      // On Blink the start already waited for the clock to move: the caption may go now.
      if (VIDEO_MOVED > 0) clockRunning = true;
      correcting = false;
      videoStartAt = performance.now();
      stats.plays++;
      reseeked = false;
      applyRate();
      var started = video.play();
      if (started && started.catch) started.catch(function (err) { if (err && err.name !== 'AbortError') console.error(err); });
    }

    // Catch-up: when the picture is off by more than CATCHUP_FROM (30 ms; Blink 6 ms) of sound time, set one
    // catch-up rate that closes the gap over ~150 ms, hold it, re-aim at most
    // every 150 ms, and go back to the base rate once within CATCHUP_DONE (12 ms; Blink 3 ms). Few rate
    // changes on purpose: some engines (WebKit on GStreamer) flush the video
    // pipeline on every playbackRate change, so a per-frame rate makes it stall.
    function correct(at) {
      var drift = video.currentTime / baseRate - at; // seconds of sound, + = picture ahead
      var now = performance.now();
      var remainSound = currentSoundDuration() - at;
      if (!correcting) {
        if (Math.abs(drift) <= CATCHUP_FROM || remainSound <= 0.06) return;
        correcting = true;
        nextAim = 0;
        stats.corrections++;
      }
      if (Math.abs(drift) < CATCHUP_DONE || remainSound <= 0.04) {
        correcting = false;
        if (Math.abs(video.playbackRate - baseRate) > 0.001) video.playbackRate = baseRate;
        return;
      }
      if (now < nextAim) return;
      nextAim = now + 150;
      var span = Math.max(0.06, Math.min(0.15, remainSound));
      var r = baseRate * (1 - drift / span);
      r = Math.min(baseRate * 2.5, Math.max(baseRate * 0.4, r));
      r = Math.min(4, Math.max(0.25, r));
      if (Math.abs(r - video.playbackRate) > 0.1 * baseRate) video.playbackRate = r;
    }

    function play() {
      var now = Date.now();
      if (now - playStamp < 250) return;
      playStamp = now;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(debounceTimer);
      debounceTimer = 0;
      warming = false;
      // A missing render is done right here inside the tap. (Before the
      // engine is up, the raw A.wav plays: the plain huh.)
      renderNow(true);
      setActive(true);
      waitingForSound = true;
      correcting = false;
      clockRunning = false;
      firstClock = -1;
      holdClock = -1;
      captionShown = true;
      setCaption(current, false);
      audio.pause();
      audio.currentTime = 0;
      video.pause();
      // Rewind while paused (the clips have one keyframe, at 0).
      try { video.currentTime = 0; } catch (e0) {}
      video.muted = true;
      applyRate();
      var p;
      try {
        p = audio.play();
      } catch (err) {
        onStatus(err && err.message ? err.message : String(err));
        setActive(false);
        waitingForSound = false;
        return;
      }
      onStatus('');
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          if (err && err.name === 'AbortError') return;
          onStatus(err && err.message ? err.message : String(err));
          setActive(false);
          waitingForSound = false;
          video.pause();
          if (rafId) cancelAnimationFrame(rafId);
          rafId = 0;
        });
      }
      function frame() {
        if (!active) return;
        video.muted = true;
        if (audio.ended) {
          finish();
          return;
        }
        var at = audio.currentTime;
        if (waitingForSound) {
          // Start the picture only once the sound is really running.
          soundGo(at);
        }
        if (!waitingForSound && isFinite(at)) {
          if (!clockRunning) {
            if (firstClock < 0) firstClock = at;
            if (at - firstClock >= CLOCK_MOVED || performance.now() - videoStartAt > CLOCK_WAIT_MS) clockRunning = true;
          }
          if (clockRunning) showCaptionAt(at);
          if (!video.seeking && !video.paused) correct(at);
          else if (video.seeking && !reseeked && performance.now() - videoStartAt > 150) {
            // The rewind to 0 (issued while paused, before the sound) never
            // finished (seen in WebKit/GStreamer): the cat would stay frozen.
            // Issue it once more; nothing has been shown yet, and catch-up
            // closes the gap.
            reseeked = true;
            stats.reseeks++;
            try { video.currentTime = 0; } catch (e1) {}
            var again = video.play();
            if (again && again.catch) again.catch(function () {});
          }
        }
        rafId = requestAnimationFrame(frame);
      }
      frame();
    }

    audio.addEventListener('ended', function () { if (active) finish(); else flushQueued(); });
    audio.addEventListener('playing', function () {
      // Usually the clock is already moving here; if so start right away
      // instead of waiting for the next animation frame.
      soundGo(audio.currentTime);
    });
    audio.addEventListener('timeupdate', function () {
      soundGo(audio.currentTime);
    });
    audio.addEventListener('loadedmetadata', function () { if (active) applyRate(); });
    video.addEventListener('loadedmetadata', function () { if (active) applyRate(); });

    // Warm the video decoder once (muted, before any user play).
    function warmVideo() {
      if (warmed || active) return;
      warmed = true;
      warming = true;
      var r = video.play();
      var stop = function () {
        if (!warming) return;
        warming = false;
        if (active) return;
        video.pause();
        try { video.currentTime = 0; } catch (e) {}
      };
      video.addEventListener('playing', function once() {
        video.removeEventListener('playing', once);
        setTimeout(stop, 60);
      });
      if (r && r.catch) r.catch(function () { warming = false; });
    }
    // ---- the still over the video, until the video has painted a frame ----
    function hideStill() {
      if (still && still.className.indexOf(' off') < 0) still.className += ' off';
    }
    // The still goes after STILL_FRAMES frames of a user play whose media time
    // has moved past 0, then on the next animation frame. On iOS (A/B, which the
    // warm-up has played, paused and rewound) the first callback after play()
    // can come before the restarted video layer is composited: hiding then
    // showed one black frame. The overlap is the same image as the clip's first
    // (near-still) frames, so it does not show.
    var STILL_FRAMES = 2;
    function armStill() {
      if (!still) return;
      if (frameCb && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCb);
      frameCb = 0;
      if (still.getAttribute('src') !== posterUrl(clip)) still.src = posterUrl(clip);
      still.className = still.className.replace(/ off/g, '');
      // A frame of the current src presented during a real (user) play: the
      // video shows. Frames of the muted warm-up do not count: it ends with a
      // pause + rewind, after which iOS shows neither poster nor frame.
      if (video.requestVideoFrameCallback) {
        var moving = 0;
        var onFrame = function (now, meta) {
          var t = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : video.currentTime;
          if (active && !waitingForSound && t > 0.001) moving++;
          else if (!active) moving = 0;
          if (moving >= STILL_FRAMES) {
            frameCb = 0;
            requestAnimationFrame(hideStill);
          } else frameCb = video.requestVideoFrameCallback(onFrame);
        };
        frameCb = video.requestVideoFrameCallback(onFrame);
      }
    }
    if (!video.requestVideoFrameCallback) {
      video.addEventListener('timeupdate', function () { if (active && !video.paused && video.currentTime > 0.05) hideStill(); });
    }
    // Poster for the starting clip, then the other three cached for switching.
    if (video.getAttribute('poster') !== posterUrl(clip)) video.poster = posterUrl(clip);
    armStill();
    setTimeout(function () {
      for (var pc = 0; pc < CLIPS.length; pc++) { var im = new Image(); im.src = posterUrl(CLIPS[pc]); }
    }, 300);
    if (video.readyState >= 2) setTimeout(warmVideo, 0);
    else video.addEventListener('loadeddata', function once() {
      video.removeEventListener('loadeddata', once);
      warmVideo();
    });

    function setClip(next) {
      if (CLIPS.indexOf(next) < 0) return false;
      if (next === clip) return false;
      clip = next;
      video.pause();
      video.poster = posterUrl(clip);
      armStill();
      video.src = '/clips/' + clip + '.mp4';
      video.load();
      armStill(); // re-arm on the new src (a callback can belong to the old one)
      video.muted = true;
      warmed = false;
      video.addEventListener('loadeddata', function once() {
        video.removeEventListener('loadeddata', once);
        if (!active) warmVideo();
      });
      placeCaption();
      return true;
    }

    function setClipText(map) {
      clipText = map || {};
      placeCaption();
    }

    function prerender(list) {
      var i = 0;
      var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 60); };
      function next() {
        if (i >= list.length) return;
        var params = list[i++];
        try { renderEntry(params); } catch (e) { console.error(e); }
        idle(next, { timeout: 400 });
      }
      idle(next, { timeout: 400 });
    }

    return {
      engineReady: engineReady,
      rawReady: rawReady,
      play: play,
      renderNow: renderNow,
      scheduleRender: scheduleRender,
      prerender: prerender,
      setClip: setClip,
      stillShown: function () { return !!still && still.className.indexOf(' off') < 0; },
      setClipText: setClipText,
      fitCaption: fitCaption,
      isActive: function () { return active; },
      clip: function () { return clip; },
      clipConfig: function () { return clipConfigOf(clipText, clip); },
      current: function () { return current; },
      entryFor: function (params) { return rawClip && engineLoaded ? renderEntry(params) : null; },
      ready: function () { return !!(rawClip && engineLoaded); },
      stats: stats
    };
  }

  return {
    CLIPS: CLIPS,
    KEYS: KEYS,
    encode: encode,
    decode: decode,
    codeFromLocation: codeFromLocation,
    sameParams: sameParams,
    clipConfigOf: clipConfigOf,
    captionSize: captionSize,
    create: create
  };
});
