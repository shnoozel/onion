// the sequencing core: a track of up to 64 steps that any instrument uses, seen three ways.
// ROLL (when the instrument has one): a piano roll that scrolls both ways; rows are notes (or slices), a tap on the
// grid writes a note there, a note drags up / down (its pitch) and sideways (its step), its right edge drags its length,
// a double tap removes it, a tap selects it (its values below). GRID, the Elektron way: 16 trig keys a page (up to 4
// pages), a tap sets / clears a trig, a long press selects the step. TRACKER, the handheld way: rows, a cursor, a
// D-pad. Under any of them: lanes to draw with a finger (velocity, chance...) and the selected step's values as rows
// (its parameter locks). CHANCE and CONDITION decide, each time round, which trigs play.
import { knob as row, toast } from './ui.js';

const $c = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const NSTEP = 64;
export const CONDS = ['—', '1:2', '2:2', '1:4', '2:4', '3:4', '4:4', '!1:2', '!1:4', '1:8'];
export function condOk(c, n) {
  if (!c) return true;
  const t = CONDS[c], neg = t[0] === '!', [a, b] = t.replace('!', '').split(':').map(Number), hit = n % b === a - 1;
  return neg ? !hit : hit;
}
function rnd(seed) { let s = (seed * 2654435761) >>> 0 || 1; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }
// which trigs of a track play on its n-th time round (n < 0: every trig as written)
export function plays(tr, n, salt = 0) {
  return tr.steps.slice(0, tr.len).map((x, k) => !!x.on && (n < 0 || (condOk(x.cnd, n) && ((x.prb ?? 100) >= 100 || rnd(n * 977 + k * 31 + salt) * 100 < x.prb))));
}

