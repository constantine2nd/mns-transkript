// Several transcripts as one conversation: a call recorded in pieces, voice messages sent back and forth.
// Only the text is joined; the recordings stay with their own transcripts, each in its own format (the user's
// choice, 27 Nov 2026: one joined recording would have to be re-encoded, and a browser can only write WAV).

import { lineCopy, speakerList, addSpeaker } from './speakers.js';

const linesOf = (tr) => tr.editedSegments ?? tr.segments ?? [];

/**
 * A new transcript with the lines of [parts] one after the other, in the given order. Each part is
 * {transcript, durationMs}; its text is what its editor shows (the edited text when there is one). The times of
 * every part after the first are moved by the length of all before it, so they keep rising. Speakers with the same
 * name become one speaker; unnamed ones stay apart, since "Govornik 1" of two recordings need not be one person.
 * Tags move with their lines. The result has no edited copy and no history: the joined text is its original.
 * `mergedFrom` records where each part starts.
 */
export function mergeTranscripts(parts, { id, title, now = Date.now() }) {
  const out = { id, title, createdAt: now, durationMs: 0, language: 'sr', segments: [], editedSegments: null, history: [], origin: 'web', mergedFrom: [] };
  const first = parts[0]?.transcript;
  if (first) {
    out.createdAt = Number(first.createdAt) || now;
    out.language = first.language || 'sr';
  }
  const byName = new Map();
  const tags = [];
  let offset = 0;
  for (const { transcript: tr, durationMs } of parts) {
    const lines = linesOf(tr);
    const ids = new Map();
    for (const p of speakerList(tr)) {
      const name = String(p.name ?? '').trim();
      let to = name ? byName.get(name) : undefined;
      if (!to) {
        to = addSpeaker(out);
        const made = out.speakers[out.speakers.length - 1];
        made.name = name || null;
        made.renamedAt = name ? (p.renamedAt || now) : 0;
        if (name) byName.set(name, to);
      }
      ids.set(p.id, to);
    }
    for (const s of lines) {
      const c = lineCopy(s);
      c.start += offset;
      c.end += offset;
      if (c.speaker) {
        if (ids.has(c.speaker)) c.speaker = ids.get(c.speaker);
        else { delete c.speaker; delete c.speakerBy; }
      }
      out.segments.push(c);
    }
    for (const g of Array.isArray(tr.tags) ? tr.tags : []) {
      if (g && typeof g.start === 'number' && typeof g.end === 'number') tags.push({ ...g, start: g.start + offset, end: g.end + offset });
    }
    out.mergedFrom.push({ id: String(tr.id ?? ''), title: String(tr.title ?? ''), start: offset });
    const last = lines.length ? lines[lines.length - 1].end : 0;
    offset += Math.max(Number(durationMs) || 0, Number(tr.durationMs) || 0, last);
  }
  out.durationMs = offset;
  if (tags.length) out.tags = tags;
  return out;
}
