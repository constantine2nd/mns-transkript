// Version history of a transcript's text (docs/bundle-format.md, "Version history"). DOM-free.
// The phone implements the same rules; change both together.

/** Two `edit` versions from the same device closer than this are one version (one typing session). */
/** At most this many versions: the original plus the newest MAX_VERSIONS - 1. */
export const MAX_VERSIONS = 50;
export const ORIGINAL_ID = 'original';

/**
 * Pairs each line of [now] with the text it replaced in [prev], for showing what a version changed: line by line
 * when both have the same lines (count and times), else by time overlap (a split or joined line is compared with
 * all the earlier text it covers). Returns [{seg, old}] where old is null when there is no previous version.
 */
export function previewPairs(prev, now) {
  if (!prev) return now.map((seg) => ({ seg, old: null }));
  const same = prev.length === now.length && prev.every((p, i) => p.start === now[i].start && p.end === now[i].end);
  if (same) return now.map((seg, i) => ({ seg, old: prev[i].text }));
  return now.map((seg) => ({
    seg,
    old: prev.filter((p) => p.start < seg.end && p.end > seg.start).map((p) => p.text).join(' '),
  }));
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const list = (history) => (Array.isArray(history) ? history.filter((v) => v && typeof v === 'object') : []);
const copySegs = (segs) => (segs == null ? null : segs.map((s) => ({ start: s.start, end: s.end, text: s.text })));

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

/** Same lines with the same start, end and text. */
export function sameText(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].text !== b[i].text) return false;
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

/** How many lines differ in text between two texts with the same line count; null when the counts differ. */
export function linesChanged(before, after) {
  if (before.length !== after.length) return null;
  let n = 0;
  for (let i = 0; i < before.length; i++) if (before[i].text !== after[i].text) n++;
  return n;
}
