// Onion ACID: a 303-style bass line. A saw / square into a resonant 4-pole ladder, an envelope on the filter, accents
// and slides the way the TB-303 does them, the pattern on the sequencing core (seqcore.js: a piano roll of the scale's
// notes, Elektron trigs, the handheld tracker; up to 64 steps, chance and conditions), and a generator in the spirit of
// Iftah's Sting: from random to acid lines, density, accents, slides, a scale, locks for what must stay, and a MORPH
// between the line you had and the new one. Each time round is rendered anew (twice through, so the filter and the
// slides carry over the loop point); SAMPLE takes the line as written.
import { SR, toWav } from './dsp.js';
import { ac, out, T, channel, refresh, toggle, play, stop, onPlay, onTempo, setBpm, stepAt } from './audio.js';
import { knob, toast, xy } from './ui.js';
import { libAdd, libAll } from './lib.js';
import { makeSeq, plays } from './seqcore.js';
import { fxPanel } from './fxpanel.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  MINOR: [0, 2, 3, 5, 7, 8, 10], PHRYG: [0, 1, 3, 5, 7, 8, 10], DORIAN: [0, 2, 3, 5, 7, 9, 10], HARM: [0, 2, 3, 5, 7, 8, 11],
  MAJOR: [0, 2, 4, 5, 7, 9, 11], PENTA: [0, 3, 5, 7, 10], CHROM: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/* ------------------------------------------------------------ state --- */
// a step (the core's): on, note (semitones above the root, -12..24), acc, sl (slide into the next), prb, cnd
const A = {
  syn: { cutoff: 380, reso: 0.72, env: 0.6, decay: 420, accent: 0.6, slide: 70, tune: 0, wave: 0, drive: 0.25, level: 0.8 },
  swing: 0, root: 9, scale: 'MINOR', baseOct: 2,
  gen: { type: 0.75, density: 0.7, accent: 0.35, slide: 0.3, range: 0.4, morph: 1 },
  locks: { notes: 0, gates: 0, acc: 0, slide: 0, oct: 0 },
  seed: 1, prev: null, genB: null,                         // MORPH: the line before the last GENERATE, and the new one
};
let sq = null;                                             // the core's track
const tr = () => sq.tr;
function persist() {
  try { localStorage.setItem('onion-acid2', JSON.stringify({ syn: A.syn, swing: A.swing, root: A.root, scale: A.scale, gen: A.gen, locks: A.locks, seed: A.seed, prev: A.prev, genB: A.genB })); } catch (e) { /* ignore */ }
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
const midiOf = x => 12 * (A.baseOct + 1) + A.root + x.note + A.syn.tune;
const noteLabel = v => { const m = 12 * (A.baseOct + 1) + A.root + v; return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); };
const inScale = v => SCALES[A.scale].includes(((v % 12) + 12) % 12);

