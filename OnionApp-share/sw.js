// the app without a network (a train): every file of it kept on the device the first time it opens, then served
// from there; a new version (a new BUILD below) replaces them the next time it opens with a network. Registered only
// on a real https address (not the Mac's own dev server)
const BUILD = '20261013024613';
const CACHE = 'onion-' + BUILD;
const FILES = ['./', 'index.html', 'style.css', 'manifest.json', 'app.js', 'audio.js', 'dsp.js', 'lib.js', 'mixer.js', 'punch.js', 'punch-worklet.js',
  'seqcore.js', 'slicer.js', 'acid.js', 'texture.js', 'grain-worklet.js', 'fxpanel.js', 'backup.js', 'ui.js', 'icons/icon-180.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// the app's files from the cache (whatever ?v= they ask with); anything else (the font, a break) fetched and kept
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match('index.html'))));
});
