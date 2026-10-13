// TEXTURE: a free sampler for any sound (a file, the library, the mic), played as grains. The waveform is the
// instrument: a finger on it plays grains from where it is (up: small grains, down: long ones), up to four fingers;
// HOLD keeps them sounding when the fingers lift; SCAN moves through the sound by itself at its own speed (slow: the
// sound stretched into a cloud). The grains are made in an AudioWorklet (grain-worklet.js) in real time; RESAMPLE
// records what comes out into the library.
import { SR, toWav } from './dsp.js';
import { ac, out } from './audio.js';
import { row, toast } from './ui.js';
import { libAdd, libAll, libGet } from './lib.js';
import { BREAKS } from './slicer.js';

// sounds made for grains, from the user's own sample library (hard links; left out of a shared build)
export const TEXTURES = [];

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const DEF = { size: 0.12, density: 18, spray: 0.04, shape: 0.5, pitch: 0, detune: 0, reverse: 0, width: 0.6, smear: 0.25, level: 0.8, rate: 0.25, quant: 0,
  position: 0.3, atk: 0.01, rel: 0.25, res: 0.2 };
// KEYS: the scale its columns are, the key (semitones from the sound as it is), what a finger's height does, glide
const KDEF = { scale: 'MINOR', root: 0, target: 'FILTER', glide: false, oct: 0 };
export const KSCALES = { MINOR: [0, 2, 3, 5, 7, 8, 10], MAJOR: [0, 2, 4, 5, 7, 9, 11], PENTA: [0, 3, 5, 7, 10], CHROM: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const TARGETS = ['FILTER', 'SIZE', 'SPRAY', 'DENSITY'];
const X = { p: { ...DEF }, k: { ...KDEF }, srcRef: null, srcName: '', data: null, hold: false, scan: false };
try { const s = JSON.parse(localStorage.getItem('onion-tex') || 'null'); if (s) { X.p = { ...DEF, ...s.p }; X.k = { ...KDEF, ...s.k }; X.srcRef = s.srcRef; } } catch (e) { /* defaults */ }
const persist = () => { try { localStorage.setItem('onion-tex', JSON.stringify({ p: X.p, k: X.k, srcRef: X.srcRef })); } catch (e) { /* ignore */ } };

/* ------------------------------------------------------------ engine --- */
let node = null, nodeP = null, show = { g: [], scan: -1 }, recording = false;
function engine() {
  if (node) return Promise.resolve(node);
  if (nodeP) return nodeP;
  const c = ac();
  if (!c.audioWorklet) { toast('TEXTURE NEEDS HTTPS (OR LOCALHOST)', 3500); return Promise.reject(new Error('no worklet')); }
  nodeP = c.audioWorklet.addModule('grain-worklet.js').then(() => {
    node = new AudioWorkletNode(c, 'grains', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(out());
    node.port.onmessage = e => {
      if (e.data.type === 'show') { show = e.data; if (X.scan) X.p.position = e.data.position; }
      if (e.data.type === 'rec') saveRec(e.data.data);
    };
    node.port.postMessage({ type: 'p', p: X.p });
    if (X.data) node.port.postMessage({ type: 'buf', data: X.data.slice() });
    return node;
  });
  return nodeP;
}
const send = m => { if (node) node.port.postMessage(m); };
const sendP = () => send({ type: 'p', p: X.p });

/* ------------------------------------------------------------ source --- */
async function decode(ab) {
  const buf = await ac().decodeAudioData(ab), n = buf.length, o = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) o[i] += d[i] / buf.numberOfChannels; }
  return o;
}
function setData(data, name, ref) {
  X.data = data; X.srcName = name; X.srcRef = ref;
  $('texName').textContent = name;
  $('texLen').textContent = (data.length / SR).toFixed(1) + 'S';
  send({ type: 'buf', data: data.slice() });
  persist(); drawWave(); drawRail(); allRows.forEach(r => r.redraw());   // (SPRAY reads in ms of this sound)
}
async function loadRef(ref) {
  try {
    if (ref.kind === 'break') { const b = BREAKS.find(x => x.url === ref.url); setData(await decode(await (await fetch(ref.url)).arrayBuffer()), b ? b.name : 'BREAK', ref); }
    else if (ref.kind === 'tex') { const t = TEXTURES.find(x => x.url === ref.url); setData(await decode(await (await fetch(ref.url)).arrayBuffer()), t ? t.name : 'TEXTURE', ref); }
    else if (ref.kind === 'lib') { const it = await libGet(ref.id); if (it) setData(await decode(await it.wav.arrayBuffer()), it.name, ref); }
  } catch (e) { toast('CANNOT LOAD THAT'); }
}
const id36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const peaksOf = (d, n = 48) => Array.from({ length: n }, (_, i) => { let m = 0; for (let j = Math.floor(i * d.length / n); j < Math.floor((i + 1) * d.length / n); j++) m = Math.max(m, Math.abs(d[j])); return +m.toFixed(3); });
async function importFile(file) {
  try {
    const ab = await file.arrayBuffer(), data = await decode(ab.slice(0)), id = id36();
    const name = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 28);
    await libAdd({ id, name, kind: 'import', created: Date.now(), sr: SR, ms: Math.round(data.length / SR * 1000), note: '', peaks: peaksOf(data), wav: new Blob([ab], { type: file.type || 'audio/wav' }) });
    setData(data, name, { kind: 'lib', id });
    toast('IN THE LIBRARY: ' + name);
  } catch (e) { toast('CANNOT READ ' + file.name.toUpperCase()); }
}
async function openPicker() {
  const box = $('texPickList');
  box.innerHTML = '';
  const add = (label, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `<span>${label}</span><small>${sub}</small>`;
    b.onclick = () => { $('texPick').classList.remove('on'); fn(); };
    box.appendChild(b);
  };
  add('FILES…', 'WAV · MP3 · AIFF · M4A', () => $('texFile').click());
  (await libAll()).forEach(it => add(it.name, it.kind.toUpperCase() + ' · ' + it.ms + ' MS', () => loadRef({ kind: 'lib', id: it.id })));
  TEXTURES.forEach(t => add(t.name, 'TEXTURE', () => loadRef({ kind: 'tex', url: t.url })));
  BREAKS.forEach(b => add(b.name, 'BREAK', () => loadRef({ kind: 'break', url: b.url })));
  $('texPick').classList.add('on');
}
// the mic, raw: what it hears becomes the sound (and goes into the library)
let mic = null;
async function micToggle() {
  if (mic) { mic.mr.stop(); return; }
  if (!window.isSecureContext) { toast('THE MIC NEEDS HTTPS: OPEN THE HTTPS ADDRESS', 3500); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('THIS BROWSER GIVES NO MIC HERE', 3500); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch (e) { toast(e.name === 'NotAllowedError' ? 'MIC BLOCKED: IPHONE SETTINGS > THE BROWSER > MICROPHONE' : 'MIC: ' + (e.name || 'ERROR').toUpperCase(), 5000); return; }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined), chunks = [], t0 = Date.now();
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(mic.tick); mic = null;
    $('texRec').classList.remove('on'); $('texRec').textContent = '● MIC';
    try {
      const data = await decode(await new Blob(chunks, { type: mr.mimeType || type }).arrayBuffer());
      const all = await libAll(), name = 'REC ' + String(all.filter(x => x.kind === 'rec').length + 1).padStart(3, '0'), id = id36();
      await libAdd({ id, name, kind: 'rec', created: Date.now(), sr: SR, ms: Math.round(data.length / SR * 1000), note: '', peaks: peaksOf(data), wav: toWav(data) });
      setData(data, name, { kind: 'lib', id });
    } catch (e) { toast('RECORDING FAILED'); }
  };
  mr.start();
  mic = { mr, tick: setInterval(() => { $('texRec').textContent = '■ ' + ((Date.now() - t0) / 1000).toFixed(1) + 'S'; }, 100) };
  $('texRec').classList.add('on');
}
// RESAMPLE: what comes out, into the library
async function saveRec(data) {
  if (!data || data.length < SR * 0.1) { toast('TOO SHORT'); return; }
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak < 1e-4) { toast('NOTHING WAS PLAYING'); return; }
  const all = await libAll(), name = 'TEX ' + String(all.filter(x => x.kind === 'texture').length + 1).padStart(3, '0');
  await libAdd({ id: id36(), name, kind: 'texture', created: Date.now(), sr: SR, ms: Math.round(data.length / SR * 1000), note: X.srcName, peaks: peaksOf(data), wav: toWav(data) });
  toast('RESAMPLED: ' + name);
}

