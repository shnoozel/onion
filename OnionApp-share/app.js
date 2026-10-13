import { SR, P as SPEC, DTYPES, BWAVES, PRESETS, BASS_PRESETS, defaults, renderKick, renderBass, renderBassLine, kickPitchAt, kickAmpAt,
  bassHz, noteName, centsOff, toWav, SAT_TYPES, satCurve } from './dsp.js';
import { libAdd, libDel, libAll } from './lib.js';
import { ac, out, T, channel, refresh, toggle, play, stop, onPlay, onTempo, setBpm, stepAt } from './audio.js';
import { makeSeq, plays } from './seqcore.js';
import { collapsible, row, xy, scrollGuard } from './ui.js';
import { initMixer } from './mixer.js';
import { initPunch } from './punch.js';
import { initSlicer, slicerShown, slicerStop } from './slicer.js';
import { initAcid, acidShown, acidStop, acidLoad } from './acid.js';
import { initTexture, textureShown, textureStop } from './texture.js';
import { exportAll, importAll } from './backup.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ------------------------------------------------------------ state --- */
let P = { ...defaults(), ...PRESETS.MENTAL }, preset = 'MENTAL';
let seq = { bpm: 132, swing: 0, k: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0], b: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0] };
try {
  const s = JSON.parse(localStorage.getItem('onion-kick2') || 'null');
  if (s && s.p) { P = { ...defaults(), ...s.p }; preset = s.preset || null; }
  if (s && s.seq) seq = { ...seq, ...s.seq };
} catch (e) { /* no storage: start from MENTAL */ }
function persist() { try { localStorage.setItem('onion-kick2', JSON.stringify({ p: P, preset, seq })); } catch (e) { /* ignore */ } }

let kickData = null, bassData = null;

/* ------------------------------------------------------------ audio --- */
let ctx = null, kickBuf = null, bassBuf = null, voice = null;
function audio() {
  if (!ctx) { ctx = ac(); buffers(); }
  ac();
  return ctx;
}
function toBuf(data) { const b = ctx.createBuffer(1, data.length, SR); b.copyToChannel(data, 0); return b; }
function buffers() { if (ctx) { kickBuf = toBuf(kickData); bassBuf = toBuf(bassData); } refresh('kick'); refresh('bass'); }
function fire(buf, when = 0, gain = 1) {
  const c = audio(), s = c.createBufferSource(), g = c.createGain();
  s.buffer = buf; g.gain.value = gain;
  s.connect(g).connect(out());
  s.start(when);
  return s;
}
function audition(which) {
  audio();
  if (voice) try { voice.stop(); } catch (e) { /* ended */ }
  voice = which === 'bass' ? fire(bassBuf, 0, 0.8 * P.blvl) : fire(kickBuf, 0, 0.8);
  if (which === 'bass') drawBassViews(true);
  $('graphCard').classList.add('hit');
  setTimeout(() => $('graphCard').classList.remove('hit'), 120);
}
async function playBlob(blob) {
  const c = audio(), buf = await c.decodeAudioData(await blob.arrayBuffer());
  if (voice) try { voice.stop(); } catch (e) { /* ended */ }
  voice = fire(buf);
}

