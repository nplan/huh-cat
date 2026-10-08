'use strict';

/**
 * huh vowel shifter (v2). Moves F1, F2 and F3 of the huh to another vowel
 * on the IPA chart while keeping the voice: each STFT frame (2048 window,
 * 4096 FFT, hop 256, zero phase) is multiplied by
 * prod_k |R(f; target Fk)| / |R(f; source Fk)|, R a DC-normalised 2-pole
 * resonator.
 *  - The h is recoloured too (an h is a voiceless vowel), so there is no
 *    "uh -> new vowel" formant glide at voicing onset; the h keeps its
 *    level above ~3 kHz.
 *  - Source bandwidths 250/85/300 Hz (this breathy voice has a broad F1),
 *    so the old formants are not carved into holes and the new ones are not
 *    whistle-sharp; target bandwidths scale with sqrt(F'/F), with floors
 *    70/70/110 Hz.
 *  - F3 stays at least 1.3 x F2 and never below the source F3.
 *  - Boosts lift the harmonics more than the breath noise between them
 *    (noise gets gain^0.6).
 *  - Where a front vowel would make F2 far louder than F1 compared with
 *    real speakers (Peterson & Barney levels), F2 is turned down.
 *  - Per-frame K-weighted loudness match, smoothed over +-3 frames.
 * Source formant tracks are precomputed for clip A only (Praat Burg,
 * 5 formants, 4000 Hz ceiling, smoothed); other audio passes through.
 * The chart point ORIGIN is the huh's own vowel: no change.
 */
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HuhVowel = api;
})(function () {
  var TRACKS_A = {"sampleRate":44100,"length":17056,"boundary":4731,"step":0.005,"start":0.07,"F1":[611,611,611,611,603,594,584,574,564,554,543,541,539,539,539,538,540,541,542,544,545,545,544,543,541,542,545,548,553,558,561,563,558,551,545,538,531,526,523,523,524,523,519,511,496,481,467,452,437,426,419,411,399,386,372,357,343,328,319,315,312,309,309,309],"F2":[903,903,903,903,903,901,898,898,897,897,896,897,901,904,905,906,906,907,905,905,907,908,912,916,921,927,931,935,938,938,937,935,933,931,929,926,927,929,931,933,935,937,937,937,934,925,915,905,896,891,888,885,889,894,897,898,896,893,890,887,884,882,882,882],"F3":[2197,2197,2202,2208,2213,2218,2217,2216,2214,2207,2194,2168,2143,2121,2099,2078,2056,2050,2056,2062,2071,2070,2065,2060,2047,2033,2020,2007,2017,2031,2049,2066,2084,2122,2165,2199,2234,2266,2301,2337,2355,2367,2377,2386,2402,2417,2435,2453,2471,2487,2504,2516,2527,2531,2536,2529,2523,2516,2505,2495,2485,2474,2474,2474],"ref":{"F1":541,"F2":927,"F3":2084}};

  // Chart corners (F1, F2, F3): the cardinal vowels i, u, a, ɑ (F1/F2 from
  // the classic cardinal-vowel table, adult male; F3 typical values). The
  // pad is bilinear in log frequency between them.
  var CORNERS = {
    closeFront: [240, 2400, 3000],
    closeBack: [250, 595, 2400],
    openFront: [850, 1610, 2600],
    openBack: [750, 940, 2500]
  };

  // Sample targets (F1, F2). Cardinal table: i e ɛ a ɑ ɔ o u ʌ. Others are
  // typical adult male values placed on the same chart.
  var VOWELS = {
    'i': [240, 2400], 'ɪ': [400, 2000], 'e': [390, 2300], 'ɛ': [610, 1900], 'æ': [750, 1750],
    'a': [850, 1610], 'ɐ': [700, 1350], 'ɑ': [750, 940], 'ɔ': [500, 700], 'o': [360, 640],
    'u': [250, 595], 'ʊ': [400, 1000], 'ʌ': [600, 1170], 'ə': [500, 1400], 'ɨ': [320, 1500]
  };
  var N = 2048;
  var M = 4096;
  var HOP = 256;
  var GMAX = 24;
  var GMIN = -30;
  var BW_SRC = [250, 85, 300];
  var BW_MIN = [70, 70, 110];
  var F3_SEP = 1.3;
  var NOISE_EXP = 0.6;
  var H_FROM = 0.085;
  var H_TO = 0.125;
  var FIX_SMOOTH = 3;
  var BAL_MIN = -16;
  var BAL_THRESH = 5;
  var BAL_SIGMA = 0.3;
  var HOLD_HZ = 8000;
  var ENV_HZ = 3500;

  /** Formants at pad point x (0 front .. 1 back), y (0 close .. 1 open). */
  function chartAt(x, y) {
    var out = [];
    for (var k = 0; k < 3; k++) {
      var a = Math.log(CORNERS.closeFront[k]);
      var b = Math.log(CORNERS.closeBack[k]);
      var c = Math.log(CORNERS.openFront[k]);
      var d = Math.log(CORNERS.openBack[k]);
      out.push(Math.exp((1 - x) * (1 - y) * a + x * (1 - y) * b + (1 - x) * y * c + x * y * d));
    }
    return out;
  }

  /** Pad point of formants (F1, F2), by Newton steps on the bilinear map. */
  function chartPoint(f1, f2) {
    var x = 0.5;
    var y = 0.5;
    for (var it = 0; it < 30; it++) {
      var f = chartAt(x, y);
      var e1 = Math.log(f[0] / f1);
      var e2 = Math.log(f[1] / f2);
      var h = 1e-4;
      var fx = chartAt(x + h, y);
      var fy = chartAt(x, y + h);
      var j11 = Math.log(fx[0] / f[0]) / h, j12 = Math.log(fy[0] / f[0]) / h;
      var j21 = Math.log(fx[1] / f[1]) / h, j22 = Math.log(fy[1] / f[1]) / h;
      var det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-12) break;
      x -= (j22 * e1 - j12 * e2) / det;
      y -= (-j21 * e1 + j11 * e2) / det;
    }
    return { x: x, y: y };
  }

  var home = chartPoint(TRACKS_A.ref.F1, TRACKS_A.ref.F2);
  // Rounded so it can be a saved default; the shift is relative to it.
  var ORIGIN = { x: Math.round(home.x * 1000) / 1000, y: Math.round(home.y * 1000) / 1000 };

  /**
   * Target ratio per formant for pad point (x, y), relative to the source
   * vowel's own point, so the source position is exactly no change.
   */
  function ratiosAt(x, y) {
    var at = chartAt(x, y);
    var h = chartAt(ORIGIN.x, ORIGIN.y);
    return [at[0] / h[0], at[1] / h[1], at[2] / h[2]];
  }

  function isIdentity(x, y) {
    return Math.abs(x - ORIGIN.x) < 1e-6 && Math.abs(y - ORIGIN.y) < 1e-6;
  }

  function tracksFor(voiced, sampleRate) {
    if (sampleRate === TRACKS_A.sampleRate && voiced.length === TRACKS_A.length) return TRACKS_A;
    return null;
  }

  function trackAt(tr, key, t) {
    var a = tr[key];
    var p = (t - tr.start) / tr.step;
    if (p <= 0) return a[0];
    if (p >= a.length - 1) return a[a.length - 1];
    var i = Math.floor(p);
    return a[i] + (a[i + 1] - a[i]) * (p - i);
  }

  // In-place radix-2 FFT with cached bit-reverse and twiddle tables.
  var fftCache = {};
  function fftTables(n) {
    var t = fftCache[n];
    if (t) return t;
    var rev = new Uint32Array(n), bits = Math.round(Math.log(n) / Math.LN2);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      rev[i] = r;
    }
    var cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (var k = 0; k < n / 2; k++) { cos[k] = Math.cos(-2 * Math.PI * k / n); sin[k] = Math.sin(-2 * Math.PI * k / n); }
    t = fftCache[n] = { rev: rev, cos: cos, sin: sin };
    return t;
  }
  function fft(re, im) {
    var n = re.length, t = fftTables(n), rev = t.rev, cs = t.cos, sn = t.sin;
    for (var i = 0; i < n; i++) {
      var j = rev[i];
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1, step = n / len;
      for (var s = 0; s < n; s += len) {
        for (var k = 0, tw = 0; k < half; k++, tw += step) {
          var a = s + k, b = a + half;
          var wr = cs[tw], wi = sn[tw];
          var vr = re[b] * wr - im[b] * wi;
          var vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
        }
      }
    }
  }

  var tables = null;
  function getTables(sampleRate) {
    if (tables && tables.sampleRate === sampleRate) return tables;
    var bins = M / 2 + 1;
    var c1 = new Float64Array(bins), s1 = new Float64Array(bins), c2 = new Float64Array(bins), s2 = new Float64Array(bins);
    var kw = new Float64Array(bins);
    var win = new Float64Array(N);
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    // BS.1770 K-weighting |H|^2 (48 kHz coefficients at the same physical frequency)
    var b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], a1 = [1, -1.69065929318241, 0.73248077421585];
    var b2 = [1, -2, 1], a2 = [1, -1.99004745483398, 0.99007225036621];
    function mag2(b, a, w) {
      var cr = Math.cos(w), sr = -Math.sin(w), c2r = Math.cos(2 * w), s2r = -Math.sin(2 * w);
      var nr = b[0] + b[1] * cr + b[2] * c2r, ni = b[1] * sr + b[2] * s2r;
      var dr = a[0] + a[1] * cr + a[2] * c2r, di = a[1] * sr + a[2] * s2r;
      return (nr * nr + ni * ni) / (dr * dr + di * di);
    }
    for (var k = 0; k < bins; k++) {
      var w = 2 * Math.PI * k / M;
      c1[k] = Math.cos(w); s1[k] = Math.sin(w); c2[k] = Math.cos(2 * w); s2[k] = Math.sin(2 * w);
      var wk = 2 * Math.PI * (k * sampleRate / M) / 48000;
      kw[k] = mag2(b1, a1, wk) * mag2(b2, a2, wk);
    }
    tables = { sampleRate: sampleRate, c1: c1, s1: s1, c2: c2, s2: s2, kw: kw, win: win };
    return tables;
  }

  // g[k] (k < kHold) = prod_f |R(f; dst_f, bd_f)| / |R(f; src_f, bs_f)|,
  // times the h's high-frequency anchor; clamped to GMIN..GMAX dB.
  function formantGain(g, tb, src, dst, bs, bd, sampleRate, kHold, anchorLog, fLo, fHi) {
    var cs = [], rs = [], cd = [], rd = [], scale = 1;
    for (var f = 0; f < 3; f++) {
      var r1 = Math.exp(-Math.PI * bs[f] / sampleRate), r2 = Math.exp(-Math.PI * bd[f] / sampleRate);
      var c1 = 2 * r1 * Math.cos(2 * Math.PI * src[f] / sampleRate), c2 = 2 * r2 * Math.cos(2 * Math.PI * dst[f] / sampleRate);
      cs.push(c1); rs.push(r1 * r1); cd.push(c2); rd.push(r2 * r2);
      scale *= (1 - c2 + r2 * r2) / (1 - c1 + r1 * r1);
    }
    scale = Math.abs(scale);
    var lo = Math.pow(10, GMIN / 20), hi = Math.pow(10, GMAX / 20);
    var df = sampleRate / M, lLo = Math.log(fLo), lSpan = Math.log(fHi / fLo);
    for (var k = 0; k < kHold; k++) {
      var a = tb.c1[k], b = tb.s1[k], c = tb.c2[k], d = tb.s2[k];
      var num = 1, den = 1;
      for (var j = 0; j < 3; j++) {
        var sr_ = 1 - cs[j] * a + rs[j] * c, si = cs[j] * b - rs[j] * d;
        var dr_ = 1 - cd[j] * a + rd[j] * c, di = cd[j] * b - rd[j] * d;
        num *= sr_ * sr_ + si * si;
        den *= dr_ * dr_ + di * di;
      }
      var v = scale * Math.sqrt(num / den);
      if (anchorLog !== 0) {
        var fr = k * df, w = 0;
        if (fr >= fHi) w = 1;
        else if (fr > fLo) { var u = (Math.log(fr) - lLo) / lSpan; w = u * u * (3 - 2 * u); }
        if (w > 0) v *= Math.exp(-w * anchorLog);
      }
      g[k] = v > hi ? hi : v < lo ? lo : v;
    }
    for (var k2 = kHold; k2 < g.length; k2++) g[k2] = g[kHold - 1];
  }

  // f0 of two frames at once from their autocorrelations (FFT of the
  // power spectra, packed as real + imaginary: both are real and even, so
  // the two transforms come out as the real and imaginary parts). 0 = none.
  function pairF0(PA, PB, sampleRate, cr, ci, out, ia, ib) {
    var bins = PA.length;
    for (var k = 0; k < M; k++) {
      var kk = k < bins ? k : M - k;
      cr[k] = PA[kk]; ci[k] = PB ? PB[kk] : 0;
    }
    fft(cr, ci);
    var l0 = Math.floor(sampleRate / 400), l1 = Math.ceil(sampleRate / 70);
    for (var which = 0; which < (PB ? 2 : 1); which++) {
      var r = which === 0 ? cr : ci, best = -1, bv = 0;
      for (var L = l0; L <= l1; L++) if (r[L] > bv && r[L] >= r[L - 1] && r[L] >= r[L + 1]) { bv = r[L]; best = L; }
      out[which === 0 ? ia : ib] = best > 0 && bv / r[0] > 0.25 ? sampleRate / best : 0;
    }
  }

  // Harmonic-aware version of the gain: boosts (g > 1) act fully on the
  // harmonics and as g^NOISE_EXP on the noise between them (noise PSD from
  // the bins midway between harmonics, averaged over +-f0). Above kHold the
  // gain is flat and the spectrum is treated as noise.
  function harmonicScale(sc, g, P, sampleRate, f0, kHold, cs, cc) {
    var bins = g.length, df = sampleRate / M, k2, gg;
    var gHold = g[kHold - 1], gnHold = gHold > 1 ? Math.exp(NOISE_EXP * Math.log(gHold)) : gHold;
    for (k2 = kHold; k2 < bins; k2++) sc[k2] = gnHold;
    if (!(f0 > 0)) {
      for (k2 = 0; k2 < kHold; k2++) { gg = g[k2]; sc[k2] = gg > 1 ? Math.exp(NOISE_EXP * Math.log(gg)) : gg; }
      return;
    }
    var W = Math.max(2, Math.round(f0 / df)), top = Math.min(bins, kHold + W + 1);
    cs[0] = 0; cc[0] = 0;
    for (k2 = 0; k2 < top; k2++) {
      var f = k2 * df, h = Math.round(f / f0), dh = f - h * f0;
      if (dh < 0) dh = -dh;
      var isNoise = k2 > 0 && h >= 1 && dh > 0.4 * f0;
      cs[k2 + 1] = cs[k2] + (isNoise ? P[k2] : 0);
      cc[k2 + 1] = cc[k2] + (isNoise ? 1 : 0);
    }
    for (k2 = 0; k2 < kHold; k2++) {
      gg = g[k2];
      if (gg <= 1) { sc[k2] = gg; continue; }
      var a = k2 - W < 0 ? 0 : k2 - W, b = k2 + W + 1 > top ? top : k2 + W + 1, cnt = cc[b] - cc[a];
      var noise = cnt > 0 ? (cs[b] - cs[a]) / cnt : P[k2];
      var H = P[k2] - noise;
      if (H < 0) H = 0;
      var Nn = P[k2] - H, gn = Math.exp(NOISE_EXP * Math.log(gg));
      sc[k2] = P[k2] > 0 ? Math.sqrt((gg * gg * H + gn * gn * Nn) / P[k2]) : gg;
    }
  }

  /**
   * Keeps peaks at or below `ceiling` with a smooth gain that never changes
   * faster than ~20 ms (longer than a pitch period, so no buzz): the needed
   * gain is min-filtered over +-10 ms, then Hann-smoothed over 20 ms.
   */
  var GUARD_SEC = 0.01;
  function setGuard(sec) { GUARD_SEC = sec; }
  function peakGuard(y, ceiling, sampleRate) {
    var n = y.length;
    var need = new Float32Array(n);
    var any = false;
    for (var i = 0; i < n; i++) {
      var a = y[i] < 0 ? -y[i] : y[i];
      need[i] = a > ceiling ? ceiling / a : 1;
      if (need[i] < 1) any = true;
    }
    if (!any) return;
    var h = Math.max(1, Math.round(GUARD_SEC * sampleRate));
    // running minimum over [i-h, i+h] (monotonic deque)
    var minv = new Float32Array(n);
    var dq = new Int32Array(n + 2 * h + 1);
    var head = 0, tail = 0;
    for (var j = 0; j < n + h; j++) {
      if (j < n) {
        while (tail > head && need[dq[tail - 1]] >= need[j]) tail--;
        dq[tail++] = j;
      }
      var c = j - h;
      if (c >= 0) {
        while (dq[head] < c - h) head++;
        minv[c] = need[dq[head]];
      }
    }
    // moving average over [m-h, m+h] (each value there is a min over a
    // window that contains m, so the result never exceeds need[m])
    var run = 0, cnt = 2 * h + 1;
    for (var p = -h; p <= h; p++) run += p < 0 || p >= n ? 1 : minv[p];
    for (var m = 0; m < n; m++) {
      var g = run / cnt;
      if (g < 1) y[m] *= g;
      var out = m - h, inn = m + h + 1;
      run += (inn >= n ? 1 : minv[inn]) - (out < 0 ? 1 : minv[out]);
    }
  }

  function levelNear(arr, F, df) {
    var m = -1e9, k0 = Math.floor(F * 0.92 / df), k1 = Math.min(arr.length - 1, Math.ceil(F * 1.08 / df));
    for (var k = k0; k <= k1; k++) if (arr[k] > m) m = arr[k];
    return m;
  }
  function valueAt(arr, F, df) {
    var p = F / df, i = Math.floor(p), u = p - i;
    if (i + 1 >= arr.length) return arr[arr.length - 1];
    return arr[i] + (arr[i + 1] - arr[i]) * u;
  }

  /**
   * voiced: the trimmed clip (Float32Array). x, y: pad point (0..1).
   * strength scales the move (1 = full). Returns a new array, or voiced
   * itself when there is nothing to do.
   */
  function shiftVowel(voiced, sampleRate, x, y, strength) {
    var s = strength === undefined ? 1 : strength;
    if (!(s > 0) || isIdentity(x, y)) return voiced;
    var tr = tracksFor(voiced, sampleRate);
    if (!tr) return voiced;
    var ratio = ratiosAt(x, y);
    var tb = getTables(sampleRate);
    var n = voiced.length;
    var bins = M / 2 + 1, df = sampleRate / M;
    var kHold = Math.min(bins, Math.ceil(HOLD_HZ / df));
    var kEnv = Math.min(bins, Math.ceil(ENV_HZ / df));
    var off = N / 2, base = M;
    var acc = new Float64Array(n + 2 * M), wsum = new Float64Array(n + 2 * M);
    var re = new Float64Array(M), im = new Float64Array(M), cr = new Float64Array(M), ci = new Float64Array(M);
    var win = tb.win;
    var frames = [];
    var LT = new Float64Array(kEnv);
    var hwBins = Math.max(2, Math.round(65 / df));
    var Pd = new Float64Array(kEnv + hwBins + 1);
    var g = new Float64Array(bins);

    // pass 1a: spectra, two real frames per complex FFT
    var starts = [];
    for (var st0 = -N / 2; st0 < n; st0 += HOP) starts.push(st0);
    var nf0 = starts.length;
    for (var p0 = 0; p0 < nf0; p0 += 2) {
      re.fill(0); im.fill(0);
      for (var h0 = 0; h0 < 2 && p0 + h0 < nf0; h0++) {
        var buf = h0 === 0 ? re : im, sA = starts[p0 + h0];
        for (var i = 0; i < N; i++) {
          var at = sA + i;
          if (at >= 0 && at < n) { buf[off + i] = voiced[at] * win[i]; wsum[at + base] += win[i]; }
        }
      }
      fft(re, im);
      for (var h1 = 0; h1 < 2 && p0 + h1 < nf0; h1++) {
        var Xr = new Float64Array(bins), Xi = new Float64Array(bins), P = new Float64Array(bins);
        for (var k = 0; k < bins; k++) {
          var mk = k === 0 ? 0 : M - k;
          if (h1 === 0) { Xr[k] = 0.5 * (re[k] + re[mk]); Xi[k] = 0.5 * (im[k] - im[mk]); }
          else { Xr[k] = 0.5 * (im[k] + im[mk]); Xi[k] = 0.5 * (re[mk] - re[k]); }
          P[k] = Xr[k] * Xr[k] + Xi[k] * Xi[k];
        }
        frames.push({ st: starts[p0 + h1], re: Xr, im: Xi, P: P });
      }
    }
    var f0s = new Float64Array(nf0);
    for (var p1 = 0; p1 < nf0; p1 += 2) pairF0(frames[p1].P, p1 + 1 < nf0 ? frames[p1 + 1].P : null, sampleRate, cr, ci, f0s, p1, p1 + 1);
    var csum = new Float64Array(bins + 2), ccnt = new Float64Array(bins + 2);

    // pass 1b: formant gain, harmonic-aware scale, envelope
    for (var fi = 0; fi < nf0; fi++) {
      var fr0 = frames[fi], tc = (fr0.st + N / 2) / sampleRate, P1 = fr0.P;
      var src = [], dst = [], bd = [];
      for (var f = 0; f < 3; f++) { src.push(trackAt(tr, 'F' + (f + 1), tc)); dst.push(src[f] * Math.pow(ratio[f], s)); }
      dst[2] = Math.max(dst[2], dst[1] * F3_SEP, src[2]);
      var A = 1;
      for (var f2 = 0; f2 < 3; f2++) {
        var b = BW_SRC[f2] * Math.sqrt(dst[f2] / src[f2]);
        bd.push(Math.max(b, BW_MIN[f2]));
        A *= (dst[f2] / src[f2]) * (dst[f2] / src[f2]);
      }
      // the h (before voicing) keeps its level above ~3 kHz
      var uu = Math.min(1, Math.max(0, (tc - H_FROM) / (H_TO - H_FROM)));
      var hw = 1 - uu * uu * (3 - 2 * uu);
      var fLo = dst[0], fHi = Math.max(dst[2] * 1.15, 3000, fLo * 1.3);
      formantGain(g, tb, src, dst, BW_SRC, bd, sampleRate, kHold, hw * Math.log(A), fLo, fHi);
      // upper envelope of the source (dB) for the level balance
      for (var k3 = 0; k3 < Pd.length; k3++) Pd[k3] = 10 * Math.log10(P1[k3] + 1e-20);
      for (var k4 = 0; k4 < kEnv; k4++) {
        var mx = -1e9;
        for (var j4 = Math.max(0, k4 - hwBins); j4 <= k4 + hwBins; j4++) if (Pd[j4] > mx) mx = Pd[j4];
        LT[k4] += Math.pow(10, mx / 10);
      }
      var gdb = new Float64Array(kEnv);
      for (var k5 = 0; k5 < kEnv; k5++) gdb[k5] = 20 * Math.log10(g[k5]);
      var sc = new Float64Array(bins);
      harmonicScale(sc, g, P1, sampleRate, f0s[fi], kHold, csum, ccnt);
      fr0.sc = sc; fr0.src = src; fr0.dst = dst; fr0.gdb = gdb;
    }
    for (var k6 = 0; k6 < kEnv; k6++) LT[k6] = 10 * Math.log10(LT[k6] / frames.length + 1e-20);

    // level balance: where F2 would come out far louder than F1 (compared
    // with real speakers), turn it down around F2 (median + mean smoothed)
    var nf = frames.length, dv = new Float64Array(nf);
    for (var q = 0; q < nf; q++) {
      var fq = frames[q], s1 = fq.src[0], s2 = fq.src[1], d1 = fq.dst[0], d2 = fq.dst[1];
      var got = (levelNear(LT, d2, df) + valueAt(fq.gdb, d2, df)) - (levelNear(LT, d1, df) + valueAt(fq.gdb, d1, df)) - (levelNear(LT, s2, df) - levelNear(LT, s1, df));
      var want = -4.94 * Math.log2(d2 / s2) + 7.87 * Math.log2(d1 / s1);
      dv[q] = want - got;
    }
    var sm = new Float64Array(nf), sm2 = new Float64Array(nf), fix = new Float64Array(nf);
    for (var q2 = 0; q2 < nf; q2++) {
      var wv = [];
      for (var j6 = -4; j6 <= 4; j6++) if (q2 + j6 >= 0 && q2 + j6 < nf) wv.push(dv[q2 + j6]);
      wv.sort(function (a, b) { return a - b; });
      sm[q2] = wv[wv.length >> 1];
    }
    for (var q3 = 0; q3 < nf; q3++) {
      var sa = 0, sn = 0;
      for (var j7 = -2; j7 <= 2; j7++) if (q3 + j7 >= 0 && q3 + j7 < nf) { sa += sm[q3 + j7]; sn++; }
      sm2[q3] = sa / sn;
    }
    for (var q4 = 0; q4 < nf; q4++) {
      var fr4 = frames[q4];
      var d = Math.max(BAL_MIN, Math.min(0, sm2[q4]));
      d = d < -BAL_THRESH ? d + BAL_THRESH : 0;
      if (d !== 0) {
        var F1 = fr4.dst[0], F2 = fr4.dst[1], mid = Math.sqrt(F1 * F2), lmid = Math.log(mid), lspan = Math.log(F2 / mid);
        for (var k7 = 1; k7 < bins; k7++) {
          var fk = k7 * df, w7;
          if (fk <= mid) continue;
          if (fk < F2) { var u7 = (Math.log(fk) - lmid) / lspan; w7 = u7 * u7 * (3 - 2 * u7); } else { var o7 = Math.log2(fk / F2) / BAL_SIGMA; w7 = Math.exp(-0.5 * o7 * o7); }
          if (w7 < 1e-4 && fk > F2) break;
          fr4.sc[k7] *= Math.pow(10, d * w7 / 20);
        }
      }
      var e0 = 0, e1 = 0;
      for (var k8 = 0; k8 < bins; k8++) { var pk = fr4.P[k8] * tb.kw[k8], gg = fr4.sc[k8]; e0 += pk; e1 += pk * gg * gg; }
      fix[q4] = e1 > 0 ? Math.log(Math.sqrt(e0 / e1)) : 0;
    }
    // loudness fix smoothed over +-FIX_SMOOTH frames, then apply; inverse
    // FFTs two frames at a time (Y = YA + i YB gives yA + i yB), overlap-add
    var fxs = new Float64Array(nf);
    for (var q5 = 0; q5 < nf; q5++) {
      var la = 0, ln = 0;
      for (var j8 = -FIX_SMOOTH; j8 <= FIX_SMOOTH; j8++) if (q5 + j8 >= 0 && q5 + j8 < nf) { la += fix[q5 + j8]; ln++; }
      fxs[q5] = Math.exp(la / ln);
      var fr5 = frames[q5];
      for (var k9 = 0; k9 < bins; k9++) { var g9 = fr5.sc[k9] * fxs[q5]; fr5.re[k9] *= g9; fr5.im[k9] *= g9; }
    }
    for (var q6 = 0; q6 < nf; q6 += 2) {
      var FA = frames[q6], FB = q6 + 1 < nf ? frames[q6 + 1] : null;
      for (var k10 = 0; k10 < M; k10++) {
        var kk = k10 <= M / 2 ? k10 : M - k10, sg = k10 <= M / 2 ? 1 : -1;
        var ar = FA.re[kk], ai = sg * FA.im[kk], br = FB ? FB.re[kk] : 0, bi = FB ? sg * FB.im[kk] : 0;
        // conjugate of (A + iB) for the inverse via a forward FFT
        re[k10] = ar - bi; im[k10] = -(ai + br);
      }
      fft(re, im);
      for (var o = 0; o < M; o++) {
        var atA = FA.st - off + o;
        if (atA >= -base && atA < n + base) acc[atA + base] += re[o] / M;
        if (FB) { var atB = FB.st - off + o; if (atB >= -base && atB < n + base) acc[atB + base] -= im[o] / M; }
      }
    }
    var out = new Float32Array(n);
    var peak0 = 0;
    for (var jj = 0; jj < n; jj++) {
      out[jj] = acc[jj + base] / Math.max(wsum[jj + base], 1e-9);
      var a0 = voiced[jj] < 0 ? -voiced[jj] : voiced[jj];
      if (a0 > peak0) peak0 = a0;
    }
    peakGuard(out, peak0, sampleRate);
    return out;
  }

  return {
    CORNERS: CORNERS,
    VOWELS: VOWELS,
    ORIGIN: ORIGIN,
    TRACKS_A: TRACKS_A,
    chartAt: chartAt,
    chartPoint: chartPoint,
    ratiosAt: ratiosAt,
    shiftVowel: shiftVowel,
    _setGuard: setGuard,
    _peakGuard: peakGuard
  };
});
