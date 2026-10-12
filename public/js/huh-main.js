'use strict';
/* Main meme page: presets, sliders, cat picker, Play / Space / tap the
 * video, Copy link (share code), Download (js/huh-export.js, loaded on
 * first use). Playback and sync live in huh-meme.js.
 *
 * Easter egg (presets.json entries with an "egg"): tapping a mood that is
 * already selected (Disgusted) turns that button into the egg (BLAAAH) and
 * the clip into the egg's clip (G, the sour-cream gag, with its own voice
 * BLAH.wav); no cat chip is pressed. Tapping BLAAAH again replays it (as any
 * selected mood does); Reset in Tune goes back to the plain blaaah. Any other
 * mood exits to that mood on the previous cat; a cat chip exits to that cat
 * with the mood the egg came from. Tune works on the blaaah. Share links carry
 * the egg as clip G; Download renders the gag clip with BLAAAH!. */
(function () {
  var SLIDER_UI = [
    ['pitch', 'Pitch', 'low', 'high'],
    ['length', 'Length', 'short', 'long'],
    ['question', 'Question', 'statement', 'question?'],
    ['vowel', 'Vowel', '\u0259 (uh)', 'a (ah)']
  ];
  var $ = function (id) { return document.getElementById(id); };
  var video = $('huh');
  var audio = $('voice');
  var status = $('status');
  var announceEl = $('announce');
  var picks = [].slice.call(document.querySelectorAll('.clips button'));
  var presetBox = $('presets');
  var sliderList = $('slider-list');
  var modeLabel = $('mode');
  var shareBtn = $('share');
  var downloadBtn = $('download');
  var presets = []; // the mood grid (and Classic)
  var eggs = []; // easter-egg presets (not in the grid), each { egg: { from, clip } }
  var eggPrevClip = null;
  var selected = null;
  var sliders = { pitch: 0, length: 0, question: 0, vowel: 0 };
  var sliderExact = { pitch: true, length: true, question: true, vowel: true };
  // Custom sound: full params. A slider move changes only its own params,
  // so a preset's other settings (gain, attack, accent, ...) carry over.
  var custom = HuhPresets.fromSliders({});
  var basedOn = null;
  var incoming = HuhMeme.codeFromLocation();

  var player = HuhMeme.create({
    video: video,
    audio: audio,
    caption: $('caption'),
    stage: $('stage'),
    captionBeforePlay: true,
    getParams: currentParams,
    onStatus: function (t) { status.textContent = t; },
    onPlayState: function (on) { document.body.classList.toggle('is-playing', on); }
  });
  if (incoming) setClipUi(incoming.clip, false);

  function announce(t) {
    announceEl.textContent = '';
    setTimeout(function () { announceEl.textContent = t; }, 30);
  }

  var baseList = []; // presets.json as deployed (no local edits)
  var presetsReady = HuhPresets.load('presets.json').then(function (r) {
    // The plain unmodified huh (same as the lab's fixed Default); its name is HuhPresets.PLAIN_LABEL.
    // Not in presets.json, so Export round-trips stay byte-identical.
    presets = [{
      id: 'original',
      label: HuhPresets.PLAIN_LABEL,
      emoji: '\uD83D\uDC31',
      params: HuhAudio.normalizeParams({}),
      fixed: true
    }].concat((r.data && r.data.presets) || []);
    eggs = presets.filter(function (p) { return p.egg && p.egg.from && p.egg.clip; });
    presets = presets.filter(function (p) { return eggs.indexOf(p) < 0; });
    baseList = (r.base && r.base.presets) || [];
    player.setClipText((r.data && r.data.clips) || {});
    buildPresets();
    applyIncoming();
    cleanUrl();
    showNearest(currentParams());
    updateUi();
    return r.data;
  }, function (err) {
    console.error(err);
    status.textContent = 'Presets did not load';
    return null;
  });

  function slugOf(id) { return id === 'original' ? 'classic' : id; }
  function applyIncoming() {
    selected = 'original';
    if (!incoming) return;
    var p = incoming.presetId ? presetById(incoming.presetId) : null;
    if (p && HuhMeme.sameParams(p.params, incoming.params)) {
      selected = p.id;
      return;
    }
    // A custom sound, or a preset that was retuned since the link was
    // made: the link's own params win, so the sound is the one shared.
    selected = null;
    custom = incoming.params;
    var from = incoming.presetId || incoming.basedOn;
    basedOn = from && presetById(from) ? from : null;
  }

  function presetById(id) {
    for (var i = 0; i < presets.length; i++) if (presets[i].id === id) return presets[i];
    for (var j = 0; j < eggs.length; j++) if (eggs[j].id === id) return eggs[j];
    return null;
  }

  // ---- easter egg
  function activeEgg() {
    for (var i = 0; i < eggs.length; i++) if (eggs[i].egg.clip === player.clip()) return eggs[i];
    return null;
  }
  function eggFrom(id) {
    for (var i = 0; i < eggs.length; i++) if (eggs[i].egg.from === id) return eggs[i];
    return null;
  }
  function enterEgg(e) {
    eggPrevClip = player.clip();
    selected = e.id;
    basedOn = null;
    setClipUi(e.egg.clip, false);
    showNearest(e.params);
    updateUi();
    var b = presetBox.querySelector('[data-preset="' + e.egg.from + '"]');
    if (b) { b.classList.remove('egg-pop'); void b.offsetWidth; b.classList.add('egg-pop'); }
    announce(e.label + '!');
    player.play(true); // the second tap of a double tap: past the 250 ms play guard
  }
  function exitEgg(toClip) {
    var back = toClip || (eggPrevClip && HuhMeme.CLIPS.indexOf(eggPrevClip) >= 0 ? eggPrevClip : 'A');
    eggPrevClip = null;
    setClipUi(back, false);
  }
  // A tap on a mood button (the egg's button shows the egg while it is on).
  function tapPreset(id) {
    var e = activeEgg();
    if (e) {
      if (id === e.egg.from) { choosePreset(e.id); return; }
      exitEgg(null);
      choosePreset(id);
      return;
    }
    var egg = eggFrom(id);
    if (egg && selected === id) { enterEgg(egg); return; }
    choosePreset(id);
  }

  function currentParams() {
    var p = selected ? presetById(selected) : null;
    return p ? p.params : custom;
  }

  function play() { player.play(); }

  // ---- presets
  function buildPresets() {
    presetBox.innerHTML = '';
    presets.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.setAttribute('data-preset', p.id);
      b.setAttribute('aria-pressed', 'false');
      var emo = document.createElement('span');
      emo.className = 'emo';
      emo.setAttribute('aria-hidden', 'true');
      emo.textContent = p.emoji || '';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.label || p.id;
      b.appendChild(emo);
      b.appendChild(name);
      b.addEventListener('click', function () { tapPreset(p.id); });
      presetBox.appendChild(b);
    });
    updateUi();
  }

  function choosePreset(id) {
    var p = presetById(id);
    if (!p) return;
    selected = id;
    showNearest(p.params);
    updateUi();
    play();
  }

  // ---- sliders
  var inputs = {};
  SLIDER_UI.forEach(function (s) {
    var wrap = document.createElement('label');
    wrap.className = 'slider';
    var top = document.createElement('div');
    top.className = 'top';
    var name = document.createElement('span');
    name.textContent = s[1];
    var out = document.createElement('output');
    top.appendChild(name);
    top.appendChild(out);
    var input = document.createElement('input');
    input.type = 'range';
    input.min = '-1';
    input.max = '1';
    input.step = '0.01';
    input.value = '0';
    input.id = 'sl-' + s[0];
    var ends = document.createElement('div');
    ends.className = 'ends';
    ends.innerHTML = '<span></span><span></span>';
    ends.children[0].textContent = s[2];
    ends.children[1].textContent = s[3];
    wrap.appendChild(top);
    wrap.appendChild(input);
    wrap.appendChild(ends);
    sliderList.appendChild(wrap);
    inputs[s[0]] = { input: input, out: out, name: s[1], lo: s[2], hi: s[3] };
    input.addEventListener('input', function () {
      sliderMoved(s[0], Number(input.value), false);
    });
    input.addEventListener('change', function () {
      sliderMoved(s[0], Number(input.value), true);
    });
  });

  function fmt(v) {
    var n = Math.round(v * 100) / 100;
    if (n === 0) return '0';
    return (n > 0 ? '+' : '\u2212') + Math.abs(n).toFixed(2);
  }

  // The filled part of the track runs from 0 (plain) to the thumb.
  function paintTrack(k) {
    var v = Number(inputs[k].input.value) || 0;
    var a = 50 + Math.min(0, v) * 50;
    var b = 50 + Math.max(0, v) * 50;
    inputs[k].input.style.setProperty('--fa', a + '%');
    inputs[k].input.style.setProperty('--fb', b + '%');
  }

  function showOut(k) {
    inputs[k].out.textContent = (sliderExact[k] ? '' : '\u2248 ') + fmt(sliders[k] || 0);
    inputs[k].out.title = sliderExact[k] ? '' : 'Nearest setting; this sound is tuned beyond the slider.';
    // The value for screen readers (pages may hide the visible readout).
    var v = sliders[k] || 0;
    var where = v === 0 ? 'middle' : (v < 0 ? 'toward ' + inputs[k].lo : 'toward ' + inputs[k].hi);
    inputs[k].input.setAttribute('aria-valuetext', fmt(v) + ', ' + where + (sliderExact[k] ? '' : ', nearest setting'));
    paintTrack(k);
  }

  function syncSliders() {
    for (var k in inputs) {
      inputs[k].input.value = String(sliders[k] || 0);
      showOut(k);
    }
  }

  function showNearest(params) {
    var n = HuhPresets.nearest(params);
    for (var k in inputs) {
      sliders[k] = n[k];
      sliderExact[k] = !!n.exact[k];
    }
    syncSliders();
  }

  function sliderMoved(name, value, final) {
    if (Math.abs(value) < 0.03) value = 0;
    var from = currentParams();
    if (selected) {
      basedOn = selected;
      selected = null;
    }
    custom = HuhPresets.applySlider(from, name, value);
    sliders[name] = value;
    sliderExact[name] = true;
    if (final) inputs[name].input.value = String(value);
    showOut(name);
    updateUi();
    player.scheduleRender(final ? 0 : 120);
  }

  function isPlainParams(params) {
    return HuhMeme.sameParams(params, {});
  }

  $('plain').addEventListener('click', function () {
    basedOn = null;
    custom = HuhPresets.fromSliders({});
    var e = activeEgg();
    choosePreset(e ? e.id : 'original'); // in the egg: the plain blaaah
  });

  function soundName() {
    var p = selected ? presetById(selected) : null;
    if (p) return p.label;
    if (activeEgg()) return 'Custom ' + activeEgg().label.toLowerCase();
    return isPlainParams(custom) ? HuhPresets.PLAIN_LABEL : 'Custom huh';
  }

  function updateUi() {
    var e = activeEgg();
    [].forEach.call(presetBox.querySelectorAll('.preset'), function (b) {
      var id = b.getAttribute('data-preset');
      var p = presetById(id);
      var asEgg = !!(e && e.egg.from === id);
      var shown = asEgg ? e : p;
      b.setAttribute('aria-pressed', (asEgg ? e.id : id) === selected ? 'true' : 'false');
      b.classList.toggle('egg', asEgg);
      var nm = b.querySelector('.name');
      var em = b.querySelector('.emo');
      if (shown && nm && nm.textContent !== shown.label) nm.textContent = shown.label;
      if (shown && em) em.textContent = shown.emoji || '';
    });
    var p = selected ? presetById(selected) : null;
    var from = basedOn ? presetById(basedOn) : null;
    if (p) modeLabel.textContent = 'Preset: ' + p.label;
    else if (isPlainParams(custom)) modeLabel.textContent = HuhPresets.PLAIN_LABEL;
    else modeLabel.textContent = from ? 'Custom (from ' + from.label + ')' : 'Custom';
  }

  // ---- share codes
  function shareState() {
    return { clip: player.clip(), presetId: selected, basedOn: basedOn, params: HuhAudio.normalizeParams(currentParams()) };
  }
  // The address bar stays clean while you play: the share code is only made when Copy link is
  // pressed. An incoming /?h=... link is loaded, then its code is dropped from the address bar.
  function cleanUrl() {
    if (!history.replaceState || !/[?&]h=/.test(location.search)) return;
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
  }
  // Copy link: the name link (/annoyed, served by the share page p.html via
  // _redirects; locally /p.html#annoyed) when the sound is an unmodified
  // preset (as deployed in presets.json, no local edits) on its usual clip
  // (A, or the egg's own clip); the /p share code otherwise.
  function basePresetParams(id) {
    if (id === 'original') return {};
    var b = baseList.filter(function (x) { return x.id === id; })[0];
    return b ? b.params : null;
  }
  function linkUrl() {
    var p = selected ? presetById(selected) : null;
    var defClip = p && p.egg ? p.egg.clip : 'A';
    var base = p ? basePresetParams(p.id) : null;
    if (p && base && player.clip() === defClip && HuhMeme.sameParams(p.params, base)) return location.origin + (local() ? '/p.html#' : '/') + slugOf(p.id);
    return shareUrl();
  }
  function local() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
  }
  function shareUrl() {
    return location.origin + (local() ? '/p.html' : '/p') + '?h=' + HuhMeme.encode(shareState());
  }
  window.HuhPage = { shareUrl: shareUrl, linkUrl: linkUrl, state: shareState, player: player, soundName: function () { return soundName(); },
    egg: function () { var e = activeEgg(); return e ? e.id : null; }, selected: function () { return selected; } };

  // ---- Copy link (Share sheet on phones)
  var useSheet = !!(navigator.share && window.matchMedia && matchMedia('(pointer: coarse)').matches);
  var shareLabel = shareBtn.querySelector('.act-label');
  if (useSheet) shareLabel.textContent = 'Share';
  var shareTimer = 0;

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) {}
      document.body.removeChild(ta);
      shareBtn.focus();
      return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(fallback);
    }
    return fallback();
  }

  function flashShare(text) {
    clearTimeout(shareTimer);
    shareBtn.classList.add('done');
    shareLabel.textContent = text;
    announce(text);
    shareTimer = setTimeout(function () {
      shareBtn.classList.remove('done');
      shareLabel.textContent = useSheet ? 'Share' : 'Copy link';
    }, 1800);
  }

  shareBtn.addEventListener('click', function () {
    var url = linkUrl();
    if (useSheet) {
      navigator.share({ title: 'HUUUH? \u2014 ' + soundName(), url: url }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        copyText(url).then(function () { flashShare('Copied!'); }, function () { window.prompt('Copy this link', url); });
      });
      return;
    }
    copyText(url).then(function () { flashShare('Copied!'); }, function () { window.prompt('Copy this link', url); });
  });

  // ---- Download (export module on first use)
  var exportReady = null;
  function loadExport() {
    if (exportReady) return exportReady;
    exportReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/js/huh-export.js?v=3';
      s.onload = function () { resolve(window.HuhExport); };
      s.onerror = function () { exportReady = null; reject(new Error('Could not load the exporter')); };
      document.head.appendChild(s);
    });
    return exportReady;
  }
  var dlLabel = downloadBtn.querySelector('.act-label');
  var pendingFile = null;
  var busy = false;
  function dlText(t) { dlLabel.textContent = t; }
  function resetDownload(ms) {
    setTimeout(function () {
      if (busy) return;
      pendingFile = null;
      downloadBtn.classList.remove('done', 'busy');
      dlText('Download');
    }, ms || 0);
  }
  downloadBtn.addEventListener('click', function () {
    if (busy) return;
    if (pendingFile) {
      // Second tap: share sheet with a fresh user gesture (iOS: Save Video).
      var f = pendingFile;
      HuhExport.deliver(f, true).then(function () { resetDownload(0); }, function () { resetDownload(0); });
      return;
    }
    if (!player.ready()) { status.textContent = 'Still loading the sound\u2026'; return; }
    busy = true;
    downloadBtn.classList.add('busy');
    dlText('Rendering\u2026');
    var entry = player.entryFor(currentParams());
    var name = soundName();
    var state = shareState();
    loadExport().then(function (X) {
      return X.render({
        clip: state.clip,
        clipUrl: HuhMeme.clipUrl(state.clip),
        entry: entry,
        clipConfig: player.clipConfig(),
        clipDuration: video.duration,
        name: name,
        onProgress: function (f) { dlText('Rendering ' + Math.round(f * 100) + '%'); }
      });
    }).then(function (file) {
      busy = false;
      return HuhExport.deliver(file, false).then(function (how) {
        downloadBtn.classList.remove('busy');
        if (how === 'needs-tap') {
          pendingFile = file;
          downloadBtn.classList.add('done');
          dlText('Save video');
          announce('Video ready. Tap Save video.');
          return;
        }
        downloadBtn.classList.add('done');
        dlText(how === 'shared' ? 'Shared' : 'Downloaded');
        announce('Video ready');
        resetDownload(2000);
      });
    }).catch(function (err) {
      busy = false;
      console.warn(err);
      downloadBtn.classList.remove('busy');
      status.textContent = err && err.userMessage ? err.userMessage : 'Download failed: ' + (err && err.message ? err.message : String(err));
      resetDownload(0);
    });
  });

  // ---- tabs (click, arrow keys)
  var tabs = [$('tab-presets'), $('tab-sliders')];
  function selectTab(t, focus) {
    tabs.forEach(function (o) {
      var on = o === t;
      o.setAttribute('aria-selected', on ? 'true' : 'false');
      o.tabIndex = on ? 0 : -1;
      $(o.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) t.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(t, false); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTab(tabs[(i + 1) % tabs.length], true);
      }
    });
  });

  // ---- cat picker (the voice is the same for every clip)
  function setClipUi(next, restart) {
    var changed = player.setClip(next);
    picks.forEach(function (x) { x.setAttribute('aria-pressed', x.getAttribute('data-clip') === player.clip() ? 'true' : 'false'); });
    if (changed) updateUi();
    if (restart) play();
  }
  picks.forEach(function (b) {
    b.addEventListener('click', function () {
        var e = activeEgg();
      if (e) {
        // Out of the egg: this cat, and the mood the egg came from.
        var wasPlaying = player.isActive();
        exitEgg(b.getAttribute('data-clip'));
        var from = presetById(e.egg.from);
        if (from && selected === e.id) { selected = from.id; showNearest(from.params); }
        else if (from && !selected) { selected = from.id; basedOn = null; showNearest(from.params); }
        updateUi();
        if (wasPlaying) player.play(true);
        return;
      }
      setClipUi(b.getAttribute('data-clip'), player.isActive());
    });
  });

  var playButton = $('play');
  playButton.addEventListener('click', play);
  playButton.addEventListener('touchend', function (e) {
    if (e.cancelable) e.preventDefault();
    play();
  });
  $('stage').addEventListener('click', play);

  // Space plays everywhere except text fields (HuhPresets.spaceToPlay).
  HuhPresets.spaceToPlay(play);

  Promise.all([player.rawReady, presetsReady]).then(function () {
    player.renderNow(false);
    // Every mood in the huh voice, then the egg(s) in their own voice.
    var rest = presets.map(function (p) { return { params: p.params, sample: 'A' }; }).concat(eggs.map(function (p) {
      return { params: p.params, sample: HuhMeme.sampleOf(p.egg.clip) };
    }));
    player.prerender(rest);
  }).catch(function (err) {
    console.error(err);
    if (!status.textContent) status.textContent = err && err.message ? err.message : String(err);
  });
})();
