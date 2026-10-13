// everything this device has made, as one file, and back: the patterns and settings (the onion-* keys of
// localStorage), the library (its sounds as WAV), and the breaks and textures that come with the app (as library
// sounds, so a copy of the app without them still has them). Saved through the share sheet (iPhone: Save to Files /
// AirDrop), loaded from a file: a way to carry it all from one address of the app to another, or keep it safe.
import { libAdd, libAll } from './lib.js';
import { toast } from './ui.js';
import { BREAKS } from './slicer.js';
import { TEXTURES } from './texture.js';

const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
const unb64 = (s, type) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
const fileId = url => 'file:' + url;

export async function exportAll() {
  toast('PACKING…', 6000);
  const keys = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('onion-')) keys[k] = localStorage.getItem(k); }
  const sounds = [];
  for (const it of await libAll()) sounds.push({ ...it, wav: await b64(it.wav), type: it.wav.type || 'audio/wav' });
  // the app's own breaks and textures, as library sounds; what pointed at them now points at those
  const have = new Set(sounds.map(s => s.id));
  for (const [list, kind] of [[BREAKS, 'break'], [TEXTURES, 'tex']]) {
    for (const f of list) {
      if (have.has(fileId(f.url))) continue;
      try {
        const blob = await (await fetch(f.url)).blob();
        sounds.push({ id: fileId(f.url), name: f.name, kind: kind === 'break' ? 'import' : 'texture-src', created: Date.now() - 1e6, sr: 48000, ms: 0, note: kind.toUpperCase(), peaks: [], wav: await b64(blob), type: blob.type || 'audio/wav' });
      } catch (e) { /* not here */ }
    }
  }
  for (const k of ['onion-slicer', 'onion-tex']) {
    try {
      const s = JSON.parse(keys[k] || 'null');
      if (s && s.srcRef && (s.srcRef.kind === 'break' || s.srcRef.kind === 'tex')) { s.srcRef = { kind: 'lib', id: fileId(s.srcRef.url) }; keys[k] = JSON.stringify(s); }
    } catch (e) { /* leave it */ }
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = new File([JSON.stringify({ onion: 1, made: Date.now(), keys, sounds })], `onion-${stamp}.onion.json`, { type: 'application/json' });
  const mb = (file.size / 1e6).toFixed(1);
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Onion Sampler' }); toast('SAVED · ' + mb + ' MB'); return; }
    catch (e) { if (e.name === 'AbortError') { toast('NOT SAVED'); return; } }
  }
  const a = document.createElement('a');                  // (no share sheet: a download)
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('SAVED · ' + mb + ' MB');
}

export async function importAll(file) {
  toast('UNPACKING…', 8000);
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { toast('NOT AN ONION FILE'); return; }
  if (!d || d.onion !== 1) { toast('NOT AN ONION FILE'); return; }
  for (const s of d.sounds || []) {
    const { type, ...it } = s;
    await libAdd({ ...it, wav: unb64(s.wav, type || 'audio/wav') });
  }
  for (const [k, v] of Object.entries(d.keys || {})) localStorage.setItem(k, v);
  toast('LOADED ' + (d.sounds || []).length + ' SOUNDS · RESTARTING', 2500);
  setTimeout(() => location.reload(), 1200);
}
