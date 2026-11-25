// AI correction round trip: an exact port of the phone's core/…/data/AiExchange.kt (keep them in step).
// The request carries "#NNN text" lines, never times; the answer is matched back by id.

import { toLatin } from './text.js';

/** "#001" for line 1; the width grows past 999 lines so the ids stay the same length. */
export function id(index, count) {
  return '#' + String(index + 1).padStart(Math.max(3, String(count).length), '0');
}

/** Name the AI is asked to give its answer file, from the transcript's file-safe base name. */
export function answerFileName(base) {
  return `${base} - AI answer.txt`;
}

/**
 * @param {{text: string}[]} segments  @param {boolean} latin  @param {string} base
 * @param {{direct?: boolean}} [opts] direct: for the Gemini API (web only, not in the phone's AiExchange): the
 *   answer comes back as the reply's text, so the lines are asked for as plain text instead of a file.
 */
export function request(segments, latin, base, { direct = false } = {}) {
  const n = segments.length;
  const script = latin ? 'Latin' : 'Cyrillic';
  const otherScript = latin ? 'Cyrillic' : 'Latin';
  let out = [
    'You are correcting an automatic speech-recognition transcript of a Serbian conversation.',
    `The text is Serbian, ekavian, ${script} script. Keep it that way: do not translate, do not`,
    `switch to ${otherScript}, do not change ekavian to ijekavian.`,
    '',
    'Fix only clear recognition errors: misheard or misspelled words, wrongly joined or split',
    'words, punctuation, capital letters, and numbers written inconsistently.',
    'Do not rephrase, shorten, summarise or improve the style. Keep spoken forms, repetitions',
    'and filler words as they are. If a line is already correct, return it unchanged.',
    'If you are unsure about a word, keep it and mark it like [?word].',
    '',
    'Format rules, strictly:',
    `- Each line starts with an id, e.g. "${id(0, n)}". Copy the id exactly; never change, renumber`,
    '  or drop it. Do not add timestamps.',
    '- Return every line, in the same order: exactly one output line per input line.',
    '  Never merge, split, add or drop lines, even if a sentence continues on the next line.',
    '- Do not stop early. If all lines do not fit in one reply, end after a complete line and',
    '  write "Continue from #NNN" after it; I will ask for the rest.',
    '- Do not add dialogue dashes, quotation marks, speaker names or any other markup.',
    ...(direct ? [
      '- Reply with the corrected lines only, as plain text: no code block, no comments before them.',
      '',
      'After the lines, add one short list titled "Doubtful" with the ids of lines you marked',
      'with [?...], or "none".',
      '',
    ] : [
      `- Return the result as a downloadable plain-text file named "${answerFileName(base)}"`,
      '  (UTF-8), containing only the corrected lines, nothing else.',
      '- If you cannot create files, output only the lines inside one code block instead,',
      '  with no comments before or after.',
      '',
      'After the file (or code block), add one short list titled "Doubtful" with the ids of',
      'lines you marked with [?...], or "none". Do not put this list inside the file.',
      '',
    ]),
  ].join('\n');
  out += '\n';
  out += n === 0 ? 'Lines: 0\n' : `Lines: ${n} (${id(0, n)}-${id(n - 1, n)})\n`;
  out += '\n';
  lines(segments).forEach((text, i) => { out += `${id(i, n)} ${text}\n`; });
  return out;
}

