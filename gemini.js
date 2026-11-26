// Sending the AI-correction request straight to Gemini with the user's own API key, instead of copying it into a
// chat. Only the transcript's text is sent (the same "#NNN text" lines as the copy-and-paste request), never the
// recording. The key is kept in this browser's localStorage and goes only to Google, in a header.

const API = 'https://generativelanguage.googleapis.com/v1beta';
const STORE_KEY = `${globalThis.BRAND?.storage ?? 'transkript'}-gemini`; // per brand (brand.js)
/**
 * Used only until the key's model list is known; then the newest Flash model on the list is picked
 * (25 Nov 2026 free tier: 3.8 Flash and 3.6 Flash, 5 requests/min and 20/day; 3.5 Flash Lite, 15/min and 500/day).
 */
export const DEFAULT_MODEL = 'gemini-flash-latest';
/** A "too many requests" reply that asks to wait at most this long is retried once, after the wait. */
export const MAX_RETRY_WAIT_MS = 60_000;
/** Waits before retrying an overloaded model (500/503): 25 Nov 2026, every Flash request answered "overloaded". */
export const BUSY_RETRY_MS = [5_000, 15_000];
/** A long call (28 min, ~290 lines) is about 8k output tokens; the rest is room for the model's thinking. */
const MAX_OUTPUT_TOKENS = 65536;
/** Rounds of "continue from #NNN" when an answer stops early. */
export const MAX_ROUNDS = 5;

export class GeminiError extends Error {
  /** @param {string} code an i18n key  @param {string} [detail] */
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

/** {key, model, models} or null; models is the list last read for the key ([{id, label}]). */
export function loadSettings(storage = globalThis.localStorage) {
  try {
    const s = JSON.parse(storage.getItem(STORE_KEY) || 'null');
    if (!s || typeof s.key !== 'string' || !s.key) return null;
    const models = Array.isArray(s.models) ? s.models.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, label: String(m.label || m.id) })) : [];
    return { key: s.key, model: String(s.model || DEFAULT_MODEL), models };
  } catch {
    return null;
  }
}

export function saveSettings(s, storage = globalThis.localStorage) {
  storage.setItem(STORE_KEY, JSON.stringify({ key: s.key, model: s.model, models: s.models ?? [] }));
}

export function clearSettings(storage = globalThis.localStorage) {
  storage.removeItem(STORE_KEY);
}

/** "AIza…xY12": enough to recognise the key, not enough to use it. */
export function maskKey(key) {
  return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…';
}

/** An HTTP failure as an i18n code: a bad key, no access, quota, overloaded, or other. */
export function errorCode(status, body) {
  const reason = JSON.stringify(body?.error?.details ?? '') + ' ' + String(body?.error?.message ?? '');
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(reason)) return 'gemBadKey';
  if (status === 401 || status === 403) return 'gemBadKey';
  if (status === 404) return 'gemNoModel';
  if (status === 429) {
    // "limit: 0": the key's tier has no requests at all for this model (25 Nov 2026: gemini-4-neon on the free tier).
    if (/limit:\s*0\b/.test(reason)) return 'gemNotInTier';
    const wait = retryDelayMs(body);
    if (wait != null && wait > MAX_RETRY_WAIT_MS) return 'gemQuotaDay';
    return 'gemQuota';
  }
  if (status === 504) return 'gemTimeout';
  if (status === 500 || status === 503) return 'gemBusy';
  return 'gemFailed';
}

