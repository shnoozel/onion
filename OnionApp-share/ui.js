// small shared widgets: a knob bound to get/set functions, a toast
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function knobSvg(n) {
  if (!isFinite(n)) n = 0;
  const a0 = Math.PI * 0.75, a1 = a0 + Math.PI * 1.5 * n, r = 22, c = 28;
  const pt = a => [c + r * Math.cos(a), c + r * Math.sin(a)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1), [xe, ye] = pt(Math.PI * 2.25);
  return `<svg viewBox="0 0 56 56"><path d="M${x0} ${y0} A${r} ${r} 0 1 1 ${xe} ${ye}" fill="none" stroke="${css('--line')}" stroke-width="6" stroke-linecap="round"/>` +
    (n > 0.002 ? `<path d="M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}" fill="none" stroke="${css('--acc')}" stroke-width="6" stroke-linecap="round"/>` : '') +
    `<circle cx="${x1}" cy="${y1}" r="4" fill="${css('--text')}"/></svg>`;
}

// o: { label, min, max, def, get(), set(v), fmt(v), log, int, onMove(), onRelease() }; the app now shows rows
export function knob(o) { return row(o); }
export function roundKnob(o) {
  const el = document.createElement('div');
  el.className = 'knob';
  el.innerHTML = `<div class="svgwrap"></div><div class="lab">${o.label}</div><div class="val"></div>`;
  const toN = v => o.log ? Math.log(v / o.min) / Math.log(o.max / o.min) : (v - o.min) / (o.max - o.min);
  const fromN = n => { n = clamp(n, 0, 1); const v = o.log ? o.min * Math.pow(o.max / o.min, n) : o.min + n * (o.max - o.min); return o.int ? Math.round(v) : v; };
  const draw = () => { el.querySelector('.svgwrap').innerHTML = knobSvg(toN(o.get())); el.querySelector('.val').textContent = (o.fmt || (v => v.toFixed(2)))(o.get()); };
  let y0 = 0, n0 = 0, lastTap = 0, moved = false;
  function up(e) {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove('drag');
    if (moved && o.onRelease) o.onRelease();
  }
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    y0 = e.clientY; n0 = toN(o.get()); moved = false;
    el.classList.add('drag');
    const now = Date.now();
    if (now - lastTap < 300 && o.def !== undefined) { o.set(o.def); draw(); o.onMove && o.onMove(); o.onRelease && o.onRelease(); }
    lastTap = now;
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { up(e); return; }
    const dy = y0 - e.clientY;
    if (Math.abs(dy) > 2) moved = true;
    const v = fromN(n0 + dy / (e.shiftKey ? 600 : 170));
    if (v !== o.get()) { o.set(v); draw(); o.onMove && o.onMove(); }
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.redraw = draw;
  draw();
  return el;
}

// a drawing surface the page still scrolls over (touch-action: pan-y): once a finger has grabbed something on it
// (grabbed() true), the page holds still under that finger
export function scrollGuard(el, grabbed) {
  el.addEventListener('touchmove', e => { if (grabbed()) e.preventDefault(); }, { passive: false });
}

export function toast(msg, ms = 1600) {
  const t = document.getElementById('toast');
  if (!msg) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), ms);
}

// every .sec under root folds on a tap of its title (not of a button in it); remembered per title on this device
export function collapsible(root, prefix) {
  let st = {};
  try { st = JSON.parse(localStorage.getItem('onion-fold') || '{}'); } catch (e) { /* none */ }
  root.querySelectorAll('.sec').forEach(sec => {
    const h = sec.querySelector('h3');
    if (!h || h.dataset.fold) return;
    h.dataset.fold = '1';
    const key = prefix + ':' + (sec.dataset.sec || h.textContent.trim());
    if (st[key]) sec.classList.add('collapsed');
    h.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      sec.classList.toggle('collapsed');
      st[key] = sec.classList.contains('collapsed');
      try { localStorage.setItem('onion-fold', JSON.stringify(st)); } catch (err) { /* ignore */ }
      window.dispatchEvent(new Event('resize'));
    });
  });
}

