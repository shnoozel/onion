// the TEXTURE engine (an AudioWorklet): grains of one sound, played where the fingers are. A voice (a finger, a held
// finger, or the SCAN head that moves through the sound at its own speed) sprays grains around its place: each grain a
// short window of the sound, its length SIZE, its start scattered by SPRAY, its pitch PITCH (+ a random DETUNE), maybe
// backwards (REVERSE), panned across WIDTH. DENSITY: how many a second. Then SMEAR: a diffuse space (a feedback delay
// network) that turns grains into a cloud. RESAMPLE: what comes out, recorded.
const MAXG = 96;

class Grains extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = null;
    this.p = { size: 0.12, density: 18, spray: 0.04, shape: 0.5, pitch: 0, detune: 0, reverse: 0, width: 0.6, smear: 0.25, level: 0.8, rate: 0.25, quant: 0,
      position: 0.3, atk: 0.01, rel: 0.25, res: 0.2 };
    this.voices = new Map();                       // id -> { pos (0..1), sizeMul, acc (grains due), gain (fades in / out) }
    this.g = [];                                   // the grains sounding: { pos (samples), inc, n, i, l, r }
    this.scan = { on: false, pos: 0 };
    this.rec = null;
    this.tick = 0;
    // SMEAR: 4 delay lines, mixed by a Householder matrix, damped
    const L = [1031, 1327, 1523, 1871].map(n => Math.round(n * sampleRate / 44100));
    this.fdn = L.map(n => ({ b: new Float32Array(n), i: 0, lp: 0 }));
    this.port.onmessage = e => this.msg(e.data);
  }
  msg(m) {
    if (m.type === 'buf') { this.buf = m.data; this.g = []; }
    else if (m.type === 'p') Object.assign(this.p, m.p);
    else if (m.type === 'v') {                     // a voice: on / moved / off
      // a voice: pos (null: follows POSITION), size (x), st (semitones), cut (0..1: its filter), dens (x), spray (x)
      if (m.on) {
        const v = this.voices.get(m.id) || { acc: 1, gain: 0, n: 0, ic1: [0, 0], ic2: [0, 0], L: new Float32Array(128), R: new Float32Array(128) };
        v.pos = m.pos ?? null; v.sizeMul = m.size ?? 1; v.st = m.st || 0; v.cut = m.cut ?? 1; v.dens = m.dens ?? 1; v.sprayMul = m.spray ?? 1; v.off = false;
        this.voices.set(m.id, v);
      }
      else { const v = this.voices.get(m.id); if (v) v.off = true; }
    } else if (m.type === 'scan') { this.scan.on = m.on; if (m.pos != null) this.scan.pos = m.pos; }
    else if (m.type === 'rec') {
      if (m.on) this.rec = { chunks: [], n: 0 };
      else if (this.rec) {
        const out = new Float32Array(this.rec.n);
        let o = 0;
        for (const c of this.rec.chunks) { out.set(c, o); o += c.length; }
        this.rec = null;
        this.port.postMessage({ type: 'rec', data: out }, [out.buffer]);
      }
    }
  }
  spawn(v, pos, gain) {
    if (!this.buf || this.g.length >= MAXG) return;
    const p = this.p, N = this.buf.length;
    const n = Math.max(64, Math.round(p.size * v.sizeMul * sampleRate));
    let st = p.pitch + (Math.random() * 2 - 1) * p.detune;
    if (p.quant) st = Math.round(st / p.quant) * p.quant;   // the random pitch kept on a set of steps (an octave, a fifth)
    const rev = Math.random() < p.reverse;
    const inc = Math.pow(2, (st + (v.st || 0)) / 12) * (rev ? -1 : 1);
    let at = (pos + (Math.random() * 2 - 1) * p.spray * (v.sprayMul ?? 1)) * N;
    if (rev) at += n * Math.abs(inc);
    at = ((at % N) + N) % N;
    const pan = 0.5 + (Math.random() - 0.5) * p.width;
    v.n++;
    this.g.push({ v, pos: at, inc, n, i: 0, l: Math.cos(pan * Math.PI / 2) * gain, r: Math.sin(pan * Math.PI / 2) * gain });
  }
  // the window: SHAPE 0 = a soft bell (Hann), 1 = nearly square (a sharp, clicky grain)
  win(x) {
    const s = this.p.shape, t = 0.5 - 0.48 * s;    // the fade at each end, as a part of the grain
    if (x < t) return 0.5 - 0.5 * Math.cos(Math.PI * x / t);
    if (x > 1 - t) return 0.5 - 0.5 * Math.cos(Math.PI * (1 - x) / t);
    return 1;
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, p = this.p;
    if (!this.buf) return true;
    const N = this.buf.length, d = this.buf;
    // the voices: grains due this block (DENSITY a second, a little uneven); each fades in by ATTACK, out by RELEASE
    if (this.scan.on) { this.p.position = ((this.p.position + p.rate * n / N) % 1 + 1) % 1; }
    if (this.scan.on && !this.voices.has('scan')) this.voices.set('scan', { acc: 1, gain: 0, n: 0, ic1: [0, 0], ic2: [0, 0], L: new Float32Array(128), R: new Float32Array(128), pos: null, sizeMul: 1, st: 0, cut: 1, dens: 1, sprayMul: 1, off: false });
    if (this.voices.has('scan')) this.voices.get('scan').off = !this.scan.on;
    const atk = n / (Math.max(0.002, p.atk) * sampleRate), rel = n / (Math.max(0.005, p.rel) * sampleRate);
    for (const [id, v] of this.voices) {
      v.gain = v.off ? v.gain - rel : Math.min(1, v.gain + atk);
      if (v.gain <= 0 && v.n <= 0) { this.voices.delete(id); continue; }
      v.L.fill(0); v.R.fill(0);
      if (v.gain <= 0) continue;
      v.acc += p.density * v.dens * n / sampleRate * (0.7 + Math.random() * 0.6);
      while (v.acc >= 1) { v.acc -= 1; this.spawn(v, v.pos ?? p.position, v.gain * 0.5 / Math.sqrt(Math.max(1, p.density * v.dens * p.size * v.sizeMul * 0.5))); }
    }
    for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
    for (let k = this.g.length - 1; k >= 0; k--) {
      const g = this.g[k], vL = g.v.L, vR = g.v.R;
      for (let i = 0; i < n && g.i < g.n; i++, g.i++) {
        const q = Math.floor(g.pos), f = g.pos - q, a = d[q] || 0, b = d[q + 1 < N ? q + 1 : 0] || 0;
        const s = (a + (b - a) * f) * this.win(g.i / g.n);
        vL[i] += s * g.l; vR[i] += s * g.r;
        g.pos += g.inc; if (g.pos >= N) g.pos -= N; else if (g.pos < 0) g.pos += N;
      }
      if (g.i >= g.n) { g.v.n--; this.g.splice(k, 1); }
    }
    // each voice through its own filter (a low pass, its CUT from the finger), then summed
    const k2 = 2 - 1.9 * p.res;
    for (const v of this.voices.values()) {
      const fc = 60 * Math.pow(300, v.cut), gg = Math.tan(Math.PI * Math.min(fc, sampleRate * 0.45) / sampleRate), a1 = 1 / (1 + gg * (gg + k2)), a2 = gg * a1, a3 = gg * a2;
      const open = v.cut > 0.995;
      for (const [ch, buf, o] of [[0, v.L, L], [1, v.R, R]]) {
        let ic1 = v.ic1[ch], ic2 = v.ic2[ch];
        for (let i = 0; i < n; i++) {
          if (open) { o[i] += buf[i]; continue; }
          const v3 = buf[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2; o[i] += v2;
        }
        v.ic1[ch] = ic1; v.ic2[ch] = ic2;
      }
    }
    // SMEAR: the grains into a space (more of it: longer, and more of it heard)
    const sm = p.smear, fb = 0.55 + sm * 0.42, wet = sm * 0.9, damp = 0.35;
    if (sm > 0.001) for (let i = 0; i < n; i++) {
      const x = (L[i] + R[i]) * 0.5, o = this.fdn.map(l => l.b[l.i]), s = (o[0] + o[1] + o[2] + o[3]) * 0.5;
      this.fdn.forEach((l, j) => { l.lp += (o[j] - s - l.lp) * (1 - damp); l.b[l.i] = x + l.lp * fb; l.i = (l.i + 1) % l.b.length; });
      L[i] = L[i] * (1 - wet * 0.5) + (o[0] + o[2]) * wet * 0.6; R[i] = R[i] * (1 - wet * 0.5) + (o[1] + o[3]) * wet * 0.6;
    }
    for (let i = 0; i < n; i++) { L[i] = Math.tanh(L[i] * p.level * 1.2); R[i] = Math.tanh(R[i] * p.level * 1.2); }
    if (this.rec) { const m = new Float32Array(n); for (let i = 0; i < n; i++) m[i] = (L[i] + R[i]) * 0.5; this.rec.chunks.push(m); this.rec.n += n; }
    if (++this.tick % 12 === 0) {                  // what to draw: the grains (where they are) and the scan head
      this.port.postMessage({ type: 'show', g: this.g.map(g => g.pos / N), scan: this.scan.on ? this.p.position : -1, position: this.p.position });
    }
    return true;
  }
}
registerProcessor('grains', Grains);
