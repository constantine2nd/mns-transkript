// Runs Whisper on the graphics card (WebGPU) off the page's thread. Messages:
//   in:  {type: 'load'}                       out: {type: 'progress', file, loaded, total} …, then {type: 'ready'}
//   in:  {type: 'run', id, pcm: Float32Array, lang: 'sr'|'en'}  out: {type: 'result', id, chunks: [{timestamp: [s, e], text}]}
//   out on any failure: {type: 'error', id?, message}
// The model comes from Hugging Face once and is then read from the browser's private storage (opfs.js).
// The recording never leaves this worker: nothing but the model files is fetched.

import { pipeline, env } from './vendor/transformers.min.js';
import { opfsCache } from './opfs.js';
import { MODEL, REVISION, DTYPE } from './asr-model.js';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.useFSCache = false;
env.useCustomCache = true;
env.customCache = opfsCache;
env.backends.onnx.wasm.wasmPaths = new URL('vendor/ort/', self.location.href).href;

let asr = null;

// 25 Nov 2026, first run on the live site: the 566 MB download broke off at 57 MB ("network error") and went
// through on the next try. Files already complete stay stored, so a retry fetches only what is missing.
const LOAD_TRIES = 3;
const isNetwork = (e) => /network|fetch|load failed|ERR_/i.test(e?.message || String(e));

async function load() {
  if (asr) { self.postMessage({ type: 'ready' }); return; }
  for (let attempt = 1; ; attempt++) {
    try {
      asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: 'webgpu',
        dtype: DTYPE,
        revision: REVISION,
        progress_callback: (p) => {
          if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
        },
      });
      break;
    } catch (e) {
      if (!isNetwork(e)) throw e;
      if (attempt >= LOAD_TRIES) throw new Error(`network: ${e.message || e}`);
      self.postMessage({ type: 'retry', attempt });
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  self.postMessage({ type: 'ready' });
}

/**
 * The app's language codes as Whisper's names. Always set: given no language, transformers.js 3.8 does not detect
 * one but decodes as English (25 Nov 2026: a Serbian clip came out as an English paraphrase), so there is no "auto".
 */
const LANGUAGES = { sr: 'serbian', en: 'english' };

async function run(id, pcm, lang) {
  // 27 s windows at most (speech.js), so the model sees one 30 s window and needs no chunking of its own.
  const opts = { task: 'transcribe', return_timestamps: true, language: LANGUAGES[lang] ?? LANGUAGES.sr };
  const r = await asr(pcm, opts);
  const chunks = r.chunks?.length ? r.chunks : [{ timestamp: [0, null], text: r.text ?? '' }];
  self.postMessage({ type: 'result', id, chunks: chunks.map((c) => ({ timestamp: c.timestamp, text: c.text })) });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') await load();
    else if (m.type === 'run') await run(m.id, m.pcm, m.lang);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
  }
};
