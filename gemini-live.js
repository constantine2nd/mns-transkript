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
 * Sends [pcm] (16 kHz mono samples) and resolves with the text Gemini heard ("" when it heard nothing).
 * Rejects with an Error whose message says why: "network", or the server's close code and reason.
 * @param {string} key the API key
 * @param {Float32Array} pcm
 * @param {object} [o] lang "sr"|"en"; vocabulary: names to listen for; the rest is for tests
 */
export function transcribeLive(key, pcm, {
  lang = 'sr', vocabulary = [], signal, WebSocketCtor = globalThis.WebSocket,
  chunkGapMs = 12, setupWaitMs = 1500, idleMs = 4000, maxMs = 60000,
} = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(`${ENDPOINT}?key=${encodeURIComponent(key)}`);
    const finals = [];
    let interim = '';
    let started = false;
    let sent = false;
    let over = false;
    let idle = 0;
    const end = (fn, value) => {
      if (over) return;
      over = true;
      clearTimeout(idle);
      clearTimeout(limit);
      try { ws.close(); } catch { /* already closed */ }
      fn(value);
    };
    const finish = () => end(resolve, (finals.join(' ').trim() || interim.trim()).replace(/\s+/g, ' '));
    const fail = (why) => end(reject, new Error(why));
    const limit = setTimeout(() => (sent ? finish() : fail('timeout')), maxMs);
    const quiet = () => { clearTimeout(idle); idle = setTimeout(finish, idleMs); };
    signal?.addEventListener('abort', () => fail('aborted'), { once: true });

    // The audio goes out faster than it plays: the page says nothing against it, and a line should not take its
    // own length to send. A short gap per piece keeps the socket's buffer small.
    const begin = async () => {
      if (started || over) return;
      started = true;
      for (const data of pcmChunks(pcm)) {
        if (over) return;
        ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` } } }));
        if (chunkGapMs) await sleep(chunkGapMs);
      }
      if (over) return;
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      sent = true;
      quiet(); // no "finished" message is promised: silence from the server ends it too
    };

    ws.onopen = () => {
      const transcription = { languageCodes: [LANG_CODES[lang] ?? LANG_CODES.sr] };
      if (vocabulary.length) transcription.customVocabulary = vocabulary.slice(0, 100);
      ws.send(JSON.stringify({ setup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: transcription,
      } }));
      // The page's example sends audio right after the setup; other Live models first answer "setupComplete".
      // Whichever comes first starts the audio.
      setTimeout(begin, setupWaitMs);
    };
    ws.onmessage = async (e) => {
      let m;
      try { m = JSON.parse(await textOf(e.data)); } catch { return; }
      if (over) return;
      if (m.error) { fail(String(m.error.message || m.error.status || 'error')); return; }
      if (m.setupComplete) begin();
      const c = m.serverContent;
      if (c?.inputTranscription?.text) finals.push(String(c.inputTranscription.text));
      if (c?.interimInputTranscription?.text) interim = String(c.interimInputTranscription.text);
      if (sent) {
        if (c?.turnComplete || c?.generationComplete) { clearTimeout(idle); idle = setTimeout(finish, 300); } else quiet();
      }
    };
    ws.onerror = () => fail('network');
    ws.onclose = (e) => {
      if (over) return;
      if (sent && (finals.length || interim)) finish();
      else fail(`${e?.code ?? ''} ${e?.reason ?? ''}`.trim() || 'closed');
    };
  });
}
