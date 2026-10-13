// Onion break slicer: a break cut into slices (by its hits, or a grid, or by hand), the slices on pads, and a chop
// pattern of up to 64 steps that plays them at any tempo: each step fires a slice at its velocity, the next one cuts
// it (the jungle way), a step can reverse it, retrigger it or pitch it. The loop you hear is rendered here sample by
// sample, the same render that SAMPLE puts in the library. Sources: the bundled breaks, the library, files, the mic.
import { SR, toWav } from './dsp.js';
import { ac, out, T, channel, refresh, toggle, onPlay, onTempo, setBpm, stepAt } from './audio.js';
import { knob, toast, scrollGuard } from './ui.js';
import { makeSeq, plays, NSTEP } from './seqcore.js';
import { libAdd, libAll, libGet } from './lib.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export const BREAKS = [
  { name: 'ONION DEMO BEAT', url: 'breaks/onion-demo.wav', bpm: 160 },
];

/* ------------------------------------------------------------ state --- */
// the chop pattern is a track of the sequencing core (seqcore.js): a step is {on, s (the slice), vel, pit, rtg, rev,
// prb, cnd}; its ROLL has a row per slice
const S = {
  srcName: '', srcRef: null, data: null,           // the break (mono, SR)
  origBpm: 136, mode: 'auto', sens: 0.5, count: 16, grid: 16,   // how it is cut: 'auto' | 'sens' | 'count' | 'grid' | 'hand'
  va: 0, vb: 1, snap: true,                         // the waveform's window (a zoom, 0..1 of the break); lines snap to zero
  slices: [0], sp: [],                              // slice starts (samples); per slice {pitch, rev, gain, dec}
  swing: 0, gpitch: 0, sel: 0, write: true,
  amp: { atk: 0, hld: 1000, dec: 400 },             // every hit's envelope (ms; HOLD 1000 = FULL); a trig can lock its own
  chaos: { swap: 0.28, rep: 0.08, rev: 0.08, roll: 0.07, vel: 0.3, gap: 0 },
};
let sq = null;
const tr = () => sq.tr;
const pad2 = v => String(v).padStart(2, '0');
function persist() {
  try {
    localStorage.setItem('onion-slicer', JSON.stringify({ srcRef: S.srcRef, origBpm: S.origBpm, mode: S.mode, sens: S.sens, count: S.count, grid: S.grid, snap: S.snap,
      slices: S.mode === 'hand' ? S.slices : null, sp: S.sp, swing: S.swing, gpitch: S.gpitch, chaos: S.chaos, amp: S.amp }));
  } catch (e) { /* ignore */ }
}
const id36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const peaksOf = (d, n = 48) => Array.from({ length: n }, (_, i) => {
  let m = 0;
  for (let j = Math.floor(i * d.length / n); j < Math.floor((i + 1) * d.length / n); j++) m = Math.max(m, Math.abs(d[j]));
  return +m.toFixed(3);
});

/* --------------------------------------------------------- analysis --- */
function estimateBpm(n, name) {
  const m = /(\d{2,3})\s*bpm/i.exec(name || '');
  if (m) return +m[1];
  const dur = n / SR;
  let best = 136, bd = 1e9;
  for (const bars of [1, 2, 4]) {
    const bpm = bars * 4 * 60 / dur;
    if (bpm >= 80 && bpm <= 190 && Math.abs(bpm - 140) < bd) { bd = Math.abs(bpm - 140); best = bpm; }
  }
  return Math.round(best * 10) / 10;
}
// transients: the first difference (hats, snares, clicks) and the level (kicks), per hop, against a moving local
// average (a loud passage does not hide a quiet hit after it); a slice starts a hop before its rise. By SENS (how far
// above its surroundings a hit must rise) or by COUNT (the strongest hits, as many as asked)
function detect(data, { sens = 0.5, count = 0, floor = 0 } = {}) {
  const hop = 256, n = Math.floor(data.length / hop), e = new Float32Array(n), lv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0;
    for (let j = i * hop + 1; j < (i + 1) * hop; j++) { a += Math.abs(data[j] - data[j - 1]); b += Math.abs(data[j]); }
    e[i] = a; lv[i] = b;
  }
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) flux[i] = Math.max(0, e[i] - e[i - 1]) + 0.5 * Math.max(0, lv[i] - lv[i - 1]);
  const W = 24, k = count ? Math.max(1.12, floor) : 1.3 + (1 - sens) * 4.5, gap = Math.round(0.06 * SR / hop), cand = [];
  let gmean = 0;
  for (let i = 0; i < n; i++) gmean += flux[i];
  gmean /= n;
  for (let i = 2; i < n - 1; i++) {
    let loc = 0, c = 0;
    for (let j = Math.max(0, i - W); j < Math.min(n, i + W); j++) { loc += flux[j]; c++; }
    loc = Math.max(loc / c, gmean * 0.5);
    if (flux[i] > loc * k && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) cand.push([i, flux[i] / loc]);
  }
  cand.sort((a, b) => b[1] - a[1]);
  const keep = [], most = count ? count - 1 : 63;
  for (const [i] of cand) { if (keep.length >= most) break; if (i * hop > 0.04 * SR && keep.every(x => Math.abs(x - i) >= gap)) keep.push(i); }
  const starts = [0, ...keep.map(i => Math.max(0, (i - 1) * hop))].sort((a, b) => a - b);
  return starts.filter((s, i) => i === 0 || s - starts[i - 1] > hop);
}
// AUTO: about a slice an eighth note (the break's own tempo), only hits that stand out; SENS / COUNT / GRID as set
function reslice() {
  if (!S.data) return;
  const eighths = Math.round(S.data.length / SR / (30 / S.origBpm));
  if (S.mode === 'auto') S.slices = detect(S.data, { count: clamp(eighths, 6, 40), floor: 1.6 });
  else if (S.mode === 'sens') S.slices = detect(S.data, { sens: S.sens });
  else if (S.mode === 'count') S.slices = detect(S.data, { count: S.count });
  else if (S.mode === 'grid') S.slices = Array.from({ length: S.grid }, (_, k) => Math.round(k * S.data.length / S.grid));
  while (S.sp.length < S.slices.length) S.sp.push({ pitch: 0, rev: 0, gain: 1, dec: 1 });
  S.sel = Math.min(S.sel, S.slices.length - 1);
}
// the nearest zero crossing (no click where a slice starts), within r samples
function zero(p, r = Math.round(0.0015 * SR)) {
  const d = S.data;
  for (let o = 0; o <= r; o++) for (const q of [p + o, p - o]) if (q > 0 && q < d.length && (d[q - 1] <= 0) !== (d[q] <= 0)) return q;
  return p;
}
const sliceEnd = i => i + 1 < S.slices.length ? S.slices[i + 1] : S.data.length;