/* ----------------------------------------------------------- render --- */
// the TB-303's way: a trig opens the envelopes (an accent opens them wider and louder); a step marked SLIDE holds its
// gate into the next one, which glides there without a new attack. n: the time round (< 0: every trig as written)
export function renderLoop(n = -1) {
  const t = tr(), p = A.syn, st = 60 / T.bpm / 4 * SR, len = t.len, total = Math.round(st * len), pl = plays(t, n, 41);
  const startOf = k => Math.round(k * st + (k % 2 ? A.swing * st * 0.5 : 0));
  const out = new Float32Array(total);
  let ph = 0, freq = 110, target = 110, y1 = 0, y2 = 0, y3 = 0, y4 = 0, fenv = 0, amp = 0, gate = 0, acc = 0, gateOff = 0;
  const slideA = Math.exp(-1 / (p.slide / 1000 * SR / 3));
  const decA = k => Math.exp(-1 / ((k ? p.decay * 0.35 : p.decay) / 1000 * SR / 4.6));
  let fdec = decA(0);
  for (let pass = 0; pass < 2; pass++) {
    let k = 0, next = len > 1 ? startOf(1) : total + 1;
    for (let i = 0; i < total; i++) {
      if (i === 0 || i === next) {                            // a step starts
        if (i !== 0) { k++; next = k + 1 < len ? startOf(k + 1) : total + 1; }
        const x = t.steps[k], pk = (k + len - 1) % len, prev = t.steps[pk];
        if (pl[k]) {
          target = 440 * Math.pow(2, (midiOf(x) - 69) / 12);
          const tied = pl[pk] && prev.sl && gate;
          if (!tied) { freq = target; fenv = 1; acc = x.acc ? 1 : 0; fdec = decA(acc); }
          else if (x.acc) acc = Math.max(acc, 0.7);
          gate = 1;
          gateOff = x.sl ? -1 : i + Math.round(st * 0.55);
        }
      }
      if (gateOff >= 0 && i >= gateOff) gate = 0;
      freq = target + (freq - target) * slideA;
      fenv *= fdec;
      amp += ((gate ? 1 : 0) - amp) * (gate ? 0.02 : 0.0035);  // a quick attack, a short release
      const dt = freq / SR;                                    // the oscillator (polyBLEP saw, or a square from it)
      ph += dt; if (ph >= 1) ph -= 1;
      let o = 2 * ph - 1;
      if (ph < dt) { const q = ph / dt; o -= q + q - q * q - 1; } else if (ph > 1 - dt) { const q = (ph - 1) / dt; o -= q * q + q + q + 1; }
      if (p.wave) o = Math.tanh(o * 6) * 0.9;
      const cut = clamp(p.cutoff * Math.pow(2, (p.env * (1 + acc * p.accent) * 4.5) * fenv), 30, SR * 0.42);
      const g = 1 - Math.exp(-2 * Math.PI * cut / SR), res = p.reso * (3.9 + acc * p.accent * 0.25);
      const inp = Math.tanh(o - res * y4);                    // a 4-pole ladder, the input saturating
      y1 += g * (inp - y1); y2 += g * (y1 - y2); y3 += g * (y2 - y3); y4 += g * (y3 - y4);
      const v = y4 * amp * (1 + acc * p.accent * 0.6) * (1 + p.reso * 0.8);
      if (pass) out[i] = Math.tanh(v * (1 + p.drive * 6)) * p.level * (0.9 / (1 + p.drive * 0.8));
    }
  }
  return out;
}

/* ------------------------------------------------------- generator --- */
// a line from the generator: TYPE 0 a random one, 1 an acid one (the root and its octave come back, notes repeat,
// accents on the offbeats, slides into another note); the locked lanes keep what they hold
function generate(seed) {
  const r = rng(seed * 2654435761), G = A.gen, sc = SCALES[A.scale], old = tr().steps, outS = [];
  for (let k = 0; k < 64; k++) {
    const o = old[k], x = sq.blank(), acid = r() < G.type, beat = k % 4 === 0, off = k % 4 === 2;
    x.on = r() < G.density * (acid ? (beat ? 1.15 : off ? 1 : 0.8) : 1) ? 1 : 0;
    const deg = acid ? (r() < 0.45 ? 0 : r() < 0.4 ? Math.min(sc.length - 1, 4) : Math.floor(r() * sc.length)) : Math.floor(r() * sc.length);
    let n = sc[deg % sc.length];
    if (acid && k > 0 && r() < 0.3) n = ((outS[k - 1].note % 12) + 12) % 12;
    const oct = r() < G.range * 0.45 ? 1 : r() < G.range * 0.15 ? -1 : 0;
    x.note = n + 12 * oct;
    x.acc = x.on && r() < G.accent * (acid ? (off ? 1.4 : beat ? 0.5 : 1) : 1) ? 1 : 0;
    x.sl = x.on && r() < G.slide ? 1 : 0;
    if (A.locks.notes) x.note = ((o.note % 12) + 12) % 12 + 12 * Math.floor(x.note / 12);
    if (A.locks.oct) x.note = ((x.note % 12) + 12) % 12 + 12 * Math.floor(o.note / 12);
    if (A.locks.gates) x.on = o.on;
    if (A.locks.acc) x.acc = o.acc;
    if (A.locks.slide) x.sl = o.sl;
    x.prb = o.prb; x.cnd = o.cnd;
    outS.push(x);
  }
  return outS;
}
// MORPH: each step takes the new line's from a threshold of its own on (the same steps flip at the same place)
function applyMorph() {
  if (!A.genB || !A.prev) return;
  const r = rng(A.seed * 97 + 13);
  tr().steps = A.prev.map((a, k) => (r() < A.gen.morph ? { ...A.genB[k] } : { ...a }));
}
function doGenerate() {
  sq.push();
  A.prev = tr().steps.map(x => ({ ...x }));
  A.seed = (Math.random() * 1e9) | 0;
  A.genB = generate(A.seed);
  A.gen.morph = 1;
  applyMorph();
}
function doMutate() {
  sq.push();
  const fresh = generate((Math.random() * 1e9) | 0);
  tr().steps = tr().steps.map((x, k) => (Math.random() < 0.2 ? fresh[k] : x));
}