/* -------------------------------------------------------- the surface --- */
const allRows = [];
const voices = new Map();                                 // pointer id -> {x, y} (where the finger is, 0..1)
const held = new Map();                                   // HOLD: voices left sounding
const sizeOf = y => Math.pow(2, (y - 0.5) * 3.4);         // up: small grains (x0.3), down: long ones (x3.2)
let raf = 0;
function drawWave() {
  const c = $('texWave');
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // size guides: up small, down long
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, 'rgba(185,162,240,.10)'); grd.addColorStop(1, 'rgba(185,162,240,.28)');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  if (X.data) {
    const d = X.data, n = d.length, mid = h / 2;
    g.fillStyle = 'rgba(244,169,112,.85)';
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(x / w * n); i < Math.floor((x + 1) / w * n); i += 2) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.fillRect(x, mid - hi * (mid - 8), 1, Math.max(1, (hi - lo) * (mid - 8)));
    }
  } else { g.fillStyle = css('--muted'); g.font = '11px Silkscreen, monospace'; g.fillText('NO SOUND · CHOOSE ONE ABOVE', 12, h / 2); }
  // POSITION (where the keys take their grains), its SPRAY around it
  const px = X.p.position * w, sw = X.p.spray * w;
  g.fillStyle = 'rgba(122,95,200,.14)'; g.fillRect(px - sw, 0, sw * 2, h);
  g.fillStyle = css('--purple-d'); g.fillRect(px - 1, 0, 2, h);
  g.beginPath(); g.moveTo(px - 7, 0); g.lineTo(px + 7, 0); g.lineTo(px, 9); g.fill();
  // the grains: a dot each, where in the sound it is now
  g.fillStyle = 'rgba(122,95,200,.55)';
  show.g.forEach((p, i) => { g.beginPath(); g.arc(p * w, h * (0.15 + ((i * 37) % 70) / 100), 2.5, 0, 7); g.fill(); });
  if (show.scan >= 0) { g.fillStyle = css('--purple-d'); g.fillRect(show.scan * w - 1, 0, 2, h); }
  // the fingers (and the held voices)
  const ring = (v, held) => {
    const s = sizeOf(v.y), r = 10 + s * 8;
    g.strokeStyle = held ? css('--purple-d') : css('--acc'); g.lineWidth = 3;
    g.beginPath(); g.arc(v.x * w, v.y * h, r, 0, 7); g.stroke();
    g.fillStyle = held ? 'rgba(122,95,200,.25)' : 'rgba(255,138,76,.25)'; g.fill();
    g.fillRect(v.x * w - 1, 0, 2, h);
  };
  held.forEach(v => { if (!v.key) ring(v, true); });
  voices.forEach(v => ring(v, false));
}
function loop() {
  drawWave(); drawRail(); drawKeys();
  raf = (voices.size || held.size || X.scan || keyF.size || trails.length) ? requestAnimationFrame(loop) : 0;
  if (!raf) { show = { g: [], scan: -1 }; drawWave(); drawKeys(); }
}
const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
function surface() {
  const c = $('texWave');
  const at = e => { const r = c.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
  const voice = (id, v, on) => send({ type: 'v', id, on, pos: v.x, size: sizeOf(v.y) });
  c.addEventListener('pointerdown', async e => {
    e.preventDefault();
    if (!X.data) { openPicker(); return; }
    try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    const v = at(e);
    voices.set(e.pointerId, v);
    await engine().catch(() => null);
    if (voices.has(e.pointerId)) voice('f' + e.pointerId, voices.get(e.pointerId), true);
    kick();
  });
  c.addEventListener('pointermove', e => {
    if (!voices.has(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { up(e); return; }
    const v = at(e);
    voices.set(e.pointerId, v);
    voice('f' + e.pointerId, v, true);
  });
  function up(e) {
    const v = voices.get(e.pointerId);
    if (!v) return;
    voices.delete(e.pointerId);
    if (X.hold) {                                         // HOLD: it stays, as a voice of its own
      const id = 'h' + Date.now() + e.pointerId;
      held.set(id, v);
      voice(id, v, true);
      voice('f' + e.pointerId, v, false);
      $('texHoldN').textContent = held.size;
    } else voice('f' + e.pointerId, v, false);
  }
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
}
/* ------------------------------------------------- the rail and KEYS --- */
// the rail: the whole sound small, POSITION on it as a flag; drag it there (no sound)
function drawRail() {
  const c = $('texRail');
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = css('--purple-xl'); g.fillRect(0, 0, w, h);
  if (X.data) {
    const d = X.data, n = d.length;
    g.fillStyle = 'rgba(185,162,240,.7)';
    for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.floor(x / w * n); i < Math.floor((x + 1) / w * n); i += 8) m = Math.max(m, Math.abs(d[i])); g.fillRect(x, h / 2 - m * (h / 2 - 3), 1, Math.max(1, m * (h - 6))); }
  }
  const px = X.p.position * w;
  g.fillStyle = 'rgba(122,95,200,.25)'; g.fillRect(px - X.p.spray * w, 0, X.p.spray * w * 2, h);
  g.fillStyle = css('--purple-d'); g.fillRect(px - 1.5, 0, 3, h);
  g.beginPath(); g.arc(px, h / 2, 7, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.font = '8px Silkscreen, monospace'; g.fillText('POSITION', 6, 10);
}
function rail() {
  const c = $('texRail');
  let on = false;
  const set = e => { const r = c.getBoundingClientRect(); X.p.position = clamp((e.clientX - r.left) / r.width, 0, 1); sendP(); drawRail(); drawWave(); };
  c.addEventListener('pointerdown', e => { e.preventDefault(); on = true; try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } set(e); });
  c.addEventListener('pointermove', e => { if (on) set(e); });
  const end = () => { if (on) { on = false; persist(); } };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
}
// KEYS: across, the scale's notes over two octaves (from the key); up / down, the expression (TARGET). A finger is a
// voice at that pitch, from POSITION, with its own filter; GLIDE: between the notes too
const keyF = new Map(), trails = [];
const notesOf = () => { const sc = KSCALES[X.k.scale], out = []; for (let o = 0; o < 2; o++) sc.forEach(v => out.push(v + 12 * o)); out.push(24); return out.map(v => v + X.k.root + 12 * X.k.oct); };
const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function keyVoice(id, f, on) {
  const notes = notesOf(), cols = notes.length, fx = f.x * cols - 0.5;
  let st;
  if (X.k.glide) { const i = clamp(Math.floor(fx), 0, cols - 2), t = clamp(fx - i, 0, 1); st = notes[i] + (notes[i + 1] - notes[i]) * t; }
  else st = notes[clamp(Math.round(fx), 0, cols - 1)];
  f.st = st;
  const y = 1 - f.y, m = { type: 'v', id, on, st, pos: null };
  if (X.k.target === 'FILTER') m.cut = 0.15 + y * 0.85;
  else if (X.k.target === 'SIZE') m.size = Math.pow(2, (y - 0.5) * 3.4);
  else if (X.k.target === 'SPRAY') m.spray = y * 4;
  else m.dens = 0.2 + y * 2.8;
  send(m);
}
function drawKeys() {
  const c = $('texKeys');
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#34264f'); bg.addColorStop(1, '#1b1428');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const notes = notesOf(), cols = notes.length, cw = w / cols, hot = new Map();
  keyF.forEach(f => { const i = clamp(Math.round(f.x * cols - 0.5), 0, cols - 1); hot.set(i, Math.max(hot.get(i) || 0, 1 - f.y)); });
  notes.forEach((v, i) => {
    const root = ((v - X.k.root) % 12 + 12) % 12 === 0, x = i * cw;
    if (hot.has(i)) { const gr = g.createLinearGradient(0, h, 0, 0); gr.addColorStop(0, 'rgba(255,138,76,.55)'); gr.addColorStop(1, 'rgba(255,138,76,0)'); g.fillStyle = gr; g.fillRect(x + 1, 0, cw - 2, h); }
    else if (root) { g.fillStyle = 'rgba(185,162,240,.16)'; g.fillRect(x + 1, 0, cw - 2, h); }
    g.fillStyle = root ? 'rgba(217,204,255,.55)' : 'rgba(217,204,255,.14)'; g.fillRect(x, 0, 1, h);
    g.fillStyle = root ? '#d9ccff' : 'rgba(217,204,255,.55)'; g.font = (root ? '9px' : '8px') + ' Silkscreen, monospace';
    g.fillText((v > 0 ? '+' : '') + v, x + 3, h - 6);
  });
  // the expression: a faint scale up the side
  g.fillStyle = 'rgba(217,204,255,.35)'; g.font = '8px Silkscreen, monospace';
  g.fillText(X.k.target + ' ▲', w - 70, 12);
  // trails and the fingers
  for (let i = trails.length - 1; i >= 0; i--) { const t = trails[i]; t.a -= 0.05; if (t.a <= 0) { trails.splice(i, 1); continue; } g.fillStyle = `rgba(255,170,110,${t.a * 0.5})`; g.beginPath(); g.arc(t.x * w, t.y * h, 3 + (1 - t.a) * 10, 0, 7); g.fill(); }
  keyF.forEach(f => {
    const x = f.x * w, y = f.y * h;
    g.shadowColor = '#ff8a4c'; g.shadowBlur = 22;
    g.fillStyle = '#ffb07a'; g.beginPath(); g.arc(x, y, 16, 0, 7); g.fill(); g.shadowBlur = 0;
    g.fillStyle = '#fff3e6'; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,243,230,.85)'; g.fillRect(x - 1, y + 16, 2, h - y - 16);
    g.font = '10px Silkscreen, monospace'; g.fillText((f.st > 0 ? '+' : '') + (Math.round(f.st * 10) / 10), x - 12, y - 22);
  });
}
function keys() {
  const c = $('texKeys');
  const at = e => { const r = c.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 0.999), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
  c.addEventListener('pointerdown', async e => {
    e.preventDefault();
    if (!X.data) { openPicker(); return; }
    try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    keyF.set(e.pointerId, at(e));
    await engine().catch(() => null);
    const f = keyF.get(e.pointerId);
    if (f) keyVoice('k' + e.pointerId, f, true);
    kick();
  });
  c.addEventListener('pointermove', e => {
    const f = keyF.get(e.pointerId);
    if (!f) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(e); return; }
    Object.assign(f, at(e));
    trails.push({ x: f.x, y: f.y, a: 1 }); if (trails.length > 60) trails.shift();
    keyVoice('k' + e.pointerId, f, true);
  });
  function end(e) {
    const f = keyF.get(e.pointerId);
    if (!f) return;
    keyF.delete(e.pointerId);
    if (X.hold) { const id = 'h' + Date.now() + e.pointerId; held.set(id, { x: X.p.position, y: 0.5, key: true }); keyVoice(id, f, true); $('texHoldN').textContent = held.size; }
    send({ type: 'v', id: 'k' + e.pointerId, on: false });
    kick();
  }
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
}
function drawKeyCtl() {
  [...$('texScale').children].forEach(b => b.classList.toggle('on', b.dataset.s === X.k.scale));
  [...$('texTarget').children].forEach(b => b.classList.toggle('on', b.dataset.t === X.k.target));
  $('texGlide').classList.toggle('on', X.k.glide);
  $('texOct').textContent = (X.k.oct > 0 ? '+' : '') + X.k.oct;
  drawKeys();
}
function releaseHeld() { held.forEach((v, id) => send({ type: 'v', id, on: false })); held.clear(); $('texHoldN').textContent = '0'; drawWave(); }