/* ------------------------------------------------------------------ rows --- */
// a parameter as a full-width row: its name, its value, a bar; drag sideways anywhere on it (the page still scrolls up
// and down), double tap: its default. o as knob(): label min max def get set fmt log int, + bipolar, onMove onRelease
export function row(o) {
  const el = document.createElement('div');
  el.className = 'prow';
  el.innerHTML = `<div class="pfill"></div><span class="plab">${o.label}</span><span class="pval"></span>`;
  const toN = v => o.log ? Math.log(v / o.min) / Math.log(o.max / o.min) : (v - o.min) / (o.max - o.min);
  const fromN = n => { n = clamp(n, 0, 1); const v = o.log ? o.min * Math.pow(o.max / o.min, n) : o.min + n * (o.max - o.min); return o.int ? Math.round(v) : v; };
  const bip = o.bipolar ?? (o.min < 0 && o.max > 0);
  const draw = () => {
    const n = clamp(toN(o.get()), 0, 1), z = bip ? clamp(toN(0), 0, 1) : 0, f = el.firstChild;
    f.style.left = Math.min(n, z) * 100 + '%'; f.style.width = Math.abs(n - z) * 100 + '%';
    el.querySelector('.pval').textContent = (o.fmt || (v => v.toFixed(2)))(o.get());
  };
  let x0 = 0, n0 = 0, lastTap = 0, moved = false, w = 1;
  let y0 = 0;
  function up(e) {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove('drag');
    if (moved) { if (o.onRelease) o.onRelease(); lastTap = 0; return; }
    if (e.type !== 'pointerup' || Math.abs(e.clientY - y0) > 8) { lastTap = 0; return; }   // the page scrolled
    const now = Date.now();                                                               // a double tap: its default
    if (now - lastTap < 320 && o.def !== undefined) { o.set(o.def); draw(); o.onMove && o.onMove(); o.onRelease && o.onRelease(); lastTap = 0; }
    else lastTap = now;
  }
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    x0 = e.clientX; y0 = e.clientY; n0 = toN(o.get()); moved = false; w = el.getBoundingClientRect().width;
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { up(e); return; }
    const dx = e.clientX - x0;
    if (!moved && (Math.abs(dx) < 6 || Math.abs(e.clientY - y0) > Math.abs(dx))) return;   // sideways only
    moved = true; el.classList.add('drag');
    const v = fromN(n0 + dx / w * (e.shiftKey ? 0.25 : 1));
    if (v !== o.get()) { o.set(v); draw(); o.onMove && o.onMove(); }
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.redraw = draw;
  draw();
  return el;
}

/* ---------------------------------------------------------------- XY pad --- */
// two parameters under one finger: the dot goes where you touch, a fading trail behind it. o.x / o.y: {label min max
// get set fmt log}; o.onStart / onMove / onRelease (an instrument uses onStart to start playing while it is touched)
export function xy(o) {
  const el = document.createElement('div');
  el.className = 'xy';
  el.innerHTML = `<canvas></canvas><span class="xl">${o.x.label}</span><span class="yl">${o.y.label}</span><span class="xyv"></span>`;
  const cv = el.firstChild, trail = [];
  const toN = (a, v) => a.log ? Math.log(v / a.min) / Math.log(a.max / a.min) : (v - a.min) / (a.max - a.min);
  const fromN = (a, n) => { n = clamp(n, 0, 1); return a.log ? a.min * Math.pow(a.max / a.min, n) : a.min + n * (a.max - a.min); };
  let touching = false, raf = 0;
  const draw = () => {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.strokeStyle = css('--line'); g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke(); }
    const nx = clamp(toN(o.x, o.x.get()), 0, 1), ny = clamp(toN(o.y, o.y.get()), 0, 1), px = nx * w, py = (1 - ny) * h;
    trail.forEach((p, i) => { g.fillStyle = `rgba(255,138,76,${(i + 1) / trail.length * 0.35})`; g.beginPath(); g.arc(p[0] * w, (1 - p[1]) * h, 3 + i / trail.length * 5, 0, 7); g.fill(); });
    g.strokeStyle = 'rgba(255,138,76,.35)'; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.moveTo(0, py); g.lineTo(w, py); g.stroke();
    g.fillStyle = css('--acc'); g.beginPath(); g.arc(px, py, touching ? 14 : 10, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(px, py, touching ? 5 : 4, 0, 7); g.fill();
    el.querySelector('.xyv').textContent = o.x.fmt(o.x.get()) + ' · ' + o.y.fmt(o.y.get());
  };
  const set = e => {
    const r = cv.getBoundingClientRect(), nx = clamp((e.clientX - r.left) / r.width, 0, 1), ny = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    o.x.set(fromN(o.x, nx)); o.y.set(fromN(o.y, ny));
    trail.push([nx, ny]); if (trail.length > 14) trail.shift();
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
    o.onMove && o.onMove();
  };
  // a finger that goes straight up / down at once scrolls the page; one held still a moment, or moving sideways, plays
  let pend = null;
  const begin = e => { pend = null; try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } touching = true; o.onStart && o.onStart(); set(e); };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') { begin(e); return; }
    pend = { x: e.clientX, y: e.clientY, ev: e, t: setTimeout(() => pend && begin(pend.ev), 110) };
  });
  el.addEventListener('pointermove', e => {
    if (pend) {
      pend.ev = e;
      const dx = Math.abs(e.clientX - pend.x), dy = Math.abs(e.clientY - pend.y);
      if (dx > 6 && dx > dy) { clearTimeout(pend.t); begin(e); }
      else if (dy > 6) { clearTimeout(pend.t); pend = null; }
      return;
    }
    if (!touching) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(e); return; }
    set(e);
  });
  el.addEventListener('touchmove', e => { if (touching) e.preventDefault(); }, { passive: false });
  function end(e) {
    if (pend) { clearTimeout(pend.t); const p = pend; if (e.type === 'pointerup') { begin(p.ev); } else { pend = null; return; } }
    if (!touching) return;
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    touching = false;
    const fade = () => { trail.shift(); draw(); if (trail.length && !touching) setTimeout(fade, 40); };
    fade();
    o.onRelease && o.onRelease();
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.redraw = draw;
  requestAnimationFrame(draw);
  return el;
}