/* ------------------------------------------------------------ audio --- */
let playing = false;
function relive() { persist(); refresh('acid'); }
function follow() {
  if (!playing) return;
  const k = stepAt(tr().len);
  if (k >= 0 && k !== follow.k) { follow.k = k; sq.draw(k); }
  requestAnimationFrame(follow);
}
function preview(k) {                                      // one note, alone (stopped)
  const t = tr(), keep = t.steps, len = t.len;
  t.steps = [{ ...keep[k], sl: 0, prb: 100, cnd: 0 }, sq.blank(), sq.blank(), sq.blank()]; t.len = 4;
  const d = renderLoop(-1);
  t.steps = keep; t.len = len;
  const c = ac(), b = c.createBuffer(1, d.length, SR), s = c.createBufferSource();
  b.copyToChannel(d, 0); s.buffer = b; s.connect(out()); s.start();
}

/* ------------------------------------------------------------ build --- */
let knobs = [], acPads = [];
function drawAll() {
  $('acBpm').textContent = Math.round(T.bpm);
  $('acSwing').textContent = Math.round(A.swing * 100) + '%';
  $('acKey').textContent = NOTES[A.root] + ' ' + A.scale;
  Object.entries(A.locks).forEach(([k, v]) => $('acLock_' + k).classList.toggle('on', !!v));
  [...$('acWave').children].forEach((b, i) => b.classList.toggle('on', i === A.syn.wave));
  [...$('acScales').children].forEach(b => b.classList.toggle('on', b.textContent === A.scale));
  knobs.forEach(k => k.redraw()); acPads.forEach(p => p.redraw());
  if (sq) sq.draw();
}
function dragNum(el, get, set, per, show) {
  let y0 = 0, v0 = 0;
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = get(); });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { el.releasePointerCapture(e.pointerId); return; }
    set(v0 + (y0 - e.clientY) * per); show();
  });
  el.addEventListener('pointerup', e => { if (el.hasPointerCapture(e.pointerId)) { el.releasePointerCapture(e.pointerId); relive(); } });
}
export function initAcid() {
  fxp = fxPanel($('acFx'), 'acid');
  let old = null;
  try {
    const s = JSON.parse(localStorage.getItem('onion-acid2') || 'null');
    if (s) Object.assign(A, s, { syn: { ...A.syn, ...s.syn }, gen: { ...A.gen, ...s.gen }, locks: { ...A.locks, ...s.locks } });
    else {                                                  // the line of the first ACID (its own steps), carried over once
      old = JSON.parse(localStorage.getItem('onion-acid') || 'null');
      if (old) Object.assign(A, { syn: { ...A.syn, ...old.syn }, swing: old.swing || 0, root: old.root ?? A.root, scale: old.scale || A.scale });
    }
  } catch (e) { /* defaults */ }
  sq = makeSeq({ id: 'acid', host: $('sqAcid'), defaults: { len: 16 },
    roll: { glide: x => !!x.sl, field: 'note', min: -12, max: 24, label: noteLabel, show: inScale, mark: x => (x.acc ? 'A' : '') + (x.sl ? '~' : ''),
      shade: v => ((((v % 12) + 12) % 12) === 0 ? 'root' : '') },
    fields: [{ k: 'note', label: 'NOTE', short: 'NOTE', min: -12, max: 24, step: 1, def: 0, lane: true, fmt: noteLabel },
      { k: 'acc', label: 'ACCENT', short: 'ACC', list: ['—', 'ACC'], def: 0, fmt: v => (v ? 'ACC' : '—') },
      { k: 'sl', label: 'SLIDE', short: 'SLD', list: ['—', 'SLIDE'], def: 0, fmt: v => (v ? 'SLD' : '—') }],
    init: t => {
      if (old && old.steps) { t.len = old.len || 16; old.steps.forEach((x, i) => { if (i < 64) Object.assign(t.steps[i], { on: x.g ? 1 : 0, note: x.n + 12 * x.oct, acc: x.acc, sl: x.sl }); }); }
      else { const g = rng(7); for (let k = 0; k < 16; k++) Object.assign(t.steps[k], { on: g() < 0.7 ? 1 : 0, note: [0, 0, 12, 3, 7, 0, 10][Math.floor(g() * 7)], acc: g() < 0.3 ? 1 : 0, sl: g() < 0.25 ? 1 : 0 }); }
    },
    audition: k => preview(k), playing: () => playing, stepAt, changed: relive,
    drawCtx: (g, w, h, k, col) => {                        // the note on a keyboard, the scale's keys lit
      if (col !== 'note') return false;
      const n = tr().steps[k].note, kw = w / 37;
      for (let i = 0; i < 37; i++) {
        const v = i - 12, black = [1, 3, 6, 8, 10].includes((((12 * (A.baseOct + 1) + A.root + v) % 12) + 12) % 12);
        g.fillStyle = v === n ? '#ff8a4c' : inScale(v) ? (black ? '#3d2b20' : 'rgba(61,43,32,.35)') : 'rgba(61,43,32,.08)';
        g.fillRect(i * kw + 1, black ? 4 : 14, kw - 2, black ? h - 22 : h - 18);
      }
      return true;
    } });
  const pct = v => Math.round(v * 100) + '%', ms = v => Math.round(v) + '';
  const syn = (k, label, min, max, def, fmt, log) => knob({ label, min, max, def, log, get: () => A.syn[k], set: v => { A.syn[k] = v; }, fmt, onMove: relive, onRelease: relive });
  const gen = (k, label) => knob({ label, min: 0, max: 1, def: A.gen[k], get: () => A.gen[k], set: v => { A.gen[k] = v; }, fmt: pct, onRelease: persist });
  knobs = [
    syn('accent', 'ACCENT', 0, 1, 0.6, pct), syn('slide', 'SLIDE', 15, 300, 70, ms, true),
    syn('tune', 'TUNE', -12, 12, 0, v => (v > 0 ? '+' : '') + Math.round(v)), syn('drive', 'DRIVE', 0, 1, 0.25, pct),
  ];
  let auto = false;                                       // the pads: touching them plays the loop
  const ax = (k, label, min, max, fmt, log) => ({ label, min, max, log, fmt, get: () => A.syn[k], set: v => { A.syn[k] = v; } });
  const padOf = (x, y) => xy({ x, y, onStart: () => { ac(); if (!T.playing) { auto = true; play(); } }, onMove: relive,
    onRelease: () => { if (auto) { auto = false; stop(); } relive(); } });
  const hz = v => (v >= 1000 ? (v / 1000).toFixed(1) + 'K' : Math.round(v) + '');
  acPads = [padOf(ax('cutoff', 'CUTOFF', 40, 5000, hz, true), ax('reso', 'RESO', 0, 0.98, pct)),
    padOf(ax('decay', 'DECAY', 40, 2500, ms, true), ax('env', 'ENV MOD', 0, 1, pct))];
  $('acPads').append(...acPads);
  knobs.forEach(k => $('acKnobs2').appendChild(k));
  const gk = [gen('type', 'TYPE'), gen('density', 'DENSITY'), gen('accent', 'ACCENTS'), gen('slide', 'SLIDES'), gen('range', 'RANGE'),
    knob({ label: 'MORPH', min: 0, max: 1, def: 1, get: () => A.gen.morph, set: v => { A.gen.morph = v; applyMorph(); sq.draw(); }, fmt: pct, onMove: relive, onRelease: () => { sq.changed(); } })];
  gk.forEach(k => $('acGenKnobs').appendChild(k));
  knobs.push(...gk);

  [...$('acWave').children].forEach((b, i) => b.onclick = () => { A.syn.wave = i; drawAll(); relive(); });
  Object.keys(A.locks).forEach(k => $('acLock_' + k).onclick = () => { A.locks[k] = A.locks[k] ? 0 : 1; drawAll(); persist(); });
  $('acKey').onclick = () => { A.root = (A.root + 1) % 12; drawAll(); relive(); };
  const sb = $('acScales');
  Object.keys(SCALES).forEach(name => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { A.scale = name; persist(); rebuildRoll(); drawAll(); };
    sb.appendChild(b);
  });
  $('acPlay').onclick = () => { ac(); toggle(); };
  $('acGen').onclick = () => { doGenerate(); sq.draw(); sq.changed(); if (!playing) { ac(); play(); } };
  $('acMutate').onclick = () => { doMutate(); sq.draw(); sq.changed(); };
  $('acUndo').onclick = () => $('sqAcid').querySelector('.sq-undo').click();
  $('acClear').onclick = () => { sq.push(); tr().steps = tr().steps.map(() => sq.blank()); sq.draw(); sq.changed(); };
  $('acSample').onclick = async () => {
    const data = renderLoop(-1), all = await libAll();
    const name = 'ACID ' + String(all.filter(x => x.kind === 'acid').length + 1).padStart(3, '0') + ' ' + NOTES[A.root] + ' ' + Math.round(T.bpm) + 'BPM';
    await libAdd({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, kind: 'acid', created: Date.now(), sr: SR,
      ms: Math.round(data.length / SR * 1000), note: NOTES[A.root] + ' ' + A.scale,
      acid: JSON.parse(JSON.stringify({ syn: A.syn, steps: tr().steps, len: tr().len, swing: A.swing, root: A.root, scale: A.scale })),
      peaks: Array.from({ length: 48 }, (_, i) => { let m = 0; for (let j = Math.floor(i * data.length / 48); j < Math.floor((i + 1) * data.length / 48); j++) m = Math.max(m, Math.abs(data[j])); return +m.toFixed(3); }),
      wav: toWav(data) });
    toast('SAMPLED: ' + name);
  };
  dragNum($('acBpmBox'), () => T.bpm, v => { const b = clamp(Math.round(v), 60, 220); if (b !== T.bpm) setBpm(b); }, 0.3, () => {});
  dragNum($('acSwingBox'), () => A.swing, v => { A.swing = clamp(v, 0, 0.6); }, 0.004, () => { $('acSwing').textContent = Math.round(A.swing * 100) + '%'; });
  channel('acid', 'ACID', n => renderLoop(n), '--acc', true);
  onTempo(v => { $('acBpm').textContent = Math.round(v); });
  onPlay(on => {
    playing = on;
    $('acPlay').classList.toggle('on', on); $('acPlay').textContent = on ? '■' : '▶';
    if (on) requestAnimationFrame(follow); else sq.draw();
  });
  drawAll();
}
// the roll shows the scale's notes: a new scale or root rebuilds its rows
function rebuildRoll() { sq.draw(); }
let fxp = null;
export function acidShown() {
  if (fxp) requestAnimationFrame(fxp.draw); requestAnimationFrame(() => drawAll()); }
export function acidStop() { }
export function acidLoad(saved) {                          // a library ACID loop back into the machine
  Object.assign(A, { syn: { ...A.syn, ...saved.syn }, swing: saved.swing || 0, root: saved.root ?? A.root, scale: saved.scale || A.scale });
  if (saved.steps) {
    const steps = saved.steps.map(x => ('g' in x ? { ...sq.blank(), on: x.g ? 1 : 0, note: x.n + 12 * x.oct, acc: x.acc, sl: x.sl } : { ...sq.blank(), ...x }));
    while (steps.length < 64) steps.push(sq.blank());
    tr().len = saved.len || 16;
    sq.set(steps);
  }
  drawAll(); relive();
}