/* -------------------------------------------------------------- build --- */
export function initTexture() {
  const P = X.p, ms = v => (v >= 1 ? v.toFixed(2) + 'S' : Math.round(v * 1000) + 'MS'), pct = v => Math.round(v * 100) + '%';
  const st = v => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' ST';
  const R = (k, label, min, max, fmt, extra = {}) => row({ label, min, max, def: DEF[k], get: () => P[k], set: v => { P[k] = v; sendP(); }, fmt, onRelease: persist, ...extra });
  const sec = (id, rows) => rows.forEach(r => { $(id).appendChild(r); allRows.push(r); });
  sec('texGrains', [R('size', 'SIZE', 0.005, 1.5, ms, { log: true }), R('density', 'DENSITY', 1, 120, v => Math.round(v) + ' /S', { log: true }),
    R('spray', 'SPRAY', 0, 0.5, v => (v * (X.data ? X.data.length / SR : 1) * 1000 | 0) + 'MS'), R('shape', 'SHAPE', 0, 1, v => (v < 0.2 ? 'SOFT' : v > 0.8 ? 'HARD' : pct(v)))]);
  sec('texPitch', [R('pitch', 'PITCH', -24, 24, st, { bipolar: true }), R('detune', 'RANDOM PITCH', 0, 24, v => '±' + (Math.round(v * 10) / 10) + ' ST'),
    R('quant', 'KEEP ON', 0, 12, v => ({ 0: 'FREE', 1: 'SEMITONES', 5: 'FOURTHS', 7: 'FIFTHS', 12: 'OCTAVES' }[v] || v + ' ST'), { int: true }),
    R('reverse', 'REVERSE', 0, 1, pct)]);
  sec('texScan', [R('rate', 'SPEED', -2, 2, v => (Math.abs(v) < 0.005 ? 'FROZEN' : (v > 0 ? '' : '−') + 'x' + Math.abs(v).toFixed(2)), { bipolar: true })]);
  sec('texAmp', [R('atk', 'ATTACK', 0.002, 4, ms, { log: true }), R('rel', 'RELEASE', 0.01, 8, ms, { log: true }), R('res', 'FILTER RESO', 0, 1, pct),
    R('position', 'POSITION', 0, 1, pct, { onMove: () => { drawRail(); drawWave(); } })]);
  $('texKeyRows').appendChild(row({ label: 'KEY', min: -12, max: 12, def: 0, int: true, get: () => X.k.root, set: v => { X.k.root = v; }, fmt: v => (v > 0 ? '+' : '') + v + ' ST', onMove: drawKeys, onRelease: persist }));
  $('texScale').innerHTML = Object.keys(KSCALES).map(k => `<button data-s="${k}">${k}</button>`).join('');
  $('texTarget').innerHTML = TARGETS.map(k => `<button data-t="${k}">${k}</button>`).join('');
  $('texScale').querySelectorAll('button').forEach(b => b.onclick = () => { X.k.scale = b.dataset.s; persist(); drawKeyCtl(); });
  $('texTarget').querySelectorAll('button').forEach(b => b.onclick = () => { X.k.target = b.dataset.t; persist(); drawKeyCtl(); });
  $('texGlide').onclick = () => { X.k.glide = !X.k.glide; persist(); drawKeyCtl(); };
  $('texOctDn').onclick = () => { X.k.oct = Math.max(-2, X.k.oct - 1); persist(); drawKeyCtl(); };
  $('texOctUp').onclick = () => { X.k.oct = Math.min(2, X.k.oct + 1); persist(); drawKeyCtl(); };
  sec('texSpace', [R('width', 'WIDTH', 0, 1, pct), R('smear', 'SMEAR', 0, 1, pct), R('level', 'LEVEL', 0, 1.5, pct)]);
  $('texSource').onclick = openPicker;
  $('texAdd').onclick = () => $('texFile').click();
  $('texFile').onchange = e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
  $('texRec').onclick = micToggle;
  $('texPickClose').onclick = () => $('texPick').classList.remove('on');
  $('texHold').onclick = () => { X.hold = !X.hold; $('texHold').classList.toggle('on', X.hold); if (!X.hold) releaseHeld(); };
  $('texFree').onclick = releaseHeld;
  $('texScanBtn').onclick = async () => {
    if (!X.data) { openPicker(); return; }
    await engine().catch(() => null);
    X.scan = !X.scan; send({ type: 'scan', on: X.scan });
    $('texScanBtn').classList.toggle('on', X.scan); $('texScanBtn').textContent = X.scan ? '■ SCAN' : '▶ SCAN';
    kick();
  };
  $('texResample').onclick = async () => {
    await engine().catch(() => null);
    if (!node) return;
    recording = !recording;
    send({ type: 'rec', on: recording });
    $('texResample').classList.toggle('rec', recording);
    $('texResample').textContent = recording ? '■ STOP · SAVE' : '● RESAMPLE';
  };
  surface(); rail(); keys(); drawKeyCtl();
  window.addEventListener('resize', () => { drawWave(); drawRail(); drawKeys(); });
  if (X.srcRef) loadRef(X.srcRef); else loadRef(TEXTURES[0] ? { kind: 'tex', url: TEXTURES[0].url } : { kind: 'break', url: BREAKS[0].url });
}
export function textureShown() { requestAnimationFrame(() => { drawWave(); drawRail(); drawKeys(); }); }
export function textureStop() {                          // leaving the page: the fingers' voices go (held ones and SCAN stay)
  voices.forEach((v, id) => send({ type: 'v', id: 'f' + id, on: false })); voices.clear();
  keyF.forEach((v, id) => send({ type: 'v', id: 'k' + id, on: false })); keyF.clear();
}
export function textureLoad(id) { loadRef({ kind: 'lib', id }); }
