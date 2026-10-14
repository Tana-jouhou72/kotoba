/* IndexedDB storage — shared by the app and the service worker. */
(function (g) {
  const DB_NAME = 'kotoba';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function all() {
    const db = await open();
    return wrap(db.transaction('cards').objectStore('cards').getAll());
  }

  async function putMany(cards) {
    if (!cards.length) return;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cards', 'readwrite');
      const store = tx.objectStore('cards');
      for (const c of cards) store.put(c);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getKV(key) {
    const db = await open();
    return wrap(db.transaction('kv').objectStore('kv').get(key));
  }

  async function setKV(key, value) {
    const db = await open();
    return wrap(db.transaction('kv', 'readwrite').objectStore('kv').put(value, key));
  }

  g.KDB = { all, putMany, put: (c) => putMany([c]), getKV, setKV };
})(self);
