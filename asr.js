// The page's side of in-browser transcription: can this browser do it, the audio as 16 kHz mono, and the worker
// that runs the model (asr-worker.js).

import { SAMPLE_RATE } from './speech.js';
import { storedFiles, clearStored } from './opfs.js';
import { BIG_FILES } from './asr-model.js';

/**
 * Whether this browser can transcribe, and if not, the i18n key saying why.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function support() {
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || typeof Worker === 'undefined') return { ok: false, reason: 'asrNoBrowser' };
  if (!navigator.gpu) return { ok: false, reason: 'asrNoWebgpu' };
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter(); } catch { /* none */ }
  if (!adapter) return { ok: false, reason: 'asrNoAdapter' };
  if (!adapter.features.has('shader-f16')) return { ok: false, reason: 'asrNoF16' };
  // Chrome reports up to 8 (GB); the model and a long recording need about 2 GB.
  if (navigator.deviceMemory && navigator.deviceMemory < 4) return { ok: false, reason: 'asrLowMemory' };
  return { ok: true };
}

/** Whether the model is already stored here, and how many bytes it takes. */
export async function modelState() {
  const files = await storedFiles();
  const bytes = files.reduce((n, f) => n + f.size, 0);
  // An empty file is a download that was cut off (opfs.js creates it before writing): not downloaded.
  const downloaded = BIG_FILES.every((b) => files.some((f) => f.name.endsWith(b) && f.size > 0));
  return { downloaded, bytes };
}

export const deleteModel = clearStored;

/** The recording as 16 kHz mono samples (channels averaged). */
export async function decodeAudio(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(buf);
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / audio.numberOfChannels;
  }
  return out;
}

/** One worker with the model loaded in it. */
export class Transcriber {
  constructor() {
    this.worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
    this.waiting = new Map();
    this.nextId = 1;
    this.onProgress = null;
    this.worker.onmessage = (e) => this.#message(e.data);
    this.worker.onerror = (e) => this.#failAll(e.message || 'worker');
  }

  #message(m) {
    if (m.type === 'progress' || m.type === 'retry') { this.onProgress?.(m); return; }
    const key = m.type === 'ready' || (m.type === 'error' && m.id == null) ? 'load' : m.id;
    const w = this.waiting.get(key);
    if (!w) return;
    this.waiting.delete(key);
    if (m.type === 'error') w.reject(new Error(m.message));
    else w.resolve(m.type === 'result' ? m.chunks : undefined);
  }

  #failAll(message) {
    for (const w of this.waiting.values()) w.reject(new Error(message));
    this.waiting.clear();
  }

  /** Loads (downloading the first time) the model. onProgress gets {type: 'progress', file, loaded, total} per file, and {type: 'retry', attempt} when a broken download starts again. */
  load(onProgress) {
    this.onProgress = onProgress;
    return new Promise((resolve, reject) => {
      this.waiting.set('load', { resolve, reject });
      this.worker.postMessage({ type: 'load' });
    });
  }

  /**
   * The model's pieces for one window of samples: [{timestamp: [s, e], text}], seconds from the window's start.
   * @param {string} [lang] 'sr' (default) or 'en'
   */
  run(pcm, lang = 'sr') {
    const id = this.nextId++;
    const copy = pcm.slice(); // the window's own buffer, handed over to the worker
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, pcm: copy, lang }, [copy.buffer]);
    });
  }

  terminate() {
    this.#failAll('stopped');
    this.worker.terminate();
  }
}
