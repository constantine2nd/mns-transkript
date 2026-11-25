// Audio rules for transcribing in the browser, ported from the phone's :core module so a recording is cut and
// cleaned the same way on both (audio/Chunker.kt, Silence; data/SentenceMerge.kt). Pure: no DOM, no model.

export const SAMPLE_RATE = 16000;
const FRAME = SAMPLE_RATE / 50; // 20 ms frames

// Chunker as the phone's refine uses it: 27 s target (so never over Whisper's 30 s), cut searched in the last 10 s.
export const TARGET_S = 27;
export const SEARCH_S = 10;
const PAUSE_FRAMES = 10; // 200 ms: a real pause or breath, not the closure of a stop consonant
const MIN_TAIL = (SAMPLE_RATE * 3) / 10; // a tail under 300 ms is dropped

/**
 * Whisper invents text for silence ("Hvala."). A stretch is silent when even its loudest 20 ms frame stays below
 * -50 dBFS (phone, 7 Nov 2026: speech peaks at -42 dBFS or louder; the silent tail that produced invented text
 * peaked at -61 dBFS).
 */
export const SILENT_PEAK_DB = -50;
const SILENT_MS = 10 ** (SILENT_PEAK_DB / 10); // mean square of a frame at the threshold

function sumSquares(pcm, from, to) {
  let e = 0;
  for (let j = from; j < to; j++) e += pcm[j] * pcm[j];
  return e;
}

/** True when pcm[from, to) has no 20 ms frame louder than SILENT_PEAK_DB. */
export function isSilent(pcm, from = 0, to = pcm.length) {
  const start = Math.min(Math.max(from, 0), pcm.length);
  const end = Math.min(Math.max(to, start), pcm.length);
  for (let i = start; i < end;) {
    const stop = Math.min(i + FRAME, end);
    if (sumSquares(pcm, i, stop) / (stop - i) >= SILENT_MS) return false;
    i = stop;
  }
  return true;
}

/** Whether a piece (ms relative to the start of pcm) covers any audible audio; 100 ms slack each side. */
export function hasSpeech(pcm, startMs, endMs) {
  const perMs = SAMPLE_RATE / 1000;
  return !isSilent(pcm, Math.round((startMs - 100) * perMs), Math.round((endMs + 100) * perMs));
}

/** The cut for a window of len samples starting at `from`: the middle of the latest 200 ms stretch within 3 dB of the quietest one. */
function quietestCut(pcm, from, len) {
  const target = TARGET_S * SAMPLE_RATE;
  const lo = Math.max(target - SEARCH_S * SAMPLE_RATE, FRAME);
  const hi = len - FRAME;
  const n = Math.floor((hi - lo) / FRAME);
  if (n <= 0) return len;
  const energy = new Float64Array(n);
  for (let k = 0; k < n; k++) energy[k] = sumSquares(pcm, from + lo + k * FRAME, from + lo + (k + 1) * FRAME);
  const w = Math.min(PAUSE_FRAMES, n);
  const sums = new Float64Array(n - w + 1);
  let sum = 0;
  for (let k = 0; k < w; k++) sum += energy[k];
  sums[0] = sum;
  for (let k = 1; k <= n - w; k++) { sum += energy[k + w - 1] - energy[k - 1]; sums[k] = sum; }
  let min = Infinity;
  for (const s of sums) if (s < min) min = s;
  const limit = Math.max(min * 2, Number.MIN_VALUE);
  let best = 0;
  for (let k = sums.length - 1; k >= 0; k--) if (sums[k] <= limit) { best = k; break; }
  return lo + best * FRAME + Math.floor((w * FRAME) / 2);
}

/**
 * The windows a whole recording is transcribed in, as [from, to) sample ranges: about 27 s each, cut in a pause,
 * never over 30 s. A final piece under 300 ms is dropped.
 */
