// the library: every sound made here, kept in the browser's IndexedDB (on this device), as WAV plus the
// parameters that made it (so a kick can be loaded back into the generator and changed)
const DB = 'onion-library', STORE = 'sounds';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
    const out = fn(st);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
export const libAdd = item => tx('readwrite', st => st.put(item));
export const libDel = id => tx('readwrite', st => st.delete(id));
export const libAll = async () => (await tx('readonly', st => st.getAll())).sort((a, b) => b.created - a.created);
export const libGet = id => tx('readonly', st => st.get(id));