/* -------------------------------------------------------- sequencer --- */
// KICK and BASS: a track each on the sequencing core (seqcore.js), up to 64 steps, rendered anew each time round
// (cycle channels of audio.js): chance and conditions differ, tails carry into the next round, the kick ducks the bass
let playing = false, kickSeq = null, bassSeq = null;
function transport() { audio(); toggle(); }
function follow() {
  if (!playing) return;
  const k = stepAt(kickSeq.tr.len), kb = stepAt(bassSeq.tr.len);         // (each on its own page)
  if (k !== follow.k) { follow.k = k; kickSeq.draw(k); drawBar(stepAt(16)); }
  if (kb !== follow.kb) { follow.kb = kb; bassSeq.draw(kb); }
  requestAnimationFrame(follow);
}
const NOTE_N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const bassNote = n => { const m = Math.round(69 + 12 * Math.log2(bassHz(P) * Math.pow(2, n / 12) / 440)); return NOTE_N[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); };
// the kick at a step's pitch and decay: rendered once per (pitch, decay) and kept until the sound changes
const variants = new Map();
function kickVariant(pit, dec) {
  const key = pit + '|' + dec;
  if (!variants.has(key)) variants.set(key, pit === 0 && dec === 1 ? kickData : renderKick({ ...P, tune: P.tune * Math.pow(2, pit / 12), decay: P.decay * dec, length: Math.min(2500, P.length * Math.max(1, dec)) }));
  return variants.get(key);
}
const stepFrames = () => 60 / T.bpm / 4 * SR;
const swingAt = k => (k % 2 ? seq.swing * stepFrames() * 0.5 : 0);
// the kick's hits that land in absolute steps a..b-1 (each in its own time round of the kick's length), as frames
function kickHits(a, b, base) {
  const L = kickSeq.tr.len, out = [];
  for (let m = a; m < b; m++) {
    const r = Math.floor(m / L), k = m % L;
    if (plays(kickSeq.tr, r, 11)[k]) out.push(Math.round((m - base) * stepFrames() + swingAt(k)));
  }
  return out;
}
const carryK = new Map(), carryB = new Map();
function withCarry(map, n, full, total) {             // the round itself, plus what rang over from the one before
  const cur = full.slice(0, total), prev = map.get(n);
  if (prev) for (let i = 0; i < prev.length && i < total; i++) cur[i] += prev[i];
  map.delete(n); map.set(n + 1, full.slice(total));
  if (map.size > 4) map.delete(map.keys().next().value);
  return cur;
}
function renderKickRound(n) {
  const tr = kickSeq.tr, st = stepFrames(), total = Math.round(st * tr.len), out = new Float32Array(total * 2), pl = plays(tr, n, 11);
  pl.forEach((on, k) => {
    if (!on) return;
    const x = tr.steps[k], v = kickVariant(x.pit, x.dec), g = 0.8 * x.vel * x.vel;
    for (let j = 0; j < x.rtg; j++) {
      const at = Math.round(k * st + swingAt(k) + j * st / x.rtg), end = j + 1 < x.rtg ? at + Math.round(st / x.rtg) : out.length;
      for (let i = 0; i < v.length && at + i < end; i++) out[at + i] += v[i] * g;
    }
  });
  return n < 0 ? out : withCarry(carryK, n, out, total);
}
function renderBassRound(n) {
  const tr = bassSeq.tr, total = Math.round(stepFrames() * tr.len), pl = plays(tr, n, 23);
  const r = Math.max(0, n), hits = kickHits(r * tr.len, (r + 1) * tr.len, r * tr.len);
  const full = renderBassLine(P, tr.steps, pl, stepFrames(), hits);
  for (let i = 0; i < full.length; i++) full[i] *= P.blvl;
  return n < 0 ? full : withCarry(carryB, n, full, total);
}
function auditionStep(which, k) {
  audio();
  if (voice) try { voice.stop(); } catch (e) { /* ended */ }
  if (which === 'kick') { const x = kickSeq.tr.steps[k]; voice = fire(toBuf(kickVariant(x.pit, x.dec)), 0, 0.8 * x.vel * x.vel); return; }
  const x = bassSeq.tr.steps[k], d = renderBassLine(P, [{ ...x, gl: 0 }], [true], stepFrames() * Math.max(1, x.len), []);
  voice = fire(toBuf(d), 0, P.blvl);
}
function buildSeq() {
  const old = JSON.parse(localStorage.getItem('onion-kick2') || 'null')?.seq;   // (the 16 dots before: carried over once)
  kickSeq = makeSeq({ id: 'kick', host: $('sqKick'), defaults: { len: 16 },
    fields: [{ k: 'vel', label: 'VELOCITY', short: 'VL', min: 0.05, max: 1, step: 0.05, def: 1, lane: true, fmt: v => Math.round(v * 99) + '' },
      { k: 'pit', label: 'PITCH', short: 'PIT', min: -12, max: 12, step: 1, def: 0, lane: true, fmt: v => (v > 0 ? '+' : '') + v },
      { k: 'dec', label: 'DECAY', short: 'DEC', min: 0.3, max: 2, step: 0.05, def: 1, lane: true, fmt: v => 'x' + v.toFixed(2) },
      { k: 'rtg', label: 'RETRIG', short: 'RT', min: 1, max: 4, step: 1, def: 1, fmt: v => 'x' + v }],
    init: tr => { (old?.k || [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]).forEach((on, i) => { tr.steps[i].on = on ? 1 : 0; }); },
    audition: k => auditionStep('kick', k), playing: () => playing, stepAt,
    changed: () => { refresh('kick'); refresh('bass'); drawBar(); },
    drawCtx: (g, w, h, k, col) => { if (col !== 'pit' && col !== 'dec' && col !== 'on') return false; miniWave(g, w, h, kickVariant(kickSeq.tr.steps[k].pit, kickSeq.tr.steps[k].dec)); return true; } });
  bassSeq = makeSeq({ id: 'bass', host: $('sqBass'), defaults: { len: 16 },
    roll: { glide: x => !!x.gl,  field: 'note', min: -12, max: 24, len: 'len', label: v => bassNote(v), mark: x => (x.gl ? '~' : ''),
      shade: v => { const m = Math.round(69 + 12 * Math.log2(bassHz(P) * Math.pow(2, v / 12) / 440)), pc = ((m % 12) + 12) % 12; return v === 0 ? 'root' : [1, 3, 6, 8, 10].includes(pc) ? 'black' : ''; } },
    fields: [{ k: 'note', label: 'NOTE', short: 'NOTE', min: -12, max: 24, step: 1, def: 0, lane: true, fmt: v => bassNote(v) },
      { k: 'vel', label: 'VELOCITY', short: 'VL', min: 0.05, max: 1, step: 0.05, def: 0.85, lane: true, fmt: v => Math.round(v * 99) + '' },
      { k: 'len', label: 'LENGTH', short: 'LEN', min: 0.25, max: 8, step: 0.25, def: 0.75, lane: true, fmt: v => v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') },
      { k: 'gl', label: 'GLIDE', short: 'GL', list: ['—', 'GLIDE'], def: 0, fmt: v => (v ? 'GL' : '—') }],
    init: tr => { (old?.b || [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0]).forEach((on, i) => { tr.steps[i].on = on ? 1 : 0; }); },
    audition: k => auditionStep('bass', k), playing: () => playing, stepAt,
    changed: () => { refresh('bass'); drawBar(); },
    drawCtx: (g, w, h, k, col) => {                        // NOTE: the step's note on a keyboard of three octaves
      if (col !== 'note') return false;
      const n = bassSeq.tr.steps[k].note, kw = w / 37;
      for (let i = 0; i < 37; i++) {
        const black = [1, 3, 6, 8, 10].includes(((i - 12) % 12 + 12) % 12);
        g.fillStyle = i - 12 === n ? '#ff8a4c' : black ? '#3d2b20' : 'rgba(61,43,32,.15)';
        g.fillRect(i * kw + 1, black ? 4 : 14, kw - 2, black ? h - 22 : h - 18);
      }
      return true;
    } });
  if (!bassSeq.tr.steps.some(x => x.on) && !localStorage.getItem('onion-bass-seeded')) {   // (an empty bass: the offbeats)
    [2, 6, 10, 14].forEach(i => { bassSeq.tr.steps[i].on = 1; });
    bassSeq.changed();
    try { localStorage.setItem('onion-bass-seeded', '1'); } catch (e) { /* ignore */ }
  }
}
function miniWave(g, w, h, d) {
  g.fillStyle = 'rgba(61,43,32,.75)';
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let i = Math.floor(x / w * d.length); i < Math.floor((x + 1) / w * d.length); i++) m = Math.max(m, Math.abs(d[i]));
    g.fillRect(x, h / 2 - m * (h / 2 - 2), 1, Math.max(1, m * (h - 4)));
  }
}
function dragNumber(el, get, set, perPx, fmtFn) {
  let y0 = 0, v0 = 0;
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = get(); });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    set(v0 + (y0 - e.clientY) * perPx); fmtFn();
  });
  el.addEventListener('pointerup', e => { if (el.hasPointerCapture(e.pointerId)) { el.releasePointerCapture(e.pointerId); persist(); } });
}
function showTempo() { $('bpmVal').textContent = $('bsBpm').textContent = Math.round(T.bpm); $('swingVal').textContent = Math.round(seq.swing * 100) + '%'; }

