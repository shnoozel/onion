// Onion kick + bass generator: every sound is computed sample by sample here, so what you audition is exactly
// what gets sampled into the library.

export const SR = 48000;

// key: [label, min, max, default, unit, log scale]
export const P = {
  // the kick's body
  tune:   ['TUNE',   30,  110,   50,   'hz', 1],
  pitch:  ['PITCH',  0,   48,    30,   'st', 0],
  pdec:   ['P.DEC',  5,   250,   35,   'ms', 1],
  pcurve: ['CURVE',  0.3, 3,     1.2,  'x',  0],
  wave:   ['WAVE',   0,   1,     0,    'wave', 0],
  // its level
  attack: ['ATTACK', 0,   20,    0.5,  'ms', 0],
  hold:   ['HOLD',   0,   200,   20,   'ms', 0],
  decay:  ['DECAY',  30,  1500,  320,  'ms', 1],
  length: ['LENGTH', 100, 2500,  700,  'ms', 1],
  // the click
  click:  ['CLICK',  0,   1,     0.35, '%',  0],
  ctone:  ['C.TONE', 500, 12000, 4000, 'hz', 1],
  clen:   ['C.LEN',  1,   30,    6,    'ms', 1],
  // the multiband distortion: two crossovers, three bands of drive / type / level, a tone after
  xlo:    ['X.LOW',  60,  400,   140,  'hz', 1],
  xhi:    ['X.HIGH', 800, 8000,  2500, 'hz', 1],
  ldrv:   ['DRIVE',  0,   1,     0.3,  '%',  0],
  ltyp:   ['TYPE',   0,   5,     0,    'enum', 0],
  llvl:   ['LEVEL',  0,   1.5,   1,    'db', 0],
  mdrv:   ['DRIVE',  0,   1,     0.4,  '%',  0],
  mtyp:   ['TYPE',   0,   5,     1,    'enum', 0],
  mlvl:   ['LEVEL',  0,   1.5,   1,    'db', 0],
  hdrv:   ['DRIVE',  0,   1,     0.2,  '%',  0],
  htyp:   ['TYPE',   0,   5,     0,    'enum', 0],
  hlvl:   ['LEVEL',  0,   1.5,   1,    'db', 0],
  tone:   ['TONE',   300, 16000, 9000, 'hz', 1],
  // the techno rumble
  rumble: ['RUMBLE', 0,   1,     0,    '%',  0],
  rsize:  ['SIZE',   0,   1,     0.6,  '%',  0],
  rlpf:   ['R.LPF',  60,  400,   140,  'hz', 1],
  rduck:  ['DUCK',   0,   1,     0.7,  '%',  0],
  // the bass: tuned to the kick (an interval above its TUNE), its own envelopes and filter
  bint:   ['NOTE',   -12, 24,    12,   'int', 0],
  bwave:  ['WAVE',   0,   3,     0,    'enum', 0],
  bpitch: ['PITCH',  0,   24,    0,    'st', 0],
  bpdec:  ['P.DEC',  2,   200,   30,   'ms', 1],
  batk:   ['ATTACK', 0,   50,    1,    'ms', 0],
  bdec:   ['DECAY',  10,  1000,  180,  'ms', 1],
  bsus:   ['SUSTAIN',0,   1,     0.4,  '%',  0],
  blen:   ['GATE',   20,  1000,  150,  'ms', 1],
  brel:   ['RELEASE',5,   800,   60,   'ms', 1],
  bcut:   ['CUTOFF', 40,  8000,  400,  'hz', 1],
  bres:   ['RESO',   0,   1,     0.35, '%',  0],
  benv:   ['F.ENV',  0,   1,     0.5,  '%',  0],
  bfdec:  ['F.DEC',  5,   1000,  120,  'ms', 1],
  bdrv:   ['DRIVE',  0,   1,     0.2,  '%',  0],
  bmb:    ['MB',     0,   1,     1,    'enum', 0],
  blvl:   ['LEVEL',  0,   1,     0.7,  '%',  0],
  bglide: ['GLIDE',  5,   400,   60,   'ms', 1],
  bduck:  ['DUCK',   0,   1,     0.5,  '%',  0],
  bduckr: ['DUCK REL', 20, 600,  140,  'ms', 1],
  // the saturator at the end of the kick (the Ableton way): DRIVE into a CURVE, COLOR (lows or highs driven harder),
  // BIAS (lopsided: even harmonics), DRY/WET
  sdrv:   ['DRIVE',  0,   30,    0,    'dbv', 0],
  styp:   ['CURVE',  0,   5,     0,    'enum', 0],
  scol:   ['COLOR',  -1,  1,     0,    'col', 0],
  sbias:  ['BIAS',   0,   0.6,   0,    '%',  0],
  smix:   ['DRY/WET',0,   1,     1,    '%',  0],
};
export const SAT_TYPES = ['ANALOG', 'SOFT SINE', 'MEDIUM', 'HARD', 'FOLD', 'DIGITAL'];
// a curve: input -> output, about -1..1 out for any input
export function satCurve(x, t) {
  const a = Math.abs(x), s = Math.sign(x);
  switch (t) {
    case 0: return x / Math.pow(1 + Math.pow(a, 2.5), 0.4);                 // ANALOG: a smooth knee, a little give
    case 1: return Math.sin(Math.max(-Math.PI / 2, Math.min(Math.PI / 2, x)));   // SOFT SINE: round, then flat
    case 2: return Math.tanh(x);                                            // MEDIUM
    case 3: return x / Math.pow(1 + Math.pow(a, 8), 0.125);                 // HARD: a short knee, then a wall
    case 4: return Math.sin(x);                                             // FOLD: past the top it folds back
    default: return Math.max(-1, Math.min(1, x));                           // DIGITAL: a clip, flat
  }
}
// in place: the kick (its peak brought to 1) driven into the curve; COLOR moves the drive to the lows (-) or highs (+)
export function saturate(x, p, sr = SR) {
  if (p.sdrv <= 0.05 && p.sbias <= 0.001) return x;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (!peak) return x;
  const g = Math.pow(10, p.sdrv / 20) / peak, t = Math.round(p.styp), b = p.sbias, off = satCurve(b, t), a = Math.exp(-2 * Math.PI * 500 / sr);
  const c = p.scol, lw = 1 - 0.6 * c, hw = c >= 0 ? 1 + 2 * c : 1 + 0.8 * c;   // COLOR: + drives the highs, - the lows
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp = (1 - a) * x[i] + a * lp;
    const hi = x[i] - lp, drv = lp * lw + hi * hw;
    const y = satCurve(drv * g + b, t) - off;
    x[i] = x[i] / peak * (1 - p.smix) + y * p.smix;
  }
  return x;
}
export const DTYPES = ['SOFT', 'HARD', 'FOLD', 'TUBE', 'CRUSH', 'RECT'];
export const BWAVES = ['SAW', 'SQR', 'SINE', 'SUB'];

