// IndexedDB persistence: one "docs" record per transcript id (the JSON and fingerprints), the audio Blob
// apart in "audio" so autosaving text never rewrites the recording.

// Per brand (brand.js): two brands on one origin must not see each other's transcripts.
const DB_NAME = globalThis.BRAND?.storage ?? 'transkript';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/**
 * Doc record: {id, title, createdAt, durationMs, transcript, loadedFp, baseFp, baseSegs, currentFp, hasAudio, savedAt}.
 */
export function getDoc(id) {
  return tx(['docs'], 'readonly', (t) => req2p(t.objectStore('docs').get(id)));
}

export function putDoc(doc) {
  return tx(['docs'], 'readwrite', (t) => { t.objectStore('docs').put(doc); });
}

export function listDocs() {
  return tx(['docs'], 'readonly', (t) => req2p(t.objectStore('docs').getAll()));
}

export function getAudio(id) {
  return tx(['audio'], 'readonly', (t) => req2p(t.objectStore('audio').get(id)));
}

/** Saves the doc and, when given, its audio, in one transaction. */
export function putDocWithAudio(doc, audioBlob) {
  return tx(['docs', 'audio'], 'readwrite', (t) => {
    t.objectStore('docs').put(doc);
    if (audioBlob) t.objectStore('audio').put(audioBlob, doc.id);
  });
}

export function deleteDoc(id) {
  return tx(['docs', 'audio'], 'readwrite', (t) => {
    t.objectStore('docs').delete(id);
    t.objectStore('audio').delete(id);
  });
}

/** Asks the browser not to evict the stored transcripts under storage pressure. */
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* optional */ }
}