/* ------------------------------------------------------------ knobs --- */
const isLog = k => SPEC[k][5] === 1;
const toNorm = (k, v) => { const [, a, b] = SPEC[k]; return isLog(k) ? Math.log(v / a) / Math.log(b / a) : (v - a) / (b - a); };
const fromNorm = (k, n) => { const [, a, b] = SPEC[k]; n = clamp(n, 0, 1); return isLog(k) ? a * Math.pow(b / a, n) : a + n * (b - a); };
function fmt(k, v) {
  const u = SPEC[k][4];
  if (u === 'hz') return v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v >= 100 ? Math.round(v) + '' : v.toFixed(1);
  if (u === 'ms') return v < 10 ? v.toFixed(1) : Math.round(v) + '';
  if (u === 'st') return '+' + Math.round(v);
  if (u === 'x') return v.toFixed(2);
  if (u === 'wave') return v < 0.05 ? 'SIN' : v > 0.95 ? 'TRI' : Math.round(v * 100) + '%';
  if (u === 'dbv') return v < 0.05 ? 'OFF' : '+' + v.toFixed(1) + ' DB';
  if (u === 'col') return v < -0.05 ? 'LOWS ' + Math.round(-v * 100) + '%' : v > 0.05 ? 'HIGHS ' + Math.round(v * 100) + '%' : 'FLAT';
  if (u === 'db') return v < 0.01 ? 'OFF' : (v >= 1 ? '+' : '') + (20 * Math.log10(v)).toFixed(1);
  if (u === 'int') { const iv = Math.round(v); return (iv > 0 ? '+' : '') + iv + ' ' + noteName(bassHz(P)); }
  return Math.round(v * 100) + '%';
}
const knobEls = {};
function knobSvg(n) {
  if (!isFinite(n)) n = 0;
  const a0 = Math.PI * 0.75, a1 = a0 + Math.PI * 1.5 * n, r = 22, c = 28;
  const pt = a => [c + r * Math.cos(a), c + r * Math.sin(a)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1), [xe, ye] = pt(Math.PI * 2.25);
  return `<svg viewBox="0 0 56 56"><path d="M${x0} ${y0} A${r} ${r} 0 1 1 ${xe} ${ye}" fill="none" stroke="${css('--line')}" stroke-width="6" stroke-linecap="round"/>` +
    (n > 0.002 ? `<path d="M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}" fill="none" stroke="${css('--acc')}" stroke-width="6" stroke-linecap="round"/>` : '') +
    `<circle cx="${x1}" cy="${y1}" r="4" fill="${css('--text')}"/></svg>`;
}
function updateKnob(k) { if (knobEls[k]) knobEls[k].redraw(); }
// a parameter of the kick / bass as a full-width row (ui.js row)
function makeKnob(k, label) {
  const el = row({ label: label || SPEC[k][0], min: SPEC[k][1], max: SPEC[k][2], def: SPEC[k][3], log: isLog(k), int: SPEC[k][4] === 'int',
    bipolar: k === 'bint', get: () => P[k], set: v => { P[k] = v; }, fmt: v => fmt(k, v),
    onMove: () => { audio(); changed(k, false); }, onRelease: () => changed(k, true) });
  knobEls[k] = el;
  return el;
}
// two parameters on an XY pad; touching it plays the loop (and stops it after, if it was not playing)
function pad(kx, ky) {
  let auto = false;
  const ax = k => ({ label: SPEC[k][0], min: SPEC[k][1], max: SPEC[k][2], log: isLog(k), get: () => P[k], set: v => { P[k] = v; }, fmt: v => fmt(k, v) });
  const el = xy({ x: ax(kx), y: ax(ky),
    onStart: () => { audio(); if (!T.playing) { auto = true; play(); } },
    onMove: () => changed(ky, false, true),
    onRelease: () => { if (auto) { auto = false; stop(); } changed(ky, true, true); } });
  pads.push(el);
  return el;
}
const pads = [];
const segEls = {};
function makeSeg(k, names) {
  const el = document.createElement('div');
  el.className = 'seg';
  names.forEach((n, i) => {
    const b = document.createElement('button');
    b.textContent = n;
    b.onclick = () => { P[k] = i; changed(k, true); };
    el.appendChild(b);
  });
  segEls[k] = el;
  return el;
}
function typeBtn(k) {
  const b = document.createElement('button');
  b.className = 'type-btn';
  b.onclick = () => { P[k] = (Math.round(P[k]) + 1) % DTYPES.length; changed(k, true); };
  segEls[k] = b;
  return b;
}
function updateSegs() {
  for (const [k, el] of Object.entries(segEls)) {
    if (el.classList.contains('type-btn')) el.textContent = DTYPES[Math.round(P[k])];
    else [...el.children].forEach((b, i) => b.classList.toggle('on', i === Math.round(P[k])));
  }
}

/* --------------------------------------------------------- sections --- */
const BASS_KEYS = new Set(Object.keys(SPEC).filter(k => k[0] === 'b'));
function section(title, extra, host = 'sections') {
  const s = document.createElement('div');
  s.className = 'sec';
  s.innerHTML = `<h3><span>${title}</span></h3>`;
  if (extra) s.querySelector('h3').appendChild(extra);
  $(host).appendChild(s);
  return s;
}
function knobRow(keys, labels = {}) {
  const g = document.createElement('div');
  g.className = 'knobs';
  for (const k of keys) g.appendChild(makeKnob(k, labels[k]));
  return g;
}
function buildSections() {
  section('BODY').append(knobRow(['tune', 'pitch', 'pdec', 'pcurve', 'wave']));
  const amp = section('AMP');
  canvasIn(amp, 'env edit').id = 'ampView';                // (its four values: the squares)
  const cl = section('CLICK');
  cl.append(pad('ctone', 'click'), knobRow(['clen']));
  const mb = section('MULTIBAND DRIVE');
  canvasIn(mb, 'bands edit').id = 'mbView';
  const types = document.createElement('div');
  types.className = 'band-types';
  for (const [b, name] of [['l', 'LOW'], ['m', 'MID'], ['h', 'HIGH']]) {
    const c = document.createElement('div');
    c.innerHTML = `<span class="band-title">${name}</span>`;
    c.append(typeBtn(b + 'typ'));
    types.appendChild(c);
  }
  mb.append(types, knobRow(['llvl', 'mlvl', 'hlvl'], { llvl: 'LOW LEVEL', mlvl: 'MID LEVEL', hlvl: 'HIGH LEVEL' }));   // (drives, crossovers, tone: the squares)
  const rb = section('RUMBLE');
  rb.append(pad('rsize', 'rumble'), knobRow(['rlpf', 'rduck']));
  const sat = section('SATURATOR');                       // (drag the picture: sideways DRIVE, up / down BIAS)
  canvasIn(sat, 'sat edit').id = 'satView';
  sat.append(makeSeg('styp', SAT_TYPES), knobRow(['sdrv', 'scol', 'sbias', 'smix']));
  satInput();
  // the BASS page: its presets, then the sound in sections (the ADSR: the squares)
  const chips = $('bassPresets');
  for (const name of Object.keys(BASS_PRESETS)) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = name;
    b.onclick = () => { Object.assign(P, BASS_PRESETS[name]); refreshAll(); audition('bass'); };
    chips.appendChild(b);
  }
  const B = t => section(t, null, 'bassSections');
  const views = document.createElement('div');
  views.className = 'bass-views';
  canvasIn(views, 'shape').id = 'bassShape';
  canvasIn(views, 'hit').id = 'bassHit';
  B('OSC').append(views, makeSeg('bwave', BWAVES), knobRow(['bint', 'blvl']));
  B('FILTER').append(pad('bcut', 'bres'), knobRow(['benv', 'bfdec']));
  const env = B('AMP');
  canvasIn(env, 'env edit').id = 'adsrView';
  B('PITCH · GLIDE').append(knobRow(['bpitch', 'bpdec', 'bglide']));
  B('DRIVE').append(knobRow(['bdrv']), makeSeg('bmb', ['DRY', 'THRU MULTIBAND']));
  B('SIDECHAIN · THE KICK DUCKS IT').append(knobRow(['bduck', 'bduckr']));
  editors();
}
function buildPresets() {
  const box = $('presets');
  box.innerHTML = '';
  for (const name of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'chip' + (name === preset ? ' on' : '');
    b.textContent = name;
    b.onclick = () => {
      const keep = {};
      for (const k of BASS_KEYS) keep[k] = P[k];
      P = { ...defaults(), ...PRESETS[name], ...keep };
      preset = name; refreshAll(); audition('kick');
    };
    box.appendChild(b);
  }
}