export function defaults() {
  const p = {};
  for (const k in P) p[k] = P[k][3];
  return p;
}

const MB = (l, lt, m, mt, h, ht) => ({ ldrv: l, ltyp: lt, mdrv: m, mtyp: mt, hdrv: h, htyp: ht });
export const PRESETS = {
  MENTAL:     { tune: 50, pitch: 36, pdec: 24, pcurve: 1.6, wave: 0.1, attack: 0.2, hold: 30, decay: 330, length: 650, click: 0.55, ctone: 5000, clen: 5, ...MB(0.5, 0, 0.85, 1, 0.6, 1), tone: 6000, rumble: 0.15, rsize: 0.5, rlpf: 160, rduck: 0.7 },
  TRIBE:      { tune: 78, pitch: 19, pdec: 55, pcurve: 0.9, wave: 0.35, attack: 0.5, hold: 10, decay: 220, length: 500, click: 0.2, ctone: 2500, clen: 8, ...MB(0.2, 3, 0.35, 3, 0.1, 0), tone: 7000, rumble: 0 },
  RUMBLE:     { tune: 46, pitch: 26, pdec: 32, pcurve: 1.3, wave: 0, attack: 0.3, hold: 20, decay: 380, length: 1400, click: 0.3, ctone: 3500, clen: 6, ...MB(0.35, 0, 0.45, 0, 0.2, 0), tone: 5000, rumble: 0.75, rsize: 0.75, rlpf: 120, rduck: 0.8 },
  HARDGROOVE: { tune: 56, pitch: 30, pdec: 28, pcurve: 1.4, wave: 0.15, attack: 0.3, hold: 15, decay: 210, length: 450, click: 0.45, ctone: 6000, clen: 4, ...MB(0.3, 0, 0.6, 2, 0.4, 2), tone: 8000, rumble: 0 },
  '909':      { tune: 52, pitch: 18, pdec: 20, pcurve: 1.0, wave: 0, attack: 0.5, hold: 5, decay: 420, length: 700, click: 0.6, ctone: 7000, clen: 3, ...MB(0.1, 0, 0.12, 0, 0.05, 0), tone: 12000, rumble: 0 },
  GABBER:     { tune: 55, pitch: 42, pdec: 18, pcurve: 1.8, wave: 0.2, attack: 0.1, hold: 40, decay: 300, length: 600, click: 0.7, ctone: 8000, clen: 4, ...MB(0.7, 1, 1, 1, 0.8, 5), tone: 9000, rumble: 0 },
  BOOM:       { tune: 44, pitch: 12, pdec: 70, pcurve: 0.8, wave: 0, attack: 1, hold: 30, decay: 1000, length: 1600, click: 0.15, ctone: 3000, clen: 8, ...MB(0.05, 0, 0.05, 0, 0, 0), tone: 6000, rumble: 0 },
  INDUSTRIAL: { tune: 48, pitch: 34, pdec: 30, pcurve: 1.5, wave: 0.6, attack: 0.2, hold: 25, decay: 280, length: 600, click: 0.5, ctone: 4000, clen: 10, ...MB(0.4, 3, 0.7, 4, 0.6, 4), tone: 7000, rumble: 0.3, rsize: 0.4, rlpf: 200, rduck: 0.5 },
};
export const BASS_PRESETS = {
  ROLL:   { bint: 12, bwave: 0, bpitch: 0, batk: 1, bdec: 140, bsus: 0.3, blen: 110, brel: 40, bcut: 300, bres: 0.4, benv: 0.55, bfdec: 90, bdrv: 0.3, bmb: 1, blvl: 0.7 },
  SUB:    { bint: 0, bwave: 2, bpitch: 3, batk: 2, bdec: 300, bsus: 0.7, blen: 200, brel: 80, bcut: 900, bres: 0, benv: 0, bfdec: 100, bdrv: 0.15, bmb: 0, blvl: 0.8 },
  ACIDIC: { bint: 12, bwave: 0, bpitch: 0, batk: 0, bdec: 200, bsus: 0.2, blen: 120, brel: 30, bcut: 220, bres: 0.85, benv: 0.8, bfdec: 140, bdrv: 0.5, bmb: 1, blvl: 0.6 },
  PLUCK:  { bint: 12, bwave: 1, bpitch: 7, bpdec: 15, batk: 0, bdec: 90, bsus: 0, blen: 80, brel: 40, bcut: 600, bres: 0.3, benv: 0.6, bfdec: 60, bdrv: 0.2, bmb: 1, blvl: 0.6 },
  RUMBLY: { bint: 0, bwave: 3, bpitch: 0, batk: 8, bdec: 400, bsus: 0.5, blen: 220, brel: 150, bcut: 160, bres: 0.2, benv: 0.2, bfdec: 200, bdrv: 0.6, bmb: 1, blvl: 0.7 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function noiseGen(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}

/* ---------------------------------------------------------- shapers --- */
// one sample through a distortion of `type`, drive 0..1 (0: clean)
function shape(x, type, drive) {
  if (drive < 0.001) return x;
  const g = 1 + drive * 24;
  switch (type) {
    case 1: return clamp(x * g, -1, 1);                                              // HARD
    case 2: return Math.sin(x * (1 + drive * 7) * Math.PI / 2);                      // FOLD
    case 3: { const b = 0.35 * drive; return Math.tanh(x * g + b) - Math.tanh(b); }  // TUBE (asymmetric)
    case 4: {                                                                          // CRUSH (bits)
      const q = Math.pow(2, Math.round(14 - drive * 12) - 1);
      return Math.round(Math.tanh(x * (1 + drive * 4)) * q) / q;
    }
    case 5: { const y = Math.tanh(x * g); return Math.abs(y) * 1.6 - 0.6 + y * 0.2; } // RECT (octave up grit)
    default: return Math.tanh(x * g);                                                 // SOFT
  }
}

/* ------------------------------------------------------------ filters --- */
function biquad(x, b0, b1, b2, a1, a2) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function bw(x, sr, hz, high) {                          // 2nd-order Butterworth
  const w = 2 * Math.PI * hz / sr, c = Math.cos(w), s = Math.sin(w), al = s / Math.SQRT2, a0 = 1 + al;
  return high ? biquad(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0)
              : biquad(x, (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
}
const lr4 = (x, sr, hz, high) => bw(bw(x, sr, hz, high), sr, hz, high);   // Linkwitz-Riley 4th order
function onePoleLP(x, sr, hz) {
  const a = Math.exp(-2 * Math.PI * hz / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; }
}

// three bands, each through its own distortion, summed; then the tone
export function multiband(x, p, sr = SR) {
  const lo = lr4(x, sr, p.xlo, false), rest = lr4(x, sr, p.xlo, true);
  const mid = lr4(rest, sr, p.xhi, false), hi = lr4(rest, sr, p.xhi, true);
  const out = new Float32Array(x.length);
  const lt = Math.round(p.ltyp), mt = Math.round(p.mtyp), ht = Math.round(p.htyp);
  for (let i = 0; i < x.length; i++)
    out[i] = shape(lo[i], lt, p.ldrv) * p.llvl + shape(mid[i], mt, p.mdrv) * p.mlvl + shape(hi[i], ht, p.hdrv) * p.hlvl;
  onePoleLP(out, sr, p.tone);
  return out;
}

function reverb(input, sr, size) {
  const out = new Float32Array(input.length);
  for (const d0 of [1557, 1617, 1491, 1422]) {
    const d = Math.round(d0 * sr / 44100 * (0.6 + size * 0.8)), buf = new Float32Array(d), fb = 0.7 + size * 0.25;
    let idx = 0, lp = 0;
    for (let i = 0; i < input.length; i++) {
      const y = buf[idx];
      lp = y * 0.6 + lp * 0.4;
      buf[idx] = input[i] + lp * fb;
      out[i] += y * 0.25;
      idx = (idx + 1) % d;
    }
  }
  for (const d of [225, 556]) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const b = buf[idx], x = out[i];
      buf[idx] = x + b * 0.5;
      out[i] = b - x * 0.5;
      idx = (idx + 1) % d;
    }
  }
  return out;
}

function normalize(out, db = -0.3) {
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? Math.pow(10, db / 20) / peak : 1, fade = Math.min(out.length, Math.round(0.006 * SR));
  for (let i = 0; i < out.length; i++) out[i] *= g * (i >= out.length - fade ? (out.length - i) / fade : 1);
  return out;
}

/* --------------------------------------------------------------- kick --- */
// the pitch (Hz) of the kick at time t (s): what the graph draws and drags
export function kickPitchAt(p, t) {
  const ptau = Math.max(0.0005, p.pdec / 1000 / 3);
  return p.tune * Math.pow(2, p.pitch * Math.pow(Math.exp(-t / ptau), p.pcurve) / 12);
}
export function kickAmpAt(p, t) {
  const a = p.attack / 1000, h = p.hold / 1000, d = p.decay / 1000 / 4.6;
  return t < a ? t / Math.max(1e-6, a) : t < a + h ? 1 : Math.exp(-(t - a - h) / d);
}

export function renderKick(p, sr = SR) {
  const n = Math.round(p.length / 1000 * sr);
  const raw = new Float32Array(n), rnd = noiseGen(12345);
  const ctau = p.clen / 1000 / 3 * sr, ca = Math.exp(-2 * Math.PI * p.ctone / sr);
  let ph = 0, clp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = kickPitchAt(p, t);
    ph += 2 * Math.PI * f / sr;
    const s = Math.sin(ph), tri = (2 / Math.PI) * Math.asin(s);
    clp = (1 - ca) * rnd() + ca * clp;
    const click = (clp * 2.2 + Math.sin(Math.PI * p.ctone * t) * 0.4) * Math.exp(-i / Math.max(1, ctau));
    raw[i] = (s * (1 - p.wave) + tri * p.wave) * kickAmpAt(p, t) + click * p.click;
  }
  const out = multiband(raw, p, sr);
  if (p.rumble > 0) {
    const wet = reverb(out, sr, p.rsize);
    onePoleLP(wet, sr, p.rlpf); onePoleLP(wet, sr, p.rlpf);
    const duck = (p.hold + p.decay * 0.6) / 1000 * sr;
    for (let i = 0; i < n; i++) {
      const d = i < duck ? Math.pow(i / duck, 2) : 1;
      out[i] += wet[i] * p.rumble * 3 * (1 - p.rduck + p.rduck * d);
    }
  }
  return normalize(saturate(out, p, sr));
}

/* --------------------------------------------------------------- bass --- */
export const bassHz = p => p.tune * Math.pow(2, Math.round(p.bint) / 12);

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

export function renderBass(p, sr = SR) {
  const gate = p.blen / 1000 * sr, rel = p.brel / 1000 * sr, n = Math.round(gate + rel);
  const out = new Float32Array(n);
  const base = bassHz(p), ptau = Math.max(0.0005, p.bpdec / 1000 / 3);
  const atk = p.batk / 1000 * sr, dtau = p.bdec / 1000 / 4.6 * sr, ftau = p.bfdec / 1000 / 4.6 * sr;
  const wave = Math.round(p.bwave), k = 2 - 1.98 * p.bres;           // SVF damping: low = resonant
  let ph = 0, ph2 = 0, ic1 = 0, ic2 = 0, envAtGate = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = base * Math.pow(2, p.bpitch * Math.exp(-t / ptau) / 12), dt = f / sr;
    ph += dt; if (ph >= 1) ph -= 1;
    let o;
    if (wave === 0) o = 2 * ph - 1 - polyblep(ph, dt);
    else if (wave === 1) { const q = (ph + 0.5) % 1; o = (ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep(q, dt); }
    else if (wave === 2) o = Math.sin(2 * Math.PI * ph);
    else { ph2 += dt / 2; if (ph2 >= 1) ph2 -= 1; o = Math.sin(2 * Math.PI * ph) * 0.6 + (2 * ph2 - 1 - polyblep(ph2, dt / 2)) * 0.5; }
    let env;                                                            // ADSR on the gate
    if (i < gate) {
      env = i < atk ? i / Math.max(1, atk) : p.bsus + (1 - p.bsus) * Math.exp(-(i - atk) / dtau);
      envAtGate = env;
    } else env = envAtGate * Math.exp(-(i - gate) / Math.max(1, rel / 4.6));
    const fenv = Math.exp(-i / ftau);
    const fc = clamp(p.bcut * Math.pow(2, p.benv * fenv * 6), 20, sr * 0.45);
    const g = Math.tan(Math.PI * fc / sr), a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = o - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;   // TPT state variable filter
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    out[i] = Math.tanh(v2 * env * (1 + p.bdrv * 8));
  }
  return normalize(Math.round(p.bmb) ? multiband(out, p, sr) : out, -1);
}

/* ------------------------------------------------------------ helpers --- */
export function noteName(hz) {
  const m = 69 + 12 * Math.log2(hz / 440), r = Math.round(m);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}
export const centsOff = hz => Math.round((69 + 12 * Math.log2(hz / 440) - Math.round(69 + 12 * Math.log2(hz / 440))) * 100);

// a loop: 16 steps of kicks and basses at bpm (swing 0..1 on the off 16ths), the tails wrapped round so it loops
export function renderLoop(kick, bass, seq, bassLevel, sr = SR) {
  const step = 60 / seq.bpm / 4, n = Math.round(step * 16 * sr), out = new Float32Array(n);
  const add = (src, at, g) => { for (let i = 0; i < src.length; i++) out[(at + i) % n] += src[i] * g; };
  for (let s = 0; s < 16; s++) {
    const at = Math.round((s * step + (s % 2 ? seq.swing * step * 0.5 : 0)) * sr);
    if (seq.k[s]) add(kick, at, 0.8);
    if (seq.b[s]) add(bass, at, 0.8 * bassLevel);
  }
  return normalize(out, -1);
}

export function toWav(data, sr = SR) {
  const n = data.length, bps = 3, buf = new ArrayBuffer(44 + n * bps), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * bps, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * bps, true); v.setUint16(32, bps, true); v.setUint16(34, 24, true); str(36, 'data');
  v.setUint32(40, n * bps, true);
  for (let i = 0, o = 44; i < n; i++, o += 3) {
    const s = Math.round(clamp(data[i], -1, 1) * 8388607);
    v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------------------------------------------------------- bass line --- */
// the bass as a line: one voice through a whole round of steps. A step opens its gate for LEN sixteenths at its
// velocity; a step marked GLIDE slides into the next note without a new attack (its gate held into it). The kick's
// hits (kickAt: frames) duck it: the sidechain. steps: {on, note (semitones above the bass root), vel, len, gl}
export function renderBassLine(p, steps, play, stepFrames, kickAt) {
  const len = play.length, total = Math.round(stepFrames * len), out = new Float32Array(total * 2);
  const root = bassHz(p), wave = Math.round(p.bwave), k = 2 - 1.98 * p.bres;
  const atk = Math.max(1, p.batk / 1000 * SR), dtau = p.bdec / 1000 / 4.6 * SR, rtau = Math.max(1, p.brel / 1000 / 4.6 * SR);
  const ftau = p.bfdec / 1000 / 4.6 * SR, ptau = Math.max(1, p.bpdec / 1000 / 3 * SR), gl = Math.exp(-1 / (p.bglide / 1000 * SR / 3));
  let ph = 0, ph2 = 0, ic1 = 0, ic2 = 0, freq = root, target = root, env = 0, gate = 0, t = 1e9, vel = 1, gateEnd = -1, attacking = 0;
  // the trigs in time order, a pointer walking them (a step's start is rounded: looking it up from the sample by
  // floor(i / stepFrames) missed every step whose start rounded down)
  const trigs = [];
  play.forEach((on, s) => { if (on) trigs.push([Math.round(s * stepFrames), s]); });
  let nx = 0;
  for (let i = 0; i < total * 2; i++) {
    if (i < total) {
      if (nx < trigs.length && trigs[nx][0] === i) {
        const s = trigs[nx++][1];
        const x = steps[s], prev = steps[(s + len - 1) % len], tied = s > 0 && play[s - 1] && prev.gl && gate;
        target = root * Math.pow(2, x.note / 12);
        vel = x.vel;
        if (!tied) { freq = target * Math.pow(2, p.bpitch / 12); t = 0; attacking = 1; }
        gate = 1;
        gateEnd = x.gl ? -1 : i + Math.round(stepFrames * Math.max(0.25, x.len));
      }
    }
    if (gateEnd >= 0 && i >= gateEnd) { gate = 0; gateEnd = -1; }
    t++;
    freq = target + (freq - target) * (t < ptau * 4 && attacking ? Math.exp(-1 / ptau) : gl);
    if (gate) {
      if (attacking) { env += (1 - env) / atk * 3; if (env > 0.98) attacking = 0; }
      else env = p.bsus + (env - p.bsus) * Math.exp(-1 / dtau);
    } else env *= Math.exp(-1 / rtau);
    const dt = freq / SR;
    ph += dt; if (ph >= 1) ph -= 1;
    let o;
    if (wave === 0) o = 2 * ph - 1 - polyblep(ph, dt);
    else if (wave === 1) { const q = (ph + 0.5) % 1; o = (ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep(q, dt); }
    else if (wave === 2) o = Math.sin(2 * Math.PI * ph);
    else { ph2 += dt / 2; if (ph2 >= 1) ph2 -= 1; o = Math.sin(2 * Math.PI * ph) * 0.6 + (2 * ph2 - 1 - polyblep(ph2, dt / 2)) * 0.5; }
    const fc = clamp(p.bcut * Math.pow(2, p.benv * Math.exp(-t / ftau) * 6 * (0.6 + 0.4 * vel)), 20, SR * 0.45);
    const g = Math.tan(Math.PI * fc / SR), a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = o - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    out[i] = Math.tanh(v2 * env * vel * (1 + p.bdrv * 8)) * 0.8;
  }
  let res = Math.round(p.bmb) ? multiband(out, p, SR) : out;
  for (let i = 0; i < res.length; i++) res[i] = Math.tanh(res[i] * 0.8) * 0.85;   // (the multiband can push it hot)
  if (p.bduck > 0 && kickAt && kickAt.length) {                    // the sidechain: under every kick
    const rel = p.bduckr / 1000 * SR;
    for (const at of kickAt) for (let i = 0; i < rel * 3 && at + i < res.length; i++) res[at + i] *= 1 - p.bduck * Math.exp(-i / rel);
  }
  return res;
}
