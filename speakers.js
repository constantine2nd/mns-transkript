// Who is talking (docs/bundle-format.md, "Speakers"). The names live in one place, transcript.speakers
// [{id, name, renamedAt}]; a line points to one with `speaker` (the id) and says who set it with `speakerBy`
// ("user" now, "auto" once speaker detection suggests). Renaming one speaker renames every line at once.
// The phone keeps these fields (core …/data/TranscriptJson.kt) but has no screen for them yet.

/** A line with its speaker fields kept: every copy of the lines goes through this, or a split or save drops them. */
export function lineCopy(s) {
  const c = { start: s.start, end: s.end, text: s.text };
  if (s.speaker) { c.speaker = s.speaker; c.speakerBy = s.speakerBy || 'user'; }
  return c;
}

export function speakerList(tr) {
  return Array.isArray(tr?.speakers) ? tr.speakers.filter((p) => p && typeof p.id === 'string') : [];
}

/** "Pera", or "Govornik 2" (by its place in the list) when it has no name; [fallback] builds that default. */
export function labelOf(tr, id, fallback = (n) => `Govornik ${n}`) {
  const list = speakerList(tr);
  const k = list.findIndex((p) => p.id === id);
  if (k < 0) return '';
  const name = String(list[k].name ?? '').trim();
  return name || fallback(k + 1);
}

/** The colour slot (0–5) of a speaker: by its place in the list. */
export function colourOf(tr, id) {
  const k = speakerList(tr).findIndex((p) => p.id === id);
  return k < 0 ? -1 : k % 6;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A new speaker's id: random ("s-k3x9qa"), never the lowest free "sN". A removed speaker's id still lives in older
 * versions and in other copies of the transcript, so a reused one put the new person's name on the removed
 * person's lines, and two browsers that each made "s1" were taken for one person on import (26 Nov 2026).
 * Ids like "s1" from before stay valid.
 */
function nextId(list) {
  for (;;) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const id = `s-${[...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join('')}`;
    if (!list.some((p) => p.id === id)) return id;
  }
}

/**
 * Adds a speaker and returns its id. For a call, the first two are named after its two sides: [names] gives
 * them (["Ja", "Pera"]); later ones start unnamed.
 */
export function addSpeaker(tr, { names = [], now = Date.now() } = {}) {
  const list = speakerList(tr);
  const id = nextId(list);
  // Its own side when free, else the side nobody has: after "Ja" was removed the next one was named after the
  // contact a second time.
  const free = (n) => n != null && !list.some((p) => p.name === n);
  const name = list.length < names.length ? (free(names[list.length]) ? names[list.length] : names.find(free) ?? null) : null;
  tr.speakers = [...list, { id, name, renamedAt: name ? now : 0 }];
  return id;
}

/**
 * Puts back, unnamed, every speaker that [segs] point to and the list no longer has; returns how many. The list is
 * not part of a version, so restoring one from before a merge or removal (or importing such a copy) left lines
 * pointing nowhere: an empty chip, no name in exports and no row in "Govornici" to fix it.
 */
export function ensureSpeakers(tr, segs) {
  const list = speakerList(tr);
  const have = new Set(list.map((p) => p.id));
  const missing = [];
  for (const s of segs ?? []) {
    if (typeof s?.speaker === 'string' && s.speaker && !have.has(s.speaker)) { have.add(s.speaker); missing.push(s.speaker); }
  }
  if (missing.length) tr.speakers = [...list, ...missing.map((id) => ({ id, name: null, renamedAt: 0 }))];
  return missing.length;
}

/** The id of the [n]th speaker (1-based), adding speakers up to it when there are fewer. */
export function nthSpeaker(tr, n, opts) {
  while (speakerList(tr).length < n) addSpeaker(tr, opts);
  return speakerList(tr)[n - 1].id;
}