/* ------------------------------------------------- the pitch graph --- */
// time runs on a square-root axis (the first 100 ms get room, the tail still shows); pitch on a log axis
const G = { fmin: 25, fmax: 4000, pad: 10 };
function gdim() { const c = $('graph'); return { w: c.clientWidth, h: c.clientHeight }; }
const tOfX = (x, w) => Math.pow(clamp((x - G.pad) / (w - 2 * G.pad), 0, 1), 2) * P.length / 1000;
const xOfT = (t, w) => G.pad + Math.sqrt(clamp(t / (P.length / 1000), 0, 1)) * (w - 2 * G.pad);
const yOfF = (f, h) => h - 14 - Math.log(f / G.fmin) / Math.log(G.fmax / G.fmin) * (h - 34);
const fOfY = (y, h) => G.fmin * Math.pow(G.fmax / G.fmin, (h - 14 - y) / (h - 34));
const yOfA = (a, h) => h - 8 - a * (h - 40);
function handles() {
  const { w, h } = gdim(), t2 = p => p / 1000;
  return {
    start: { x: G.pad + 6, y: yOfF(P.tune * Math.pow(2, P.pitch / 12), h) },
    curve: { x: xOfT(t2(P.pdec) * 0.3, w), y: yOfF(kickPitchAt(P, t2(P.pdec) * 0.3), h) },
    knee:  { x: xOfT(t2(P.pdec), w), y: yOfF(P.tune, h) },
    decay: { x: xOfT(t2(P.attack + P.hold + P.decay), w), y: yOfA(kickAmpAt(P, t2(P.attack + P.hold + P.decay)), h) },
  };
}
let drag = null;
function drawGraph() {
  const c = $('graph'), dpr = window.devicePixelRatio || 1, { w, h } = gdim();
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = css('--line'); g.lineWidth = 1;                         // octave lines of the tune
  for (let f = P.tune; f < G.fmax; f *= 2) { const y = Math.round(yOfF(f, h)) + 0.5; g.beginPath(); g.moveTo(G.pad, y); g.lineTo(w - G.pad, y); g.stroke(); }
  const n = kickData.length, mid = h / 2;
  g.fillStyle = css('--lilac'); g.globalAlpha = 0.55;                     // the sound, on the same time axis
  for (let x = G.pad; x < w - G.pad; x++) {
    const a = Math.floor(tOfX(x, w) * SR), b = Math.max(a + 1, Math.floor(tOfX(x + 1, w) * SR));
    let lo = 0, hi = 0;
    for (let i = a; i < b && i < n; i++) { const v = kickData[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.fillRect(x, mid - hi * (mid - 18), 1, Math.max(1, (hi - lo) * (mid - 18)));
  }
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(61,43,32,.45)'; g.lineWidth = 1.5; g.beginPath();   // the level envelope
  for (let x = G.pad; x < w - G.pad; x += 2) { const y = yOfA(kickAmpAt(P, tOfX(x, w)), h); x === G.pad ? g.moveTo(x, y) : g.lineTo(x, y); }
  g.stroke();
  g.strokeStyle = css('--acc'); g.lineWidth = 2.5; g.beginPath();        // the pitch
  for (let x = G.pad; x < w - G.pad; x += 2) { const y = yOfF(kickPitchAt(P, tOfX(x, w)), h); x === G.pad ? g.moveTo(x, y) : g.lineTo(x, y); }
  g.stroke();
  for (const [k, p] of Object.entries(handles())) {
    g.fillStyle = k === 'decay' ? css('--text') : k === 'curve' ? css('--lilac') : css('--yel');
    g.strokeStyle = css('--ink'); g.lineWidth = 2;
    const s = drag && drag.k === k ? 16 : 12;
    g.fillRect(p.x - s / 2, p.y - s / 2, s, s); g.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
  }
}
function graphInput() {
  const c = $('graph');
  c.addEventListener('pointerdown', e => {
    audio();
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 30;
    for (const [k, p] of Object.entries(handles())) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = k; } }
    drag = { k: best, x0: x, y0: y, moved: false, p0: { ...P } };
    c.setPointerCapture(e.pointerId);
    drawGraph();
  });
  c.addEventListener('pointermove', e => {
    if (!drag || !c.hasPointerCapture(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { c.dispatchEvent(new PointerEvent('pointerup', e)); return; }   // (a lost mouse-up)
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, { w, h } = gdim();
    if (Math.hypot(x - drag.x0, y - drag.y0) > 4) drag.moved = true;
    if (!drag.moved || !drag.k) return;
    const k = drag.k;
    if (k === 'start') P.pitch = clamp(12 * Math.log2(fOfY(y, h) / P.tune), 0, 48);
    if (k === 'knee') { P.pdec = clamp(tOfX(x, w) * 1000, 5, 250); P.tune = clamp(fOfY(y, h), 30, 110); }
    if (k === 'curve') P.pcurve = clamp(drag.p0.pcurve * Math.pow(2, (y - drag.y0) / 70), 0.3, 3);
    if (k === 'decay') P.decay = clamp(tOfX(x, w) * 1000 - P.attack - P.hold, 30, 1500);
    changed('tune', false, true);
  });
  c.addEventListener('pointerup', e => {
    if (!drag) return;
    c.releasePointerCapture(e.pointerId);
    const d = drag;
    drag = null;
    if (d.moved && d.k) changed('pdec', true, true);
    else audition('kick');
  });
  c.addEventListener('pointercancel', () => { drag = null; drawGraph(); });   // the page scrolled instead
  scrollGuard(c, () => !!(drag && drag.k));
}

/* ----------------------------------------------------------- render --- */
let raf = 0, dirtyBass = true;
function rerender() {
  kickData = renderKick(P);
  variants.clear();
  if (dirtyBass) { bassData = renderBass(P); dirtyBass = false; }
  buffers();
  drawGraph();
  drawViews();
  const c = centsOff(P.tune);
  $('noteInfo').textContent = noteName(P.tune) + (c ? (c > 0 ? ' +' : ' ') + c + '¢' : '') + ' · ' + P.tune.toFixed(1) + ' HZ';
  $('lenInfo').textContent = Math.round(P.length) + ' MS';
}
// a value moved: redraw now, sound it when the finger lets go (playing: the loop already plays the new sound)
function changed(k, release, all) {
  if (all) Object.keys(knobEls).forEach(updateKnob); else updateKnob(k);
  pads.forEach(p => p.redraw());
  if (k === 'tune') updateKnob('bint');
  updateSegs();
  dirtyBass = true;                                       // (the bass follows the tune and the multiband too)
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; rerender(); });
  if (release) {
    if (preset && PRESETS[preset][k] !== undefined && Math.abs(PRESETS[preset][k] - P[k]) > 1e-6) { preset = null; buildPresets(); }
    persist();
    if (!playing) setTimeout(() => audition(BASS_KEYS.has(k) ? 'bass' : 'kick'), 20);
  }
}
function refreshAll() {
  Object.keys(knobEls).forEach(updateKnob);
  updateSegs(); buildPresets(); dirtyBass = true; rerender(); persist();
}

/* ---------------------------------------------------- dice / mutate --- */
const RANGES = { tune: [40, 72], pitch: [10, 44], pdec: [12, 90], pcurve: [0.7, 2], wave: [0, 0.5], attack: [0, 2], hold: [0, 60],
  decay: [150, 700], length: [350, 1200], click: [0, 0.8], ctone: [1500, 9000], clen: [2, 12], ldrv: [0, 0.8], mdrv: [0, 1], hdrv: [0, 0.8],
  tone: [2500, 14000], rumble: [0, 0.6], rsize: [0.3, 0.9] };
