// The speech model's files in the browser's private file storage (OPFS). Used by transformers.js as its cache
// (match/put like the Web Cache API), because the Cache API refused the 350 MB encoder (25 Nov 2026 test:
// "Unexpected internal error"). Works in the page and in the worker.

const DIR = 'model-cache';

const fileName = (key) => String(key instanceof Request ? key.url : key).replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_');

async function dir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

/** Files being written in this context: transformers.js asks for some files twice in parallel. */
const writing = new Set();

export const opfsCache = {
  async match(key) {
    const name = fileName(key);
    if (writing.has(name)) return undefined;
    try {
      const file = await (await (await dir()).getFileHandle(name)).getFile();
      // A file is created empty and filled only when its writer closes, so an empty one is unfinished
      // (being written elsewhere, or a download that was cut off).
      if (file.size === 0) return undefined;
      return new Response(file, { status: 200, headers: { 'content-length': String(file.size) } });
    } catch {
      return undefined;
    }
  },
  async put(key, response) {
    const name = fileName(key);
    if (writing.has(name)) return;
    writing.add(name);
    try {
      const handle = await (await dir()).getFileHandle(name, { create: true });
      // createWritable writes to a swap file that replaces the file only on close: an interrupted download leaves
      // no half file behind.
      const w = await handle.createWritable();
      try {
        await response.body.pipeTo(w);
      } catch (e) {
        await w.abort().catch(() => {});
        throw e;
      }
    } finally {
      writing.delete(name);
    }
  },
};

/** The stored files, as [{name, size}]; [] when there are none or the browser has no OPFS. */
export async function storedFiles() {
  try {
    const d = await dir(false);
    const out = [];
    for await (const [name, h] of d.entries()) if (h.kind === 'file') out.push({ name, size: (await h.getFile()).size });
    return out;
  } catch {
    return [];
  }
}

/** Deletes every stored model file. */
export async function clearStored() {
  try { await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true }); } catch { /* none */ }
}
