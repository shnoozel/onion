// the header's corner: PLAY for everything, a little scope of the master, and the mixer it opens (mute and level of
// every channel of the shared transport)
import { ac, T, channels, toggle, onPlay, setMute, setLevel, analyser } from './audio.js';

const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function buildStrips() {
  const box = $('mixStrips');
  box.innerHTML = '';
  for (const c of channels()) {
    const el = document.createElement('div');
    el.className = 'strip';
    el.innerHTML = `<span class="sname" style="color:var(${c.color || '--text'})">${c.label}</span>
      <input type="range" min="0" max="100" value="${Math.round(c.level * 100)}">
      <button class="mute${c.muted ? ' on' : ''}">${c.muted ? 'MUTED' : 'ON'}</button>`;
    el.querySelector('input').oninput = e => setLevel(c.id, e.target.value / 100);
    const m = el.querySelector('.mute');
    m.onclick = () => { setMute(c.id, !c.muted); m.classList.toggle('on', c.muted); m.textContent = c.muted ? 'MUTED' : 'ON'; drawMuteDots(); };
    box.appendChild(el);
  }
}
function drawMuteDots() {                                  // the little lights under the corner: which channels play
  $('mixDots').innerHTML = channels().map(c => `<i style="background:${c.muted ? 'transparent' : `var(${c.color || '--text'})`}"></i>`).join('');
}
const buf = new Float32Array(1024);
function scopeFrame() {
  for (const id of ['miniScope', 'bigScope']) {
    const cv = $(id);
    if (!cv || !cv.clientWidth) continue;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const an = analyser();
    g.strokeStyle = css('--acc'); g.lineWidth = id === 'miniScope' ? 1.5 : 2;
    g.beginPath();
    if (an && T.playing) {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      while (s < 512 && !(buf[s] < 0 && buf[s + 1] >= 0)) s++;   // a rising zero crossing: the trace stands still
      const n = id === 'miniScope' ? 256 : 512;
      for (let i = 0; i < n; i++) { const x = i / (n - 1) * w, y = h / 2 - buf[s + i] * h * 0.45; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    } else { g.moveTo(0, h / 2); g.lineTo(w, h / 2); }
    g.stroke();
  }
  requestAnimationFrame(scopeFrame);
}
export function initMixer() {
  $('gPlay').onclick = () => { ac(); toggle(); };
  onPlay(on => { $('gPlay').classList.toggle('on', on); $('gPlay').textContent = on ? '■' : '▶'; });
  $('mixBtn').onclick = () => { buildStrips(); $('mixer').classList.toggle('on'); };
  $('mixClose').onclick = () => $('mixer').classList.remove('on');
  drawMuteDots();
  requestAnimationFrame(scopeFrame);
}
