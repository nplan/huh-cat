'use strict';
/* Main meme page: presets, sliders, cat picker, Play / Space / tap the
 * video, Copy link (share code), Download (js/huh-export.js, loaded on
 * first use). Playback and sync live in huh-meme.js. */
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
  var presets = [];
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

  var presetsReady = HuhPresets.load('presets.json').then(function (r) {
    // Original = plain unmodified huh (same as the lab's fixed Default).
    // Not in presets.json, so Export round-trips stay byte-identical.
    presets = [{
      id: 'original',
      label: 'Original huh',
      emoji: '\uD83D\uDC31',
      params: HuhAudio.normalizeParams({}),
      fixed: true
    }].concat((r.data && r.data.presets) || []);
    player.setClipText((r.data && r.data.clips) || {});
    buildPresets();
    applyIncoming();
    showNearest(currentParams());
    updateUi();
    return r.data;
  }, function (err) {
    console.error(err);
    status.textContent = 'Presets did not load';
    return null;
  });

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
    return null;
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
      b.addEventListener('click', function () { choosePreset(p.id); });
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
    inputs[s[0]] = { input: input, out: out };
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
    choosePreset('original');
  });

  function soundName() {
    var p = selected ? presetById(selected) : null;
    if (p) return p.label;
    return isPlainParams(custom) ? 'Original huh' : 'Custom huh';
  }

  var urlTimer = 0;
  function updateUi() {
    [].forEach.call(presetBox.querySelectorAll('.preset'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-preset') === selected ? 'true' : 'false');
    });
    var p = selected ? presetById(selected) : null;
    var from = basedOn ? presetById(basedOn) : null;
    if (p) modeLabel.textContent = 'Preset: ' + p.label;
    else if (isPlainParams(custom)) modeLabel.textContent = 'Original huh';
    else modeLabel.textContent = from ? 'Custom (from ' + from.label + ')' : 'Custom';
    clearTimeout(urlTimer);
    urlTimer = setTimeout(syncUrl, 400);
  }

  // ---- share codes
  function shareState() {
    return { clip: player.clip(), presetId: selected, basedOn: basedOn, params: HuhAudio.normalizeParams(currentParams()) };
  }
  function isDefaultState() {
    return selected === 'original' && player.clip() === 'A';
  }
  // The address bar follows the state, so a reload keeps it.
  function syncUrl() {
    if (!presets.length || !history.replaceState) return;
    var want = isDefaultState() ? location.pathname : location.pathname + '?h=' + HuhMeme.encode(shareState());
    if (location.pathname + location.search === want) return;
    try { history.replaceState(null, '', want); } catch (e) {}
  }
  function local() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
  }
  function shareUrl() {
    return location.origin + (local() ? '/p.html' : '/p') + '?h=' + HuhMeme.encode(shareState());
  }
  window.HuhPage = { shareUrl: shareUrl, state: shareState, player: player, soundName: function () { return soundName(); } };

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
    var url = shareUrl();
    syncUrl();
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
      s.src = 'js/huh-export.js?v=2';
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
        clipUrl: '/clips/' + state.clip + '.mp4',
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

  // Space plays, unless a keyboard-focused control should get it.
  window.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.repeat) return;
    var t = e.target;
    if (t && t !== document.body) {
      var tag = (t.tagName || '').toLowerCase();
      var typ = (t.type || '').toLowerCase();
      if (tag === 'input' && typ !== 'range') return;
      if (tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
      var kb = false;
      try { kb = t.matches(':focus-visible'); } catch (err) {}
      if ((tag === 'button' || tag === 'a') && t.id !== 'play' && kb) return;
    }
    e.preventDefault();
    play();
  }, true);

  Promise.all([player.rawReady, presetsReady]).then(function () {
    player.renderNow(false);
    var rest = presets.map(function (p) { return p.params; });
    player.prerender(rest);
  }).catch(function (err) {
    console.error(err);
    if (!status.textContent) status.textContent = err && err.message ? err.message : String(err);
  });
})();
