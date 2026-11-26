// Transcript bundles (docs/bundle-format.md): parse a phone bundle, build one to send back.
// Mirrors the phone's core/…/data/Bundle.kt.

import { readZip, writeZip } from './zip.js';
import { baseName } from './text.js';

export const FORMAT = 'transcribe-bundle';
export const VERSION = 1;
export const AUDIO_ENTRY = 'audio.m4a';

// The recording travels in its own format as audio.<ext> (docs/bundle-format.md): the phone sends m4a, the editor
// the file it was given. Both sides decode any of these.
const TYPES = {
  m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', amr: 'audio/amr', '3gp': 'audio/3gpp', webm: 'audio/webm',
};
const EXTS = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'video/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/aac': 'aac',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/amr': 'amr', 'audio/3gpp': '3gp', 'audio/webm': 'webm',
};
const AUDIO_NAME = /^audio\.([a-z0-9]{2,4})$/;

/** The bundle entry for a recording of MIME [type] (else named by [fileName]'s extension): "audio.<ext>". */
export function audioEntry(type, fileName = '') {
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(fileName)?.[1]?.toLowerCase();
  // The file's own extension first: a recording picked without a MIME type was stored as audio/mp4.
  return `audio.${(fromName in TYPES ? fromName : null) ?? EXTS[(type || '').split(';')[0].trim().toLowerCase()] ?? 'm4a'}`;
}

/** The MIME type to store a bundle's recording under, from its entry name. */
export function audioType(entry) {
  return TYPES[AUDIO_NAME.exec(entry || '')?.[1]] ?? 'audio/mp4';
}
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export class BadBundle extends Error {
  /** @param {string} code an i18n key  @param {string} [detail] */
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail; }
}

/** The text shown and edited: editedSegments ?? segments. */
export function effective(t) {
  return t.editedSegments ?? t.segments ?? [];
}

/** Lowercase hex SHA-256 of "start\tend\ttext\n" per segment, text as stored. */
export async function fingerprint(segments) {
  const text = segments.map((s) => `${s.start}\t${s.end}\t${s.text}\n`).join('');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function checkSegments(list, key) {
  if (list == null) return;
  if (!Array.isArray(list)) throw new BadBundle('errTranscript', key);
  for (const s of list) {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.text !== 'string') throw new BadBundle('errTranscript', key);
  }
}

/**
 * Reads a bundle. Returns {envelope, transcript (the parsed JSON object, all keys kept), audio (Uint8Array|null)}.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {object} [zipOpts] passed to readZip (tests inject an inflater)
 */
export async function parseBundle(bytes, zipOpts) {
  let entries;
  try { entries = readZip(bytes, zipOpts); } catch (e) { throw new BadBundle('errNotZip', e.message); }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const readJson = async (name, code) => {
    const e = byName.get(name);
    if (!e) throw new BadBundle(code, `${name} missing`);
    if (e.size > MAX_JSON_BYTES) throw new BadBundle(code, `${name} too large`);
    try { return JSON.parse(new TextDecoder('utf-8').decode(await e.read())); } catch (err) { throw new BadBundle(code, err.message); }
  };
  const env = await readJson('bundle.json', 'errEnvelope');
  if (!env || env.format !== FORMAT) throw new BadBundle('errFormat');
  const version = Number.isInteger(env.version) ? env.version : 0;
  if (version < 1 || version > VERSION) throw new BadBundle('errVersion', String(env.version));
  const transcript = await readJson('transcript.json', 'errTranscript');
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript)) throw new BadBundle('errTranscript');
  if (!Array.isArray(transcript.segments)) throw new BadBundle('errTranscript', 'segments');
  checkSegments(transcript.segments, 'segments');
  checkSegments(transcript.editedSegments, 'editedSegments');
  const envelope = {
    from: String(env.from ?? ''),
    transcriptId: String(env.transcriptId || transcript.id || ''),
    title: String(env.title || transcript.title || ''),
    exportedAt: Number(env.exportedAt) || 0,
    baseFingerprint: String(env.baseFingerprint ?? ''),
    audio: typeof env.audio === 'string' && env.audio && env.audio !== 'null' ? env.audio : null,
    baseSegments: null,
  };
  // The text the sender started from (docs/bundle-format.md); kept only when it matches its fingerprint.
  if (Array.isArray(env.baseSegments)) {
    try {
      checkSegments(env.baseSegments, 'baseSegments');
      if ((await fingerprint(env.baseSegments)) === envelope.baseFingerprint) envelope.baseSegments = env.baseSegments;
    } catch { /* ignored: an unusable base only means no three-way compare */ }
  }
  if (!envelope.transcriptId) throw new BadBundle('errTranscript', 'id');
  let audio = null;
  if (envelope.audio && AUDIO_NAME.test(envelope.audio) && byName.has(envelope.audio)) audio = await byName.get(envelope.audio).read();
  return { envelope, transcript, audio, audioType: audio ? audioType(envelope.audio) : null };
}

/**
 * Builds a bundle of [transcript] (every key kept, editedSegments replaced) for the phone or another browser.
 * [baseFingerprint] is the fingerprint of the text as it came in (or as made here); [audio], {name, data}, is the
 * recording, named by audioEntry().
 */
export function buildBundle({ transcript, editedSegments, baseFingerprint, baseSegments = null, audio = null, now = Date.now() }) {
  const t = { ...transcript, editedSegments: editedSegments ?? null };
  const env = {
    format: FORMAT,
    version: VERSION,
    from: 'web',
    transcriptId: String(transcript.id),
    title: String(transcript.title ?? ''),
    exportedAt: now,
    baseFingerprint,
    audio: audio ? audio.name : null,
  };
  // The phone's text as loaded, so the phone can offer only the lines changed here (three-way compare).
  if (baseSegments) env.baseSegments = baseSegments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const zip = writeZip([
    { name: 'bundle.json', data: JSON.stringify(env, null, 2) },
    { name: 'transcript.json', data: JSON.stringify(t) },
    ...(audio ? [{ name: audio.name, data: audio.data }] : []),
  ], new Date(now));
  return { bytes: zip, fileName: `${baseName(transcript.title)} - editor.zip` };
}

/**
 * What to do when a bundle arrives for an id already stored:
 * 'new' when there is none, 'replace' when the local copy is unchanged since it was loaded (or already has the
 * incoming text), else 'ask'.
 * @param {{loadedFp: string}|null} local  @param {string} localCurrentFp  @param {string} [incomingFp]
 */
export function importDecision(local, localCurrentFp, incomingFp) {
  if (!local) return 'new';
  if (localCurrentFp === local.loadedFp || localCurrentFp === incomingFp) return 'replace';
  return 'ask';
}

/**
 * The fingerprints a freshly opened bundle starts with: loadedFp is its effective text, baseFp the one to send
 * back. A bundle the editor saved itself ("web") carries the phone's base along.
 */
export async function loadFingerprints(envelope, transcript) {
  const loadedFp = await fingerprint(effective(transcript));
  const fromWeb = envelope.from === 'web' && envelope.baseFingerprint;
  const baseFp = fromWeb ? envelope.baseFingerprint : loadedFp;
  // The text to send back as the base: the phone's, as loaded; a re-opened editor bundle carries it along.
  const baseSegs = fromWeb ? (envelope.baseSegments ?? null) : effective(transcript);
  return { loadedFp, baseFp, baseSegs };
}