function dice() {
  for (const [k, [a, b]] of Object.entries(RANGES)) P[k] = isLog(k) ? a * Math.pow(b / a, Math.random()) : a + Math.random() * (b - a);
  for (const t of ['ltyp', 'mtyp', 'htyp']) P[t] = Math.floor(Math.random() * DTYPES.length);
  if (Math.random() < 0.5) P.rumble = 0;
  preset = null; refreshAll(); if (!playing) audition('kick');
}
function mutate() {
  for (const k of Object.keys(RANGES)) P[k] = fromNorm(k, toNorm(k, P[k]) + (Math.random() - 0.5) * 0.12);
  preset = null; refreshAll(); if (!playing) audition('kick');
}

/* ---------------------------------------------------------- library --- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 1600);
}
function peaksOf(data, n = 48) {
  const out = [], step = data.length / n;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, Math.abs(data[j]));
    out.push(+m.toFixed(3));
  }
  return out;
}
async function sample(kind) {
  const all = await libAll(), num = String(all.filter(x => x.kind === kind).length + 1).padStart(3, '0');
  let data, name, extra = {};
  if (kind === 'kick') { data = kickData; name = 'KICK ' + num + (preset ? ' ' + preset : ''); }
  else if (kind === 'bass') { data = bassData; name = 'BASS ' + num + ' ' + noteName(bassHz(P)); }
  else {                                                  // the two tracks as they are written, round once, tails wrapped
    const k = renderKickRound(-1), b = renderBassRound(-1), L = Math.round(stepFrames() * Math.max(kickSeq.tr.len, bassSeq.tr.len));
    data = new Float32Array(L);
    for (const [src, len] of [[k, kickSeq.tr.len], [b, bassSeq.tr.len]]) {
      const per = Math.round(stepFrames() * len);
      for (let rep = 0; rep * per < L; rep++) for (let i = 0; i < src.length; i++) data[(rep * per + i) % L] += src[i];
    }
    let pk = 0; for (const v of data) pk = Math.max(pk, Math.abs(v)); if (pk > 0.98) for (let i = 0; i < L; i++) data[i] *= 0.98 / pk;
    name = 'LOOP ' + num + ' ' + Math.round(T.bpm) + 'BPM';
  }
  await libAdd({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, kind, created: Date.now(), sr: SR,
    ms: Math.round(data.length / SR * 1000), note: noteName(kind === 'bass' ? bassHz(P) : P.tune), params: { ...P }, ...extra,
    peaks: peaksOf(data), wav: toWav(data) });
  toast('SAMPLED: ' + name);
}
async function share(item) {
  const file = new File([item.wav], item.name.replace(/[^\w\- ]+/g, '').trim() + '.wav', { type: 'audio/wav' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: item.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function drawMini(canvas, peaks) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 72, h = canvas.clientHeight || 40;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr); g.fillStyle = css('--lilac');
  const bw = w / peaks.length;
  peaks.forEach((v, i) => { const hh = Math.max(1, v * (h - 6)); g.fillRect(i * bw, (h - hh) / 2, Math.max(1, bw - 0.5), hh); });
}
async function renderLib() {
  const all = await libAll(), list = $('libList');
  list.innerHTML = '';
  $('libCount').textContent = all.length + (all.length === 1 ? ' SOUND' : ' SOUNDS');
  $('libEmpty').style.display = all.length ? 'none' : 'block';
  for (const it of all) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="row"><canvas></canvas><div><div class="name"></div><div class="meta">${it.note || ''} · ${it.ms} ms · ${new Date(it.created).toLocaleDateString()}</div></div><button class="play">▶</button></div>
      <div class="tools"><button data-a="load">EDIT</button><button data-a="share">EXPORT</button><button data-a="ren">RENAME</button><button data-a="del" class="del">DELETE</button></div>`;
    el.querySelector('.name').textContent = it.name;
    el.querySelector('.play').onclick = () => playBlob(it.wav);
    el.querySelector('[data-a=load]').onclick = () => {
      if (it.acid) { acidLoad(it.acid); show('acid'); return; }
      if (!it.params) return;
      P = { ...defaults(), ...it.params }; preset = null;
      if (it.seq) { seq = { ...seq, swing: it.seq.swing ?? seq.swing }; showTempo(); }
      refreshAll(); show('kick');
    };
    el.querySelector('[data-a=share]').onclick = () => share(it);
    el.querySelector('[data-a=ren]').onclick = async () => {
      const n = prompt('Name', it.name);
      if (n && n.trim()) { it.name = n.trim().toUpperCase().slice(0, 28); await libAdd(it); renderLib(); }
    };
    el.querySelector('[data-a=del]').onclick = async () => { if (confirm('Delete ' + it.name + '?')) { await libDel(it.id); renderLib(); } };
    list.appendChild(el);
    requestAnimationFrame(() => drawMini(el.querySelector('canvas'), it.peaks || []));
  }
}

/* ------------------------------------------------------- the logo --- */
const ONION = ["..GGG.....GGG...", ".G...G...G...G..", ".G.g.G...G.g.G..", "..G.gG..GGg.G...", "....gGg.gGg.....", "......kGGk......", ".....kyyyyk.....", "....kyWyyyok....", "...kyWyyyyook...", "..kyWyyyoyyook..", "..kyyyyyoyyook..", "..kyyyyoyyyook..", "...kyyyoyyook...", "....kkyyookk....", "......kkkk......", ".....o.o.o......"];
const OC = { k: '#1b1026', g: '#7ee08f', G: '#2f8a4e', y: '#ffd23f', o: '#d9962b', W: '#fff6c8' };
function drawLogo() {
  const g = $('logo').getContext('2d');
  ONION.forEach((row, r) => [...row].forEach((ch, c) => { if (OC[ch]) { g.fillStyle = OC[ch]; g.fillRect(c, r, 1, 1); } }));
}

/* ------------------------------------------------------------- tabs --- */
function show(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + page));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  $('pageName').textContent = { kick: 'KICK', bass: 'BASS', lib: 'LIBRARY', slicer: 'SLICER', acid: 'ACID', tex: 'TEXTURE' }[page];
  $('texActions').style.display = page === 'tex' ? 'flex' : 'none';
  if (page !== 'tex') textureStop(); else textureShown();
  $('kickActions').style.display = page === 'kick' ? 'flex' : 'none';
  $('bsActions').style.display = page === 'bass' ? 'flex' : 'none';
  $('slActions').style.display = page === 'slicer' ? 'flex' : 'none';
  $('acActions').style.display = page === 'acid' ? 'flex' : 'none';
  if (page !== 'acid') acidStop(); else acidShown();
  if (page !== 'slicer') slicerStop(); else slicerShown();
  if (page === 'lib') renderLib();
  if (page === 'kick') requestAnimationFrame(drawGraph);
  if (page === 'kick' || page === 'bass') requestAnimationFrame(() => { drawViews(); (page === 'kick' ? kickSeq : bassSeq).draw(); });
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.page));

