// One line's sound to Gemini's speech-to-text model, with the user's own API key (gemini.js keeps it), for a second
// opinion on a line that was heard wrongly. Unlike the AI correction, this sends audio: only the samples of the one
// line, never the whole recording, and only when asked for.
//
// It uses the streaming model ("Live"): on the free tier it has no daily limit on requests, where the one-request
// model allows 25 a day (the limits shown for a free key, 28 Nov 2026), and it takes the 16 kHz mono samples the
// editor already has. The protocol is from Google's "Live transcription" page as read on 28 Nov 2026; what that
// page leaves open (a setup acknowledgement, what ends a turn) is handled both ways below.

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const LIVE_MODEL = 'gemini-3.5-transcribe-live';
export const SAMPLE_RATE = 16000;
/** 100 ms of audio per message, as the page recommends. */
export const CHUNK = SAMPLE_RATE / 10;
const LANG_CODES = { sr: 'sr-RS', en: 'en-US' };

/** Samples (-1…1) as 16-bit little-endian PCM in base64, [CHUNK] samples per piece. */
export function pcmChunks(pcm, size = CHUNK) {
  const out = [];
  for (let at = 0; at < pcm.length; at += size) {
    const n = Math.min(size, pcm.length - at);
    const bytes = new Uint8Array(n * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, pcm[at + i]));
      view.setInt16(i * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    out.push(btoa(bin));
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function textOf(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text(); // a Blob: some servers answer in binary frames
  return String(data ?? '');
}

/**
 * Gemini's text a little cleaned: a space after a sentence's end and where the script changes, as its pieces
 * sometimes come glued (28 Nov 2026, a 22-minute test: "posustaje.i", "важноšto").
 */
export function tidyHeard(text) {
  return String(text ?? '')
    .replace(/([.!?])(?=\p{L})/gu, '$1 ')
    .replace(/(\p{Script=Cyrillic})(?=\p{Script=Latin})|(\p{Script=Latin})(?=\p{Script=Cyrillic})/gu, '$1$2 ')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUOTA = /exhaust|quota|1011|429|rate/i;
/** True for Google's "too much at once" (the free tier's 20K tokens a minute), after which a pause helps. */
export const isQuota = (e) => QUOTA.test(e?.message || String(e ?? ''));

/**
 * One connection that hears lines one after another: the setup is paid once, not per line. Measured on 28 Nov
 * 2026 (Milica 2, ten lines in one session): after a line's audio and "audioStreamEnd" the line's text arrives as
 * one final piece, then "generationComplete" 336–553 ms after the end, and the same socket takes the next line.
 * A session is renewed before Google's 10-minute limit.
 */
export class LiveSession {
  /**
   * @param {string} key the API key
   * @param {object} [o]
   * @param {number} [o.gapMs] a fixed gap per 100 ms piece; without it the pace follows [o.budgetSec]
   * @param {number} [o.budgetSec] audio seconds a minute sent fast (8x); more than that goes at 2x. 8 minutes at 8x
   *   ended in "1011 Resource has been exhausted" after 20 s, 22 minutes at 2x went through (28 Nov 2026).
   */
  constructor(key, {
    lang = 'sr', vocabulary = [], WebSocketCtor = globalThis.WebSocket, gapMs = null, budgetSec = 120,
    setupWaitMs = 1500, idleMs = 4000, lineMaxMs = 60000, maxAgeMs = 9 * 60000, now = () => Date.now(),
  } = {}) {
    Object.assign(this, { key, lang, vocabulary, WebSocketCtor, gapMs, budgetSec, setupWaitMs, idleMs, lineMaxMs, maxAgeMs, now });
    this.ws = null;
    this.ready = null; // a promise: the connection open and set up
    this.openedAt = 0;
    this.line = null;  // the line being heard: {finals, interim, sent, done, fail, idle}
    this.sentLog = []; // [time, audio seconds] of the last minute, for the pace
    this.closed = true;
  }

  #connect() {
    const ws = new this.WebSocketCtor(`${ENDPOINT}?key=${encodeURIComponent(this.key)}`);
    this.ws = ws;
    this.closed = false;
    this.openedAt = this.now();
    this.ready = new Promise((resolve, reject) => {
      let up = false;
      const go = () => { if (!up && ws === this.ws && !this.closed) { up = true; resolve(); } };
      ws.onopen = () => {
        const transcription = { languageCodes: [LANG_CODES[this.lang] ?? LANG_CODES.sr] };
        if (this.vocabulary.length) transcription.customVocabulary = this.vocabulary.slice(0, 100);
        ws.send(JSON.stringify({ setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: transcription,
        } }));
        // The page's example sends audio right after the setup; other Live models first answer "setupComplete".
        setTimeout(go, this.setupWaitMs);
      };
      ws.onmessage = async (e) => {
        let m;
        try { m = JSON.parse(await textOf(e.data)); } catch { return; }
        if (ws !== this.ws) return;
        if (m.error) { const err = new Error(String(m.error.message || m.error.status || 'error')); this.#drop(err); reject(err); return; }
        if (m.setupComplete) go();
        this.#message(m.serverContent);
      };
      ws.onerror = () => { if (ws === this.ws) { const err = new Error('network'); this.#drop(err); reject(err); } };
      ws.onclose = (e) => {
        if (ws !== this.ws) return;
        const err = new Error(`${e?.code ?? ''} ${e?.reason ?? ''}`.trim() || 'closed');
        this.#drop(err, true);
        reject(err);
      };
    });
    this.ready.catch(() => {}); // a failure is reported through hear()
  }

  /** The connection is gone: the line being heard ends with what it has, or fails. */
  #drop(err, closing = false) {
    this.closed = true;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    const l = this.line;
    if (!l) return;
    if (closing && l.sent && (l.finals.length || l.interim)) l.done();
    else l.fail(err);
  }

  #message(c) {
    const l = this.line;
    if (!l || !c) return;
    let text = false;
    if (c.inputTranscription?.text) { l.finals.push(String(c.inputTranscription.text)); text = true; }
    if (c.interimInputTranscription?.text) { l.interim = String(c.interimInputTranscription.text); text = true; }
    if (!l.sent) return;
    if (c.turnComplete || c.generationComplete) { clearTimeout(l.idle); l.idle = setTimeout(l.done, 150); }
    // only text keeps it waiting: a "voiceActivity" message comes in the same instant as the end mark
    else if (text) l.quiet();
  }

  /** Seconds of audio sent in the last minute. */
  #recent() {
    const since = this.now() - 60000;
    this.sentLog = this.sentLog.filter(([t]) => t >= since);
    return this.sentLog.reduce((a, [, sec]) => a + sec, 0);
  }

  /** Resolves with the text heard in [pcm] ("" when nothing); rejects with the reason. One line at a time. */
  async hear(pcm, { signal } = {}) {
    if (this.busy) throw new Error('busy');
    this.busy = true;
    try { return await this.#hear(pcm, signal); } finally { this.busy = false; }
  }

  async #hear(pcm, signal) {
    if (this.closed || this.now() - this.openedAt > this.maxAgeMs) { this.close(); this.#connect(); }
    await this.ready;
    const sec = pcm.length / SAMPLE_RATE;
    const gap = this.gapMs ?? (this.#recent() + sec > this.budgetSec ? 50 : 12);
    this.sentLog.push([this.now(), sec]);
    return new Promise((resolve, reject) => {
      const l = { finals: [], interim: '', sent: false, idle: 0 };
      let over = false;
      const end = (fn, v) => {
        if (over) return;
        over = true;
        clearTimeout(l.idle);
        clearTimeout(limit);
        if (this.line === l) this.line = null;
        fn(v);
      };
      l.done = () => end(resolve, (l.finals.join(' ').trim() || l.interim.trim()).replace(/\s+/g, ' '));
      l.fail = (e) => end(reject, e);
      l.quiet = () => { clearTimeout(l.idle); l.idle = setTimeout(l.done, this.idleMs); };
      const limit = setTimeout(() => (l.sent ? l.done() : l.fail(new Error('timeout'))), this.lineMaxMs);
      signal?.addEventListener('abort', () => { l.fail(new Error('aborted')); this.close(); }, { once: true });
      this.line = l;
      (async () => {
        const ws = this.ws;
        for (const data of pcmChunks(pcm)) {
          if (over || ws !== this.ws) return;
          ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` } } }));
          if (gap) await sleep(gap);
        }
        if (over || ws !== this.ws) return;
        ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        l.sent = true;
        l.quiet(); // no end mark is promised: silence from the server ends it too
      })();
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.closed = true;
    try { ws?.close(); } catch { /* already closed */ }
    this.line?.fail(new Error('closed'));
  }
}

/**
 * Sends [pcm] (16 kHz mono samples) on a connection of its own and resolves with the text Gemini heard ("" when it
 * heard nothing). Rejects with an Error whose message says why: "network", or the server's close code and reason.
 */
export async function transcribeLive(key, pcm, {
  lang = 'sr', vocabulary = [], signal, WebSocketCtor = globalThis.WebSocket,
  chunkGapMs = 12, setupWaitMs = 1500, idleMs = 4000, maxMs = 60000,
} = {}) {
  const s = new LiveSession(key, { lang, vocabulary, WebSocketCtor, gapMs: chunkGapMs, setupWaitMs, idleMs, lineMaxMs: maxMs });
  try { return await s.hear(pcm, { signal }); } finally { s.close(); }
}