/* ----------------------------------------------------------- render --- */
// one slice into out, from sample `at`, until `cut` (the next trigger; it fades there): its pitch, reverse, decay,
// gain, and the step's velocity
// a hit's envelope (its trig's locks over the track's): attack, hold (FULL: to the end), decay to -40 dB, in samples
const ampOf = step => ({ atk: step?.atk ?? S.amp.atk, hld: step?.hld ?? S.amp.hld, dec: step?.dec ?? S.amp.dec });
function play(out, at, cut, si, step, wrap) {
  const a = S.slices[si], b = sliceEnd(si), seg = b - a, p = S.sp[si];
  const rate = Math.pow(2, (p.pitch + (step ? step.pit : 0) + S.gpitch) / 12);
  const rev = (p.rev ? 1 : 0) ^ (step && step.rev ? 1 : 0);
  const vel = step && step.vel != null ? step.vel : 1;
  const E = ampOf(step), As = E.atk * SR / 1000, Hs = E.hld >= 1000 ? Infinity : E.hld * SR / 1000, Ds = E.dec * SR / 1000;
  const len = Math.min(Math.floor(seg / rate), cut - at, Math.ceil(As + Hs + Ds * 1.6));
  const dlen = p.dec < 0.999 ? Math.max(32, p.dec * seg / rate) : 0, fi = 48, fo = 144, n = out.length;
  for (let i = 0; i < len; i++) {
    const pos = rev ? b - 1 - i * rate : a + i * rate, k = Math.floor(pos), f = pos - k;
    const x = S.data[k] * (1 - f) + (S.data[k + 1] || 0) * f;
    let g = p.gain * vel * vel * (dlen ? Math.exp(-i * 4.6 / dlen) : 1);
    if (i < As) g *= i / As; else if (i > As + Hs) g *= Math.exp(-(i - As - Hs) * 4.6 / Ds);
    if (i < fi) g *= i / fi;
    if (len - i < fo) g *= (len - i) / fo;
    const o = at + i;
    if (wrap) out[o % n] += x * g; else if (o < n) out[o] += x * g;
  }
}
// the steps that fire on the n-th time round (n < 0: all of them, as written: SAMPLE)
function triggers(n = -1) {
  const t = tr(), st = 60 / T.bpm / 4 * SR, total = Math.round(st * t.len), out = [], pl = plays(t, n, 7);
  for (let k = 0; k < t.len; k++) {
    const x = t.steps[k];
    if (!pl[k] || x.s < 0 || x.s >= S.slices.length) continue;
    const t0 = k * st + (k % 2 ? S.swing * st * 0.5 : 0), r = x.rtg || 1;
    for (let j = 0; j < r; j++) out.push({ at: Math.round(t0 + j * st / r), s: x.s, step: x });
  }
  return { tr: out, total };
}
export function renderLoop() {
  const { tr, total } = triggers(), out = new Float32Array(total);
  tr.forEach((t, i) => play(out, t.at, i + 1 < tr.length ? tr[i + 1].at : tr[0].at + total, t.s, t.step, true));
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.98) for (let i = 0; i < total; i++) out[i] *= 0.98 / peak;
  return out;
}
// the n-th time round, for the transport: what rings past the end of one round is carried into the next
const carry = new Map();
function renderCycle(n) {
  const { tr, total } = triggers(n), out = new Float32Array(total * 2);
  tr.forEach((t, i) => play(out, t.at, i + 1 < tr.length ? tr[i + 1].at : total + (tr[0] ? tr[0].at : 0), t.s, t.step, false));
  const cur = out.subarray(0, total), prev = carry.get(n);
  if (prev) for (let i = 0; i < prev.length && i < total; i++) cur[i] += prev[i];
  carry.delete(n); carry.set(n + 1, out.slice(total, total * 2));
  if (carry.size > 4) carry.delete(carry.keys().next().value);
  return cur.slice();
}
function renderSlice(si, vel = 1) {
  const p = S.sp[si], rate = Math.pow(2, (p.pitch + S.gpitch) / 12), n = Math.floor((sliceEnd(si) - S.slices[si]) / rate) + 8;
  const out = new Float32Array(n);
  play(out, 0, n, si, { pit: 0, rev: 0, vel }, false);
  return out;
}

/* ------------------------------------------------------------ audio --- */
// the BREAK channel of the shared transport (audio.js): its loop is renderLoop at the tempo
let playing = false, padVoice = null;
function bufOf(data) { const c = ac(), b = c.createBuffer(1, data.length, SR); b.copyToChannel(data, 0); return b; }
function relive() { refresh('break'); }                  // a change while playing: same place, new sound
function transport() { if (S.data) { ac(); toggle(); } }
function follow() {
  if (!playing) return;
  const k = stepAt(tr().len);
  if (k >= 0 && k !== follow.last) { follow.last = k; const x = tr().steps[k]; sq.draw(k); drawWave(x.on ? x.s : -1); }
  requestAnimationFrame(follow);
}
function audition(si, vel = 1) {
  if (!S.data || si < 0) return;
  if (padVoice) try { padVoice.stop(); } catch (e) { /* ended */ }
  const c = ac(), s = c.createBufferSource();
  s.buffer = bufOf(renderSlice(si, vel)); s.connect(out()); s.start();
  padVoice = s;
}

