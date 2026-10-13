// the app's one AudioContext, its master bus (a scope taps it), and the shared transport: one tempo, one start time,
// and a looping channel per instrument (KICK, BASS, BREAK, ACID) that the mixer mutes and levels. Every channel renders
// its own loop at the tempo; they all start on the same moment, so they stay in step whatever their lengths
import { SR } from './dsp.js';

let ctx = null, master = null, scope = null, punch = null;
const punchQ = [];                                          // messages for PUNCH before its worklet is loaded
export function ac() {
  if (!ctx) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older iOS */ }
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    master = ctx.createGain();
    scope = ctx.createAnalyser();
    scope.fftSize = 1024;
    master.connect(scope);
    scope.connect(ctx.destination);
    makeFx();
    if (ctx.audioWorklet) {                                 // PUNCH between the master and the scope (a secure page)
      ctx.audioWorklet.addModule('punch-worklet.js').then(() => {
        punch = new AudioWorkletNode(ctx, 'punch', { outputChannelCount: [2] });
        master.disconnect(); master.connect(punch); punch.connect(scope);
        punch.port.onmessage = e => punchFns.forEach(f => f(e.data));
        punch.port.postMessage({ type: 'bpm', v: T.bpm });
        punchQ.splice(0).forEach(m => punch.port.postMessage(m));
      }).catch(() => { /* no PUNCH here */ });
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export const out = () => { ac(); return master; };          // where every sound goes (the scope sees it)
export const analyser = () => (ctx ? scope : null);

/* -------------------------------------------------------- send FX --- */
// three shared spaces every channel can send to (after its fader): REVERB (a tail made here: noise dying away, darker
// as it goes by DAMP), DELAY (ping-pong, in 16ths of the tempo, FEEDBACK through a TONE filter), CHORUS (two delays
// swept by slow LFOs, one each side). They return into the master (so PUNCH comes after them)
export const DLY_DIVS = [1, 2, 3, 4, 6, 8];                  // in 16ths: 1/16 1/8 3/16 1/4 3/8 1/2
export const FX = { size: 2.6, damp: 0.5, div: 3, fb: 0.45, tone: 0.55, rate: 0.6, depth: 0.5 };
try { Object.assign(FX, JSON.parse(localStorage.getItem('onion-fx') || '{}')); } catch (e) { /* defaults */ }
let fx = null;
function irOf(size, damp) {
  const n = Math.round(size * SR), b = ctx.createBuffer(2, n, SR);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n, k = 1 - Math.min(0.97, damp * (0.25 + t * 1.1));   // darker as it dies
      lp += (Math.random() * 2 - 1 - lp) * k;
      d[i] = lp * Math.exp(-t * 6.9) * (i < 64 ? i / 64 : 1);
    }
  }
  return b;
}
function makeFx() {
  const c = ctx, ret = c.createGain();
  ret.connect(master);
  const fxScope = c.createAnalyser(); fxScope.fftSize = 512; ret.connect(fxScope);
  const rev = c.createConvolver(); rev.buffer = irOf(FX.size, FX.damp); rev.connect(ret);
  const revIn = c.createGain(); revIn.connect(rev);
  const dIn = c.createGain(), dL = c.createDelay(4), dR = c.createDelay(4), fb1 = c.createGain(), fb2 = c.createGain(), tone = c.createBiquadFilter(), mg = c.createChannelMerger(2);
  tone.type = 'lowpass';
  dIn.connect(dL); dL.connect(mg, 0, 0); dL.connect(fb1); fb1.connect(tone); tone.connect(dR); dR.connect(mg, 0, 1); dR.connect(fb2); fb2.connect(dL);
  mg.connect(ret);
  const cIn = c.createGain(), c1 = c.createDelay(0.1), c2 = c.createDelay(0.1), cm = c.createChannelMerger(2);
  const l1 = c.createOscillator(), l2 = c.createOscillator(), g1 = c.createGain(), g2 = c.createGain();
  c1.delayTime.value = 0.012; c2.delayTime.value = 0.019;
  l1.connect(g1).connect(c1.delayTime); l2.connect(g2).connect(c2.delayTime); l1.start(); l2.start(c.currentTime + 0.37);
  cIn.connect(c1); cIn.connect(c2); c1.connect(cm, 0, 0); c2.connect(cm, 0, 1); cm.connect(ret);
  fx = { ret, fxScope, rev, ins: { rev: revIn, dly: dIn, cho: cIn }, dL, dR, fb1, fb2, tone, l1, l2, g1, g2 };
  applyFx(true);
  order.forEach(id => { if (chans[id].bus) wireSends(chans[id]); });
}
function applyFx(ir) {
  if (!fx) return;
  const t = ctx.currentTime, s = DLY_DIVS[FX.div] * stepDur();
  if (ir) fx.rev.buffer = irOf(FX.size, FX.damp);
  fx.dL.delayTime.setTargetAtTime(s, t, 0.02); fx.dR.delayTime.setTargetAtTime(s, t, 0.02);
  fx.fb1.gain.setTargetAtTime(FX.fb, t, 0.02); fx.fb2.gain.setTargetAtTime(FX.fb, t, 0.02);
  fx.tone.frequency.setTargetAtTime(400 * Math.pow(40, FX.tone), t, 0.02);
  fx.l1.frequency.setTargetAtTime(FX.rate, t, 0.05); fx.l2.frequency.setTargetAtTime(FX.rate * 1.13, t, 0.05);
  fx.g1.gain.setTargetAtTime(0.0005 + FX.depth * 0.006, t, 0.05); fx.g2.gain.setTargetAtTime(0.0005 + FX.depth * 0.007, t, 0.05);
}
let irT = 0;
export function setFx(k, v) {
  FX[k] = v;
  try { localStorage.setItem('onion-fx', JSON.stringify(FX)); } catch (e) { /* ignore */ }
  if (k === 'size' || k === 'damp') { clearTimeout(irT); irT = setTimeout(() => applyFx(true), 120); } else applyFx(false);
}
export const fxAnalyser = () => (fx ? fx.fxScope : null);
// a channel's own bus: its fader goes here, then the master and its sends
function bus(c) {
  if (!c.bus) { c.bus = ctx.createGain(); c.bus.connect(master); wireSends(c); }
  return c.bus;
}
function wireSends(c) {
  if (!fx || !c.bus) return;
  c.sendG = c.sendG || {};
  for (const k of ['rev', 'dly', 'cho']) {
    if (!c.sendG[k]) { c.sendG[k] = ctx.createGain(); c.bus.connect(c.sendG[k]); c.sendG[k].connect(fx.ins[k]); }
    c.sendG[k].gain.setTargetAtTime(c.sends[k] || 0, ctx.currentTime, 0.02);
  }
}
export function setSend(id, k, v) {
  const c = chans[id];
  if (!c) return;
  c.sends[k] = v;
  if (ctx && c.bus) wireSends(c);
  saveMix();
}
export const getSend = (id, k) => (chans[id] ? chans[id].sends[k] || 0 : 0);

