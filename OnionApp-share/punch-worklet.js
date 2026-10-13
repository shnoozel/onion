// PUNCH: the master bus through one effect at a time, punched in while a pad is held (or latched, or played back from
// the PUNCH lane at exact times). The last 8 s of the mix are always kept in a ring, so a LOOP repeats what just
// played and REVERSE plays it backwards. ECHO's tail rings on after the pad is let go.
const FX = ['LOOP 1/4', 'LOOP 1/8', 'LOOP 1/16', 'LOOP 1/32', 'STUTTER', 'REVERSE', 'TAPE STOP', 'HALF', 'LPF', 'HPF', 'PHONE', 'CRUSH',
  'GATE', 'ECHO', 'FREEZE', 'WOBBLE'];
const LOOPN = [4, 8, 16, 32];                       // loop lengths as notes (1/n)

class Biquad {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(type, f, q) {
    const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (type === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else if (type === 'hp') { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    else { this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; }   // band-pass
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class Punch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = sampleRate * 8;
    this.ring = new Float32Array(this.N);
    this.w = 0;                                    // the ring's write index (it follows the absolute frame)
    this.bpm = 132;
    this.live = -1;                                // a pad held or latched: it wins over the lane
    this.sched = [];                               // the lane's events: {fx, s0, s1} in frames
    this.cur = -1; this.s0 = 0;                    // the effect sounding, the frame it began
    this.mix = 0;                                  // 0 dry .. 1 the effect (a short crossfade either way)
    this.read = 0; this.rate = 1;                  // TAPE STOP / HALF
    this.f = new Biquad(); this.f2 = new Biquad();
    this.held = 0; this.hcount = 0;                // CRUSH
    this.dly = new Float32Array(sampleRate * 2); this.dw = 0;   // ECHO
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'bpm') this.bpm = m.v;
      else if (m.type === 'live') this.live = m.fx;
      else if (m.type === 'sched') this.sched.push({ fx: m.fx, s0: Math.round(m.t0 * sampleRate), s1: Math.round(m.t1 * sampleRate) });
      else if (m.type === 'clear') this.sched.length = 0;
    };
  }
  at(abs) { return this.ring[((abs % this.N) + this.N) % this.N]; }
  atf(pos) { const k = Math.floor(pos), f = pos - k; return this.at(k) * (1 - f) + this.at(k + 1) * f; }
  engage(fx, abs) {
    this.cur = fx; this.s0 = abs; this.read = abs; this.rate = 1;
    this.f = new Biquad(); this.f2 = new Biquad();
    if (fx === 10) { this.f.set('bp', 1400, 1.6); this.f2.set('hp', 400, 0.7); }
    this.port.postMessage({ type: 'on', fx });
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], n = out[0].length;
    const beat = 60 / this.bpm * sampleRate, x16 = beat / 4;
    for (let i = 0; i < n; i++) {
      const abs = currentFrame + i, x = inp.length ? (inp[0][i] + (inp[1] ? inp[1][i] : inp[0][i])) * 0.5 : 0;
      this.ring[abs % this.N] = x;
      let want = this.live;
      if (want < 0) {
        while (this.sched.length && this.sched[0].s1 <= abs) this.sched.shift();
        for (const ev of this.sched) if (abs >= ev.s0 && abs < ev.s1) { want = ev.fx; break; }
      }
      if (want >= 0 && want !== this.cur) this.engage(want, abs);
      if (want < 0 && this.cur >= 0 && this.mix <= 0) { this.port.postMessage({ type: 'off' }); this.cur = -1; }
      this.mix = Math.max(0, Math.min(1, this.mix + (want >= 0 ? 1 : -1) / 96));
      let y = x;
      const t = abs - this.s0, fx = this.cur;
      if (fx >= 0 && fx <= 4 || fx === 14) {                         // the loops: the last L frames, round and round
        const L = fx === 14 ? 2400 : Math.max(64, Math.round(beat * 4 / (fx === 4 ? 16 : LOOPN[fx])));
        const pos = t % L, start = this.s0 - L, xf = Math.min(fx === 14 ? 600 : 96, L / 4);
        y = this.at(start + pos);
        if (pos < xf) y = y * (pos / xf) + this.at(start + pos - L) * (1 - pos / xf);
        if (fx === 4) {                                              // STUTTER: each repeat shorter and softer
          const rep = Math.floor(t / L), g = pos < L * 0.55 ? 1 : Math.max(0, 1 - (pos - L * 0.55) / 64);
          y *= g * Math.pow(0.82, rep);
        }
      } else if (fx === 5) y = this.at(this.s0 - 1 - t);             // REVERSE
      else if (fx === 6 || fx === 7) {                                // TAPE STOP / HALF
        if (fx === 6) this.rate = Math.max(0, 1 - t / (0.75 * sampleRate)); else this.rate = 0.5;
        this.read += this.rate;
        y = this.atf(this.read) * (fx === 6 ? Math.min(1, this.rate * 3) : 1);
      } else if (fx === 8 || fx === 9) {                              // a filter sweeping over a beat
        if ((t & 31) === 0) {
          const k = Math.min(1, t / beat);
          if (fx === 8) this.f.set('lp', 9000 * Math.pow(250 / 9000, k), 3.5); else this.f.set('hp', 30 * Math.pow(2500 / 30, k), 3);
        }
        y = this.f.run(x);
      } else if (fx === 10) y = Math.tanh(this.f2.run(this.f.run(x)) * 4) * 0.7;   // PHONE
      else if (fx === 11) {                                            // CRUSH: 5 bits, a lower rate
        if (this.hcount-- <= 0) { this.held = Math.round(x * 16) / 16; this.hcount = 7; }
        y = this.held;
      } else if (fx === 12) {                                          // GATE: 1/16 on, 1/16 off
        const ph = (t % (x16 * 2)) / x16;
        y = x * (ph < 1 ? Math.min(1, ph * 40) : Math.max(0, 1 - (ph - 1) * 40));
      } else if (fx === 15) {                                          // WOBBLE: a wavering tape
        const d = 600 + 420 * Math.sin(2 * Math.PI * 3.3 * t / sampleRate) + 120 * Math.sin(2 * Math.PI * 0.7 * t / sampleRate);
        y = this.atf(abs - d);
      }
      let o = x + (y - x) * this.mix;
      {                                                                // ECHO: fed while held, its tail rings on
        const D = this.dly.length, dt = Math.min(D - 1, Math.round(beat * 0.75)), r = this.dly[(this.dw - dt + D) % D];
        this.dly[this.dw] = (fx === 13 && this.mix > 0 ? x * this.mix : 0) + r * 0.62;
        this.dw = (this.dw + 1) % D;
        o += r * 0.8;
      }
      for (let c = 0; c < out.length; c++) out[c][i] = o;
    }
    return true;
  }
}
registerProcessor('punch', Punch);