/* ---------------------------------------------------- small views --- */
// the AMP section's envelope, the BASS section's wave (a few cycles) and its whole hit (a line runs along it when it
// plays), and the bar: the kick and the bass where they land on the 16 steps, one over the other
function canvasIn(sec, cls) {
  const c = document.createElement('canvas');
  c.className = 'view ' + cls;
  sec.appendChild(c);
  return c;
}
function ctx2(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  return { g, w, h };
}
// the editors: a picture of the values with squares to drag. o.handles() -> [{id, x, y, c}], o.drag(id, x, y, w, h)
const EDS = {};
function editor(id, o) {
  const c = $(id);
  EDS[id] = o;
  let hit = null, moved = false, x0 = 0, y0 = 0;
  const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', e => {
    audio();
    const [x, y] = pos(e);
    let bd = 28;
    hit = null;
    for (const h of o.handles(c.clientWidth, c.clientHeight)) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; hit = h.id; } }
    c.setPointerCapture(e.pointerId); moved = false; x0 = x; y0 = y;
    o.grab = hit; drawViews();
  });
  c.addEventListener('pointermove', e => {
    if (!c.hasPointerCapture(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { c.releasePointerCapture(e.pointerId); return; }
    const [x, y] = pos(e);
    if (Math.hypot(x - x0, y - y0) > 3) moved = true;
    if (!moved || !hit) return;
    o.drag(hit, x, y, c.clientWidth, c.clientHeight);
    changed(o.key || 'decay', false, true);
  });
  c.addEventListener('pointerup', e => {
    if (!c.hasPointerCapture(e.pointerId)) return;
    c.releasePointerCapture(e.pointerId);
    o.grab = null;
    if (moved && hit) changed(o.key || 'decay', true, true); else audition(o.sound || 'kick');
    drawViews();
  });
  c.addEventListener('pointercancel', () => { hit = null; o.grab = null; drawViews(); });
  scrollGuard(c, () => !!hit);
}
function squares(g, hs, grab) {
  for (const h of hs) {
    const s = h.id === grab ? 16 : 12;
    g.fillStyle = h.c || css('--yel'); g.strokeStyle = css('--ink'); g.lineWidth = 2;
    g.fillRect(h.x - s / 2, h.y - s / 2, s, s); g.strokeRect(h.x - s / 2, h.y - s / 2, s, s);
  }
}
// time on a square-root axis up to `max` ms (the start gets room), x of t and t of x
const sx = (t, max, w) => 8 + Math.sqrt(clamp(t / max, 0, 1)) * (w - 16);
const tx = (x, max, w) => Math.pow(clamp((x - 8) / (w - 16), 0, 1), 2) * max;
const AMPMAX = 2500, BASSMAX = 2200;
function ampHandles(w, h) {
  const top = 10, bot = h - 8;
  return [{ id: 'attack', x: sx(P.attack, AMPMAX, w), y: top }, { id: 'hold', x: Math.max(sx(P.attack + P.hold, AMPMAX, w), sx(P.attack, AMPMAX, w) + 14), y: top + 22 },
    { id: 'decay', x: sx(P.attack + P.hold + P.decay, AMPMAX, w), y: bot - 4, c: css('--acc') },
    { id: 'length', x: sx(P.length, AMPMAX, w), y: h / 2, c: css('--soft') }];
}
function drawAmp() {
  const c = $('ampView');
  if (!c || !c.clientWidth) return;
  const { g, w, h } = ctx2(c), top = 10, bot = h - 8;
  const lx = sx(P.length, AMPMAX, w);
  g.fillStyle = 'rgba(207,179,151,.25)'; g.fillRect(lx, 0, w - lx, h);
  g.strokeStyle = css('--soft'); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(lx, 0); g.lineTo(lx, h); g.stroke(); g.setLineDash([]);
  g.beginPath(); g.moveTo(8, bot);
  for (let x = 8; x <= w - 8; x += 2) g.lineTo(x, bot - kickAmpAt(P, tx(x, AMPMAX, w) / 1000) * (bot - top));
  g.lineTo(w - 8, bot); g.closePath();
  g.fillStyle = 'rgba(242,181,58,.30)'; g.fill();
  g.strokeStyle = css('--yel'); g.lineWidth = 2; g.stroke();
  squares(g, ampHandles(w, h), EDS.ampView && EDS.ampView.grab);
}
// the multiband: frequency (log) across; the two crossovers to drag sideways; each band a block as high as its drive
// (its square drags it up / down); the TONE a slope at the right
const FMIN = 30, FMAX = 16000;
const fxp = (f, w) => 8 + Math.log(f / FMIN) / Math.log(FMAX / FMIN) * (w - 16);
const xfp = (x, w) => FMIN * Math.pow(FMAX / FMIN, clamp((x - 8) / (w - 16), 0, 1));
function mbHandles(w, h) {
  const yd = d => h - 10 - d * (h - 30), mid = (a, b) => (fxp(a, w) + fxp(b, w)) / 2;
  return [{ id: 'xlo', x: fxp(P.xlo, w), y: 10, c: css('--soft') }, { id: 'xhi', x: fxp(P.xhi, w), y: 10, c: css('--soft') },
    { id: 'ldrv', x: mid(FMIN, P.xlo), y: yd(P.ldrv) }, { id: 'mdrv', x: mid(P.xlo, P.xhi), y: yd(P.mdrv) },
    { id: 'hdrv', x: mid(P.xhi, Math.min(FMAX, P.tone)), y: yd(P.hdrv) }, { id: 'tone', x: fxp(P.tone, w), y: h / 2, c: css('--acc') }];
}
function drawMB() {
  const c = $('mbView');
  if (!c || !c.clientWidth) return;
  const { g, w, h } = ctx2(c), yd = d => h - 10 - d * (h - 30);
  const bands = [[FMIN, P.xlo, P.ldrv, P.ltyp], [P.xlo, P.xhi, P.mdrv, P.mtyp], [P.xhi, FMAX, P.hdrv, P.htyp]];
  g.font = '9px Silkscreen, monospace';
  bands.forEach(([a, b, d, t]) => {
    const x0 = fxp(a, w), x1 = fxp(b, w);
    g.fillStyle = 'rgba(255,138,76,' + (0.15 + d * 0.45).toFixed(2) + ')';
    g.fillRect(x0 + 1, yd(d), x1 - x0 - 2, h - 10 - yd(d));
    g.fillStyle = css('--muted'); g.fillText(DTYPES[Math.round(t)], x0 + 4, h - 14);
  });
  const tx2 = fxp(P.tone, w);                               // the tone: everything above it rolls off
  g.fillStyle = 'rgba(255,246,234,.75)'; g.beginPath(); g.moveTo(tx2, 0); g.lineTo(w, 0); g.lineTo(w, h); g.lineTo(tx2, h); g.fill();
  g.strokeStyle = css('--acc'); g.beginPath(); g.moveTo(tx2, 4); g.quadraticCurveTo(tx2 + 30, 6, w - 8, h - 8); g.stroke();
  [P.xlo, P.xhi].forEach(f => { const x = fxp(f, w); g.strokeStyle = css('--soft'); g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });
  squares(g, mbHandles(w, h), EDS.mbView && EDS.mbView.grab);
}
// the bass ADSR on its gate: attack, decay to the sustain (that square moves both), the gate's end, the release
function adsrHandles(w, h) {
  const top = 10, bot = h - 8, ys = bot - P.bsus * (bot - top);
  return [{ id: 'batk', x: sx(P.batk, BASSMAX, w), y: top }, { id: 'bdec', x: sx(P.batk + P.bdec, BASSMAX, w), y: ys, c: css('--acc') },
    { id: 'blen', x: sx(P.blen, BASSMAX, w), y: ys, c: css('--soft') }, { id: 'brel', x: sx(P.blen + P.brel, BASSMAX, w), y: bot - 4 }];
}
function bassAmpAt(t) {                                     // ms -> 0..1, as dsp.js renderBass shapes it
  const a = P.batk, d = P.bdec / 4.6;
  const on = x => x < a ? x / Math.max(0.001, a) : P.bsus + (1 - P.bsus) * Math.exp(-(x - a) / d);
  return t < P.blen ? on(t) : on(P.blen) * Math.exp(-(t - P.blen) / (P.brel / 4.6));
}
function drawADSR() {
  const c = $('adsrView');
  if (!c || !c.clientWidth) return;
  const { g, w, h } = ctx2(c), top = 10, bot = h - 8, gx = sx(P.blen, BASSMAX, w);
  g.fillStyle = 'rgba(185,162,240,.12)'; g.fillRect(8, 0, gx - 8, h);
  g.beginPath(); g.moveTo(8, bot);
  for (let x = 8; x <= w - 8; x += 2) g.lineTo(x, bot - bassAmpAt(tx(x, BASSMAX, w)) * (bot - top));
  g.lineTo(w - 8, bot); g.closePath();
  g.fillStyle = 'rgba(185,162,240,.30)'; g.fill();
  g.strokeStyle = css('--soft'); g.lineWidth = 2; g.stroke();
  g.font = '9px Silkscreen, monospace'; g.fillStyle = css('--muted'); g.fillText('GATE', gx + 4, 12);
  squares(g, adsrHandles(w, h), EDS.adsrView && EDS.adsrView.grab);
}
function editors() {
  editor('ampView', { key: 'decay', handles: ampHandles, drag: (id, x) => {
    const t = tx(x, AMPMAX, $('ampView').clientWidth);
    if (id === 'attack') P.attack = clamp(t, 0, 20);
    if (id === 'hold') P.hold = clamp(t - P.attack, 0, 200);
    if (id === 'decay') P.decay = clamp(t - P.attack - P.hold, 30, 1500);
    if (id === 'length') P.length = clamp(t, 100, 2500);
  } });
  editor('mbView', { key: 'mdrv', handles: mbHandles, drag: (id, x, y, w, h) => {
    const d = clamp((h - 10 - y) / (h - 30), 0, 1);
    if (id === 'xlo') P.xlo = clamp(xfp(x, w), 60, Math.min(400, P.xhi * 0.7));
    if (id === 'xhi') P.xhi = clamp(xfp(x, w), Math.max(800, P.xlo * 1.5), 8000);
    if (id === 'tone') P.tone = clamp(xfp(x, w), 300, 16000);
    if (id === 'ldrv' || id === 'mdrv' || id === 'hdrv') P[id] = d;
  } });
  editor('adsrView', { key: 'bdec', sound: 'bass', handles: adsrHandles, drag: (id, x, y, w, h) => {
    const t = tx(x, BASSMAX, w), s = clamp((h - 8 - y) / (h - 18), 0, 1);
    if (id === 'batk') P.batk = clamp(t, 0, 50);
    if (id === 'bdec') { P.bdec = clamp(t - P.batk, 10, 1000); P.bsus = s; }
    if (id === 'blen') { P.blen = clamp(t, 20, 1000); P.bsus = s; }
    if (id === 'brel') P.brel = clamp(t - P.blen, 5, 800);
  } });
}
function drawBassViews(play) {
  const sc = $('bassShape'), hc = $('bassHit');
  if (!sc || !sc.clientWidth || !bassData) return;
  {                                                       // a few cycles, after the attack
    const { g, w, h } = ctx2(sc), per = SR / bassHz(P), a = Math.min(bassData.length - 1, Math.round(SR * 0.012)), n = Math.round(per * 3);
    g.strokeStyle = css('--line'); g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.strokeStyle = css('--soft'); g.lineWidth = 2; g.beginPath();
    for (let x = 0; x < w; x++) { const v = bassData[a + Math.floor(x / w * n)] || 0; const y = h / 2 - v * (h / 2 - 4); x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  const { g, w, h } = ctx2(hc), n = bassData.length, mid = h / 2;
  g.fillStyle = css('--soft');
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let i = Math.floor(x / w * n); i < Math.floor((x + 1) / w * n); i++) m = Math.max(m, Math.abs(bassData[i]));
    g.fillRect(x, mid - m * (mid - 3), 1, Math.max(1, m * 2 * (mid - 3)));
  }
  if (play) {                                             // a line along the hit as it sounds
    const t0 = performance.now(), dur = n / SR * 1000;
    const run = () => {
      const f = (performance.now() - t0) / dur;
      drawBassViews(false);
      if (f >= 1) return;
      const c2 = hc.getContext('2d');
      c2.fillStyle = css('--acc'); c2.fillRect(f * w, 0, 2, h);
      requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }
}
function drawBar(now = -1) {
  const c = $('barView');
  if (!c || !c.clientWidth || !kickData) return;
  const { g, w, h } = ctx2(c), sd = 60 / T.bpm / 4, n = Math.round(sd * 16 * SR);
  const lanes = [[renderKickRound(-1), 'rgba(242,181,58,.75)'], [renderBassRound(-1), 'rgba(185,162,240,.75)']];
  for (let k = 0; k < 16; k++) {
    if (k === now) { g.fillStyle = 'rgba(255,138,76,.18)'; g.fillRect(k / 16 * w, 0, w / 16, h); }
    g.fillStyle = k % 4 ? css('--panel2') : css('--line'); g.fillRect(Math.round(k / 16 * w), 0, 1, h);
  }
  const mid = h / 2;
  for (const [d, col] of lanes) {
    g.fillStyle = col;
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(x / w * n); i < Math.floor((x + 1) / w * n); i += 2) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.fillRect(x, mid - hi * (mid - 2), 1, Math.max(1, (hi - lo) * (mid - 2)));
    }
  }
}
// the SATURATOR's picture: its curve (the kick's levels as a histogram under it) and the kick's start before / after
let dryCache = { key: '', d: null };
function drawSat() {
  const c = $('satView');
  if (!c || !c.clientWidth || !kickData) return;
  const { g, w, h } = ctx2(c), sq = Math.min(h, w * 0.42), t = Math.round(P.styp), gain = Math.pow(10, P.sdrv / 20), b = P.sbias, off = satCurve(b, t);
  const key = Object.keys(P).filter(k => k[0] !== 's' || k === 'smix').map(k => P[k]).join(',');
  if (dryCache.key !== key) dryCache = { key, d: renderKick({ ...P, sdrv: 0, sbias: 0 }) };
  const dry = dryCache.d, bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#2e2145'); bg.addColorStop(1, '#1d1530');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // the curve: input -1..1 across, output up
  const X = v => 8 + (v + 1) / 2 * (sq - 16), Y = v => h / 2 - v * (h / 2 - 10);
  g.strokeStyle = 'rgba(217,204,255,.12)'; g.lineWidth = 1;
  for (const v of [-1, -0.5, 0, 0.5, 1]) { g.beginPath(); g.moveTo(X(v), 6); g.lineTo(X(v), h - 6); g.moveTo(X(-1), Y(v)); g.lineTo(X(1), Y(v)); g.stroke(); }
  const hist = new Float32Array(40);                       // where the kick's samples sit
  for (let i = 0; i < dry.length; i += 3) hist[Math.min(39, Math.floor((dry[i] + 1) / 2 * 40))]++;
  const hm = Math.max(...hist);
  g.fillStyle = 'rgba(185,162,240,.22)';
  hist.forEach((v, i) => { const bh = Math.sqrt(v / hm) * (h - 20); g.fillRect(X(i / 20 - 1), h - 6 - bh, (sq - 16) / 40 - 1, bh); });
  g.setLineDash([3, 4]); g.strokeStyle = 'rgba(217,204,255,.3)'; g.beginPath(); g.moveTo(X(-1), Y(-1)); g.lineTo(X(1), Y(1)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#ff8a4c'; g.lineWidth = 3; g.shadowColor = '#ff8a4c'; g.shadowBlur = 12; g.beginPath();
  for (let i = 0; i <= 120; i++) { const v = i / 60 - 1, o = (satCurve(v * gain + b, t) - off) * P.smix + v * (1 - P.smix); i ? g.lineTo(X(v), Y(Math.max(-1.2, Math.min(1.2, o)))) : g.moveTo(X(v), Y(o)); }
  g.stroke(); g.shadowBlur = 0;
  g.fillStyle = '#fff3e6'; g.beginPath(); g.arc(X(1), Y(Math.max(-1.2, Math.min(1.2, (satCurve(gain + b, t) - off) * P.smix + (1 - P.smix)))), 5, 0, 7); g.fill();
  // the kick's first 150 ms: before (a ghost) and after
  const x0 = sq + 6, ww = w - x0 - 6, n = Math.min(dry.length, Math.round(0.15 * SR)), mid = h / 2;
  let dp = 0, wp = 0;
  for (let i = 0; i < dry.length; i++) dp = Math.max(dp, Math.abs(dry[i]));
  for (let i = 0; i < kickData.length; i++) wp = Math.max(wp, Math.abs(kickData[i]));
  g.fillStyle = 'rgba(185,162,240,.35)';
  for (let x = 0; x < ww; x++) { let m = 0; for (let i = Math.floor(x / ww * n); i < Math.floor((x + 1) / ww * n); i++) m = Math.max(m, Math.abs(dry[i])); g.fillRect(x0 + x, mid - m / dp * (mid - 8), 1, m / dp * (mid - 8) * 2); }
  for (let x = 0; x < ww; x++) {
    let lo = 0, hi = 0, diff = 0;
    for (let i = Math.floor(x / ww * n); i < Math.floor((x + 1) / ww * n); i++) { const v = kickData[i] / wp; if (v < lo) lo = v; if (v > hi) hi = v; diff = Math.max(diff, Math.abs(v - dry[i] / dp)); }
    const hot = diff > 0.12;                                // where the saturator changed it: lit
    g.fillStyle = hot ? '#ffd23f' : '#ff8a4c';
    g.fillRect(x0 + x, mid - hi * (mid - 8), 1, Math.max(1, (hi - lo) * (mid - 8)));
  }
  g.font = '9px Silkscreen, monospace'; g.fillStyle = '#d9ccff';
  g.fillText(SAT_TYPES[t] + (P.sdrv > 0.05 ? ' · +' + P.sdrv.toFixed(1) + ' DB' : ' · OFF'), x0 + 4, 13);
  g.fillStyle = 'rgba(217,204,255,.5)'; g.fillText('IN', X(1) - 14, h - 9); g.fillText('OUT', 10, 14);
}
function satInput() {
  const c = $('satView');
  let d = null;
  scrollGuard(c, () => !!(d && d.moved));
  c.addEventListener('pointerdown', e => { d = { x: e.clientX, y: e.clientY, v: P.sdrv, b: P.sbias, moved: false }; try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } audio(); });
  c.addEventListener('pointermove', e => {
    if (!d) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { d = null; return; }
    const dx = e.clientX - d.x, dy = d.y - e.clientY;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved && e.pointerType !== 'mouse' && Math.abs(dy) > Math.abs(dx) * 2 && d.v === P.sdrv) { d = null; return; }   // a scroll
    d.moved = true;
    P.sdrv = clamp(d.v + dx * 0.12, 0, 30); P.sbias = clamp(d.b + dy * 0.004, 0, 0.6);
    changed('sdrv', false, true);
  });
  const end = () => { if (!d) return; const m = d.moved; d = null; if (m) changed('sdrv', true, true); else audition('kick'); };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', () => { d = null; });
}
function drawViews() { drawSat(); drawAmp(); drawMB(); drawADSR(); drawBassViews(false); drawBar(); }


