// Text helpers shared by the editor and the tests: transliteration, clocks, exports, split/join.
// Ports of the phone's core/…/data/Transliterate.kt and Exporters.kt.

const MAP = {
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Ђ': 'Đ', 'Е': 'E',
  'Ж': 'Ž', 'З': 'Z', 'И': 'I', 'Ј': 'J', 'К': 'K', 'Л': 'L', 'Љ': 'Lj',
  'М': 'M', 'Н': 'N', 'Њ': 'Nj', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S',
  'Т': 'T', 'Ћ': 'Ć', 'У': 'U', 'Ф': 'F', 'Х': 'H', 'Ц': 'C', 'Ч': 'Č',
  'Џ': 'Dž', 'Ш': 'Š',
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'đ', 'е': 'e',
  'ж': 'ž', 'з': 'z', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj',
  'м': 'm', 'н': 'n', 'њ': 'nj', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's',
  'т': 't', 'ћ': 'ć', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'č',
  'џ': 'dž', 'ш': 'š',
  // Letters that only occur in other Cyrillic alphabets, mapped sensibly (as on the phone).
  'Й': 'J', 'й': 'j', 'Ь': '', 'ь': '', 'Ъ': '', 'ъ': '', 'Ы': 'Y', 'ы': 'y',
  'Э': 'E', 'э': 'e', 'Ю': 'Ju', 'ю': 'ju', 'Я': 'Ja', 'я': 'ja', 'Ё': 'Jo', 'ё': 'jo',
  'Щ': 'Šč', 'щ': 'šč', 'Ѓ': 'Đ', 'ѓ': 'đ', 'Ќ': 'Ć', 'ќ': 'ć', 'Ѕ': 'Dz', 'ѕ': 'dz',
  'І': 'I', 'і': 'i', 'Ї': 'Ji', 'ї': 'ji', 'Є': 'Je', 'є': 'je', 'Ґ': 'G', 'ґ': 'g',
};

const isUpper = (c) => c !== undefined && c !== c.toLowerCase() && c === c.toUpperCase();

/** Serbian Cyrillic to Latin; "ЉУБАВ" → "LJUBAV", "Љубав" → "Ljubav". */
export function toLatin(text) {
  let out = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const repl = MAP[c];
    if (repl === undefined) { out += c; continue; }
    changed = true;
    if (repl.length === 2 && isUpper(c) && nextIsUpper(text, i)) out += repl.toUpperCase();
    else out += repl;
  }
  return changed ? out : text;
}

function nextIsUpper(text, i) {
  if (i + 1 >= text.length) return isUpper(text[i - 1]);
  return isUpper(text[i + 1]);
}

// ------------------------------------------------------------ Latin → Cyrillic (display)

const LAT = {
  a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', đ: 'ђ', e: 'е', ž: 'ж', z: 'з', i: 'и', j: 'ј', k: 'к', l: 'л',
  m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', ć: 'ћ', u: 'у', f: 'ф', h: 'х', c: 'ц', č: 'ч', š: 'ш',
};
const DIGRAPH = { lj: 'љ', nj: 'њ', dž: 'џ' };
/**
 * Word starts where one lj / nj / dž pair is two letters (prefix nad-/pod- before ž, Latin roots with "nj"),
 * with the index of that pair; only that pair is split ("nadživljavati" → "надживљавати").
 */
const SPLIT_DIGRAPH = [['nadž', 2], ['podž', 2], ['injun', 1], ['konjun', 2], ['injek', 1], ['vanjezi', 2], ['tanjug', 2]];

/** A word that is not Serbian (letters Serbian Latin lacks) or not a word (link, e-mail, code): kept in Latin. */
const FOREIGN = /[qwxyäöüßàâçèéêëîïôûù]|^(?:https?:|www\.)|@|\.(?:com|rs|org|net)\b/i;

function wordToCyrillic(w) {
  // Per-character lowercase keeps indexes aligned with [w] (toLowerCase() of the whole word can change its length).
  const lower = Array.from(w, (c) => (c.toLowerCase().length === 1 ? c.toLowerCase() : c)).join('');
  if (FOREIGN.test(w) || !/[a-zčćžšđ]/i.test(w)) return w;
  const splitAt = SPLIT_DIGRAPH.find(([p]) => lower.startsWith(p))?.[1] ?? -1;
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const lc = lower[i];
    const pair = lower.slice(i, i + 2);
    if (i !== splitAt && DIGRAPH[pair]) {
      const cyr = DIGRAPH[pair];
      out += c !== lc ? cyr.toUpperCase() : cyr; // case follows the first letter: "Lj"/"LJ" → "Љ"
      i++;
      continue;
    }
    const cyr = LAT[lc];
    if (cyr === undefined) { out += c; continue; }
    out += c !== lc ? cyr.toUpperCase() : cyr;
  }
  return out;
}

/**
 * Serbian Latin to Cyrillic, for display. Text already in Cyrillic is left as is; words with letters Serbian
 * lacks (q, w, x, y…), links and e-mail addresses stay Latin.
 */
