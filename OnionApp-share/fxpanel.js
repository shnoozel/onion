// the send FX panel for a channel: a picture of the three spaces (the reverb's tail, the delay's echoes left and
// right, the chorus's two sweeping voices) with the sound coming back from them drawn live over it, then how much of
// the channel goes to each (the sends) and how each one sounds (shared by every channel)
import { FX, DLY_DIVS, setFx, setSend, getSend, fxAnalyser, T, onPlay } from './audio.js';
import { row } from './ui.js';

const DIV_NAMES = ['1/16', '1/8', '3/16', '1/4', '3/8', '1/2'];

export function fxPanel(host, id) {
  host.innerHTML = '<canvas class="fx-view"></canvas><div class="fx-sends rows"></div><div class="fx-groups"></div>';
  const cv = host.querySelector('canvas'), sends = host.querySelector('.fx-sends'), groups = host.querySelector('.fx-groups');
  const pct = v => Math.round(v * 100) + '%';
  const send = (k, label) => row({ label, min: 0, max: 1, def: 0, get: () => getSend(id, k), set: v => setSend(id, k, v), fmt: v => (v < 0.005 ? 'OFF' : pct(v)), onMove: draw });
  [send('rev', 'REVERB'), send('dly', 'DELAY'), send('cho', 'CHORUS')].forEach(r => { r.classList.add('send'); sends.appendChild(r); });
  const fxr = (k, label, min, max, fmt, extra = {}) => row({ label, min, max, def: FX[k], get: () => FX[k], set: v => setFx(k, v), fmt, onMove: draw, ...extra });
  const group = (title, rows) => { const g = document.createElement('div'); g.className = 'fx-group'; g.innerHTML = `<div class="fx-gt">${title}</div>`; rows.forEach(r => g.appendChild(r)); groups.appendChild(g); };
  group('REVERB', [fxr('size', 'SIZE', 0.4, 8, v => v.toFixed(1) + 'S'), fxr('damp', 'DAMP', 0, 1, pct)]);
  group('DELAY', [fxr('div', 'TIME', 0, DLY_DIVS.length - 1, v => DIV_NAMES[Math.round(v)], { int: true }), fxr('fb', 'FEEDBACK', 0, 0.92, pct), fxr('tone', 'TONE', 0, 1, v => (v < 0.3 ? 'DARK' : v > 0.75 ? 'BRIGHT' : pct(v)))]);
  group('CHORUS', [fxr('rate', 'RATE', 0.05, 4, v => v.toFixed(2) + ' HZ', { log: true }), fxr('depth', 'DEPTH', 0, 1, pct)]);

  let live = null, raf = 0, t0 = performance.now();
  function draw() {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d'), t = (performance.now() - t0) / 1000;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#2e2145'); bg.addColorStop(1, '#1d1530');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    const third = w / 3, mid = h / 2 + 6;
    g.font = '8px Silkscreen, monospace';
    const label = (x, s, on) => { g.fillStyle = on ? '#d9ccff' : '#6d5c9c'; g.fillText(s, x + 8, 13); };
    // REVERB: a tail as long as SIZE (8 s fills it), darker as it dies by DAMP, as tall as the send
    const rs = getSend(id, 'rev'), len = Math.sqrt(Math.min(1, FX.size / 8)) * (third - 16);
    label(0, 'REVERB', rs > 0.005);
    const grd = g.createLinearGradient(8, 0, 8 + len, 0);
    grd.addColorStop(0, `rgba(185,162,240,${0.25 + rs * 0.7})`); grd.addColorStop(1, `rgba(${185 - FX.damp * 120},${162 - FX.damp * 110},240,0)`);
    g.fillStyle = grd; g.beginPath(); g.moveTo(8, mid);
    for (let x = 0; x <= len; x += 2) { const e = Math.exp(-x / len * 3) * (0.2 + rs * 0.8) * (h * 0.4), j = Math.sin(x * 0.9 + t * 3) * 1.5 * rs; g.lineTo(8 + x, mid - e - j); }
    for (let x = len; x >= 0; x -= 2) { const e = Math.exp(-x / len * 3) * (0.2 + rs * 0.8) * (h * 0.4); g.lineTo(8 + x, mid + e); }
    g.fill();
    // DELAY: the echoes, a step of TIME apart, left (up) and right (down), each FEEDBACK quieter
    const ds = getSend(id, 'dly'), sp = (third - 20) / 14 * DLY_DIVS[FX.div];
    label(third, 'DELAY · ' + DIV_NAMES[FX.div], ds > 0.005);
    let a = 0.15 + ds * 0.85;
    for (let k = 0, x = third + 10; x < 2 * third - 6 && a > 0.03; k++, x += Math.max(6, sp)) {
      const bh = a * h * 0.4, up = k % 2 === 0;
      g.fillStyle = `rgba(255,${138 + FX.tone * 80},${76 + FX.tone * 60},${0.35 + a * 0.6})`;
      g.fillRect(x, up ? mid - bh : mid, Math.max(4, Math.min(14, sp * 0.5)), bh);
      a *= FX.fb;
    }
    g.fillStyle = 'rgba(217,204,255,.25)'; g.fillRect(third + 6, mid, third - 12, 1);
    // CHORUS: two voices sweeping apart, RATE fast, DEPTH wide
    const cs = getSend(id, 'cho');
    label(2 * third, 'CHORUS', cs > 0.005);
    for (const [ph, col] of [[0, '#b9a2f0'], [2.1, '#ff8a4c']]) {
      g.strokeStyle = col; g.globalAlpha = 0.35 + cs * 0.65; g.lineWidth = 2; g.beginPath();
      for (let x = 0; x < third - 16; x += 2) { const y = mid + Math.sin(x * 0.08 + t * FX.rate * 6 + ph) * (4 + FX.depth * h * 0.28); x ? g.lineTo(2 * third + 8 + x, y) : g.moveTo(2 * third + 8, y); }
      g.stroke();
    }
    g.globalAlpha = 1;
    // what comes back, live
    const an = fxAnalyser();
    if (an && T.playing) {
      live = live || new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(live);
      g.strokeStyle = 'rgba(255,243,230,.75)'; g.lineWidth = 1.5; g.shadowColor = '#ff8a4c'; g.shadowBlur = 8; g.beginPath();
      for (let i = 0; i < live.length; i++) { const x = i / live.length * w, y = h - 14 - live[i] * 40; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke(); g.shadowBlur = 0;
    }
    g.strokeStyle = 'rgba(217,204,255,.12)'; g.beginPath(); g.moveTo(third, 18); g.lineTo(third, h - 4); g.moveTo(2 * third, 18); g.lineTo(2 * third, h - 4); g.stroke();
  }
  const loop = () => { draw(); raf = T.playing && host.offsetParent ? requestAnimationFrame(loop) : 0; };
  onPlay(on => { if (on && !raf) raf = requestAnimationFrame(loop); });
  window.addEventListener('resize', draw);
  return { draw: () => { draw(); if (T.playing && !raf) raf = requestAnimationFrame(loop); } };
}