/** Sets (or with null clears) the speaker of line [i]; true when it changed. */
export function setLineSpeaker(segs, i, id) {
  const s = segs[i];
  if (!s || (s.speaker ?? null) === (id ?? null)) return false;
  if (id) { s.speaker = id; s.speakerBy = 'user'; } else { delete s.speaker; delete s.speakerBy; }
  return true;
}

export function renameSpeaker(tr, id, name, now = Date.now()) {
  const p = speakerList(tr).find((x) => x.id === id);
  if (!p) return false;
  const clean = String(name ?? '').trim() || null;
  if ((p.name ?? null) === clean) return false;
  p.name = clean;
  p.renamedAt = now;
  return true;
}

/** Lines per speaker id. */
export function counts(segs) {
  const c = {};
  for (const s of segs) if (s.speaker) c[s.speaker] = (c[s.speaker] || 0) + 1;
  return c;
}

/** Two speakers are one person: [fromId]'s lines go to [intoId], and [fromId] leaves the list. */
export function mergeSpeaker(tr, segs, fromId, intoId) {
  if (fromId === intoId) return 0;
  let n = 0;
  for (const s of segs) if (s.speaker === fromId) { s.speaker = intoId; n++; }
  tr.speakers = speakerList(tr).filter((p) => p.id !== fromId);
  return n;
}

/** Removes a speaker; its lines become unmarked. */
export function removeSpeaker(tr, segs, id) {
  let n = 0;
  for (const s of segs) if (s.speaker === id) { delete s.speaker; delete s.speakerBy; n++; }
  tr.speakers = speakerList(tr).filter((p) => p.id !== id);
  return n;
}

/**
 * Consecutive lines by the same speaker, for exports: [{speaker, lines: [...]}]. Unmarked lines form runs of
 * their own (speaker null).
 */
export function runs(segs) {
  const out = [];
  for (const s of segs) {
    const who = s.speaker ?? null;
    const last = out[out.length - 1];
    if (last && last.speaker === who && who !== null) last.lines.push(s);
    else out.push({ speaker: who, lines: [s] });
  }
  return out;
}

/**
 * Importing a copy whose text replaces ours. The fingerprint covers only times and text, so speakers must be merged
 * by hand or ours would vanish without a word: a line (same start and end) marked on one side only keeps that
 * side's speaker; marked on both, the incoming one wins. Names: union by id, the later rename wins.
 * Mutates and returns [incoming] (the transcript object about to be stored).
 */
export function mergeIncoming(local, incoming) {
  if (!local) return incoming;
  const byId = new Map(speakerList(incoming).map((p) => [p.id, { ...p }]));
  for (const p of speakerList(local)) {
    const q = byId.get(p.id);
    if (!q || (p.renamedAt || 0) > (q.renamedAt || 0)) byId.set(p.id, { ...p });
  }
  const mine = new Map();
  for (const s of local.editedSegments ?? local.segments ?? []) if (s.speaker) mine.set(`${s.start}-${s.end}`, s);
  let lines = incoming.editedSegments ?? incoming.segments ?? [];
  const carried = (s) => (s.speaker ? null : mine.get(`${s.start}-${s.end}`));
  // The machine lines are never changed (docs/bundle-format.md): with no edited copy to mark, make one first, or
  // "Vrati original" could not clear these speakers.
  if (incoming.editedSegments == null && lines.some(carried)) {
    incoming.editedSegments = lines.map(lineCopy);
    lines = incoming.editedSegments;
  }
  for (const s of lines) {
    const m = carried(s);
    if (m) { s.speaker = m.speaker; s.speakerBy = m.speakerBy || 'user'; }
  }
  // keep the local order first (colours stay), then any new ones from the other side
  const order = [...speakerList(local).map((p) => p.id), ...speakerList(incoming).map((p) => p.id)];
  const seen = new Set();
  const merged = [];
  for (const id of order) if (!seen.has(id) && byId.has(id)) { seen.add(id); merged.push(byId.get(id)); }
  if (merged.length) incoming.speakers = merged;
  ensureSpeakers(incoming, lines);
  return incoming;
}
