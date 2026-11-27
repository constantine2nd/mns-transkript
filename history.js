// Version history of a transcript's text (docs/bundle-format.md, "Version history"). DOM-free.
import { lineCopy } from './speakers.js';
// The phone implements the same rules; change both together.

/** Two `edit` versions from the same device closer than this are one version (one typing session). */
/** At most this many versions: the original plus the newest MAX_VERSIONS - 1. */
export const MAX_VERSIONS = 50;
export const ORIGINAL_ID = 'original';

/**
 * Pairs each line of [now] with the text it replaced in [prev], for showing what a version changed: line by line
 * when both have the same lines (count and times), else by time overlap. A joined line is compared with all the
 * earlier text it covers. The lines a split made share one earlier text, which is divided among them where their
 * words match: comparing each half with the whole earlier line showed the other half as deleted (27 Nov 2026).
 *
 * A changed division of lines is itself shown (the user's choice, 27 Nov 2026): the end of a line inside such a
 * group is the word BREAK, in [old] where the earlier lines ended and in [shown] where the new ones do, so the
 * word comparison marks a split as an added BREAK and a join as a removed one. [regrouped] is true for every line
 * of such a group, so the caller shows them all, also the half whose words did not change.
 * Returns [{seg, old, shown, regrouped}]; old is null when there is no previous version, shown is the line's text
 * to compare and display.
 */
export const BREAK = '¶';

export function previewPairs(prev, now) {
  if (!prev) return now.map((seg) => ({ seg, old: null, shown: seg.text, regrouped: false }));
  const same = prev.length === now.length && prev.every((p, i) => p.start === now[i].start && p.end === now[i].end);
  if (same) return now.map((seg, i) => ({ seg, old: prev[i].text, shown: seg.text, regrouped: false }));
  const over = now.map((seg) => prev.map((p, k) => (p.start < seg.end && p.end > seg.start ? k : -1)).filter((k) => k >= 0));
  const out = [];
  for (let i = 0; i < now.length;) {
    // the lines of [now] that share earlier lines form one group
    const used = new Set(over[i]);
    let j = i + 1;
    while (j < now.length && over[j].some((k) => used.has(k))) { for (const k of over[j]) used.add(k); j++; }
    const regrouped = used.size > 1 || j - i > 1;
    const old = [...used].sort((a, b) => a - b).map((k) => prev[k].text).join(` ${BREAK} `);
    const shown = now.slice(i, j).map((s, k) => (k < j - i - 1 ? `${s.text} ${BREAK}` : s.text));
    const parts = j - i === 1 ? [old] : divideOld(old, shown);
    for (let k = i; k < j; k++) out.push({ seg: now[k], old: parts[k - i], shown: shown[k - i], regrouped });
    i = j;
  }
  return out;
}

const wordsOf = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * Divides the earlier text [old] among the new [texts] of the lines that replaced it: each cut falls before the
 * first earlier word that reappears in the next line (longest common run of words). Too long to compare word by
 * word: every line gets the whole earlier text, as before.
 */
function divideOld(old, texts) {
  const a = wordsOf(old);
  const b = texts.flatMap(wordsOf);
  const n = a.length;
  const m = b.length;
  if (n * m > 250000) return texts.map(() => old);
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const match = new Array(n).fill(-1); // for each earlier word, the new word it is kept as
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) match[i++] = j++;
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  const parts = [];
  let from = 0;
  let boundary = 0;
  for (let k = 0; k < texts.length; k++) {
    boundary += wordsOf(texts[k]).length;
    let to = n;
    if (k < texts.length - 1) {
      const next = match.findIndex((j, i) => i >= from && j >= boundary);
      if (next >= 0) to = next;
    }
    parts.push(a.slice(from, to).join(' '));
    from = to;
  }
  return parts;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const list = (history) => (Array.isArray(history) ? history.filter((v) => v && typeof v === 'object') : []);
// a version keeps each line's speaker too (speakers.js), so restoring it brings the speakers back
const copySegs = (segs) => (segs == null ? null : segs.map(lineCopy));

/** Rule 5: the last entry's n, or 1 for an empty history. */
export function currentVersion(history) {
  const h = list(history);
  return h.length ? h[h.length - 1].n : 1;
}