/** The text each segment goes out as: one segment, one line. */
export function lines(segments) {
  return segments.map((s) => s.text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

// ------------------------------------------------------------------ answer

// Java's \s is ASCII whitespace; kept so word splitting matches the phone exactly.
const WS = /[ \t\n\x0B\f\r]+/;
const LINE = /^#(\d+)(?:[ \t\n\x0B\f\r](.*))?$/s;
const STAMP = /^\[\d{1,2}:\d{2}(?::\d{2})?]\s*/;
const DOUBT_SRC = '\\[\\?\\s*([^\\]]*?)\\s*]';

export function stripDoubt(text) {
  return text.replace(new RegExp(DOUBT_SRC, 'g'), (_, w) => w);
}

const isDoubtful = (text) => new RegExp(DOUBT_SRC).test(text);
const words = (t) => t.split(WS).filter((w) => w.length > 0);
const squash = (t) => t.trim().replace(/[ \t\n\x0B\f\r]+/g, ' ');

function lcs(a, b) {
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  return dp[0];
}

/** One line the AI changed: index into the segments, the text that went out, the text that came back. */
export class Change {
  constructor(index, old, neu) { this.index = index; this.old = old; this.new = neu; }
  /** The AI marked a word it was unsure of, like [?word]. */
  get doubtful() { return isDoubtful(this.new); }
  /** The text to store: the doubt marks removed, the words kept. */
  get applied() { return stripDoubt(this.new); }
  /** More than 40% of the words changed in a line of 6+ words: a rewrite rather than a fix. */
  get rewritten() {
    const a = words(this.old);
    const b = words(stripDoubt(this.new));
    if (Math.max(a.length, b.length) < 6) return false;
    return 1.0 - lcs(a, b) / Math.max(a.length, b.length) > 0.4;
  }
}

/**
 * Matches the AI's answer to the sent lines by id. Returns
 * {type: 'ok', changes, missing, lastReceived, continueFrom} or
 * {type: 'mismatch', missing, duplicate, unknown, found, unrelated}. Ids are 1-based.
 */
export function parseAnswer(answer, sent) {
  const got = new Map();
  const duplicate = new Set();
  const unknown = new Set();
  for (const raw of answer.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/^﻿/, '').trim().replace(/^`+|`+$/g, '').trim();
    // "Doubtful", "**Doubtful:**", "## Doubtful lines": the list under it repeats ids, so reading stops here.
    if (line.replace(/^[#*_>\- ]+/, '').toLowerCase().startsWith('doubtful')) break;
    const m = LINE.exec(line);
    if (!m) continue;
    const num = Number(m[1]);
    if (!Number.isSafeInteger(num) || num > 2147483647) continue; // Kotlin's toIntOrNull
    if (num < 1 || num > sent.length) { unknown.add(num); continue; }
    if (got.has(num - 1)) duplicate.add(num);
    got.set(num - 1, (m[2] ?? '').trim());
  }
  const sortNum = (s) => [...s].sort((x, y) => x - y);
  const missing = sent.map((_, i) => i).filter((i) => !got.has(i)).map((i) => i + 1);
  if (got.size === 0 || duplicate.size > 0 || unknown.size > 0) {
    return { type: 'mismatch', missing, duplicate: sortNum(duplicate), unknown: sortNum(unknown), found: got.size, unrelated: false };
  }
  const changes = [];
  sent.forEach((old, i) => {
    if (!got.has(i)) return;
    let neu = got.get(i);
    // A time the AI put in front anyway is not text.
    if (!STAMP.test(old)) neu = neu.replace(STAMP, '');
    if (squash(neu) !== squash(old)) changes.push(new Change(i, old, neu));
  });
  if (unrelated(sent, got)) return { type: 'mismatch', missing, duplicate: [], unknown: [], found: got.size, unrelated: true };
  const lastReceived = Math.max(...got.keys()) + 1;
  const continueFrom = missing.find((x) => x > lastReceived) ?? null;
  return { type: 'ok', changes, missing, lastReceived, continueFrom };
}

const normWords = (t) => words(toLatin(t).toLowerCase()).map((w) => w.replace(/[^\p{L}\p{Nd}]/gu, '')).filter((w) => w.length > 0);

/** Unrelated when at least half of the lines with 3+ words keep under half of their words. */
function unrelated(sent, got) {
  let checked = 0;
  let foreign = 0;
  for (const [i, text] of got) {
    const a = normWords(sent[i]);
    if (a.length < 3) continue;
    checked++;
    const b = normWords(stripDoubt(text));
    if (lcs(a, b) / a.length < 0.5) foreign++;
  }
  return checked >= 3 && foreign * 2 >= checked;
}

/** True when most letters of the lines are Latin (ties count as Latin). */
export function mostlyLatin(texts) {
  let cyr = 0;
  let lat = 0;
  for (const l of texts) {
    for (const c of l) {
      if (/\p{Script=Cyrillic}/u.test(c)) cyr++;
      else if (/\p{Script=Latin}/u.test(c)) lat++;
    }
  }
  return lat >= cyr;
}

/** Exact word diff, old and new words interleaved in reading order: [{text, kind: 'same'|'removed'|'added'}]. */
export function diff(old, neu) {
  const a = words(old);
  const b = words(neu);
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ text: a[i], kind: 'same' }); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i * w + j + 1] > dp[(i + 1) * w + j])) { out.push({ text: b[j], kind: 'added' }); j++; }
    else { out.push({ text: a[i], kind: 'removed' }); i++; }
  }
  return out;
}