/* ------------------------------------------------------------- init --- */
drawLogo();
initSlicer();
initAcid();
initTexture();
buildSections();
collapsible($('page-kick'), 'kick');
collapsible($('page-bass'), 'bass');
collapsible($('page-slicer'), 'slicer');
collapsible($('page-acid'), 'acid');
collapsible($('page-tex'), 'tex');
buildSeq();
showTempo();
refreshAll();
graphInput();
dragNumber($('bsBpmBox'), () => T.bpm, v => { const b = clamp(Math.round(v), 60, 220); if (b !== T.bpm) setBpm(b); }, 0.25, showTempo);
dragNumber($('bpm'), () => T.bpm, v => { const b = clamp(Math.round(v), 60, 220); if (b !== T.bpm) setBpm(b); }, 0.25, showTempo);
dragNumber($('swing'), () => seq.swing, v => { seq.swing = clamp(v, 0, 0.6); refresh('kick'); refresh('bass'); }, 0.004, showTempo);
channel('kick', 'KICK', n => renderKickRound(n), '--yel', true);
channel('bass', 'BASS', n => renderBassRound(n), '--soft', true);
onTempo(showTempo);
onPlay(on => {
  playing = on;
  for (const b of [$('btnPlay'), $('bsPlay')]) { b.classList.toggle('on', on); b.textContent = on ? '■' : '▶'; }
  follow.k = follow.kb = -2;
  if (on) requestAnimationFrame(follow); else { kickSeq.draw(); bassSeq.draw(); drawBar(); }
});
$('btnPlay').onclick = transport;
$('bsPlay').onclick = transport;
$('bsHear').onclick = () => audition('bass');
$('bsSample').onclick = () => sample('bass');
$('btnDice').onclick = dice;
$('btnMutate').onclick = mutate;
$('btnSample').onclick = () => $('sheet').classList.add('on');
$('sheet').onclick = async e => {
  const k = e.target.dataset && e.target.dataset.s;
  if (e.target === $('sheet') || k === 'cancel') { $('sheet').classList.remove('on'); return; }
  if (k) { $('sheet').classList.remove('on'); await sample(k); }
};
$('bkSave').onclick = () => exportAll().catch(() => toast('COULD NOT SAVE'));
$('bkLoad').onclick = () => $('bkFile').click();
$('bkFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f && confirm('LOAD THIS FILE? ITS PATTERNS AND SETTINGS REPLACE THESE (SOUNDS ARE ADDED).')) importAll(f); };
// offline (sw.js): only on a real https address, not the Mac's dev servers (localhost, the LAN, its own certificate)
if ('serviceWorker' in navigator && location.protocol === 'https:' && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('keydown', e => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); transport(); } });
window.addEventListener('resize', () => kickData && drawGraph());
initMixer();
onTempo(() => drawBar());
requestAnimationFrame(() => drawViews());                 // (once the page has its size)
window.addEventListener('resize', () => drawViews());
initPunch();