/* ------------------------------------------------------ the waveform --- */
// the window shown (S.va..S.vb of the break) above a strip of the whole of it (the window drawn on it: drag there to
// move it); lines drawn where the slices start
const OVH = 18;
function drawWave(hot = -1) {
  const c = $('slWave');
  if (!c || !S.data || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight, H = h - OVH - 4;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const n = S.data.length, a0 = S.va * n, span = (S.vb - S.va) * n, X = s => (s - a0) / span * w, mid = H / 2;
  const sa = S.slices[S.sel], sb = sliceEnd(S.sel);
  g.fillStyle = 'rgba(185,162,240,.22)'; g.fillRect(X(sa), 0, X(sb) - X(sa), H);
  if (hot >= 0 && hot < S.slices.length) { g.fillStyle = 'rgba(255,138,76,.25)'; g.fillRect(X(S.slices[hot]), 0, X(sliceEnd(hot)) - X(S.slices[hot]), H); }
  g.fillStyle = css('--lilac'); g.strokeStyle = css('--lilac');
  const per = span / w;
  if (per < 3) {                                        // close in: the samples as a line
    g.beginPath(); g.lineWidth = 1.5;
    for (let x = 0; x <= w; x++) { const i = Math.floor(a0 + x * per), v = S.data[i] || 0; x ? g.lineTo(x, mid - v * (mid - 6)) : g.moveTo(x, mid - v * (mid - 6)); }
    g.stroke();
  } else for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(a0 + x * per); i < Math.floor(a0 + (x + 1) * per); i++) { const v = S.data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.fillRect(x, mid - hi * (mid - 6), 1, Math.max(1, (hi - lo) * (mid - 6)));
  }
  g.fillStyle = 'rgba(61,43,32,.12)'; g.fillRect(0, mid, w, 1);
  g.font = '10px Silkscreen, monospace';
  S.slices.forEach((s, i) => {
    const x = Math.round(X(s)) + 0.5;
    if (x < -10 || x > w + 10) return;
    const on = i === S.sel;
    g.fillStyle = on ? css('--purple-d') : css('--yel');
    g.fillRect(x - (on ? 1 : 0.5), 0, on ? 2 : 1, H);
    g.fillRect(x - 0.5, 0, 9, 9);
    if (X(sliceEnd(i)) - X(s) > 16) { g.fillStyle = on ? css('--purple-d') : 'rgba(61,43,32,.6)'; g.fillText(String(i + 1), x + 3, H - 4); }
  });
  // the strip: all of it, the window on it
  const oy = h - OVH;
  g.fillStyle = css('--purple-xl'); g.fillRect(0, oy, w, OVH);
  g.fillStyle = 'rgba(185,162,240,.8)';
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let i = Math.floor(x / w * n); i < Math.floor((x + 1) / w * n); i += 4) m = Math.max(m, Math.abs(S.data[i]));
    g.fillRect(x, oy + OVH / 2 - m * (OVH / 2 - 2), 1, Math.max(1, m * (OVH - 4)));
  }
  if (S.vb - S.va < 0.999) { g.strokeStyle = css('--purple-d'); g.lineWidth = 2; g.strokeRect(S.va * w + 1, oy + 1, Math.max(4, (S.vb - S.va) * w) - 2, OVH - 2); }
  const z = $('slZoomV');
  if (z) z.textContent = Math.round(1 / (S.vb - S.va) * 10) / 10 + 'X';
}
function setView(a, b) {                                  // the window, kept inside the break
  const min = Math.min(1, 300 / S.data.length), wd = clamp(b - a, min, 1);   // (300 samples across: each one seen)
  S.va = clamp(a, 0, 1 - wd); S.vb = S.va + wd;
  drawWave();
}
function zoomAt(f, at = 0.5) {                            // by f, about a point (0..1 of the window) that stays put
  const p = S.va + at * (S.vb - S.va), wd = (S.vb - S.va) / f;
  setView(p - at * wd, p - at * wd + wd);
}
function zoomToSlice() {
  const a = S.slices[S.sel] / S.data.length, b = sliceEnd(S.sel) / S.data.length, pad = (b - a) * 0.15;
  setView(a - pad, b + pad);
}
// one finger: tap a slice (plays it), drag a line (moves it, as fine as the zoom), drag elsewhere sideways (moves
// the window); double tap: a line there, or (on one) remove it; two fingers: pinch the zoom, move; the strip below:
// drag the window there. The page still scrolls up / down over it
function waveInput() {
  const c = $('slWave'), pts = new Map();
  let drag = -1, x0 = 0, y0 = 0, moved = false, lastT = 0, lastX = -99, pan = null, pinch = null, strip = false;
  const R = () => c.getBoundingClientRect();
  const at = e => { const r = R(); return clamp(S.va + clamp((e.clientX - r.left) / r.width, 0, 1) * (S.vb - S.va), 0, 1) * S.data.length; };
  const lineAt = px => {
    const w = R().width, n = S.data.length;
    let best = -1, bd = 16;
    S.slices.forEach((s, i) => { const d = Math.abs((s / n - S.va) / (S.vb - S.va) * w - px); if (i > 0 && d < bd) { bd = d; best = i; } });
    return best;
  };
  const toHand = () => { if (S.mode !== 'hand') { S.mode = 'hand'; drawModes(); } };
  scrollGuard(c, () => drag > 0 || !!pan || !!pinch || strip);
  c.addEventListener('pointerdown', e => {
    if (!S.data) return;
    ac();
    try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    pts.set(e.pointerId, e.clientX);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.abs(a - b) || 1, va: S.va, vb: S.vb, c: ((a + b) / 2 - R().left) / R().width };
      drag = -1; pan = null; return;
    }
    const r = R();
    x0 = e.clientX - r.left; y0 = e.clientY - r.top; moved = false;
    strip = y0 > r.height - OVH - 4;
    if (strip) { const f = x0 / r.width, wd = S.vb - S.va; setView(f - wd / 2, f + wd / 2); return; }
    drag = lineAt(x0);
  });
  c.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(e); return; }
    pts.set(e.pointerId, e.clientX);
    const r = R(), px = e.clientX - r.left;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()], f = Math.abs(a - b) / pinch.d, wd = (pinch.vb - pinch.va) / f, p = pinch.va + pinch.c * (pinch.vb - pinch.va);
      const cNow = ((a + b) / 2 - r.left) / r.width;
      setView(p - cNow * wd, p - cNow * wd + wd);
      return;
    }
    if (strip) { const f = px / r.width, wd = S.vb - S.va; setView(f - wd / 2, f + wd / 2); return; }
    if (!moved && Math.abs(px - x0) < 5) return;
    if (!moved && Math.abs(e.clientY - r.top - y0) > Math.abs(px - x0)) { pts.delete(e.pointerId); return; }   // the page scrolls
    moved = true;
    if (drag > 0) {
      toHand();
      S.slices[drag] = clamp(Math.round(at(e)), S.slices[drag - 1] + 256, drag + 1 < S.slices.length ? S.slices[drag + 1] - 256 : S.data.length - 256);
      drawWave();
    } else if (S.vb - S.va < 0.999) {
      if (!pan) pan = { x: e.clientX, va: S.va, vb: S.vb };
      const d = (e.clientX - pan.x) / r.width * (pan.vb - pan.va);
      setView(pan.va - d, pan.vb - d);
    }
  });
  function end(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    try { c.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    if (pinch) { if (pts.size < 2) pinch = null; return; }
    if (strip) { strip = false; return; }
    if (pan) { pan = null; return; }
    if (e.type !== 'pointerup') { drag = -1; return; }
    if (drag > 0 && moved) {
      if (S.snap) S.slices[drag] = clamp(zero(S.slices[drag]), S.slices[drag - 1] + 64, drag + 1 < S.slices.length ? S.slices[drag + 1] - 64 : S.data.length - 64);
      S.sel = drag; drag = -1; drawWave(); drawPads(); relive(); persist(); sq.draw(); return;
    }
    drag = -1;
    if (moved) return;
    const now = Date.now(), px = e.clientX - R().left;
    if (now - lastT < 320 && Math.abs(px - lastX) < 20) {           // double tap
      lastT = 0;
      const ln = lineAt(px);
      toHand();
      if (ln > 0) { S.slices.splice(ln, 1); S.sp.splice(ln, 1); remapSteps(ln, -1); }
      else {
        let p = Math.round(at(e));
        if (S.snap) p = zero(p);
        let i = 0;
        while (i + 1 < S.slices.length && S.slices[i + 1] <= p) i++;
        if (p - S.slices[i] > 256 && sliceEnd(i) - p > 256) { S.slices.splice(i + 1, 0, p); S.sp.splice(i + 1, 0, { ...S.sp[i] }); remapSteps(i + 1, 1); }
      }
      S.sel = Math.min(S.sel, S.slices.length - 1);
      drawAll(); relive(); persist();
      return;
    }
    lastT = now; lastX = px;
    const p = at(e);
    let i = 0;
    while (i + 1 < S.slices.length && S.slices[i + 1] <= p) i++;
    selectSlice(i, true);
  }
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('wheel', e => {                           // a mouse / trackpad: zoom (ctrl, a pinch) or move
    if (!S.data) return;
    e.preventDefault();
    const r = R();
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5 && !e.shiftKey) zoomAt(Math.exp(-e.deltaY * 0.004), (e.clientX - r.left) / r.width);
    else { const d = (e.deltaX || e.deltaY) / r.width * (S.vb - S.va); setView(S.va + d, S.vb + d); }
  }, { passive: false });
}
// the selected slice's start moved by a little (the zoom sets how little: a pixel of it, at least a sample)
function nudge(d) {
  const i = S.sel;
  if (i <= 0 || !S.data) { toast(i <= 0 ? 'THE FIRST SLICE STARTS AT 0' : ''); return; }
  const c = $('slWave'), px = Math.max(1, Math.round((S.vb - S.va) * S.data.length / (c.clientWidth || 300)));
  if (S.mode !== 'hand') { S.mode = 'hand'; drawModes(); }
  S.slices[i] = clamp(S.slices[i] + d * px, S.slices[i - 1] + 64, i + 1 < S.slices.length ? S.slices[i + 1] - 64 : S.data.length - 64);
  drawWave(); relive(); persist();
}
// a slice added (+1) or removed (-1) at index i: the steps keep pointing at the same audio
function remapSteps(i, d) {
  for (const x of tr().steps) {
    if (d < 0 && x.s === i) x.s = Math.max(0, i - 1);
    else if (x.s >= i) x.s += d;
  }
  sq.changed();
}
function selectSlice(i, sound) {
  S.sel = i;
  drawWave(); drawPads(); sliceKnobs.forEach(k => k.redraw()); drawRev(); ampAll.redraw();
  if (sound) audition(i);
}