/** "r-" plus 6 random letters and digits, not already in [taken]. */
export function newId(taken = new Set()) {
  for (;;) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const id = `r-${[...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

/** The v1 entry an empty history stands for (rule 1): made on the phone, or here for a recording transcribed here. */
export function originalEntry(transcript) {
  const device = transcript.origin === 'web' ? 'web' : 'phone';
  return { id: ORIGINAL_ID, n: 1, at: Number(transcript.createdAt) || 0, source: 'original', device, segments: null };
}

/** The history to show: the stored one, or v1 alone when it is missing or empty (rule 1). */
export function versions(transcript) {
  const h = list(transcript.history);
  return h.length ? h : [originalEntry(transcript)];
}

/** The text of a version: its segments, or the machine segments for null. */
export function textOf(transcript, entry) {
  return entry.segments ?? transcript.segments ?? [];
}

/** Same lines with the same start, end, text and speaker (marking a speaker is an edit like typing). */
export function sameText(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].text !== b[i].text) return false;
    if ((a[i].speaker ?? null) !== (b[i].speaker ?? null)) return false;
  }
  return true;
}

/** Rule 4: the original plus the newest MAX_VERSIONS - 1 (or the newest MAX_VERSIONS when there is no original). */
export function cap(history) {
  if (history.length <= MAX_VERSIONS) return history;
  if (history[0]?.id === ORIGINAL_ID) return [history[0], ...history.slice(history.length - (MAX_VERSIONS - 1))];
  return history.slice(history.length - MAX_VERSIONS);
}

/**
 * Rule 2: the history after a change of the text to [segments] (null = back to the machine text).
 * Returns a new array; the transcript is not modified.
 * @param {object} transcript with segments, createdAt and maybe history
 * @param {{source: string, device?: string, segments: Array|null, now?: number, from?: number}} change
 */
export function record(transcript, { source, device = 'web', segments, now = Date.now(), from }) {
  const history = list(transcript.history).slice();
  const machine = transcript.segments ?? [];
  const last = history.length ? history[history.length - 1] : originalEntry(transcript);
  if (sameText(segments ?? machine, textOf(transcript, last))) return history;
  const segs = copySegs(segments);
  if (history.length === 0) history.push(originalEntry(transcript));
  const entry = { id: newId(new Set(history.map((v) => v.id))), n: (Number(last.n) || history.length) + 1, at: now, source, device };
  if (from != null) entry.from = from;
  entry.segments = segs;
  history.push(entry);
  return cap(history);
}

/**
 * Rule 3: union by id (the later `at` wins when both have it), sorted by `at` with the original first,
 * renumbered from 1, then capped (rule 4).
 */
export function merge(a, b) {
  const byId = new Map();
  for (const v of [...list(a), ...list(b)]) {
    const have = byId.get(v.id);
    if (!have || (Number(v.at) || 0) > (Number(have.at) || 0)) byId.set(v.id, v);
  }
  const all = [...byId.values()];
  const rank = (v) => (v.id === ORIGINAL_ID ? 0 : 1);
  all.sort((x, y) => rank(x) - rank(y) || (Number(x.at) || 0) - (Number(y.at) || 0));
  return cap(all.map((v, i) => ({ ...v, n: i + 1 })));
}

/** The segments of version [n] (null = the machine text), or undefined when there is no such version. */
export function restoreTarget(transcript, n) {
  const v = versions(transcript).find((x) => x.n === n);
  return v === undefined ? undefined : copySegs(v.segments);
}

/** How many lines differ in who is talking, for two texts with the same line count; null when the counts differ. */
export function speakersChanged(before, after) {
  if (before.length !== after.length) return null;
  let n = 0;
  for (let i = 0; i < before.length; i++) if ((before[i].speaker ?? null) !== (after[i].speaker ?? null)) n++;
  return n;
}

/** How many lines differ in text between two texts with the same line count; null when the counts differ. */
export function linesChanged(before, after) {
  if (before.length !== after.length) return null;
  let n = 0;
  for (let i = 0; i < before.length; i++) if (before[i].text !== after[i].text) n++;
  return n;
}
