// Minimalny wrapper na IndexedDB: karty + klucz-wartość (ustawienia, dni, oczekujące analizy).
const DB_NAME = 'fr-clips';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const cards = {
  all: () => tx('cards', 'readonly', s => s.getAll()),
  put: card => tx('cards', 'readwrite', s => s.put(card)),
  putMany: list => tx('cards', 'readwrite', s => { list.forEach(c => s.put(c)); }),
  remove: id => tx('cards', 'readwrite', s => s.delete(id)),
  clear: () => tx('cards', 'readwrite', s => s.clear()),
};

export const kv = {
  get: key => tx('kv', 'readonly', s => s.get(key)),
  set: (key, value) => tx('kv', 'readwrite', s => s.put(value, key)),
  remove: key => tx('kv', 'readwrite', s => s.delete(key)),
};