export function toCyrillic(text) {
  if (!/[A-Za-zČĆŽŠĐčćžšđ]/.test(text)) return text;
  return text.replace(/[\p{L}\p{M}][\p{L}\p{M}\p{N}.:/@_-]*/gu, (w) => {
    // keep sentence punctuation outside the word check: "kuća." → "кућа."
    const m = /^(.*?)([.:]*)$/u.exec(w);
    return wordToCyrillic(m[1]) + m[2];
  });
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** mm:ss, or h:mm:ss above one hour. */
export function clock(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function stamp(ms, sep) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export const TAG_SYMBOLS = { IMPORTANT: '★', DECISION: '✓', TODO: '☐', QUESTION: '?', NUMBER: '#', CUSTOM: '•' };

export const tagCovers = (tag, s) => s.start < tag.end && s.end > tag.start;

/** One "[mm:ss] text" line per segment; tagged lines carry the tag symbol(s) in front, as the phone's export. */
/** [nameOf] gives a line's speaker name ("" for none): "[00:12] Pera: text". */
export function toTxt(segments, { header = null, tags = [], nameOf = () => '', times = true } = {}) {
  let out = header ? `${header}\n\n` : '';
  for (const s of segments) {
    const marks = [...new Set(tags.filter((g) => tagCovers(g, s)).map((g) => TAG_SYMBOLS[g.kind] || TAG_SYMBOLS.CUSTOM))].join('');
    if (marks) out += marks + ' ';
    const who = nameOf(s);
    out += `${times ? `[${clock(s.start)}] ` : ''}${who ? `${who}: ` : ''}${s.text}\n`;
  }
  return out;
}

/**
 * A line's text for a subtitle cue: no empty rows. Enter in the editor puts a new row into a line, and an empty
 * one ends the cue, so the rest of the text became a broken block that players drop.
 */
const cueText = (text) => String(text ?? '').split(/\r\n|\n|\r/).map((row) => row.trim()).filter(Boolean).join('\n');

export function toSrt(segments, { nameOf = () => '' } = {}) {
  return segments.map((s, i) => {
    const who = nameOf(s);
    return `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${who ? `${who}: ` : ''}${cueText(s.text)}\n\n`;
  }).join('');
}

/**
 * VTT names a speaker with its own voice tag: <v Pera>text. In the text "&", "<" and ">" are written as entities:
 * VTT reads "<" as the start of a tag, and "-->" may not appear in a cue.
 */
export function toVtt(segments, { nameOf = () => '' } = {}) {
  const voice = (n) => n.replace(/[<>&]/g, '');
  return 'WEBVTT\n\n' + segments.map((s) => {
    const who = nameOf(s);
    const text = cueText(s.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${who ? `<v ${voice(who)}>` : ''}${text}\n\n`;
  }).join('');
}

/** File-safe base name from a title, as the phone's suggestedFileName. */
export function baseName(title) {
  const t = String(title || '');
  const dot = t.lastIndexOf('.');
  const stem = dot >= 0 ? t.slice(0, dot) : t;
  return stem.replace(/[^\p{L}\p{N} _+-]/gu, '_').trim() || 'transcript';
}

/**
 * Splits a segment at character [pos]: the time is divided in proportion to the text before the cursor.
 * Spaces at the cut are dropped. Returns two segments.
 */
export function splitSegment(seg, pos) {
  const text = seg.text;
  const p = Math.max(0, Math.min(pos, text.length));
  const ratio = text.length > 0 ? p / text.length : 0.5;
  let cut = Math.round(seg.start + (seg.end - seg.start) * ratio);
  cut = Math.max(seg.start, Math.min(seg.end, cut));
  // both halves keep the line's speaker (speakers.js): the user then corrects the one that changed
  const who = seg.speaker ? { speaker: seg.speaker, speakerBy: seg.speakerBy || 'user' } : {};
  return [
    { start: seg.start, end: cut, text: text.slice(0, p).replace(/\s+$/u, ''), ...who },
    { start: cut, end: seg.end, text: text.slice(p).replace(/^\s+/u, ''), ...who },
  ];
}

/** Joins a segment with the next one: earliest start, latest end, texts joined by one space; the first one's speaker. */
export function joinSegments(a, b) {
  const parts = [a.text.replace(/\s+$/u, ''), b.text.replace(/^\s+/u, '')].filter((t) => t.length > 0);
  const src = a.speaker ? a : b.speaker ? b : null;
  const who = src ? { speaker: src.speaker, speakerBy: src.speakerBy || 'user' } : {};
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), text: parts.join(' '), ...who };
}

/**
 * Maps a cursor position in the Latin display of [stored] back to a position in [stored]
 * (Љ, Њ, Џ become two letters, a few foreign letters none).
 */
export function displayPosToStored(stored, pos) {
  let shown = 0;
  for (let k = 0; k < stored.length; k++) {
    if (shown >= pos) return k;
    const r = MAP[stored[k]];
    shown += r === undefined ? 1 : r.length;
  }
  return stored.length;
}