/* ------------------------------------------------------- transport --- */
export const T = { bpm: 132, playing: false, t0: 0 };
try { const b = +localStorage.getItem('onion-bpm'); if (b >= 60 && b <= 220) T.bpm = b; } catch (e) { /* default */ }
const chans = {}, order = [], tempoFns = [], playFns = [];
export const stepDur = () => 60 / T.bpm / 4;
// a channel: id, label, render() -> Float32Array (one loop at T.bpm, at SR). A `cycle` channel renders each time round
// anew, render(n) for the n-th cycle (chance and conditions differ from one to the next): its buffers are queued
// back to back instead of looping one
export function channel(id, label, render, color, cycle) {
  if (!chans[id]) order.push(id);
  let st = {};
  try { st = JSON.parse(localStorage.getItem('onion-mix') || '{}')[id] || {}; } catch (e) { /* none */ }
  chans[id] = { id, label, render, color, cycle: !!cycle, muted: !!st.muted, level: st.level ?? 0.85, src: null, gain: null, dur: 1, srcs: [], sends: st.sends || {} };
}
export const channels = () => order.map(id => chans[id]);
function saveMix() {
  const m = {};
  order.forEach(id => { m[id] = { muted: chans[id].muted, level: chans[id].level, sends: chans[id].sends }; });
  try { localStorage.setItem('onion-mix', JSON.stringify(m)); } catch (e) { /* ignore */ }
}
function startCycle(c, now) {
  c.srcs.forEach(s => { try { s.stop(now + 0.01); } catch (e) { /* ended */ } });
  c.srcs = [];
  const first = c.render(0);
  if (!first || !first.length) return;
  c.dur = first.length / SR;
  const n = Math.max(0, Math.floor((now - T.t0) / c.dur));
  if (!c.gain) { c.gain = ctx.createGain(); c.gain.connect(bus(c)); }
  c.gain.gain.setTargetAtTime(c.muted ? 0 : c.level, now, 0.005);
  queueCycle(c, n, now, now - T.t0 - n * c.dur);
}
function queueCycle(c, n, at, off) {
  const data = c.render(n);
  const b = ctx.createBuffer(1, data.length, SR), s = ctx.createBufferSource();
  b.copyToChannel(data, 0);
  s.buffer = b; s.connect(c.gain);
  s.start(at, Math.max(0, off));
  s.onended = () => { c.srcs = c.srcs.filter(x => x !== s); };
  c.srcs.push(s);
  c.nextN = n + 1; c.nextT = T.t0 + (n + 1) * c.dur;
}
setInterval(() => {                                         // the next cycle of each cycle channel, a little ahead
  if (!T.playing || !ctx) return;
  for (const id of order) {
    const c = chans[id];
    if (c.cycle && c.srcs.length && ctx.currentTime > c.nextT - 0.3) queueCycle(c, c.nextN, c.nextT, 0);
  }
}, 50);
function startChan(c, now) {
  if (c.cycle) { startCycle(c, now); return; }
  const data = c.render();
  if (!data || !data.length) return;
  const b = ctx.createBuffer(1, data.length, SR), s = ctx.createBufferSource(), g = ctx.createGain();
  b.copyToChannel(data, 0);
  s.buffer = b; s.loop = true;
  s.connect(g).connect(bus(c));
  const lvl = c.muted ? 0 : c.level;
  g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(lvl, now + 0.008);
  const off = (((now - T.t0) % b.duration) + b.duration) % b.duration;
  s.start(now, off);
  if (c.src) { const og = c.gain; og.gain.setValueAtTime(og.gain.value, now); og.gain.linearRampToValueAtTime(0, now + 0.008); c.src.stop(now + 0.01); }
  c.src = s; c.gain = g; c.dur = b.duration;
}
const pend = {};
// a channel's sound changed: playing, it restarts at the same place (once a frame at most)
export function refresh(id) {
  if (!T.playing || pend[id] || !chans[id]) return;
  pend[id] = requestAnimationFrame(() => { pend[id] = 0; if (T.playing) startChan(chans[id], ctx.currentTime); });
}
export function play() {
  if (T.playing) return;
  ac();
  T.playing = true;
  const now = ctx.currentTime + 0.03;
  T.t0 = now;
  order.forEach(id => startChan(chans[id], now));
  playFns.forEach(f => f(true));
}
export function stop() {
  if (!T.playing) return;
  T.playing = false;
  order.forEach(id => { const c = chans[id]; if (c.src) { c.src.stop(); c.src = null; } c.srcs.forEach(s => { try { s.stop(); } catch (e) { /* ended */ } }); c.srcs = []; });
  playFns.forEach(f => f(false));
}
export const toggle = () => (T.playing ? stop() : play());
export const onPlay = f => playFns.push(f);
export const onTempo = f => tempoFns.push(f);
// a new tempo: the music keeps its place (the beat it is on), every channel re-rendered at the new speed
export function setBpm(v) {
  const old = stepDur();
  T.bpm = v;
  if (punch) punch.port.postMessage({ type: 'bpm', v });
  try { localStorage.setItem('onion-bpm', String(v)); } catch (e) { /* ignore */ }
  tempoFns.forEach(f => f(v));
  applyFx(false);                                           // the delay keeps to the tempo
  if (T.playing) {
    const now = ctx.currentTime, pos = (now - T.t0) / old;
    T.t0 = now - pos * stepDur();
    order.forEach(id => startChan(chans[id], now));
  }
}
// the 16th the music is on, in a pattern of len steps (-1 stopped)
export function stepAt(len) {
  if (!T.playing || !ctx) return -1;
  const k = Math.floor((ctx.currentTime - T.t0) / stepDur());
  return k < 0 ? -1 : k % len;
}
export function setMute(id, m) {
  const c = chans[id];
  c.muted = m;
  if (c.gain) c.gain.gain.setTargetAtTime(m ? 0 : c.level, ctx.currentTime, 0.01);
  saveMix();
}
export function setLevel(id, l) {
  const c = chans[id];
  c.level = l;
  if (c.gain && !c.muted) c.gain.gain.setTargetAtTime(l, ctx.currentTime, 0.01);
  saveMix();
}
// one loop of a one-shot sound fired on a pattern's steps (tails wrapped round), no normalising: levels stay true
export function renderLane(data, pattern, swing, gain) {
  const st = stepDur() * SR, n = Math.round(st * pattern.length), o = new Float32Array(n);
  if (!data) return o;
  pattern.forEach((on, k) => {
    if (!on) return;
    const at = Math.round(k * st + (k % 2 ? swing * st * 0.5 : 0));
    for (let i = 0; i < data.length; i++) o[(at + i) % n] += data[i] * gain;
  });
  return o;
}
export const hasCtx = () => !!ctx;
const punchFns = [];
export const punchMsg = m => { if (punch) punch.port.postMessage(m); else punchQ.push(m); };
export const onPunch = f => punchFns.push(f);
export const punchReady = () => !!punch || !!(ctx && ctx.audioWorklet);