/* -------------------------------------------------------------- pads --- */
function drawPads() {
  const box = $('slPads');
  box.innerHTML = '';
  S.slices.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = 'pad' + (i === S.sel ? ' sel' : '');
    b.textContent = String(i + 1).padStart(2, '0');
    let vel = 1, y0 = 0, x0 = 0;
    b.onpointerdown = e => {
      e.preventDefault();
      ac();
      const r = b.getBoundingClientRect();
      vel = clamp(1 - (e.clientY - r.top) / r.height * 0.6, 0.4, 1);     // higher on the pad: harder
      x0 = e.clientX; y0 = e.clientY;
      audition(i, vel);
    };
    b.onpointerup = e => {                            // written when the finger lifts where it landed (not a scroll)
      if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) return;
      if (S.write) {                                  // write: the selected step takes it (and that velocity), on to the next
        const t = tr();
        sq.push();
        Object.assign(t.steps[t.sel], { on: 1, s: i, vel: Math.round(vel * 20) / 20 });
        t.sel = (t.sel + 1) % t.len;
        sq.draw(); sq.changed();
      }
      S.sel = i; drawWave(); sliceKnobs.forEach(k => k.redraw()); drawRev(); ampAll.redraw();
      [...box.children].forEach((p, j) => p.classList.toggle('sel', j === i));
    };
    box.appendChild(b);
  });
}

// the finder: how the break is cut, and the one value that goes with it
let findRow = null;
function drawModes() {
  [...$('slFind').children].forEach(b => b.classList.toggle('on', S.mode === b.dataset.f));
  const show = S.mode === 'sens' || S.mode === 'count' || S.mode === 'grid';
  if (findRow) { findRow.style.display = show ? '' : 'none'; findRow.redraw(); }
  $('slFindInfo').textContent = S.slices.length + ' SLICES' + (S.mode === 'hand' ? ' · BY HAND' : S.mode === 'auto' ? ' · AUTO' : '');
  $('slSnap').classList.toggle('on', S.snap);
}
function drawRev() { $('slRev').classList.toggle('on', !!(S.sp[S.sel] && S.sp[S.sel].rev)); }
function drawAll() {
  $('slName').textContent = S.srcName || 'NO BREAK';
  $('slOrig').textContent = (Math.round(S.origBpm * 10) / 10) + '';
  $('slBpm').textContent = Math.round(T.bpm);
  $('slSwing').textContent = Math.round(S.swing * 100) + '%';
  drawModes(); drawWave(); drawPads(); drawRev(); if (sq) sq.draw(); if (ampAll) ampAll.redraw();
  sliceKnobs.forEach(k => k.redraw()); globalKnobs.forEach(k => k.redraw());
}

/* ---------------------------------------------------------- loading --- */
async function decode(ab) {
  const buf = await ac().decodeAudioData(ab);
  const n = buf.length, out = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
  return out;
}
async function loadData(data, name, ref, keep, bpm) {
  S.data = data; S.srcName = name; S.srcRef = ref;
  if (!keep) {
    S.origBpm = bpm || estimateBpm(data.length, name);
    S.sp = []; S.mode = 'auto'; S.sel = 0; S.va = 0; S.vb = 1;
    reslice();
    tr().len = data.length / SR > 1.5 * 240 / S.origBpm ? 32 : 16;  // longer than a bar and a half: two bars
    order(); sq.changed();
  } else reslice();
  drawAll(); relive(); persist();
}
async function loadRef(ref, keep) {
  try {
    if (ref.kind === 'break') {
      const b = BREAKS.find(x => x.url === ref.url);
      const data = await decode(await (await fetch(ref.url)).arrayBuffer());
      await loadData(data, b ? b.name : ref.url, ref, keep, b && b.bpm);
    } else if (ref.kind === 'lib') {
      const it = await libGet(ref.id);
      if (!it) return;
      await loadData(await decode(await it.wav.arrayBuffer()), it.name, ref, keep);
    }
  } catch (e) { toast('CANNOT LOAD THAT'); }
}
// files: each into the library (so it stays), the first one into the slicer
async function importFiles(files) {
  let first = null;
  for (const file of files) {
    try {
      const ab = await file.arrayBuffer(), data = await decode(ab.slice(0));
      const name = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 28), id = id36();
      await libAdd({ id, name, kind: 'import', created: Date.now(), sr: SR, ms: Math.round(data.length / SR * 1000), note: '',
        peaks: peaksOf(data), wav: new Blob([ab], { type: file.type || 'audio/wav' }) });
      if (!first) first = { data, name, id };
    } catch (e) { toast('CANNOT READ ' + file.name.toUpperCase()); }
  }
  if (first) {
    await loadData(first.data, first.name, { kind: 'lib', id: first.id });
    toast(files.length > 1 ? files.length + ' FILES IN THE LIBRARY' : 'IN THE LIBRARY: ' + first.name);
  }
}
async function openPicker() {
  const box = $('slPickList');
  box.innerHTML = '';
  const add = (label, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `<span>${label}</span><small>${sub}</small>`;
    b.onclick = () => { $('slPick').classList.remove('on'); fn(); };
    box.appendChild(b);
  };
  add('FILES…', 'WAV · MP3 · AIFF · M4A', () => $('slFile').click());
  BREAKS.forEach(b => add(b.name, 'BREAK', () => loadRef({ kind: 'break', url: b.url })));
  (await libAll()).forEach(it => add(it.name, it.kind.toUpperCase() + ' · ' + it.ms + ' MS', () => loadRef({ kind: 'lib', id: it.id })));
  $('slPick').classList.add('on');
}

