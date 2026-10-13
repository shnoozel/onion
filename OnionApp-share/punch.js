// the PUNCH screen, SLOOP-style: 16 effects on the master; hold a pad and it plays, let go and it stops, double tap:
// latched until tapped again. REC writes what you hold into the PUNCH lane (32 sixteenths, two bars) while the music
// plays, and the lane plays it back at the exact steps, every time round
import { ac, T, punchMsg, onPunch, onPlay, onTempo, stepAt, stepDur } from './audio.js';
import { toast } from './ui.js';

const $ = id => document.getElementById(id);
export const FX = ['LOOP 1/4', 'LOOP 1/8', 'LOOP 1/16', 'LOOP 1/32', 'STUTTER', 'REVERSE', 'TAPE STOP', 'HALF', 'LPF', 'HPF', 'PHONE', 'CRUSH',
  'GATE', 'ECHO', 'FREEZE', 'WOBBLE'];
const SHORT = ['L4', 'L8', 'L16', 'L32', 'ST', 'RV', 'TP', 'HF', 'LP', 'HP', 'PH', 'CR', 'GT', 'EC', 'FZ', 'WB'];
const ROWC = ['--acc', '--yel', '--soft', '--lilac'];      // a colour a row
const LANE = 32;
let lane = new Array(LANE).fill(-1), live = -1, latched = -1, rec = false, held = [];
try { const l = JSON.parse(localStorage.getItem('onion-punch') || 'null'); if (Array.isArray(l) && l.length === LANE) lane = l; } catch (e) { /* none */ }
const save = () => { try { localStorage.setItem('onion-punch', JSON.stringify(lane)); } catch (e) { /* ignore */ } };

function setLive(fx) {
  live = fx;
  punchMsg({ type: 'live', fx });
  drawPads();
}
function press(i) {                                       // the newest held pad wins; letting it go returns to the one before
  ac();
  held = held.filter(x => x !== i); held.push(i);
  setLive(i);
}
function release(i) {
  held = held.filter(x => x !== i);
  if (live === i) setLive(held.length ? held[held.length - 1] : latched);
}
function drawPads() {
  [...$('punchPads').children].forEach((b, i) => {
    b.classList.toggle('on', i === live);
    b.classList.toggle('latch', i === latched);
  });
  $('punchNow').textContent = live >= 0 ? FX[live] : sounding >= 0 ? FX[sounding] : '—';
  $('fxBtn').classList.toggle('on', live >= 0 || sounding >= 0);
}
function drawLane(now = -1) {
  [...$('punchLane').children].forEach((c, k) => {
    const f = lane[k];
    c.textContent = f >= 0 ? SHORT[f] : '';
    c.style.background = f >= 0 ? `var(${ROWC[f >> 2]})` : '';
    c.classList.toggle('now', k === now);
    c.classList.toggle('beat', k % 4 === 0);
  });
  $('fxBtn').classList.toggle('has', lane.some(f => f >= 0));
}

/* the lane, played back: the steps a little ahead are sent with their exact times (the worklet starts them on the
 * frame); a held pad wins over it */
let nextM = -1, timer = 0;
function scheduler() {
  if (!T.playing) return;
  const sd = stepDur(), now = ac().currentTime, m0 = Math.floor((now - T.t0) / sd);
  if (nextM < m0) nextM = m0;
  while (T.t0 + nextM * sd < now + 0.15) {
    const k = ((nextM % LANE) + LANE) % LANE;
    if (lane[k] >= 0) punchMsg({ type: 'sched', fx: lane[k], t0: T.t0 + nextM * sd, t1: T.t0 + (nextM + 1) * sd });
    nextM++;
  }
}
function resync() { punchMsg({ type: 'clear' }); nextM = -1; }

let sounding = -1;
function frame() {                                        // REC: what is held goes into the step under the playhead
  const k = stepAt(LANE);
  if (rec && T.playing && live >= 0 && k >= 0 && lane[k] !== live) { lane[k] = live; save(); resync(); }
  if (k !== frame.k) { frame.k = k; drawLane(k); }
  requestAnimationFrame(frame);
}

export function initPunch() {
  const pads = $('punchPads');
  FX.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'ppad';
    b.style.setProperty('--c', `var(${ROWC[i >> 2]})`);
    b.innerHTML = `<span>${name}</span>`;
    let last = 0;
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      const now = Date.now();
      if (now - last < 300) { latched = latched === i ? -1 : i; }   // double tap: latch / unlatch
      last = now;
      press(i);
    });
    const up = e => { if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId); release(i); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    pads.appendChild(b);
  });
  const ln = $('punchLane');
  for (let k = 0; k < LANE; k++) {
    const c = document.createElement('button');
    c.className = 'pcell';
    c.onclick = () => { lane[k] = -1; save(); resync(); drawLane(); };   // a tap on a step: empty
    ln.appendChild(c);
  }
  $('fxBtn').onclick = () => { ac(); $('punch').classList.add('on'); };
  $('punchClose').onclick = () => { $('punch').classList.remove('on'); };
  $('punchRec').onclick = () => {
    rec = !rec; $('punchRec').classList.toggle('on', rec);
    if (rec && !T.playing) toast('PRESS PLAY, THEN HOLD PADS');
  };
  $('punchClear').onclick = () => { lane.fill(-1); save(); resync(); drawLane(); };
  $('punchUnlatch').onclick = () => { latched = -1; held = []; setLive(-1); };
  onPunch(m => { sounding = m.type === 'on' ? m.fx : -1; drawPads(); });
  onPlay(on => { resync(); if (on) { clearInterval(timer); timer = setInterval(scheduler, 25); scheduler(); } else { clearInterval(timer); drawLane(); } });
  onTempo(() => resync());
  drawLane(); drawPads();
  requestAnimationFrame(frame);
}