// o: { id, host, fields: [{k, label, short, min, max, step, def, fmt(v), lane, list}], blank(), init(tr), audition(k),
//      changed(), playing(), stepAt(len), drawCtx(g, w, h, k, col), defaults: {len}, editor(el, api) -> redraw (an
//      instrument's own editor for the selected step, above its rows),
// a field with lock: true is a parameter lock, the Digitakt way: null (its def) = the track's own value (inherit()),
//      a value = this trig's own
//      roll: { field, min, max (numbers or functions), asc (lowest row on top), label(v), head(v, el) (draws the row's head),
//              shade(v) -> 'root'|'black'|'', show(v) -> bool, len: field | null, mark(x) -> text } }
export function makeSeq(o) {
  const F = [...o.fields, { k: 'prb', label: 'CHANCE', short: 'PRB', min: 0, max: 100, step: 5, def: 100, lane: true, fmt: v => (v >= 100 ? '---' : v + '%') },
    { k: 'cnd', label: 'CONDITION', short: 'CND', list: CONDS, def: 0, fmt: v => CONDS[v] }];
  const blank = () => { const b = { on: 0 }; F.forEach(f => { b[f.k] = f.def; }); return Object.assign(b, o.blank ? o.blank() : {}); };
  const tr = { len: o.defaults?.len || 16, steps: Array.from({ length: NSTEP }, blank), page: 0, view: o.roll ? 'roll' : 'grid',
    lane: F.find(f => f.lane).k, sel: 0, col: 0, clip: null };
  try {
    const s = JSON.parse(localStorage.getItem('onion-seq-' + o.id) || 'null');
    if (s) { tr.len = s.len; (s.steps || []).forEach((x, i) => { if (i < NSTEP) tr.steps[i] = { ...blank(), ...x }; }); tr.view = s.view || tr.view; tr.lane = s.lane || tr.lane; tr.zoom = s.zoom || 1; tr.tall = !!s.tall; }
    else if (o.init) o.init(tr);
  } catch (e) { /* defaults */ }
  if (!o.roll && tr.view === 'roll') tr.view = 'grid';
  const hist = [];
  const save = () => { try { localStorage.setItem('onion-seq-' + o.id, JSON.stringify({ len: tr.len, steps: tr.steps, view: tr.view, lane: tr.lane, zoom: tr.zoom, tall: tr.tall })); } catch (e) { /* ignore */ } };
  const push = () => { hist.push(JSON.stringify(tr.steps)); if (hist.length > 40) hist.shift(); };
  const changed = () => { save(); o.changed && o.changed(); };
  const fmt = (f, x) => (f.lock && x[f.k] == null ? '—' : f.fmt ? f.fmt(x[f.k]) : String(x[f.k]));
  const hear = k => { if (o.audition && !o.playing() && tr.steps[k].on) o.audition(k); };

  /* ---- the frame: the view switch, the views, then the lanes and the step's values (for every view) */
  const VIEWS = o.roll ? ['roll', 'grid', 'tracker'] : ['grid', 'tracker'];
  const root = $c('div', 'sq');
  root.innerHTML = `<div class="sq-head"><div class="seg sq-sw">${VIEWS.map(v => `<button data-v="${v}">${v.toUpperCase()}</button>`).join('')}</div>
    <div class="bpm sq-len"><span class="lab">LEN</span><span class="num"></span></div><button class="tog sq-undo">UNDO</button></div>
    <div class="views"><div class="vtrack" style="width:${VIEWS.length * 100}%">${VIEWS.map(v => `<div class="vpane sq-${v}" style="width:${100 / VIEWS.length}%"></div>`).join('')}</div></div>
    <div class="sq-edit"><div class="sq-screen"><div class="scr-top"><button class="scr-btn sq-prev">◀</button><div class="sq-ename"></div>
    <button class="scr-btn sq-next">▶</button><button class="scr-btn sq-hear">♪</button><button class="scr-btn sq-del">✕</button></div>
    <div class="scr-wheels"></div></div><div class="sq-extra"></div><div class="sq-erows"></div></div>
    <div class="sq-lanes"></div><div class="lanebars"></div>`;
  o.host.appendChild(root);
  const views = root.querySelector('.views'), vtrack = root.querySelector('.vtrack');
  // the box is as tall as the view shown (not the tallest of the three), following it as it changes
  const fitViews = () => { const p = vtrack.children[VIEWS.indexOf(tr.view)]; if (p && p.offsetHeight) views.style.height = p.offsetHeight + 'px'; };
  if (window.ResizeObserver) { const ro = new ResizeObserver(fitViews); [...vtrack.children].forEach(p => ro.observe(p)); }
  const lanes = root.querySelector('.sq-lanes'), bars = root.querySelector('.lanebars');

  /* ---- ROLL */
  // its own camera (no scroll box inside a scroll box): the grid moves under a window, the note names move with it up /
  // down, the step numbers sideways, and it never runs past its edges. One finger on the grid: a still tap writes a
  // note, a drag moves the view (it glides on); two fingers: move and pinch the zoom. On a note: drag up / down = its
  // row, sideways = its step, its right edge = its length; a tap selects it, a double tap removes it. The note names
  // let the page scroll (a finger there is not on the roll)
  let drawRoll = () => {}, centerRoll = () => {};
  if (o.roll) {
    const R = o.roll, P = root.querySelector('.sq-roll'), HW = 46, TH = 20;
    P.innerHTML = `<div class="roll-tools"><button class="tog rz-out">−</button><span class="rz-v"></span><button class="tog rz-in">+</button>
      <button class="tog rz-tall">TALL</button><span class="rz-hint">1 FINGER: MOVE · TAP: NOTE · 2: ZOOM</span></div>
      <div class="rollbox"><div class="roll-corner"></div><div class="roll-top"><div class="roll-top-in"></div></div>
      <div class="roll-heads"><div class="roll-heads-in"></div></div>
      <div class="roll"><div class="roll-cam"><div class="roll-grid"><svg class="roll-glide"></svg></div><div class="roll-ph"></div></div></div></div>`;
    const box = P.querySelector('.rollbox'), sc = P.querySelector('.roll'), cam = P.querySelector('.roll-cam'), grid = P.querySelector('.roll-grid');
    const gsvg = P.querySelector('.roll-glide'), headsIn = P.querySelector('.roll-heads-in'), topIn = P.querySelector('.roll-top-in'), ph = P.querySelector('.roll-ph');
    let rows = [], built = '', CW = 30, RH = 22, sx = 0, sy = 0, lastUser = 0;
    const sizes = () => { const z = tr.zoom || 1; CW = Math.round(30 * z); RH = Math.round(22 * z); };
    const vw = () => sc.clientWidth, vh = () => sc.clientHeight;
    const setCam = () => {
      sx = clamp(sx, 0, Math.max(0, tr.len * CW - vw())); sy = clamp(sy, 0, Math.max(0, rows.length * RH - vh()));
      cam.style.transform = `translate3d(${-sx}px,${-sy}px,0)`;
      headsIn.style.transform = `translate3d(0,${-sy}px,0)`; topIn.style.transform = `translate3d(${-sx}px,0,0)`;
    };
    const rowOf = v => rows.indexOf(v);
    const build = () => {                                    // the rows (the values shown, top = highest) and the frame
      sizes();
      box.classList.toggle('tall', !!tr.tall);
      P.querySelector('.rz-tall').classList.toggle('on', !!tr.tall);
      P.querySelector('.rz-v').textContent = Math.round((tr.zoom || 1) * 100) + '%';
      rows = [];
      const lo = typeof R.min === 'function' ? R.min() : R.min, hi = typeof R.max === 'function' ? R.max() : R.max;
      for (let v = hi; v >= lo; v--) if (!R.show || R.show(v)) rows.push(v);
      if (R.asc) rows.reverse();
      const key = rows.join(',') + '|' + tr.len + '|' + CW + 'x' + RH + '|' + (R.key ? R.key() : '');
      if (key === built) return;
      built = key;
      headsIn.innerHTML = ''; topIn.innerHTML = '';
      grid.querySelectorAll('.rband').forEach(b => b.remove());
      els.forEach(n => n.remove()); els.clear();
      const fs = Math.max(9, Math.min(13, Math.round(RH * 0.5))) + 'px';
      rows.forEach((v, r) => {
        const sh = R.shade ? R.shade(v) : '';
        const hd = headsIn.appendChild($c('div', 'rh ' + sh, `<b>${R.label(v)}</b>`));
        Object.assign(hd.style, { top: r * RH + 'px', height: RH + 'px', lineHeight: RH + 'px', fontSize: fs });
        if (R.head) R.head(v, hd);
        const band = grid.appendChild($c('div', 'rband ' + sh));
        Object.assign(band.style, { top: r * RH + 'px', height: RH + 'px', width: tr.len * CW + 'px' });
      });
      for (let k = 0; k < tr.len; k++) {
        const t = topIn.appendChild($c('div', 'rt' + (k % 4 === 0 ? ' beat' : ''), k % 4 === 0 ? String(k + 1) : '·'));
        t.style.left = k * CW + 'px'; t.style.width = CW + 'px';
      }
      grid.style.width = tr.len * CW + 'px'; grid.style.height = rows.length * RH + 'px';
      grid.style.backgroundSize = `${CW}px 100%, ${CW * 4}px 100%`;
      ph.style.width = CW + 'px'; ph.style.height = rows.length * RH + 'px';
      setCam();
    };
    // the notes are kept (one element per trig, moved, not rebuilt), so a finger on one never loses it
    const els = new Map();
    drawRoll = now => {
      build();
      const seen = new Set();
      for (let k = 0; k < tr.len; k++) {
        const x = tr.steps[k];
        if (!x.on) continue;
        const r = rowOf(x[R.field]);
        if (r < 0) continue;
        seen.add(k);
        let n = els.get(k);
        if (!n) { n = $c('div', 'rnote'); n.dataset.k = k; els.set(k, n); grid.appendChild(n); }
        const span = R.len ? clamp(x[R.len], 0.25, tr.len - k) : 1;
        n.className = 'rnote' + (k === tr.sel ? ' sel' : '') + (k === now ? ' now' : '') + ((x.prb ?? 100) < 100 || x.cnd ? ' maybe' : '') + (nd && nd.k === k ? ' drag' : '');
        const t = R.mark ? R.mark(x) : '';
        if (n.textContent !== t) n.textContent = t;
        Object.assign(n.style, { left: k * CW + 1 + 'px', top: r * RH + 1 + 'px', width: span * CW - 2 + 'px', height: RH - 2 + 'px', lineHeight: RH - 2 + 'px',
          opacity: x.vel != null ? 0.5 + 0.5 * x.vel : '' });
      }
      for (const [k, n] of els) if (!seen.has(k)) { n.remove(); els.delete(k); }
      if (R.glide) {                                       // a glide: a curve from the note into the next one
        gsvg.setAttribute('width', tr.len * CW); gsvg.setAttribute('height', rows.length * RH);
        let paths = '';
        const on = [...seen].sort((a, b) => a - b);
        on.forEach((k, i) => {
          const x = tr.steps[k], k2 = on[i + 1];
          if (!R.glide(x) || k2 == null) return;
          const span = R.len ? clamp(x[R.len], 0.25, tr.len - k) : 1, y1 = rowOf(x[R.field]) * RH + RH / 2, y2 = rowOf(tr.steps[k2][R.field]) * RH + RH / 2;
          const x2 = k2 * CW + 3, x1 = Math.min(k * CW + span * CW - 4, x2 - 6), mx = (x1 + x2) / 2;
          paths += `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/><circle cx="${x2}" cy="${y2}" r="3"/>`;
        });
        gsvg.innerHTML = paths;
      }
      ph.style.display = now >= 0 ? '' : 'none';
      if (now >= 0) {
        ph.style.left = now * CW + 'px';
        const px = now * CW;                                 // the view follows the playhead (not while you move it)
        if (o.follow !== false && !pts.size && Date.now() - lastUser > 1500 && (px < sx || px > sx + vw() - CW)) { sx = px; setCam(); }
      }
    };
    // start where the notes are (or the middle): once the roll is first seen (a hidden page has no size)
    let centered = false;
    centerRoll = () => {
      if (centered || !vh()) return;
      centered = true;
      const used = tr.steps.slice(0, tr.len).filter(x => x.on).map(x => rowOf(x[R.field])).filter(r => r >= 0);
      const mid = used.length ? used.reduce((a, b) => a + b, 0) / used.length : rows.length / 2;
      sy = mid * RH - vh() / 2 + RH / 2; setCam();
    };
    const zoomTo = (z, ax = vw() / 2, ay = vh() / 2) => {    // about a point of the window (it stays put)
      z = clamp(Math.round(z * 100) / 100, 0.6, 2.4);
      const wx = (sx + ax) / CW, wy = (sy + ay) / RH;
      tr.zoom = z; build();
      sx = wx * CW - ax; sy = wy * RH - ay; setCam();
      drawRoll(-1); save();
    };
    P.querySelector('.rz-in').onclick = () => zoomTo((tr.zoom || 1) * 1.25);
    P.querySelector('.rz-out').onclick = () => zoomTo((tr.zoom || 1) / 1.25);
    P.querySelector('.rz-tall').onclick = () => { tr.tall = !tr.tall; build(); setCam(); save(); };

    // fingers on the roll
    const pts = new Map();
    let nd = null, pan = null, pinch = null, glide = 0, lastTap = { k: -1, t: 0 }, raf = 0;
    const local = e => { const r = sc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const cellAt = e => { const [x, y] = local(e); return [Math.floor((x + sx) / CW), Math.floor((y + sy) / RH)]; };
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawRoll(-1); drawLanes(-1); drawEdit(); }); };
    const startPinch = () => {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, z: tr.zoom || 1 };
    };
    sc.addEventListener('pointerdown', e => {
      cancelAnimationFrame(glide); glide = 0;
      try { sc.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      lastUser = Date.now();
      if (pts.size === 2) {                                  // a second finger: no note, no tap; move / zoom
        if (nd && !nd.moved) nd = null;
        pan = null; startPinch(); return;
      }
      if (pts.size > 2) return;
      const n = e.target.closest('.rnote');
      if (n) {
        e.preventDefault();
        const k = +n.dataset.k, r = n.getBoundingClientRect();
        nd = { k, k0: k, x0: e.clientX, y0: e.clientY, moved: false, pushed: false, v0: tr.steps[k][R.field], len0: R.len ? tr.steps[k][R.len] : 1,
          edge: !!R.len && r.width >= 18 && e.clientX > r.right - Math.min(12, r.width * 0.3) };
        drawRoll(-1);
        return;
      }
      pan = { x0: e.clientX, y0: e.clientY, sx0: sx, sy0: sy, t: Date.now(), moved: false, vx: 0, vy: 0, lt: Date.now(), lx: e.clientX, ly: e.clientY };
    });
    sc.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(e); return; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      lastUser = Date.now();
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        sx -= cx - pinch.cx; sy -= cy - pinch.cy; pinch.cx = cx; pinch.cy = cy;
        const z = clamp(pinch.z * d / pinch.d, 0.6, 2.4);
        if (Math.abs(z - (tr.zoom || 1)) > 0.03) { const r0 = sc.getBoundingClientRect(); zoomTo(z, cx - r0.left, cy - r0.top); } else setCam();
        return;
      }
      if (pan) {
        const dx = e.clientX - pan.x0, dy = e.clientY - pan.y0;
        if (!pan.moved && Math.hypot(dx, dy) < 7) return;
        pan.moved = true;
        const now = Date.now(), dt = Math.max(1, now - pan.lt);
        pan.vx = (e.clientX - pan.lx) / dt; pan.vy = (e.clientY - pan.ly) / dt; pan.lt = now; pan.lx = e.clientX; pan.ly = e.clientY;
        sx = pan.sx0 - dx; sy = pan.sy0 - dy; setCam();
        return;
      }
      if (!nd) return;
      const dx = e.clientX - nd.x0, dy = e.clientY - nd.y0;
      if (!nd.moved && Math.hypot(dx, dy) < 6) return;
      if (!nd.pushed) { push(); nd.pushed = true; }
      nd.moved = true;
      const x = tr.steps[nd.k];
      if (nd.edge) x[R.len] = clamp(Math.round((nd.len0 + dx / CW) * 4) / 4, 0.25, tr.len - nd.k);
      else {
        const r = clamp(rowOf(nd.v0) + Math.round(dy / RH), 0, rows.length - 1);
        if (rows[r] !== x[R.field]) { x[R.field] = rows[r]; hear(nd.k); }
        const nk = clamp(nd.k0 + Math.round(dx / CW), 0, tr.len - 1);
        if (nk !== nd.k && !tr.steps[nk].on) { tr.steps[nk] = x; tr.steps[nd.k] = blank(); nd.k = nk; tr.sel = nk; }
      }
      redraw();
    });
    const end = e => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      try { sc.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
      if (pinch) { if (pts.size < 2) { pinch = null; save(); } return; }
      if (pan) {
        const p = pan;
        pan = null;
        if (p.moved) {                                       // let go while moving: it glides on
          let vx = p.vx, vy = p.vy;
          if (Date.now() - p.lt > 80) return;
          const step = () => { vx *= 0.94; vy *= 0.94; sx -= vx * 16; sy -= vy * 16; setCam(); if (Math.abs(vx) + Math.abs(vy) > 0.02) glide = requestAnimationFrame(step); };
          glide = requestAnimationFrame(step);
          return;
        }
        if (e.type !== 'pointerup' || Date.now() - p.t > 500) return;
        const [k, r] = cellAt(e);                            // a still tap on the grid: a note there
        if (k < 0 || k >= tr.len || r < 0 || r >= rows.length) return;
        push();
        const x = tr.steps[k];
        if (!x.on) Object.assign(x, blank());
        x.on = 1; x[R.field] = rows[r];
        tr.sel = k; lastTap = { k, t: Date.now() }; hear(k); draw(); changed();
        return;
      }
      if (!nd) return;
      const d = nd;
      nd = null;
      if (d.moved) { draw(); changed(); return; }
      if (e.type !== 'pointerup') { drawRoll(-1); return; }
      const now = Date.now();
      if (lastTap.k === d.k && now - lastTap.t < 350) { push(); tr.steps[d.k].on = 0; lastTap.k = -1; draw(); changed(); return; }
      lastTap = { k: d.k, t: now };
      tr.sel = d.k; hear(d.k); draw();
    };
    sc.addEventListener('pointerup', end);
    sc.addEventListener('pointercancel', end);
    sc.addEventListener('wheel', e => {                       // a mouse / trackpad: scroll it, pinch (ctrl) zooms
      e.preventDefault();
      if (e.ctrlKey) { const [x, y] = local(e); zoomTo((tr.zoom || 1) * Math.exp(-e.deltaY * 0.01), x, y); return; }
      sx += e.shiftKey ? e.deltaY : e.deltaX; sy += e.shiftKey ? 0 : e.deltaY; lastUser = Date.now(); setCam();
    }, { passive: false });
    window.addEventListener('resize', () => setCam());
  }

  /* ---- GRID: Elektron trig keys */
  const G = root.querySelector('.sq-grid');
  G.innerHTML = `<div class="sq-pages"></div><div class="trigs"></div>`;
  const pagesEl = G.querySelector('.sq-pages'), trigs = G.querySelector('.trigs');
  for (let p = 0; p < 4; p++) { const b = $c('button', '', String(p + 1)); b.onclick = () => { tr.page = p; draw(); }; pagesEl.appendChild(b); }
  for (let i = 0; i < 16; i++) {
    const b = $c('button', 'trig', `<i></i><span>${i + 1}</span>`);
    let t = 0, long = false, x0 = 0, y0 = 0;
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); long = false; x0 = e.clientX; y0 = e.clientY;
      t = setTimeout(() => { long = true; tr.sel = tr.page * 16 + i; draw(); hear(tr.sel); }, 380);   // long press: select it
    });
    b.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) clearTimeout(t); });
    b.addEventListener('pointerup', e => {
      clearTimeout(t);
      if (long || Math.hypot(e.clientX - x0, e.clientY - y0) > 10) return;   // a finger that moved was scrolling
      const k = tr.page * 16 + i;
      if (k >= tr.len) return;
      push();
      const x = tr.steps[k];
      x.on = x.on ? 0 : 1;
      tr.sel = k;
      hear(k); draw(); changed();
    });
    b.addEventListener('pointercancel', () => clearTimeout(t));
    trigs.appendChild(b);
  }
  function drawGrid(now) {
    const pages = Math.ceil(tr.len / 16);
    tr.page = Math.min(tr.page, pages - 1);
    [...pagesEl.children].forEach((b, p) => { b.style.display = p < pages ? '' : 'none'; b.classList.toggle('on', p === tr.page); b.classList.toggle('play', now >= 0 && Math.floor(now / 16) === p); });
    [...trigs.children].forEach((b, i) => {
      const k = tr.page * 16 + i, x = tr.steps[k];
      b.className = 'trig' + (k >= tr.len ? ' out' : '') + (x.on ? ' on' : '') + (k === now ? ' now' : '') + (k === tr.sel ? ' sel' : '') +
        (x.on && ((x.prb ?? 100) < 100 || x.cnd) ? ' maybe' : '') + (i % 4 === 0 ? ' beat' : '');
    });
  }

  /* ---- the lanes: 16 bars of the page of the selected step, drawn across with a finger */
  F.filter(f => f.lane).forEach(f => { const b = $c('button', '', f.short); b.dataset.k = f.k; b.onclick = () => { tr.lane = f.k; drawLanes(-1); save(); }; lanes.appendChild(b); });
  for (let i = 0; i < 16; i++) bars.appendChild($c('div', 'lbar'));
  const lanePage = () => (tr.view === 'grid' ? tr.page : Math.floor(tr.sel / 16));
  const paint = e => {
    const f = F.find(x => x.k === tr.lane), r = bars.getBoundingClientRect(), i = clamp(Math.floor((e.clientX - r.left) / r.width * 16), 0, 15);
    const k = lanePage() * 16 + i, x = tr.steps[k];
    if (k >= tr.len || !x.on) return;
    const v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    x[f.k] = clamp(Math.round((f.min + v * (f.max - f.min)) / (f.step || 1)) * (f.step || 1), f.min, f.max);
    tr.sel = k; drawLanes(-1); drawEdit(); drawRoll(-1);
  };
  // a finger that holds still a moment draws (then the page does not scroll under it); one that moves at once scrolls
  // the page; a tap sets the bar it is on
  let lp = null;
  const startPaint = e => { lp.on = true; try { bars.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } push(); paint(e); bars.classList.add('drawing'); };
  bars.addEventListener('pointerdown', e => {
    lp = { x: e.clientX, y: e.clientY, on: false, ev: e };
    if (e.pointerType === 'mouse') startPaint(e);
    else lp.t = setTimeout(() => { if (lp && !lp.on) startPaint(lp.ev); }, 140);
  });
  bars.addEventListener('pointermove', e => {
    if (!lp) return;
    if (lp.on) paint(e);
    else { lp.ev = e; if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) { clearTimeout(lp.t); lp = null; } }
  });
  bars.addEventListener('touchmove', e => { if (lp && lp.on) e.preventDefault(); }, { passive: false });
  const lend = e => {
    if (!lp) return;
    clearTimeout(lp.t);
    if (!lp.on && e.type === 'pointerup') { push(); paint(e); lp.on = true; }
    if (lp.on) changed();
    lp = null; bars.classList.remove('drawing');
  };
  bars.addEventListener('pointerup', lend);
  bars.addEventListener('pointercancel', lend);
  function drawLanes(now) {
    const f = F.find(x => x.k === tr.lane), pg = lanePage();
    [...lanes.children].forEach(b => b.classList.toggle('on', b.dataset.k === tr.lane));
    [...bars.children].forEach((d, i) => {
      const k = pg * 16 + i, x = tr.steps[k], v = (x[f.k] - f.min) / (f.max - f.min);
      d.className = 'lbar' + (x.on && k < tr.len ? '' : ' off') + (k === now ? ' now' : '') + (k === tr.sel ? ' sel' : '');
      d.style.setProperty('--v', x.on ? clamp(v, 0, 1) : 0);
      d.dataset.t = x.on && k < tr.len ? fmt(f, x) : '';
    });
  }
  // the selected step's values as rows (its parameter locks)
  const erows = root.querySelector('.sq-erows'), editRows = [];
  const snap = (f, v) => (v == null ? null : f.step && f.step < 1 ? Math.round(v / f.step) * f.step : f.step > 1 ? Math.round(v / f.step) * f.step : Math.round(v));
  F.forEach(f => {
    const r = row({ label: f.label, min: f.list ? 0 : f.min, max: f.list ? f.list.length - 1 : f.max, def: f.def, int: f.step >= 1 || !!f.list, log: f.log,
      get: () => tr.steps[tr.sel][f.k] ?? (f.lock ? f.inherit() : f.def), set: v => { tr.steps[tr.sel][f.k] = snap(f, v); },
      fmt: v => (f.lock && tr.steps[tr.sel][f.k] == null ? 'ALL · ' : '') + (f.fmt ? f.fmt(v) : String(v)),
      onMove: () => { drawLanes(-1); drawRoll(-1); extra(); }, onRelease: () => { changed(); hear(tr.sel); drawEdit(); } });
    r.dataset.k = f.k;
    editRows.push(r); erows.appendChild(r);
  });
  let extra = () => {};
  if (o.editor) extra = o.editor(root.querySelector('.sq-extra'), { tr, refresh: () => { editRows.forEach(r => r.redraw()); drawRoll(-1); drawEdit(); }, push, changed, hear: () => hear(tr.sel) }) || extra;
  // the edit bar: ◀ ▶ the previous / next trig (or step), HEAR it, DEL it
  const jump = d => {
    let k = tr.sel;
    for (let i = 0; i < tr.len; i++) { k = (k + d + tr.len) % tr.len; if (tr.steps[k].on) break; }
    if (!tr.steps.slice(0, tr.len).some(x => x.on)) k = (tr.sel + d + tr.len) % tr.len;
    tr.sel = k; tr.page = Math.floor(k / 16); hear(k); draw();
  };
  root.querySelector('.sq-prev').onclick = () => jump(-1);
  root.querySelector('.sq-next').onclick = () => jump(1);
  root.querySelector('.sq-hear').onclick = () => o.audition && o.audition(tr.sel);
  root.querySelector('.sq-del').onclick = () => { if (!tr.steps[tr.sel].on) return; push(); tr.steps[tr.sel].on = 0; draw(); changed(); };
  // the screen's wheels: the selected step's main values (the first four, or o.screen), each rolled up / down with a
  // finger like a drum (its neighbours show above and below); a double tap: its default. Rolling an empty step's
  // value writes a trig there
  const SF = (o.screen ? o.screen.map(k => F.find(f => f.k === k)) : F.filter(f => !f.lock && f.k !== 'prb' && f.k !== 'cnd').slice(0, 4)).filter(Boolean);
  const wheelsEl = root.querySelector('.scr-wheels'), wheels = [];
  const valOf = (f, x) => x[f.k] ?? (f.lock ? f.inherit() : f.def);
  const stepOf = f => (f.list ? 1 : f.step || 1), lo = f => (f.list ? 0 : f.min), hi = f => (f.list ? f.list.length - 1 : f.max);
  const show = (f, v) => (f.fmt ? f.fmt(v) : String(v));
  SF.forEach(f => {
    const w = $c('div', 'wheel', `<div class="wl">${f.short || f.label}</div><div class="wdrum"><span class="wp"></span><span class="wv"></span><span class="wn"></span></div>`);
    const drum = w.querySelector('.wdrum');
    let y0 = 0, v0 = 0, last = 0, pid = null, pushed = false;
    const PX = 18;                                         // a value every 18 px of the finger
    w.addEventListener('pointerdown', e => {
      e.preventDefault(); pid = e.pointerId; pushed = false;
      try { w.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
      y0 = e.clientY; v0 = valOf(f, tr.steps[tr.sel]); w.classList.add('drag');
      const now = Date.now();
      if (now - last < 300) { push(); tr.steps[tr.sel][f.k] = f.def; draw(); changed(); hear(tr.sel); pid = null; w.classList.remove('drag'); }
      last = now;
    });
    w.addEventListener('pointermove', e => {
      if (e.pointerId !== pid) return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(e); return; }
      const d = (y0 - e.clientY) / PX, n = Math.round(d), x = tr.steps[tr.sel];
      drum.style.transform = `translateY(${(d - n) * -PX * 0.9}px)`;
      const v = clamp(Math.round((v0 + n * stepOf(f)) * 1000) / 1000, lo(f), hi(f));
      if (v !== valOf(f, x)) {
        if (!pushed) { push(); pushed = true; }
        x[f.k] = v;
        if (!x.on && !f.lock && f.k !== 'prb' && f.k !== 'cnd') x.on = 1;
        if (f.k === (o.roll && o.roll.field) || f.k === 'note' || f.k === 's') hear(tr.sel);
        drawRoll(-1); drawLanes(-1); drawGrid(-1); drawWheels(); editRows.forEach(r2 => r2.redraw());
      }
    });
    const end = e => {
      if (e.pointerId !== pid) return;
      pid = null; w.classList.remove('drag'); drum.style.transform = '';
      if (pushed) { changed(); hear(tr.sel); draw(); }
    };
    w.addEventListener('pointerup', end); w.addEventListener('pointercancel', end);
    w.addEventListener('wheel', e => { e.preventDefault(); const x = tr.steps[tr.sel]; push(); x[f.k] = clamp(valOf(f, x) + (e.deltaY < 0 ? 1 : -1) * stepOf(f), lo(f), hi(f)); if (!x.on && !f.lock) x.on = 1; draw(); changed(); }, { passive: false });
    wheelsEl.appendChild(w);
    wheels.push({ f, w });
  });
  wheelsEl.style.gridTemplateColumns = `repeat(${Math.max(1, SF.length)}, 1fr)`;
  function drawWheels() {
    const x = tr.steps[tr.sel];
    wheels.forEach(({ f, w }) => {
      const v = valOf(f, x), s = stepOf(f);
      w.querySelector('.wv').textContent = show(f, v);
      w.querySelector('.wp').textContent = v + s <= hi(f) + 1e-9 ? show(f, Math.round((v + s) * 1000) / 1000) : '';
      w.querySelector('.wn').textContent = v - s >= lo(f) - 1e-9 ? show(f, Math.round((v - s) * 1000) / 1000) : '';
      w.classList.toggle('off', !x.on);
      w.style.setProperty('--fill', ((v - lo(f)) / ((hi(f) - lo(f)) || 1)) * 100 + '%');
    });
  }
  function drawEdit() {
    const x = tr.steps[tr.sel];
    root.querySelector('.sq-ename').innerHTML = 'STEP <b>' + String(tr.sel + 1).padStart(2, '0') + '</b><i>' + (x.on ? '/' + tr.len : 'EMPTY') + '</i>';
    drawWheels();
    root.querySelector('.sq-del').disabled = !x.on;
    editRows.forEach((r, i) => { r.redraw(); r.classList.toggle('locked', !!F[i].lock && x[F[i].k] != null); });
    extra();
  }

  /* ---- TRACKER */
  const TK = root.querySelector('.sq-tracker');
  TK.innerHTML = `<div class="device"><div class="screen"><canvas class="tk-ctx"></canvas><div class="tk-info"></div>
    <div class="tk-head"><span>ST</span><span>ON</span>${F.map(f => `<span>${f.short}</span>`).join('')}</div><div class="tk-rows"></div></div>
    <div class="dev-ctl"><div class="dpad"><button data-d="up" class="dk up">▲</button><button data-d="left" class="dk left">◀</button>
    <button data-d="right" class="dk right">▶</button><button data-d="down" class="dk down">▼</button></div>
    <div class="dev-keys"><button data-d="dec" class="dkey">−</button><button data-d="inc" class="dkey">+</button>
    <button data-d="clr" class="dkey small">CLR</button><button data-d="copy" class="dkey small">COPY</button>
    <button data-d="paste" class="dkey small">PASTE</button><button data-d="aud" class="dkey small">HEAR</button></div></div></div>`;
  const cols = [{ k: 'on', label: 'TRIG', short: 'ON', min: 0, max: 1, step: 1, def: 0 }, ...F];
  const tmpl = '2.2em 1.8em ' + F.map(f => (f.list ? '1fr' : '2.9em')).join(' ');
  TK.querySelector('.tk-head').style.gridTemplateColumns = tmpl;
  const rowsEl = TK.querySelector('.tk-rows');
  for (let r = 0; r < 16; r++) {
    const el = $c('div', 'tk-row');
    el.style.gridTemplateColumns = tmpl;
    el.innerHTML = '<span></span>' + cols.map(() => '<span></span>').join('');
    [...el.children].forEach((cell, ci) => cell.onclick = () => { const k = +el.dataset.k; if (isNaN(k)) return; tr.sel = k; if (ci > 0) tr.col = ci - 1; draw(); });
    rowsEl.appendChild(el);
  }
  function edit(d) {
    const x = tr.steps[tr.sel], c = cols[tr.col];
    push();
    if (c.k === 'on') x.on = d > 0 ? 1 : 0;
    else if (c.list) x[c.k] = clamp(x[c.k] + d, 0, c.list.length - 1);
    else x[c.k] = clamp(Math.round(((x[c.k] ?? (c.lock ? c.inherit() : c.def)) + d * (c.step || 1)) * 1000) / 1000, c.min, c.max);
    if (c.k !== 'on' && c.k !== 'prb' && c.k !== 'cnd' && !c.lock && !x.on && d > 0) x.on = 1;
    hear(tr.sel); draw(); changed();
  }
  function key(d) {
    if (d === 'up') tr.sel = (tr.sel - 1 + tr.len) % tr.len;
    else if (d === 'down') tr.sel = (tr.sel + 1) % tr.len;
    else if (d === 'left') tr.col = (tr.col - 1 + cols.length) % cols.length;
    else if (d === 'right') tr.col = (tr.col + 1) % cols.length;
    else if (d === 'inc') return edit(1);
    else if (d === 'dec') return edit(-1);
    else if (d === 'clr') { push(); tr.steps[tr.sel] = blank(); changed(); }
    else if (d === 'copy') { tr.clip = { ...tr.steps[tr.sel] }; toast('STEP ' + String(tr.sel + 1).padStart(2, '0') + ' COPIED'); }
    else if (d === 'paste' && tr.clip) { push(); tr.steps[tr.sel] = { ...tr.clip }; tr.sel = (tr.sel + 1) % tr.len; changed(); }
    else if (d === 'aud' && o.audition) o.audition(tr.sel);
    tr.page = Math.floor(tr.sel / 16);
    draw();
  }
  TK.querySelectorAll('.dk, .dkey').forEach(b => {
    let t = 0, iv = 0;
    const rep = ['up', 'down', 'left', 'right', 'inc', 'dec'].includes(b.dataset.d);
    b.addEventListener('pointerdown', e => { e.preventDefault(); key(b.dataset.d); if (rep) t = setTimeout(() => { iv = setInterval(() => key(b.dataset.d), 70); }, 320); });
    const stop = () => { clearTimeout(t); clearInterval(iv); };
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop);
  });
  function drawTracker(now) {
    const topRow = clamp(tr.sel - 7, 0, Math.max(0, tr.len - 16));
    [...rowsEl.children].forEach((el, r) => {
      const k = topRow + r, x = tr.steps[k];
      el.style.visibility = k < tr.len ? '' : 'hidden';
      if (k >= tr.len) return;
      el.dataset.k = k;
      el.className = 'tk-row' + (k === now ? ' now' : '') + (k % 4 === 0 ? ' beat' : '') + (x.on ? '' : ' empty');
      el.children[0].textContent = String(k).padStart(2, '0');
      cols.forEach((c, ci) => { el.children[ci + 1].textContent = c.k === 'on' ? (x.on ? '■' : '·') : fmt(c, x); el.children[ci + 1].className = k === tr.sel && ci === tr.col ? 'cur' : ''; });
    });
    const c = cols[tr.col], x = tr.steps[tr.sel], cv = TK.querySelector('.tk-ctx');
    TK.querySelector('.tk-info').textContent = c.label + ' · STEP ' + String(tr.sel).padStart(2, '0') + ' · ' + (c.k === 'on' ? (x.on ? 'TRIG' : 'NO TRIG') : fmt(c, x));
    if (!cv.clientWidth) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    if (o.drawCtx && o.drawCtx(g, w, h, tr.sel, c.k)) return;
    if (c.k === 'cnd') {
      for (let n = 0; n < 8; n++) { g.fillStyle = condOk(x.cnd, n) ? '#ff8a4c' : 'rgba(61,43,32,.18)'; g.fillRect(4 + n * (w - 8) / 8, 10, (w - 8) / 8 - 6, h - 20); }
    } else if (!c.list && c.k !== 'on') {
      const v = (x[c.k] - c.min) / (c.max - c.min);
      g.fillStyle = 'rgba(61,43,32,.15)'; g.fillRect(0, h / 2 - 8, w, 16);
      g.fillStyle = '#3d2b20'; g.fillRect(c.min < 0 ? w / 2 : 0, h / 2 - 8, c.min < 0 ? (v - 0.5) * w : v * w, 16);
    } else {
      for (let k = 0; k < tr.len; k++) { g.fillStyle = k === tr.sel ? '#ff8a4c' : tr.steps[k].on ? '#3d2b20' : 'rgba(61,43,32,.15)'; g.fillRect(k / tr.len * w + 1, 12, w / tr.len - 2, h - 24); }
    }
  }

  /* ---- all of it */
  function draw(now = -1) {
    if (now < 0 && o.playing()) now = o.stepAt(tr.len);
    const vi = VIEWS.indexOf(tr.view);
    vtrack.style.transform = `translateX(${-vi * 100 / VIEWS.length}%)`;
    views.classList.toggle('is-roll', tr.view === 'roll');
    fitViews();
    [...root.querySelector('.sq-sw').children].forEach(b => b.classList.toggle('on', b.dataset.v === tr.view));
    root.querySelector('.sq-len .num').textContent = tr.len;
    if (tr.view === 'roll') { drawRoll(now); centerRoll(); }
    if (tr.view === 'grid') drawGrid(now);
    if (tr.view === 'tracker') drawTracker(now);
    drawLanes(now); drawEdit();
  }
  root.querySelectorAll('.sq-sw button').forEach(b => b.onclick = () => { tr.view = b.dataset.v; save(); draw(); });
  const undo = () => { if (!hist.length) { toast('NOTHING TO UNDO'); return; } tr.steps = JSON.parse(hist.pop()); draw(); changed(); };
  root.querySelector('.sq-undo').onclick = undo;
  {                                                          // LEN: drag up / down, 1..64
    const el = root.querySelector('.sq-len');
    let y0 = 0, v0 = 0;
    el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = tr.len; });
    el.addEventListener('pointermove', e => { if (!el.hasPointerCapture(e.pointerId)) return; const v = clamp(Math.round(v0 + (y0 - e.clientY) * 0.15), 1, NSTEP); if (v !== tr.len) { tr.len = v; tr.sel = Math.min(tr.sel, v - 1); draw(); } });
    el.addEventListener('pointerup', e => { if (el.hasPointerCapture(e.pointerId)) { el.releasePointerCapture(e.pointerId); changed(); } });
  }
  draw();
  return { tr, draw, blank, push, changed, undo, set: steps => { push(); tr.steps = steps; draw(); changed(); } };
}