/* ------------------------------------------------------- recording --- */
// the microphone (a secure page only: https or localhost), raw (no voice processing), trimmed of the silence around
let rec = null;
async function recToggle() {
  if (rec) { rec.mr.stop(); return; }
  // why not, said plainly: an http page (the mic needs https), the browser said no (iPhone: Settings > the browser >
  // Microphone, and the site's own permission), no mic, or a browser without a recorder
  if (!window.isSecureContext) { toast('THE MIC NEEDS HTTPS: OPEN THE HTTPS ADDRESS', 3500); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('THIS BROWSER GIVES NO MIC HERE', 3500); return; }
  if (!window.MediaRecorder) { toast('THIS BROWSER CANNOT RECORD (UPDATE IOS)', 3500); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch (e) {
    const why = { NotAllowedError: 'MIC BLOCKED: IPHONE SETTINGS > CHROME (OR SAFARI) > MICROPHONE, AND ALLOW THE SITE', NotFoundError: 'NO MICROPHONE FOUND',
      NotReadableError: 'THE MIC IS BUSY (A CALL? ANOTHER APP?)', OverconstrainedError: 'MIC SETTINGS REFUSED' }[e.name] || 'MIC: ' + (e.name || 'ERROR').toUpperCase();
    toast(why, 5000); return;
  }
  ac();
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined), chunks = [], t0 = Date.now();
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(rec.tick); rec = null;
    $('slRec').classList.remove('on'); $('slRec').textContent = '● REC';
    try {
      const blob = new Blob(chunks, { type: mr.mimeType || type });
      let data = await decode(await blob.arrayBuffer());
      data = trim(data);
      const all = await libAll(), name = 'REC ' + String(all.filter(x => x.kind === 'rec').length + 1).padStart(3, '0'), id = id36();
      await libAdd({ id, name, kind: 'rec', created: Date.now(), sr: SR, ms: Math.round(data.length / SR * 1000), note: '', peaks: peaksOf(data), wav: toWav(data) });
      await loadData(data, name, { kind: 'lib', id });
      toast('RECORDED: ' + name);
    } catch (e) { toast('RECORDING FAILED'); }
  };
  mr.start();
  rec = { mr, tick: setInterval(() => { $('slRec').textContent = '■ ' + ((Date.now() - t0) / 1000).toFixed(1) + 'S'; }, 100) };
  $('slRec').classList.add('on');
}
function trim(d) {
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const thr = Math.max(peak * 0.02, 0.003);
  let a = 0, b = d.length - 1;
  while (a < b && Math.abs(d[a]) < thr) a++;
  while (b > a && Math.abs(d[b]) < thr) b--;
  a = Math.max(0, a - Math.round(0.005 * SR)); b = Math.min(d.length, b + Math.round(0.05 * SR));
  const out = d.slice(a, b), g = peak > 0 ? 0.95 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/* ------------------------------------------------------- patterns --- */
function order() {                                  // the break as it was (looped to the pattern): a step fires the
  const st = 60 / S.origBpm / 4 * SR;               // slice that starts in it, one with none stays empty
  const srcSteps = Math.max(1, Math.round(S.data.length / st)), steps = [];
  for (let k = 0; k < NSTEP; k++) {
    const t = (k % srcSteps) * st;
    let i = -1;
    S.slices.forEach((s, j) => { if (s >= t - st / 2 && s < t + st / 2 && (i < 0 || Math.abs(s - t) < Math.abs(S.slices[i] - t))) i = j; });
    if (k % srcSteps === 0) i = 0;
    steps.push({ ...sq.blank(), on: i >= 0 && t < S.data.length ? 1 : 0, s: Math.max(0, i) });
  }
  tr().steps = steps;
}
// chaos on the steps, by the CHAOS amounts (a scale 0..1 of them: CHOP all of it from the break in order, MUTATE a
// little of it on what is there): SWAP another slice, REPEAT the one two steps back, REV, ROLL a retrigger, VEL
// humanise, GAPS empty steps. The downbeats keep their slice
function chaos(scale) {
  const c = S.chaos, n = S.slices.length, t = tr(), st = t.steps;
  for (let k = 0; k < t.len; k++) {
    const x = st[k], q = p => Math.random() < p * scale;
    if (x.on && c.vel > 0) x.vel = Math.round(clamp((k % 4 === 0 ? 1 : x.vel) - Math.random() * c.vel * scale * (k % 4 === 0 ? 0.2 : 0.7), 0.1, 1) * 20) / 20;
    if (k % 8 === 0) continue;
    if (q(c.swap)) { x.s = Math.floor(Math.random() * n); x.on = 1; }
    else if (q(c.rep)) { const p = st[Math.max(0, k - 2)]; x.s = p.s; x.on = p.on; }
    if (q(c.gap)) x.on = 0;
    if (x.on && q(c.rev)) x.rev = x.rev ? 0 : 1;
    if (x.on && q(c.roll)) x.rtg = 2 + Math.floor(Math.random() * 3);
  }
  if (scale >= 1) for (let bar = 16; bar <= t.len; bar += 16) if (Math.random() < c.roll * 6) {   // a roll into some bars
    const k = bar - 2;
    if (!st[k].on) { st[k].on = 1; st[k].s = st[k - 2].on ? st[k - 2].s : 0; }
    st[k].rtg = 4; st[k].vel = 0.75;
  }
}
function chop() { order(); chaos(1); }

/* ------------------------------------------------------------ build --- */
let sliceKnobs = [], globalKnobs = [], ampAll = null;
function dragNum(el, get, set, per, show) {
  let y0 = 0, v0 = 0;
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = get(); });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { el.releasePointerCapture(e.pointerId); return; }
    set(v0 + (y0 - e.clientY) * per); show();
  });
  el.addEventListener('pointerup', e => { if (el.hasPointerCapture(e.pointerId)) { el.releasePointerCapture(e.pointerId); relive(); persist(); } });
}
// an envelope you drag: the slice's sound behind it, three handles (end of ATTACK, end of HOLD, end of DECAY). o: {
// env() -> {atk, hld, dec}, base() -> the track's envelope (drawn dashed under a trig's own) or null, slice() -> its
// slice, set(k, v), done() }
const ENVH = { atk: [0, 300], hld: [0, 1000], dec: [10, 4000] };
function envEditor(cv, o) {
  const spanOf = () => { const si = o.slice(); return S.data ? Math.max(0.12, (sliceEnd(si) - S.slices[si]) / SR * 1.15) * 1000 : 500; };
  const pts = (e, w, h, span) => {                       // ms -> px; HOLD FULL and long decays sit at the right edge
    const X = ms => Math.min(w - 6, 6 + ms / span * (w - 12)), a = X(e.atk), hl = e.hld >= 1000 ? w - 6 : X(e.atk + e.hld);
    return { atk: [a, 8], hld: [hl, 8], dec: [e.hld >= 1000 ? w - 6 : X(e.atk + e.hld + e.dec), h - 8] };
  };
  const path = (g, e, w, h, span) => {
    const P = pts(e, w, h, span);
    g.beginPath(); g.moveTo(6, h - 8); g.lineTo(P.atk[0], 8); g.lineTo(P.hld[0], 8);
    if (e.hld < 1000) {                                   // the decay curve
      const x0 = P.hld[0], x1 = P.dec[0];
      for (let i = 1; i <= 24; i++) { const f = i / 24; g.lineTo(x0 + (x1 - x0) * f, 8 + (h - 16) * (1 - Math.exp(-f * 4.6))); }
    }
  };
  const draw = () => {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'), span = spanOf(), e = o.env(), b = o.base();
    g.scale(dpr, dpr);
    if (S.data) {                                         // the slice behind it
      const si = o.slice(), a = S.slices[si], n = (sliceEnd(si) - a) / SR * 1000;
      g.fillStyle = 'rgba(185,163,227,.45)';
      for (let x = 6; x < w - 6; x++) {
        const t0 = (x - 6) / (w - 12) * span, t1 = (x - 5) / (w - 12) * span;
        if (t0 > n) break;
        let m = 0;
        for (let j = a + Math.floor(t0 * SR / 1000); j < a + Math.floor(Math.min(t1, n) * SR / 1000); j++) m = Math.max(m, Math.abs(S.data[j]));
        g.fillRect(x, h / 2 - m * (h / 2 - 8), 1, Math.max(1, m * (h - 16)));
      }
    }
    if (b) { g.setLineDash([3, 3]); g.strokeStyle = 'rgba(61,43,32,.4)'; g.lineWidth = 1; path(g, b, w, h, span); g.stroke(); g.setLineDash([]); }
    g.strokeStyle = css('--acc') || '#ff8a4c'; g.lineWidth = 2.5; path(g, e, w, h, span); g.stroke();
    const P = pts(e, w, h, span);
    Object.entries(P).forEach(([k, [x, y]]) => {
      if (k === 'dec' && e.hld >= 1000) return;
      g.fillStyle = drag === k ? css('--acc') : '#fff'; g.strokeStyle = css('--acc') || '#ff8a4c'; g.lineWidth = 2;
      g.fillRect(x - 6, y - 6, 12, 12); g.strokeRect(x - 6, y - 6, 12, 12);
    });
    g.fillStyle = 'rgba(61,43,32,.7)'; g.font = '9px Silkscreen, monospace';
    const ms = v => (v >= 1000 ? (v / 1000).toFixed(1) + 'S' : Math.round(v) + 'MS');
    g.fillText('A ' + ms(e.atk) + '  H ' + (e.hld >= 1000 ? 'FULL' : ms(e.hld)) + (e.hld >= 1000 ? '' : '  D ' + ms(e.dec)), 8, h - 3);
  };
  let drag = null;
  const pos = ev => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top, r.width]; };
  cv.addEventListener('pointerdown', ev => {
    const [x, y, w] = pos(ev), P = pts(o.env(), w, cv.clientHeight, spanOf());
    let best = null, bd = 34;
    Object.entries(P).forEach(([k, [px, py]]) => { if (k === 'dec' && o.env().hld >= 1000) return; const d = Math.hypot(px - x, (py - y) * 0.5); if (d < bd) { bd = d; best = k; } });
    if (!best) return;
    ev.preventDefault(); cv.setPointerCapture(ev.pointerId); drag = best; o.start && o.start(); draw();
  });
  cv.addEventListener('pointermove', ev => {
    if (!drag || !cv.hasPointerCapture(ev.pointerId)) return;
    if (ev.pointerType === 'mouse' && !(ev.buttons & 1)) { end(ev); return; }
    const [x, , w] = pos(ev), span = spanOf(), t = clamp((x - 6) / (w - 12), 0, 1) * span, e = o.env();
    if (drag === 'atk') o.set('atk', Math.round(clamp(t, 0, ENVH.atk[1])));
    if (drag === 'hld') o.set('hld', x > w - 12 ? 1000 : Math.round(clamp(t - e.atk, 0, 995) / 5) * 5);
    if (drag === 'dec') o.set('dec', x > w - 10 ? 4000 : Math.round(clamp(t - e.atk - e.hld, 10, 4000)));
    draw();
  });
  function end(ev) { if (!drag) return; drag = null; try { cv.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ } draw(); o.done(); }
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  scrollGuard(cv, () => !!drag);
  cv.redraw = draw;
  return cv;
}
// a row head of the ROLL: the slice's own waveform behind its number (a tap plays it)
function sliceHead(v, el) {
  el.onclick = () => { ac(); audition(v); };
  if (!S.data || v >= S.slices.length) return;
  const dpr = window.devicePixelRatio || 1, w = 44, h = 22, c = document.createElement('canvas');
  c.className = 'rh-wave'; c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'), a = S.slices[v], b = sliceEnd(v);
  g.scale(dpr, dpr); g.fillStyle = css('--lilac') || '#b9a3e3';
  for (let i = 0; i < w; i++) {
    let m = 0;
    for (let j = a + Math.floor(i / w * (b - a)); j < a + Math.floor((i + 1) / w * (b - a)); j++) m = Math.max(m, Math.abs(S.data[j]));
    g.fillRect(i, h / 2 - m * (h / 2 - 1), 1, Math.max(1, m * (h - 2)));
  }
  el.prepend(c);
}
// the tracker's screen on the SLICE column: the slice's sound (reversed if it plays so)
function sliceCtx(g, w, h, k, col) {
  const x = tr().steps[k];
  if (col !== 's' || !S.data) return false;
  const si = Math.min(x.s, S.slices.length - 1), a = S.slices[si], b = sliceEnd(si), mid = h / 2, rev = (S.sp[si].rev ? 1 : 0) ^ (x.rev ? 1 : 0);
  g.fillStyle = 'rgba(61,43,32,.75)';
  for (let i = 0; i < w; i++) {
    let m = 0;
    const p0 = a + Math.floor((rev ? w - 1 - i : i) / w * (b - a)), p1 = a + Math.floor((rev ? w - i : i + 1) / w * (b - a));
    for (let j = Math.min(p0, p1); j < Math.max(p0, p1); j++) m = Math.max(m, Math.abs(S.data[j]));
    g.fillRect(i, mid - m * (mid - 2), 1, Math.max(1, m * 2 * (mid - 2)));
  }
  return true;
}
export function initSlicer() {
  const cur = () => S.sp[S.sel] || { pitch: 0, rev: 0, gain: 1, dec: 1 };
  const live = () => { relive(); persist(); };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('onion-slicer') || 'null'); } catch (e) { /* none */ }
  if (saved && saved.slices) S.slices = saved.slices;
  sq = makeSeq({ id: 'break', host: $('sqBreak'), defaults: { len: 32 },
    roll: { field: 's', min: 0, max: () => Math.max(0, S.slices.length - 1), asc: true, label: v => 'S' + pad2(v + 1), head: sliceHead,
      key: () => S.srcName + ':' + S.slices.join(','), mark: x => (x.rev ? 'R' : '') + (x.rtg > 1 ? 'x' + x.rtg : '') + (x.pit ? (x.pit > 0 ? '+' : '') + x.pit : '') + (x.atk != null || x.hld != null || x.dec != null ? '◢' : '') },
    editor: (el, api) => {                         // this trig's own envelope over the track's (dashed); ALL drops its locks
      el.className = 'sq-extra env-box';
      el.innerHTML = '<div class="env-head"><span>AMP · THIS HIT</span><button class="tog">ALL HITS</button></div><canvas class="env-cv"></canvas>';
      const st = () => api.tr.steps[api.tr.sel];
      const cv = envEditor(el.querySelector('canvas'), { env: () => ampOf(st()), base: () => (['atk', 'hld', 'dec'].some(k => st()[k] != null) ? S.amp : null),
        slice: () => Math.min(st().s, S.slices.length - 1), start: api.push, set: (k, v) => { st()[k] = v; }, done: () => { api.changed(); api.refresh(); api.hear(); } });
      el.querySelector('button').onclick = () => { api.push(); ['atk', 'hld', 'dec'].forEach(k => { st()[k] = null; }); api.changed(); api.refresh(); };
      return () => { const own = ['atk', 'hld', 'dec'].some(k => st()[k] != null); el.querySelector('.env-head span').textContent = own ? 'AMP · THIS HIT (LOCKED)' : 'AMP · AS ALL HITS'; el.querySelector('button').style.visibility = own ? '' : 'hidden'; cv.redraw(); };
    },
    fields: [{ k: 's', label: 'SLICE', short: 'SLC', min: 0, max: NSTEP - 1, step: 1, def: 0, fmt: v => 'S' + pad2(v + 1) },
      { k: 'vel', label: 'VELOCITY', short: 'VEL', min: 0.05, max: 1, step: 0.05, def: 1, lane: true, fmt: v => String(Math.round(v * 100)) },
      { k: 'pit', label: 'PITCH', short: 'PIT', min: -12, max: 12, step: 1, def: 0, lane: true, fmt: v => (v > 0 ? '+' : '') + v },
      { k: 'rtg', label: 'RETRIG', short: 'RTG', min: 1, max: 4, step: 1, def: 1, fmt: v => 'x' + v },
      { k: 'rev', label: 'REVERSE', short: 'REV', list: ['—', 'REV'], def: 0, fmt: v => (v ? 'REV' : '—') },
      { k: 'atk', label: 'ATTACK', short: 'ATK', min: 0, max: 300, step: 1, def: null, lock: true, inherit: () => S.amp.atk, fmt: v => Math.round(v) + 'MS' },
      { k: 'hld', label: 'HOLD', short: 'HLD', min: 0, max: 1000, step: 5, def: null, lock: true, inherit: () => S.amp.hld, fmt: v => (v >= 1000 ? 'FULL' : Math.round(v) + 'MS') },
      { k: 'dec', label: 'DECAY', short: 'DEC', min: 10, max: 4000, step: 1, log: true, def: null, lock: true, inherit: () => S.amp.dec, fmt: v => (v >= 1000 ? (v / 1000).toFixed(1) + 'S' : Math.round(v) + 'MS') }],
    blank: () => ({ s: S.sel }),
    init: t => {                                   // the pattern from before the core: a step with a slice is a trig
      if (!saved || !saved.steps) return;
      t.len = saved.len || 32;
      saved.steps.slice(0, NSTEP).forEach((x, k) => Object.assign(t.steps[k], { on: x.s >= 0 ? 1 : 0, s: Math.max(0, x.s),
        vel: x.vel ?? 1, pit: x.pit || 0, rtg: x.rtg || 1, rev: x.rev || 0, prb: x.prb ?? 100, cnd: x.cnd || 0 }));
      t.fromOld = true;
    },
    audition: k => { const x = tr().steps[k]; audition(x.s, x.vel); }, playing: () => playing, stepAt,
    changed: () => { relive(); drawWave(); }, drawCtx: sliceCtx });
  sliceKnobs = [
    knob({ label: 'PITCH', min: -24, max: 24, def: 0, int: true, get: () => cur().pitch, set: v => { cur().pitch = v; }, fmt: v => (v > 0 ? '+' : '') + v, onRelease: () => { live(); audition(S.sel); } }),
    knob({ label: 'DECAY', min: 0.05, max: 1, def: 1, get: () => cur().dec, set: v => { cur().dec = v; }, fmt: v => v > 0.995 ? 'FULL' : Math.round(v * 100) + '%', onRelease: () => { live(); audition(S.sel); } }),
    knob({ label: 'GAIN', min: 0, max: 2, def: 1, get: () => cur().gain, set: v => { cur().gain = v; }, fmt: v => v < 0.01 ? 'OFF' : (20 * Math.log10(v)).toFixed(1), onRelease: () => { live(); audition(S.sel); } }),
  ];
  sliceKnobs.forEach(k => $('slSliceKnobs').appendChild(k));
  globalKnobs = [
    knob({ label: 'PITCH', min: -12, max: 12, def: 0, get: () => S.gpitch, set: v => { S.gpitch = Math.round(v * 10) / 10; }, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1), onRelease: live }),
  ];
  globalKnobs.forEach(k => $('slGlobalKnobs').appendChild(k));
  ampAll = envEditor($('slAmp'), { env: () => S.amp, base: () => null, slice: () => S.sel, set: (k, v) => { S.amp[k] = v; },
    done: () => { live(); sq.draw(); audition(S.sel); } });

  // the finder: AUTO · SENS · COUNT · GRID (HAND: lines moved by hand)
  const FV = { sens: [0, 1], count: [2, 48], grid: [2, 64] };
  findRow = knob({ label: 'AMOUNT', min: 0, max: 1, def: 0.5,
    get: () => { const m = S.mode, [a, b] = FV[m] || [0, 1]; return m === 'sens' ? S.sens : m === 'count' ? (S.count - a) / (b - a) : m === 'grid' ? (S.grid - a) / (b - a) : 0; },
    set: v => { const m = S.mode, [a, b] = FV[m] || [0, 1]; if (m === 'sens') S.sens = v; else if (m === 'count') S.count = Math.round(a + v * (b - a)); else if (m === 'grid') S.grid = Math.round(a + v * (b - a)); },
    fmt: () => (S.mode === 'sens' ? 'SENSITIVITY ' + Math.round(S.sens * 100) + '%' : S.mode === 'count' ? S.count + ' SLICES' : S.grid + ' EQUAL'),
    onMove: () => { reslice(); drawWave(); $('slFindInfo').textContent = S.slices.length + ' SLICES'; },
    onRelease: () => { reslice(); drawAll(); live(); } });
  findRow.querySelector('.plab').style.display = 'none';
  $('slFindRow').appendChild(findRow);
  $('slFind').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.f === 'hand') return;
    if (b.dataset.f === 'count' && S.mode !== 'count') S.count = clamp(S.slices.length, 2, 48);   // from what it is now
    S.mode = b.dataset.f; reslice(); drawAll(); live();
  });
  $('slZoomIn').onclick = () => zoomAt(2);
  $('slZoomOut').onclick = () => zoomAt(0.5);
  $('slZoomSel').onclick = zoomToSlice;
  $('slZoomFit').onclick = () => setView(0, 1);
  $('slNudgeL').onclick = () => nudge(-1);
  $('slNudgeR').onclick = () => nudge(1);
  $('slSnap').onclick = () => { S.snap = !S.snap; drawModes(); persist(); };
  $('slRev').onclick = () => { const p = cur(); p.rev = p.rev ? 0 : 1; drawRev(); live(); audition(S.sel); };
  $('slWrite').onclick = () => { S.write = !S.write; $('slWrite').classList.toggle('on', S.write); };
  $('slWrite').classList.toggle('on', S.write);
  $('slPlay').onclick = transport;
  $('slSource').onclick = openPicker;
  $('slAdd').onclick = () => $('slFile').click();
  $('slRec').onclick = recToggle;
  $('slPickClose').onclick = () => $('slPick').classList.remove('on');
  $('slFile').onchange = e => { const f = [...e.target.files]; if (f.length) importFiles(f); e.target.value = ''; };
  const page = $('page-slicer');                    // files dropped on the page (a computer)
  page.addEventListener('dragover', e => { e.preventDefault(); page.classList.add('drop'); });
  page.addEventListener('dragleave', () => page.classList.remove('drop'));
  page.addEventListener('drop', e => { e.preventDefault(); page.classList.remove('drop'); const f = [...e.dataTransfer.files].filter(x => /audio/.test(x.type) || /\.(wav|aif+|mp3|m4a|flac|ogg)$/i.test(x.name)); if (f.length) importFiles(f); });
  const redo = () => { sq.draw(); sq.changed(); drawWave(); };
  $('slOrder').onclick = () => { sq.push(); order(); redo(); };
  $('slChop').onclick = () => { sq.push(); chop(); redo(); if (!playing) transport(); };
  $('slMutate').onclick = () => { sq.push(); chaos(0.35); redo(); if (!playing) transport(); };
  $('slUndo').onclick = () => sq.undo();
  $('slClear').onclick = () => sq.set(Array.from({ length: NSTEP }, () => ({ ...sq.blank(), on: 0 })));
  const pct = v => Math.round(v * 100) + '%';
  [['swap', 'SWAP'], ['rep', 'REPEAT'], ['rev', 'REV'], ['roll', 'ROLL'], ['vel', 'VEL'], ['gap', 'GAPS']].forEach(([k, l]) =>
    $('slChaosKnobs').appendChild(knob({ label: l, min: 0, max: 1, def: { swap: 0.28, rep: 0.08, rev: 0.08, roll: 0.07, vel: 0.3, gap: 0 }[k],
      get: () => S.chaos[k], set: v => { S.chaos[k] = v; }, fmt: pct, onRelease: persist })));
  $('slSample').onclick = async () => {
    if (!S.data) return;
    const data = renderLoop(), all = await libAll();
    const name = 'BREAK ' + String(all.filter(x => x.kind === 'break').length + 1).padStart(3, '0') + ' ' + Math.round(T.bpm) + 'BPM';
    await libAdd({ id: id36(), name, kind: 'break', created: Date.now(), sr: SR, ms: Math.round(data.length / SR * 1000), note: S.srcName, peaks: peaksOf(data), wav: toWav(data) });
    toast('SAMPLED: ' + name);
  };
  dragNum($('slBpmBox'), () => T.bpm, v => { const b = clamp(Math.round(v), 60, 220); if (b !== T.bpm) setBpm(b); }, 0.3, () => {});
  channel('break', 'BREAK', n => (S.data ? renderCycle(n) : null), '--lilac', true);
  onTempo(v => { $('slBpm').textContent = Math.round(v); });
  onPlay(on => {
    playing = on;
    $('slPlay').classList.toggle('on', on); $('slPlay').textContent = on ? '■' : '▶';
    follow.last = -1;
    if (on) requestAnimationFrame(follow); else { sq.draw(-1); drawWave(-1); }
  });
  dragNum($('slSwingBox'), () => S.swing, v => { S.swing = clamp(v, 0, 0.6); }, 0.004, () => { $('slSwing').textContent = Math.round(S.swing * 100) + '%'; });
  dragNum($('slOrigBox'), () => S.origBpm, v => { S.origBpm = clamp(Math.round(v * 10) / 10, 60, 220); }, 0.1, () => { $('slOrig').textContent = S.origBpm.toFixed(1); });
  waveInput();
  window.addEventListener('resize', () => drawWave());

  if (saved && saved.srcRef) {
    const m = typeof saved.mode === 'number' ? 'grid' : saved.mode || 'auto';   // (8 / 16 / 32 before: a grid)
    Object.assign(S, { origBpm: saved.origBpm, mode: m, sens: saved.sens ?? 0.5, count: saved.count || 16, grid: typeof saved.mode === 'number' ? saved.mode : saved.grid || 16, snap: saved.snap ?? true, sp: saved.sp || [],
      swing: saved.swing || 0, gpitch: saved.gpitch || 0, chaos: { ...S.chaos, ...(saved.chaos || {}) }, amp: { ...S.amp, ...(saved.amp || {}) } });
    if (tr().fromOld) { delete tr().fromOld; sq.changed(); persist(); }   // moved onto the core: the old steps go
    loadRef(saved.srcRef, true);
  } else loadRef({ kind: 'break', url: BREAKS[0].url });
}
export function slicerShown() { requestAnimationFrame(() => { drawWave(); sq.draw(); }); }
export function slicerStop() { }