export function windows(pcm) {
  const target = TARGET_S * SAMPLE_RATE;
  const out = [];
  let start = 0;
  // The phone's Chunker gets audio in small blocks and cuts as soon as it holds 27 s, so each cut is searched in
  // the first 27 s of what is left.
  while (pcm.length - start >= target) {
    const cut = quietestCut(pcm, start, target);
    out.push([start, start + cut]);
    start += cut;
  }
  if (pcm.length - start >= MIN_TAIL) out.push([start, pcm.length]);
  return out;
}

// ------------------------------------------------------------------ sentences (SentenceMerge.kt)

// 24 Nov 2026: initial values on the phone, to be tuned there; kept equal here.
export const MAX_SENTENCE_MS = 30_000;
export const MAX_SENTENCE_CHARS = 400;
export const BREAK_GAP_MS = 2_000;
const CLOSERS = '"\'”“’»«)]';

const isLetterOrDigit = (c) => /[\p{L}\p{N}]/u.test(c);
const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase();
const isDigit = (c) => /\p{N}/u.test(c);

/** Whether a piece with `text` ends a sentence when `next` (the following piece's text, or null) comes after it. */
export function endsSentence(text, next) {
  let s = text.trim();
  while (s && (/\s/.test(s.at(-1)) || CLOSERS.includes(s.at(-1)))) s = s.slice(0, -1);
  if (!s) return false;
  const last = s.at(-1);
  if (last === '?' || last === '!') return true;
  if (last === '.' || last === '…') {
    const c = next ? [...next].find(isLetterOrDigit) : undefined;
    return !(c !== undefined && (isLower(c) || isDigit(c)));
  }
  return false;
}

const join = (g) => ({ start: g[0].start, end: g.at(-1).end, text: g.map((p) => p.text.trim()).join(' ') });

function fits(group, p) {
  if (!group.length) return true;
  if (p.end - group[0].start > MAX_SENTENCE_MS) return false;
  const len = group.reduce((n, q) => n + q.text.trim().length, 0) + p.text.trim().length + group.length;
  return len <= MAX_SENTENCE_CHARS;
}

/** Whisper's phrase pieces ({start, end, text} in ms, time order) joined into sentence-sized lines. Join only. */
export function mergeSentences(pieces) {
  const src = pieces.filter((p) => p.text.trim());
  const out = [];
  let group = [];
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    while (group.length && !fits(group, p)) {
      let best = -1;
      let bestGap = -Infinity;
      for (let k = 0; k < group.length; k++) {
        const following = k + 1 < group.length ? group[k + 1] : p;
        const gap = following.start - group[k].end;
        if (gap >= bestGap) { bestGap = gap; best = k; }
      }
      out.push(join(group.slice(0, best + 1)));
      group = group.slice(best + 1);
    }
    group.push(p);
    const next = src[i + 1];
    if (!next || endsSentence(p.text, next.text) || next.start - p.end > BREAK_GAP_MS) {
      out.push(join(group));
      group = [];
    }
  }
  return out;
}

/**
 * The model's pieces for one window ({timestamp: [s, e] in seconds relative to the window, text}) placed in
 * recording time (ms), with pieces over silence dropped (the model only invents text for them).
 */
export function placePieces(chunks, pcm, [from, to]) {
  const startMs = Math.round((from / SAMPLE_RATE) * 1000);
  const durMs = Math.round(((to - from) / SAMPLE_RATE) * 1000);
  const win = pcm.subarray(from, to);
  const out = [];
  for (const c of chunks) {
    const text = String(c.text ?? '').trim();
    if (!text) continue;
    const s = Math.max(0, Math.round((c.timestamp?.[0] ?? 0) * 1000));
    const e0 = c.timestamp?.[1];
    const e = Math.min(durMs, Math.max(s, Math.round((e0 == null ? durMs / 1000 : e0) * 1000)));
    if (!hasSpeech(win, s, e)) continue;
    out.push({ start: startMs + s, end: startMs + e, text });
  }
  return out;
}

/** A transcript id in the phone's form, "yyyyMMdd-HHmmss-NNNN" (local time). */
export function newTranscriptId(now = new Date(), rand = Math.random) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const d = now;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(Math.floor(rand() * 10000), 4)}`;
}