async function call(fetchFn, key, path, init = {}) {
  let res;
  try {
    res = await fetchFn(`${API}/${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key, ...(init.headers || {}) },
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new GeminiError('gemNetwork', e?.message || String(e));
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new GeminiError(errorCode(res.status, body), `HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
    err.retryMs = retryDelayMs(body);
    throw err;
  }
  return body;
}

/** The wait a 429 reply asks for (google.rpc.RetryInfo, e.g. "23s" or "1.5s"), in ms, or null. */
export function retryDelayMs(body) {
  for (const d of body?.error?.details ?? []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ''));
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  // "Please retry in 15h49m47.81s." in the message text
  const t = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(String(body?.error?.message ?? ''));
  if (t && (t[1] || t[2] || t[3])) return Math.round(((Number(t[1] || 0) * 60 + Number(t[2] || 0)) * 60 + Number(t[3] || 0)) * 1000);
  return null;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** The text models this key can use, best first: [{id, label}]. Also checks the key. */
export async function listModels(key, fetchFn = fetch) {
  const out = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const body = await call(fetchFn, key, `models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const m of body?.models ?? []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini-/.test(id) || !(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
      // Image, video, music, audio, speech, embedding and live models cannot do this job (25 Nov 2026: the list
      // also had gemini-nano-banana-2.1, an image model, with a free-tier limit of 0).
      if (/image|banana|imagen|veo|lyria|audio|tts|live|embedding|transcribe|robotics|computer-use/.test(id)) continue;
      out.push({ id, label: m.displayName ? `${m.displayName} (${id})` : id });
    }
    page = body?.nextPageToken;
    if (!page) break;
  }
  return sortModels(out);
}

/** Flash models first, then Flash Lite, then the rest; newest versions first within each; previews and aliases last. */
export function sortModels(models) {
  const rank = (id) => (/flash/.test(id) && !/lite/.test(id) ? 1 : /flash/.test(id) ? 2 : 3) + (/preview|exp|latest/.test(id) ? 0.5 : 0);
  const version = (id) => Number((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || 0);
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || version(b.id) - version(a.id) || a.id.localeCompare(b.id));
}

/** The model's text from a generateContent reply (its "thought" parts left out), and why it stopped. */
export function replyText(body) {
  const c = body?.candidates?.[0];
  if (!c) {
    const blocked = body?.promptFeedback?.blockReason;
    throw new GeminiError(blocked ? 'gemBlocked' : 'gemEmpty', blocked || '');
  }
  const text = (c.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  return { text, finish: String(c.finishReason || '') };
}

/** One generateContent call with the conversation so far: [{role: 'user'|'model', text}]. */
export async function generate(key, model, turns, { fetchFn = fetch, signal, onWait, wait = sleep } = {}) {
  const send = () => call(fetchFn, key, `models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  let quotaWaited = false;
  let busyTries = 0;
  for (;;) {
    try {
      return replyText(await send());
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      let ms = null;
      // Per-minute limits (5 requests/min on the free Flash tier) clear within a minute: wait once and retry.
      if (e.code === 'gemQuota' && !quotaWaited && e.retryMs != null && e.retryMs <= MAX_RETRY_WAIT_MS) {
        quotaWaited = true;
        ms = e.retryMs + 500;
      } else if (e.code === 'gemBusy' && busyTries < BUSY_RETRY_MS.length) {
        ms = BUSY_RETRY_MS[busyTries++];
      }
      if (ms == null) throw e;
      onWait?.(ms, e.code);
      await wait(ms, signal);
    }
  }
}

/**
 * Sends the request and, while the answer stops early (the model says "Continue from #NNN", or ran out of
 * tokens), asks for the rest, up to MAX_ROUNDS. `nextFrom(answerSoFar)` returns the 1-based id of the first line
 * still missing after the last one received, or null when the answer is complete. Returns all the answers joined.
 */
export async function correct(key, model, prompt, nextFrom, { fetchFn = fetch, signal, onRound, onWait, wait, idOf } = {}) {
  const turns = [{ role: 'user', text: prompt }];
  let all = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    onRound?.(round);
    const { text } = await generate(key, model, turns, { fetchFn, signal, onWait, wait });
    all += (all ? '\n' : '') + text;
    const from = nextFrom(all);
    if (from == null) break;
    turns.push({ role: 'model', text });
    turns.push({ role: 'user', text: `Continue from ${idOf ? idOf(from) : `#${from}`}. Same rules and format: only the remaining lines, then the "Doubtful" list.` });
  }
  return all;
}
