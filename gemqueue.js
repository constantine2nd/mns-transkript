// Gemini suggestions for single lines, kept with a transcript until they are accepted or thrown away (the user's
// wish, 28 Nov 2026: press "G" on several lines, keep working, and review each one when it is ready).
//
// A suggestion belongs to a line as it was when the line was sent: its start, its end and its text then ([base]).
// A line that was edited, split or joined since no longer matches, and its suggestion is dropped rather than offered
// against a text it was not made for.

/** {start, end, base, heard} of a line sent to Gemini; [base] is the line's text at the time. */
export const lineOf = (seg) => ({ start: seg.start, end: seg.end, base: seg.text });

/** The same line (times and text) as [x]: a suggestion and the line it was made for. */
export const sameLine = (x, seg) => !!seg && x.start === seg.start && x.end === seg.end && x.base === seg.text;

/** Where [x]'s line is in [segs], or -1 when it was changed. */
export const findLine = (segs, x) => segs.findIndex((s) => sameLine(x, s));

/** A transcript's suggestions (missing in older records). */
export const suggestionsOf = (doc) => (Array.isArray(doc?.gemSuggest) ? doc.gemSuggest : []);

/** The suggestions whose lines are still as they were; [null] when none had to go (nothing to save). */
export function pruned(list, segs) {
  const kept = list.filter((x) => findLine(segs, x) >= 0);
  return kept.length === list.length ? null : kept;
}

/** [list] with [sug] in place of an older one for the same line. */
export const withSuggestion = (list, sug) => [...list.filter((x) => !(x.start === sug.start && x.end === sug.end)), sug];

/** [list] without the one for [seg]'s line. */
export const withoutSuggestion = (list, seg) => list.filter((x) => !(x.start === seg.start && x.end === seg.end));
