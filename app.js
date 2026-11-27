// Transkript: the editor UI (branded per brands/<id>, see tools/build.mjs). Logic without the DOM lives in the other modules (and their tests).

import { t } from './i18n.js';
import { toDocx, docxLang, DOCX_TYPE } from './docx.js';
import * as spk from './speakers.js';
import { lineCopy } from './speakers.js';
import { parseBundle, buildBundle, fingerprint, effective, loadFingerprints, importDecision, BadBundle, audioEntry } from './bundle.js';
import { toLatin, toCyrillic, clock, toTxt, toSrt, toVtt, baseName, splitSegment, joinSegments, displayPosToStored, tagCovers } from './text.js';
import * as ai from './ai.js';
import * as store from './store.js';
import * as hist from './history.js';
import * as asr from './asr.js';
import * as gemini from './gemini.js';
import { SAMPLE_RATE, windows, isSilent, placePieces, mergeSentences, newTranscriptId } from './speech.js';
import { DOWNLOAD_MB, ENGINE } from './asr-model.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const MAX_AI_ANSWER_BYTES = 4 * 1024 * 1024;
const SAVE_DELAY_MS = 600;
/** A version is saved by itself after this long without typing (and on Nazad, leaving or refreshing the page). */
const VERSION_IDLE_MS = 60_000;
const PREFS_KEY = `${self.BRAND?.storage ?? 'transkript'}-prefs`; // also read by theme.js

// ------------------------------------------------------------------ state

/** The open transcript. */
const S = {
  doc: null,          // store record (see store.js)
  segs: [],           // working copy of the effective segments
  hasEdited: false,   // editedSegments is non-null
  audioUrl: null,
  current: -1,        // index of the line playing
  focused: -1,        // index of the last focused line
  saveTimer: 0,
  pendingEdit: false, // typed/split/joined since the last 'edit' version was recorded
  review: null,       // {sent, changes, missing, continueFrom, checked:Set}
};

const prefs = loadPrefs();
function loadPrefs() {
  const d = { latin: true, autoscroll: true, speed: 1, theme: 'system', asrLang: 'sr' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return d; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// Both directions: a transcript mixes scripts (Whisper writes Cyrillic, Parakeet drafts and edits are Latin).
// Only Serbian text: an English transcript (web editor, 1.9) is shown as stored, Cyrillic would garble it.
const docLang = () => S.doc?.transcript?.language || 'sr';
const scriptApplies = (lang = docLang()) => lang !== 'en';
const display = (text, lang = docLang()) => (!scriptApplies(lang) ? text : prefs.latin ? toLatin(text) : toCyrillic(text));
const displayedSegs = () => S.segs.map((s) => ({ ...s, text: display(s.text) }));

// ------------------------------------------------------------------ i18n in markup

function applyI18n() {
  document.title = t('appName');
  $('#app-version').textContent = t('version', self.APP_VERSION ?? '?');
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
  for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
}

function showMsg(node, text, warn = false) {
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('warn', warn);
}

let edMsgTimer = 0;
function flash(text, warn = false) {
  const n = $('#ed-msg');
  showMsg(n, text, warn);
  clearTimeout(edMsgTimer);
  if (!warn) edMsgTimer = setTimeout(() => showMsg(n, ''), 6000);
}

// ------------------------------------------------------------------ dialogs

function closeOnBackdrop(d) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  for (const b of d.querySelectorAll('[data-close]')) b.addEventListener('click', () => d.close());
}

/** Shows a choice dialog; resolves with the chosen value, or null when dismissed. */
function choose(title, text, buttons) {
  const d = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const actions = $('#confirm-actions');
  actions.replaceChildren();
  return new Promise((resolve) => {
    let value = null;
    for (const b of buttons) {
      const btn = el('button', `btn ${b.cls || ''}`, b.label);
      btn.type = 'button';
      btn.addEventListener('click', () => { value = b.value; d.close(); });
      actions.append(btn);
    }
    d.addEventListener('close', () => resolve(value), { once: true });
    d.showModal();
  });
}

const confirmBox = (title, text, okLabel) => choose(title, text, [
  { label: t('cancel'), value: false, cls: 'ghost' },
  { label: okLabel || t('ok'), value: true, cls: 'primary' },
]).then((v) => v === true);

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const downloadText = (text, name, type = 'text/plain') => downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), name);

// ------------------------------------------------------------------ start screen

async function showStart() {
  await flushSave();
  await autoVersion();
  stopAudio();
  S.doc = null;
  $('#editor').hidden = true;
  $('#start').hidden = false;
  await renderSaved();
}

async function renderSaved() {
  let docs = [];
  try { docs = await store.listDocs(); } catch (e) { showMsg($('#start-msg'), t('errStorage', e.message), true); }
  docs.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const list = $('#saved-list');
  list.replaceChildren();
  $('#saved-empty').hidden = docs.length > 0;
  for (const d of docs) {
    const li = el('li', 'saved-item');
    const info = el('div', 'saved-info');
    info.append(el('strong', '', d.title || d.id));
    const meta = el('span', 'muted');
    const parts = [];
    if (d.createdAt) parts.push(new Date(d.createdAt).toLocaleString('sr-Latn'));
    if (d.durationMs) parts.push(clock(d.durationMs));
    if (!d.hasAudio) parts.push(t('noAudio'));
    meta.textContent = parts.join(' · ');
    info.append(meta);
    info.append(langBadge(d.transcript?.language || d.asr?.lang));
    if (d.currentFp && d.currentFp !== d.loadedFp && !d.asr) info.append(el('span', 'badge', t('edited')));
    li.dataset.id = d.id;
    const running = ASR.current === d.id;
    const queued = ASR.queue.includes(d.id);
    if (running) info.append(el('span', 'badge asr-live', t('asrRunningPct', asrPercent(d))));
    else if (queued) info.append(el('span', 'badge', t('asrQueuedBadge', ASR.queue.indexOf(d.id) + 1)));
    else if (d.asr) info.append(el('span', 'badge unsure', t('asrUnfinished', asrPercent(d))));
    const open = el('button', 'btn primary small', running ? t('asrShow') : queued ? t('asrUnqueue') : d.asr ? t('asrResume') : t('open'));
    open.type = 'button';
    if (queued) open.className = 'btn small';
    open.addEventListener('click', () => {
      if (running) $('#dlg-asr').showModal();
      else if (queued) dequeue(d.id);
      else if (d.asr) enqueue([d.id]);
      else openDoc(d.id);
    });
    const del = el('button', 'btn ghost small', t('delete'));
    del.type = 'button';
    del.hidden = running; // stop it first: its run still writes to it
    del.addEventListener('click', async () => {
      if (await confirmBox(t('delete'), t('deleteConfirm', d.title || d.id), t('delete'))) {
        // its run may have started while the question was open: the list now shows it running, without "Obriši"
        if (ASR.current === d.id) { renderSaved(); return; }
        dequeue(d.id);
        await store.deleteDoc(d.id);
        renderSaved();
      }
    });
    const ren = el('button', 'btn ghost small', t('rename'));
    ren.type = 'button';
    ren.setAttribute('aria-label', t('renameOf', d.title || d.id));
    ren.addEventListener('click', () => renameDoc(d.id));
    const actions = [open];
    if (!d.asr) {
      // The same export as in the editor, without opening it; an unfinished transcription has nothing to send yet.
      const exp = el('button', 'btn small', t('saveForPhone'));
      exp.type = 'button';
      exp.title = t('saveForPhoneHint');
      exp.setAttribute('aria-label', t('exportOf', d.title || d.id));
      exp.addEventListener('click', async () => {
        const msg = await exportDoc(d, d.transcript.editedSegments ?? null);
        if (msg) showMsg($('#start-msg'), msg);
      });
      actions.push(exp);
    }
    li.append(info, ...actions, ren, del);
    list.append(li);
  }
}

/**
 * Gives a saved transcript a new name: shown here and in the editor, and used for the exported files' names. The id
 * stays, so exports and imports still match it up with the other side's copy.
 */
async function renameDoc(id) {
  let doc = await store.getDoc(id);
  if (!doc) return;
  const d = $('#dlg-rename');
  const input = $('#rename-input');
  input.value = doc.title || '';
  const name = await new Promise((resolve) => {
    let value = null;
    const save = () => { value = input.value.trim(); d.close(); };
    $('#rename-save').onclick = save;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    d.addEventListener('close', () => resolve(value), { once: true });
    d.showModal();
    input.select();
  });
  if (!name) return;
  // The record read before the dialog is old by now: a transcription rewrites it after every window, and writing the
  // old one back undid the rename or a finished run. A running one is renamed in the run's own copy (it saves that
  // one); any other is read again.
  const setTitle = (x) => { x.title = name; if (x.transcript) x.transcript.title = name; };
  const live = () => (ASR.doc?.id === id ? ASR.doc : null);
  doc = live() ?? await store.getDoc(id);
  if (!doc) return;
  if (name !== doc.title) {
    setTitle(doc);
    await store.putDoc(doc);
  }
  // a run that read the record just before that save has the old name
  const run = live();
  if (run) {
    if (run !== doc) setTitle(run);
    $('#asr-file-name').textContent = `${run.title} · ${langName(run.asr?.lang)}`;
  }
  renderSaved();
}

/** "Srpski" for sr; a transcript without a language is from the phone or from before 1.9, so Serbian. */
function langName(code) {
  const c = code || 'sr';
  return c === 'sr' ? t('langSr') : c === 'en' ? t('langEn') : c;
}

/** "SR" / "EN" on a saved transcript: its language, fixed when it was transcribed (a new one needs a new transcription). */
function langBadge(code) {
  const c = code || 'sr';
  const b = el('span', 'badge lang');
  b.title = t('langTag', langName(c));
  b.append(el('span', '', c.toUpperCase()));
  b.firstChild.setAttribute('aria-hidden', 'true');
  b.append(el('span', 'sr-only', b.title));
  return b;
}

async function importFile(file) {
  if (isAudio(file)) { await transcribeFiles([file]); return; }
  const msg = $('#start-msg');
  showMsg(msg, t('loading'));
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { envelope, transcript, audio, audioType } = await parseBundle(bytes);
    if (!transcript.id) transcript.id = envelope.transcriptId;
    const id = String(transcript.id);
    const { loadedFp, baseFp, baseSegs } = await loadFingerprints(envelope, transcript);
    const local = await store.getDoc(id);
    const decision = importDecision(local, local?.currentFp ?? local?.loadedFp, loadedFp);
    if (decision === 'ask') {
      const pick = await choose(t('conflictTitle'), t('conflictText', local.title || id), [
        { label: t('cancel'), value: null, cls: 'ghost' },
        { label: t('takePhone'), value: 'phone' },
        { label: t('keepMine'), value: 'mine', cls: 'primary' },
      ]);
      if (pick === null) { showMsg(msg, ''); return; }
      if (pick === 'mine') { showMsg(msg, ''); await openDoc(id); return; }
    }
    // Taking the incoming text over a local copy: keep the versions made here too (history rule 3).
    if (local) transcript.history = hist.merge(local.transcript?.history, transcript.history);
    // The fingerprint covers only times and text: without this, taking a copy with the same text dropped our speakers.
    if (local) spk.mergeIncoming(local.transcript, transcript);
    // The text taken is the phone's: when the history does not end with it (a merged laptop version, or phone edits
    // made before versions existed), record it as a "Sa telefona" version, so it is not later saved as a laptop edit.
    transcript.history = hist.record(transcript, { source: 'phone', device: 'web', segments: transcript.editedSegments ?? null, now: Date.now() });
    const doc = {
      id,
      title: String(transcript.title || envelope.title || id),
      createdAt: Number(transcript.createdAt) || envelope.exportedAt || Date.now(),
      durationMs: Number(transcript.durationMs) || 0,
      transcript,
      loadedFp,
      baseFp,
      baseSegs,
      currentFp: loadedFp,
      hasAudio: !!audio || !!local?.hasAudio,
      savedAt: Date.now(),
    };
    const blob = audio ? new Blob([audio], { type: audioType }) : null;
    await store.putDocWithAudio(doc, blob);
    store.persist();
    showMsg(msg, '');
    await openDoc(id);
  } catch (e) {
    console.error(e);
    const text = e instanceof BadBundle ? t(e.code, e.detail) : t('errRead', e.message || String(e));
    showMsg(msg, text, true);
  }
}

// ------------------------------------------------------------------ transcribing in the browser

/** In-browser transcription: ok once support() passed; one run at a time. */
// In-browser transcription runs one recording at a time, in the background: more can wait in [queue], and the
// editor stays usable meanwhile. [current] is the id being transcribed; [show] opens the progress dialog for the
// next run (a run the user just started from the start screen); [status] is its latest progress line.
const ASR = { ok: false, why: '', running: false, stop: false, loading: false, transcriber: null,
  queue: [], current: null, show: false, status: { text: '', fraction: null } };

const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|opus|aac|flac|amr|3gp|webm|mp4)$/i;
const isAudio = (f) => (f.type || '').startsWith('audio/') || AUDIO_EXT.test(f.name || '');
const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
const asrPercent = (d) => {
  const total = (d.durationMs || 0) * (SAMPLE_RATE / 1000);
  return total ? Math.min(99, Math.floor((100 * (d.asr.done || 0)) / total)) : 0;
};

/** Shows the card: the button when this browser can transcribe, else why not. */
async function setupAsr() {
  const s = await asr.support();
  ASR.ok = s.ok;
  ASR.why = s.ok ? '' : t(s.reason);
  $('#asr-card').hidden = false;
  $('#drop').hidden = !s.ok;
  $('#set-model').hidden = !s.ok;
  $('#asr-lang-field').hidden = !s.ok;
  $('#asr-gentle-field').hidden = !s.ok;
  syncGentle();
  $('#asr-lang').value = ['sr', 'en'].includes(prefs.asrLang) ? prefs.asrLang : 'sr';
  $('#asr-why').hidden = s.ok;
  $('#asr-why').textContent = ASR.why;
  await updateModelLine();
}

/** The pause mode's two switches (start screen, progress dialog) show the one setting; on unless turned off. */
function syncGentle() {
  for (const box of [$('#asr-gentle'), $('#asr-gentle-dlg')]) box.checked = prefs.asrGentle !== false;
}

async function updateModelLine() {
  const m = await asr.modelState();
  const text = !ASR.ok ? '' : m.downloaded ? t('asrModelReady', mb(m.bytes)) : t('asrModelMissing', DOWNLOAD_MB);
  $('#asr-model').textContent = text;
  $('#set-model-text').textContent = text;
  $('#asr-delete-model').hidden = !(m.bytes > 0) || ASR.running;
  return m;
}

async function deleteModel() {
  const m = await asr.modelState();
  if (!(await confirmBox(t('asrDeleteModelTitle'), t('asrDeleteModelText', mb(m.bytes)), t('delete')))) return;
  ASR.transcriber?.terminate();
  ASR.transcriber = null;
  await asr.deleteModel();
  await updateModelLine();
  $('#set-model-text').textContent = `${t('asrModelDeleted')}. ${$('#set-model-text').textContent}`;
}

/** New transcripts from audio files: each stored with its recording, then queued for transcription. */
async function transcribeFiles(files) {
  const msg = $('#start-msg');
  const audio = files.filter(isAudio);
  if (!audio.length) { showMsg(msg, t('asrNotAudio'), true); return; }
  if (!ASR.ok) { showMsg(msg, ASR.why || t('asrNoWebgpu'), true); return; }
  const busy = ASR.current != null || ASR.queue.length > 0;
  if (!busy && !(await asr.modelState()).downloaded
    && !(await confirmBox(t('asrDownloadTitle'), t('asrDownloadText', DOWNLOAD_MB), t('asrDownload')))) return;
  const ids = [];
  let failed = null;
  for (const file of audio) {
    // A full disk fails the save: say so, stop there (the rest would fail too) and still queue what was stored.
    try { ids.push(await addRecording(file)); } catch (e) { failed = e; break; }
  }
  if (failed) {
    console.error(failed);
    const text = t('errStorage', failed.message || String(failed));
    showMsg(msg, ids.length ? `${text} ${t('asrQueued', ids.length)}` : text, true);
    if (!ids.length) return;
  } else {
    store.persist();
    showMsg(msg, busy || ids.length > 1 ? t('asrQueued', ids.length) : '');
  }
  // The first run started from the start screen shows its progress; anything added later just waits its turn.
  enqueue(ids, { show: !busy && !$('#start').hidden });
}

/** Stores [file] as a new, not yet transcribed transcript in the language chosen now; returns its id. */
async function addRecording(file) {
  const now = new Date();
  const id = newTranscriptId(now);
  const title = file.name.replace(/\.[^.]+$/, '') || id;
  const createdAt = file.lastModified || now.getTime(); // a recording's file date is when it was recorded
  const lang = $('#asr-lang').value || 'sr';
  const transcript = {
    id, title, createdAt, durationMs: 0, language: lang, segments: [], editedSegments: null, history: [],
    origin: 'web', engine: ENGINE, sourceFile: file.name,
  };
  const fp = await fingerprint([]);
  const doc = {
    id, title, createdAt, durationMs: 0, transcript, loadedFp: fp, baseFp: fp, baseSegs: null, currentFp: fp,
    hasAudio: true, savedAt: Date.now(),
    // samples transcribed so far, the model's pieces and the language: what a resume continues from
    asr: { done: 0, pieces: [], lang },
  };
  const blob = file.type ? file : new Blob([file], { type: 'audio/mp4' });
  await store.putDocWithAudio(doc, blob);
  return id;
}

/** Adds transcripts to the queue (an unfinished one resumes where it stopped) and starts the next if idle. */
function enqueue(ids, { show = false } = {}) {
  for (const id of ids) if (id !== ASR.current && !ASR.queue.includes(id)) ASR.queue.push(id);
  if (show && ASR.current == null) ASR.show = true;
  updateAsrStatus();
  renderSaved();
  pump();
}

function dequeue(id) {
  ASR.queue = ASR.queue.filter((q) => q !== id);
  updateAsrStatus();
  renderSaved();
}

async function pump() {
  if (ASR.current != null || !ASR.queue.length) return;
  const id = ASR.queue.shift();
  // Taken before the first await: runAsr reads the record first, and a second enqueue in that gap saw nothing
  // running and started a second run on the same worker.
  ASR.current = id;
  ASR.stop = false; // here, not after runAsr's first await: a "Zaustavi" pressed during that read was dropped
  try {
    await runAsr(id);
  } finally {
    if (ASR.current === id) { // runAsr left before it started (no WebGPU, or nothing left to transcribe)
      ASR.current = null;
      ASR.status = { text: '', fraction: null };
      updateAsrStatus();
      if ($('#editor').hidden) renderSaved();
    }
  }
  pump();
}

// ---------------- transcription diagnostics (open the page with ?diag)
// Measures what makes the page sluggish during a run: page stalls (frames over 50 ms apart; long main-thread tasks
// when the browser reports them), the recogniser's time per window, and the save after each window. The summary is
// printed to the console (and kept in window.asrDiag) when a run ends.
const DIAG = new URLSearchParams(location.search).has('diag');

function diagStart() {
  if (!DIAG) return null;
  const d = { gaps: [], longTasks: [], windows: [], phases: {}, done: false, cores: navigator.hardwareConcurrency };
  try {
    d.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) d.longTasks.push(Math.round(e.duration)); });
    d.obs.observe({ type: 'longtask' });
  } catch { /* not every browser reports long tasks */ }
  let last = performance.now();
  const tick = (now) => {
    if (d.done) return;
    // a hidden tab draws no frames: that is not a stall
    if (document.visibilityState === 'visible' && now - last > 50) d.gaps.push(Math.round(now - last));
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return d;
}

function diagEnd(d) {
  if (!d) return;
  d.done = true;
  d.obs?.disconnect();
  const stats = (xs) => {
    if (!xs.length) return { n: 0 };
    const s = [...xs].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { n: s.length, total: s.reduce((a, b) => a + b, 0), p50: at(0.5), p95: at(0.95), max: s.at(-1) };
  };
  const summary = {
    cores: d.cores, phases: d.phases,
    stalls_over_50ms: stats(d.gaps),
    long_main_thread_tasks: stats(d.longTasks),
    recogniser_ms_per_window: stats(d.windows.map((w) => w.run)),
    save_ms_per_window: stats(d.windows.map((w) => w.save)),
    audio_s_per_window: stats(d.windows.map((w) => w.audio)),
  };
  globalThis.asrDiag = { summary, windows: d.windows, gaps: d.gaps, longTasks: d.longTasks };
  console.log('[asr-diag]', JSON.stringify(summary, null, 2));
  console.table(d.windows);
}

/** A message wherever the user is: in the editor's message line, or above the saved list. */
function notify(text, warn = false) {
  if (!$('#editor').hidden) flash(text, warn);
  else showMsg($('#start-msg'), text, warn);
}

/** The header button, the running card's badge and the tab title follow the current run. */
function updateAsrStatus() {
  const pill = $('#asr-pill');
  const running = ASR.current != null;
  pill.hidden = !running && !ASR.queue.length;
  const pct = ASR.status.fraction == null ? null : Math.floor(ASR.status.fraction * 100);
  const head = pct == null ? t('asrPillBusy') : t('asrPill', pct);
  pill.textContent = ASR.queue.length ? `${head} · ${t('asrPillQueue', ASR.queue.length)}` : head;
  const live = document.querySelector(`#saved-list li[data-id="${CSS.escape(ASR.current ?? '')}"] .asr-live`);
  if (live) live.textContent = pct == null ? ASR.status.text : t('asrRunningPct', pct);
  $('#asr-queue').textContent = ASR.queue.length ? t('asrQueueLine', ASR.queue.length) : '';
  document.title = running && pct != null ? `${pct}% · ${t('appName')}` : t('appName');
}

function setAsrPhase(text, fraction) {
  ASR.status = { text, fraction };
  updateAsrStatus();
  $('#asr-phase').textContent = text;
  const bar = $('#asr-bar');
  if (fraction == null) bar.removeAttribute('value');
  else bar.value = fraction;
}

/** Transcribes (or goes on transcribing) the stored transcript `id`, saving after every window. */
async function runAsr(id) {
  if (!ASR.ok) { notify(ASR.why || t('asrNoWebgpu'), true); return; }
  const doc = await store.getDoc(id);
  if (!doc?.asr) return;
  if (ASR.stop) { $('#dlg-asr').close(); return; } // stopped while the record was read: it stays resumable
  ASR.running = true;
  ASR.doc = doc; // the copy this run saves after every window; a rename goes into it
  ASR.status = { text: '', fraction: null };
  const dlg = $('#dlg-asr');
  // The language chosen when it started: a resume keeps it, whatever the selector says now.
  $('#asr-file-name').textContent = `${doc.title} · ${langName(doc.asr.lang)}`;
  $('#asr-detail').textContent = '';
  $('#asr-last').hidden = true;
  $('#asr-stop').disabled = false;
  $('#asr-delete-model').hidden = true;
  renderSaved();
  if (ASR.show) { ASR.show = false; if (!dlg.open) dlg.showModal(); }
  const diag = diagStart();
  let outcome = 'stopped';
  try {
    const downloading = !(await asr.modelState()).downloaded;
    setAsrPhase(t('asrLoadingModel'), null);
    if (!ASR.transcriber) ASR.transcriber = new asr.Transcriber();
    const files = new Map();
    ASR.loading = true;
    let tLoad = performance.now();
    await ASR.transcriber.load((p) => {
      if (p.type === 'retry') { $('#asr-detail').textContent = t('asrRetry', p.attempt + 1); return; }
      if (!downloading || !p.total) return;
      files.set(p.file, p);
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
      total = Math.max(total, DOWNLOAD_MB * 1e6);
      setAsrPhase(t('asrDownloading', Math.round(loaded / 1e6), Math.round(total / 1e6)), loaded / total);
    });
    ASR.loading = false;
    if (diag) diag.phases.load_ms = Math.round(performance.now() - tLoad);
    if (ASR.stop) throw new Error('stopped');

    setAsrPhase(t('asrDecoding'), null);
    let pcm;
    tLoad = performance.now();
    try {
      pcm = await asr.decodeAudio(await store.getAudio(id));
      if (diag) diag.phases.decode_ms = Math.round(performance.now() - tLoad);
    } catch (e) {
      throw new Error(t('asrBadAudio', e.message || String(e)));
    }
    const durMs = Math.round((pcm.length / SAMPLE_RATE) * 1000);
    doc.durationMs = durMs;
    doc.transcript.durationMs = durMs;
    const st = doc.asr;
    const from = Math.min(st.done || 0, pcm.length);
    const ws = windows(pcm.subarray(from)).map(([a, b]) => [a + from, b + from]);
    const t0 = performance.now();
    const showProgress = (doneSamples) => {
      const done = doneSamples / pcm.length;
      setAsrPhase(t('asrProgress', clock((doneSamples / SAMPLE_RATE) * 1000), clock(durMs)), done);
      const audioS = (doneSamples - from) / SAMPLE_RATE;
      const spentS = (performance.now() - t0) / 1000;
      if (audioS > 0 && doneSamples < pcm.length) {
        const speed = spentS / audioS;
        $('#asr-detail').textContent = t('asrEta', clock(((pcm.length - doneSamples) / SAMPLE_RATE) * speed * 1000), speed.toFixed(2));
      } else if (doneSamples === from) {
        $('#asr-detail').textContent = t('asrWarmup');
      }
    };
    showProgress(from);
    for (const w of ws) {
      if (ASR.stop) break;
      const tRun = performance.now();
      if (!isSilent(pcm, w[0], w[1])) {
        const placed = placePieces(await ASR.transcriber.run(pcm.subarray(w[0], w[1]), st.lang || 'sr'), pcm, w);
        st.pieces.push(...placed);
        if (placed.length) {
          $('#asr-last').textContent = display(placed.at(-1).text, st.lang || 'sr');
          $('#asr-last').hidden = false;
        }
      }
      st.done = w[1];
      doc.savedAt = Date.now();
      const tSave = performance.now();
      await store.putDoc(doc);
      if (diag) {
        diag.windows.push({ audio: Math.round((w[1] - w[0]) / SAMPLE_RATE), run: Math.round(tSave - tRun), save: Math.round(performance.now() - tSave),
          pieces: st.pieces.length, kb: Math.round(JSON.stringify(st.pieces).length / 1024) });
      }
      showProgress(w[1]);
      // Edge and Chrome draw every tab through the GPU process the recogniser keeps busy, so they freeze while it runs
      // (26 Nov 2026; Firefox on Linux has no WebGPU). A pause after each window lets the browser catch up.
      if (prefs.asrGentle !== false && w !== ws.at(-1)) {
        const pause = Math.min(8000, Math.max(500, 0.3 * (performance.now() - tRun)));
        for (const until = performance.now() + pause; performance.now() < until && !ASR.stop;) await new Promise((r) => setTimeout(r, 100));
        if (diag) diag.windows.at(-1).pause = Math.round(pause);
      }
    }
    if (!ASR.stop) {
      const segs = mergeSentences(st.pieces);
      doc.transcript.segments = segs;
      delete doc.asr;
      const fp = await fingerprint(segs);
      Object.assign(doc, { loadedFp: fp, baseFp: fp, currentFp: fp, savedAt: Date.now() });
      await store.putDoc(doc);
      outcome = segs.length ? 'done' : 'empty';
    }
  } catch (e) {
    console.error(e);
    // a stop while the model loads ends the worker, which fails the load
    if (!ASR.stop) {
      outcome = 'failed';
      const text = /^network/.test(e.message || '') ? t('asrNetwork') : t('asrFailed', e.message || String(e));
      notify(`${doc.title}: ${text}`, true);
      ASR.transcriber?.terminate();
      ASR.transcriber = null;
    }
  } finally {
    ASR.running = false;
    ASR.loading = false;
    ASR.current = null;
    ASR.doc = null;
    ASR.status = { text: '', fraction: null };
    diagEnd(diag);
    // Still watching: with more waiting the dialog stays open for the next one; with none left, the result opens
    // (unless the user is in the middle of another transcript).
    const keepOpen = dlg.open && ASR.queue.length > 0 && !ASR.stop;
    const watching = dlg.open && !ASR.queue.length && $('#editor').hidden;
    if (keepOpen) ASR.show = true; else dlg.close();
    updateAsrStatus();
    await updateModelLine();
    if (outcome === 'done' || outcome === 'empty') {
      if (watching) {
        await openDoc(id);
        flash(outcome === 'done' ? t('asrDone', S.segs.length) : t('asrEmpty'), outcome === 'empty');
      } else {
        const n = doc.transcript.segments.length;
        notify(outcome === 'done' ? t('asrDoneOf', doc.title, n) : `${doc.title}: ${t('asrEmpty')}`, outcome === 'empty');
      }
    }
    if ($('#editor').hidden) await renderSaved();
  }
}

/** "Zaustavi": ends the current run after its window and empties the queue; all stay resumable from the list. */
function stopAsr() {
  ASR.queue = [];
  // Between two queued runs nothing is running, and the dialog was kept open for the next one: with the queue now
  // empty no run would ever close it, and it stayed on "Zaustavljam…".
  if (ASR.current == null) {
    ASR.show = false;
    $('#dlg-asr').close();
    updateAsrStatus();
    if ($('#editor').hidden) renderSaved();
    return;
  }
  ASR.stop = true;
  $('#asr-stop').disabled = true;
  setAsrPhase(t('asrStopping'), null);
  // while loading there is no window to finish: end the worker (the next run loads it again)
  if (ASR.loading) {
    ASR.transcriber?.terminate();
    ASR.transcriber = null;
  }
}

// ------------------------------------------------------------------ editor

async function openDoc(id) {
  const doc = await store.getDoc(id);
  if (!doc) return;
  if (doc.asr) { // not transcribed to the end yet
    if (ASR.current === id) $('#dlg-asr').showModal();
    else if (ASR.queue.includes(id)) notify(t('asrInQueue', doc.title));
    else enqueue([id], { show: true });
    return;
  }
  S.doc = doc;
  S.hasEdited = doc.transcript.editedSegments != null;
  S.pendingEdit = false;
  S.segs = effective(doc.transcript).map(lineCopy);
  spk.ensureSpeakers(doc.transcript, S.segs); // mends a transcript restored or imported before this check existed
  S.current = -1;
  S.focused = -1;
  $('#start').hidden = true;
  $('#editor').hidden = false;
  $('#title').textContent = doc.title;
  // Typing left unsaved when the page was closed or reloaded becomes a version now, if leaving could not record it.
  if (unsavedChanges()) { commitEdit(); await saveNow(); }
  updateVersionChip();
  $('#meta').textContent = metaLine(doc.transcript);
  setSaveState('');
  showMsg($('#ed-msg'), '');
  stopAudio();
  const blob = doc.hasAudio ? await store.getAudio(id) : null;
  const audio = $('#audio');
  if (blob) {
    S.audioUrl = URL.createObjectURL(blob);
    audio.src = S.audioUrl;
    audio.playbackRate = prefs.speed;
    // A broken file (e.g. an m4a whose encoding was cut short, 25 Nov 2026) fails here, before anyone presses play.
    audio.onerror = () => { if (audio.src === S.audioUrl) flash(t('audioBroken'), true); };
  } else {
    audio.removeAttribute('src');
  }
  $('#player').classList.toggle('disabled', !blob);
  $('#no-audio').hidden = !!blob;
  updateScriptButtons();
  renderLines();
  updateTime();
  window.scrollTo(0, 0);
}

/** "Petar (+381…) · date · dolazni · 04:24" for a call, or null. */
function callLine(tr) {
  const c = tr.call;
  if (!c || typeof c !== 'object') return null;
  const parts = [];
  const who = [c.name, c.number].filter(Boolean);
  if (who.length) parts.push(who.length === 2 ? `${who[0]} (${who[1]})` : who[0]);
  if (c.date) parts.push(new Date(c.date).toLocaleString('sr-Latn'));
  const dir = { 1: 'callIncoming', 2: 'callOutgoing', 3: 'callMissed', 4: 'callVoicemail', 5: 'callRejected' }[c.type] || 'callUnknown';
  parts.push(t(dir));
  if (c.durationSec) parts.push(clock(c.durationSec * 1000));
  return parts.join(' · ');
}

function metaLine(tr) {
  const call = callLine(tr);
  const parts = [];
  if (call) parts.push(call);
  else {
    if (tr.createdAt) parts.push(new Date(tr.createdAt).toLocaleString('sr-Latn'));
    if (tr.durationMs) parts.push(t('duration', clock(tr.durationMs)));
  }
  parts.push(t('lines', S.segs.length || effective(tr).length));
  parts.push(langName(tr.language));
  return parts.join(' · ');
}

function stopAudio() {
  const audio = $('#audio');
  audio.pause();
  if (S.audioUrl) { URL.revokeObjectURL(S.audioUrl); S.audioUrl = null; }
  audio.removeAttribute('src');
  audio.load();
  updatePlayButton();
}

// ---------------- lines

function tagsOf() {
  const tags = S.doc?.transcript?.tags;
  return Array.isArray(tags) ? tags.filter((g) => g && typeof g.start === 'number' && typeof g.end === 'number') : [];
}

/**
 * Rebuilds the line list. [anchor]: the line that keeps its place on screen (by default the one to focus); without
 * it a join or split showed the list from a different place (26 Nov 2026: the joined line jumped from mid-screen to
 * behind the player bar, because the rows were measured one text row high and grew only on the next frame).
 */
function renderLines(focusIndex = -1, caret = -1, anchor = focusIndex) {
  const ol = $('#lines');
  const anchorTop = anchor >= 0 ? rowOf(anchor)?.getBoundingClientRect().top : undefined;
  ol.replaceChildren();
  const tags = tagsOf();
  for (let i = 0; i < S.segs.length; i++) ol.append(lineRow(i, tags));
  updateChips(); // before measuring: the speaker column's width changes the text boxes' width
  growAll();
  markChanged();
  highlight(S.current, false);
  if (S.doc) $('#meta').textContent = metaLine(S.doc.transcript);
  const row = anchor >= 0 ? rowOf(anchor) : null;
  if (row && anchorTop !== undefined) window.scrollBy(0, row.getBoundingClientRect().top - anchorTop);
  if (focusIndex >= 0) focusLine(focusIndex, caret);
}

/** Every line's text box to its text's height: all heights read first, then all set, so the page lays out once. */
function growAll() {
  const tas = [...document.querySelectorAll('#lines .ltext')];
  for (const ta of tas) ta.style.height = 'auto';
  const heights = tas.map((ta) => ta.scrollHeight);
  tas.forEach((ta, k) => { if (heights[k]) ta.style.height = `${heights[k]}px`; }); // 0: not on screen, left as is
}

function lineRow(i, tags) {
  const s = S.segs[i];
  const li = el('li', 'line');
  li.dataset.i = i;
  const time = el('button', 'ltime', clock(s.start));
  time.type = 'button';
  time.title = t('playLine');
  time.setAttribute('aria-label', t('playFrom', clock(s.start)));
  time.addEventListener('click', () => playFrom(i));
  const who = el('button', 'lspk');
  who.type = 'button';
  who.addEventListener('click', () => openSpeakerMenu(Number(li.dataset.i), who));
  const marks = el('span', 'tags');
  for (const g of tags.filter((g) => tagCovers(g, s))) {
    const m = el('span', g.kind === 'IMPORTANT' ? 'tag important' : 'tag', g.kind === 'IMPORTANT' ? '★' : '•');
    m.title = (g.label && String(g.label).trim()) || (g.kind === 'IMPORTANT' ? t('tagImportant') : t('tagOther'));
    if (g.note) m.title += ` — ${g.note}`;
    m.setAttribute('role', 'img');
    m.setAttribute('aria-label', m.title);
    marks.append(m);
  }
  const ta = el('textarea', 'ltext');
  ta.setAttribute('aria-label', t('lineLabel', i + 1, clock(s.start)));
  ta.rows = 1;
  ta.spellcheck = true;
  ta.lang = docLang(); // the spelling check follows the transcript's language, not always Serbian
  ta.value = display(s.text);
  ta.addEventListener('input', () => onInput(i, ta));
  ta.addEventListener('focus', () => { S.focused = i; });
  ta.addEventListener('blur', () => nameLine(Number(li.dataset.i)));
  ta.addEventListener('keydown', (e) => onLineKey(e, i, ta));
  const join = el('button', 'ljoin', '⤓');
  join.type = 'button';
  join.title = t('joinNext');
  join.setAttribute('aria-label', t('joinNext'));
  join.hidden = i === S.segs.length - 1;
  join.addEventListener('click', () => joinAt(i));
  li.append(time, who, marks, ta, join);
  return li;
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

const rowOf = (i) => $('#lines').children[i];
const areaOf = (i) => rowOf(i)?.querySelector('textarea');

function markChanged() {
  const orig = S.doc?.transcript?.segments || [];
  const same = orig.length === S.segs.length;
  for (let i = 0; i < S.segs.length; i++) {
    const row = rowOf(i);
    if (!row) continue;
    const changed = same && (orig[i].text !== S.segs[i].text || orig[i].start !== S.segs[i].start || orig[i].end !== S.segs[i].end);
    row.classList.toggle('changed', changed);
    nameLine(i, row);
  }
}

/**
 * A line's name for screen readers ("Red 3, 00:12, izmenjen red") and its tooltip. Not renamed while it has focus:
 * a name change makes some screen readers read the line again on every keystroke; it is renamed on leaving it.
 */
function nameLine(i, row = rowOf(i)) {
  if (!row) return;
  const changed = row.classList.contains('changed');
  row.title = changed ? t('lineChanged') : '';
  const ta = row.querySelector('textarea');
  if (!ta || document.activeElement === ta) return;
  const name = t('lineLabel', i + 1, clock(S.segs[i].start));
  ta.setAttribute('aria-label', changed ? `${name}, ${t('lineChanged')}` : name);
}

function focusLine(i, caret = -1) {
  const ta = areaOf(i);
  if (!ta) return;
  ta.focus({ preventScroll: true });
  const p = caret < 0 ? ta.value.length : Math.min(caret, ta.value.length);
  ta.setSelectionRange(p, p);
  reveal(rowOf(i));
}

/** Scrolls just enough to show [row] below the sticky player bar, which scrollIntoView does not know about. */
function reveal(row) {
  const margin = 8;
  const top = ($('.player')?.getBoundingClientRect().bottom ?? 0) + margin;
  const r = row.getBoundingClientRect();
  if (r.top < top) window.scrollBy(0, r.top - top);
  else if (r.bottom > innerHeight - margin) window.scrollBy(0, Math.min(r.bottom - innerHeight + margin, r.top - top));
}

function edited() {
  S.hasEdited = true;
  S.pendingEdit = true;
  updateVersionChip();
  scheduleSave();
}

function onInput(i, ta) {
  S.segs[i].text = ta.value;   // stored as typed, also in Latin mode (as on the phone)
  autoGrow(ta);
  const orig = S.doc.transcript.segments;
  const row = rowOf(i);
  if (orig.length === S.segs.length) {
    const changed = orig[i].text !== ta.value || orig[i].start !== S.segs[i].start || orig[i].end !== S.segs[i].end;
    row.classList.toggle('changed', changed);
    row.title = changed ? t('lineChanged') : '';
  }
  edited();
}

function splitAt(i, ta) {
  const s = S.segs[i];
  // The cursor is in the displayed text; split the stored text at the same letter so Cyrillic stays Cyrillic.
  let pos;
  if (ta.value === s.text) pos = ta.selectionStart;
  else if (prefs.latin && scriptApplies()) pos = displayPosToStored(s.text, ta.selectionStart);
  else { s.text = ta.value; pos = ta.selectionStart; } // Cyrillic view of Latin text: keep the line as shown, like a typed edit
  const [a, b] = splitSegment(s, pos);
  S.segs.splice(i, 1, a, b);
  edited();
  renderLines(i + 1, 0, i);
}

function joinAt(i) {
  if (i < 0 || i + 1 >= S.segs.length) return;
  const caret = display(S.segs[i].text.replace(/\s+$/u, '')).length + (S.segs[i].text.trim() && S.segs[i + 1].text.trim() ? 1 : 0);
  S.segs.splice(i, 2, joinSegments(S.segs[i], S.segs[i + 1]));
  edited();
  if (S.current > i) S.current--;
  renderLines(i, caret);
}

function onLineKey(e, i, ta) {
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl+Alt+1…9: this line's speaker (a new one is added when there are fewer); Ctrl+Alt+0 clears it. Not Alt+1…9:
  // Chrome and Edge on Linux switch tabs with it before the page sees it (26 Nov 2026). AltGr (Ctrl+Alt on Windows)
  // types characters on the Serbian keyboard, so it is left alone.
  if (e.altKey && e.ctrlKey && !e.getModifierState('AltGraph') && /^Digit[0-9]$/.test(e.code)) {
    e.preventDefault();
    const n = Number(e.code.slice(5));
    setSpeaker(i, n === 0 ? null : spk.nthSpeaker(S.doc.transcript, n, { names: callNames() }));
    return;
  }
  if (mod && e.key === 'Enter') { e.preventDefault(); splitAt(i, ta); return; }
  if (mod && e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && i > 0) {
    e.preventDefault();
    joinAt(i - 1);
  }
}

// ---------------- speakers (who is talking; speakers.js holds the rules)

/** For a call, the first two speakers are offered as its two sides: "Ja" and the contact. */
function callNames() {
  const c = S.doc?.transcript?.call;
  if (!c || typeof c !== 'object') return [];
  return [t('speakerMe'), String(c.name || c.number || '').trim() || null];
}

const speakerLabel = (id) => spk.labelOf(S.doc.transcript, id, (n) => t('speakerN', n));

function setSpeaker(i, id) {
  if (i < 0 || !spk.setLineSpeaker(S.segs, i, id)) return;
  edited();
  updateChips();
}

/**
 * Every line's chip: the name at the start of a run of lines by one speaker, a coloured bar on the lines that follow
 * (the user's choice: the name once per run), a faint "+" on unmarked lines, shown on hover when nobody is marked yet.
 */
function updateChips() {
  if (!S.doc) return;
  const tr = S.doc.transcript;
  const any = spk.speakerList(tr).length > 0;
  const ol = $('#lines');
  const widen = any !== ol.classList.contains('has-speakers');
  ol.classList.toggle('has-speakers', any);
  // The first speaker widens the column and narrows the text: the boxes need their heights again (26 Nov 2026:
  // on a phone-width screen a two-line text showed one line).
  if (widen) requestAnimationFrame(growAll);
  for (let i = 0; i < S.segs.length; i++) {
    const chip = rowOf(i)?.querySelector('.lspk');
    if (!chip) continue;
    const id = S.segs[i].speaker;
    const label = id ? speakerLabel(id) : '';
    const cont = !!id && i > 0 && S.segs[i - 1].speaker === id;
    chip.className = `lspk${id ? ` c${spk.colourOf(tr, id)}` : ' none'}${cont ? ' cont' : ''}`;
    chip.textContent = id ? (cont ? '' : label) : '+';
    chip.setAttribute('aria-label', id ? t('speakerOf', label) : t('speakerSet'));
    chip.title = id ? t('speakerOf', label) : t('speakerSet');
    chip.setAttribute('aria-haspopup', 'menu');
  }
}

/** The small menu under a line's chip: the speakers, a new one, none, and the panel. Keyboard like "Sačuvaj kao…". */
function openSpeakerMenu(i, chip) {
  const menu = $('#spk-menu');
  const tr = S.doc.transcript;
  const items = [];
  const item = (text, action, cls = '') => {
    const b = el('button', `menu-item ${cls}`, text);
    b.type = 'button';
    b.addEventListener('click', () => { closeSpeakerMenu(true); action(); });
    items.push(b);
  };
  spk.speakerList(tr).forEach((p, k) => {
    item(`${k < 9 ? `${k + 1}  ` : ''}${speakerLabel(p.id)}`, () => setSpeaker(i, p.id), `sw c${k % 6}${S.segs[i].speaker === p.id ? ' on' : ''}`);
  });
  item(t('speakerNew'), () => setSpeaker(i, spk.addSpeaker(tr, { names: callNames() })));
  if (S.segs[i].speaker) item(t('speakerNone'), () => setSpeaker(i, null));
  item(t('speakersPanel'), openSpeakers);
  menu.replaceChildren(...items);
  const r = chip.getBoundingClientRect();
  menu.style.left = `${r.left + scrollX}px`;
  menu.style.top = `${r.bottom + scrollY + 4}px`;
  menu.hidden = false;
  S.menuChip = chip;
  chip.setAttribute('aria-expanded', 'true');
  items[0].focus();
}

function closeSpeakerMenu(focusChip = false) {
  const menu = $('#spk-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  S.menuChip?.setAttribute('aria-expanded', 'false');
  if (focusChip) S.menuChip?.focus();
}

/** "Govornici": rename once for all lines, merge two into one, remove, add. */
function openSpeakers() {
  renderSpeakers();
  $('#dlg-speakers').showModal();
}

function renderSpeakers() {
  const tr = S.doc.transcript;
  const list = spk.speakerList(tr);
  const n = spk.counts(S.segs);
  const ul = $('#spk-list');
  ul.replaceChildren();
  $('#spk-empty').hidden = list.length > 0;
  list.forEach((p, k) => {
    const li = el('li', 'spk-row');
    const sw = el('span', `swatch c${k % 6}`);
    sw.setAttribute('aria-hidden', 'true');
    const name = el('input', 'spk-name');
    name.type = 'text';
    name.value = p.name ?? '';
    name.placeholder = t('speakerN', k + 1);
    name.setAttribute('aria-label', t('speakerNameOf', k + 1));
    name.addEventListener('change', async () => {
      if (spk.renameSpeaker(tr, p.id, name.value)) { updateChips(); await saveNow(); }
    });
    const count = el('span', 'muted small', t('speakerLines', n[p.id] || 0));
    const merge = el('select', 'spk-merge');
    merge.setAttribute('aria-label', t('speakerMergeOf', speakerLabel(p.id)));
    merge.append(el('option', '', t('speakerMerge')));
    merge.options[0].value = '';
    for (const q of list) if (q.id !== p.id) { const o = el('option', '', speakerLabel(q.id)); o.value = q.id; merge.append(o); }
    merge.disabled = list.length < 2;
    merge.addEventListener('change', async () => {
      const into = merge.value;
      if (!into) return;
      if (await confirmBox(t('speakerMerge'), t('speakerMergeText', speakerLabel(p.id), speakerLabel(into)), t('speakerMergeOk'))) {
        spk.mergeSpeaker(tr, S.segs, p.id, into);
        edited();
        updateChips();
      }
      renderSpeakers();
    });
    const del = el('button', 'btn ghost small', t('speakerRemove'));
    del.type = 'button';
    del.setAttribute('aria-label', t('speakerRemoveOf', speakerLabel(p.id)));
    del.addEventListener('click', async () => {
      if (await confirmBox(t('speakerRemove'), t('speakerRemoveText', speakerLabel(p.id), n[p.id] || 0), t('speakerRemove'))) {
        spk.removeSpeaker(tr, S.segs, p.id);
        edited();
        updateChips();
        renderSpeakers();
      }
    });
    li.append(sw, name, count, merge, del);
    ul.append(li);
  });
}

// ---------------- playback

const audioEl = () => $('#audio');
const hasAudio = () => !!S.audioUrl;

/** play() rejects for an unplayable file or a blocked autoplay; say so instead of doing nothing. */
function play(a) {
  a.play().catch((e) => { if (e?.name !== 'AbortError') flash(a.error ? t('audioBroken') : t('playFailed', e?.message || e), true); });
}

function playFrom(i) {
  const s = S.segs[i];
  if (!s) return;
  endClip();
  S.focused = i;
  if (!hasAudio()) { focusLine(i, 0); return; }
  const a = audioEl();
  a.currentTime = s.start / 1000;
  play(a);
}

// One line played on its own (AI review, version history): it stops at the line's end. A little past it, because the
// recognised end is often a few hundred ms early and the last word gets clipped.
const CLIP_TAIL_MS = 300;
let clip = null; // {end, btn} while a line plays

function clipButton(startMs, endMs, label) {
  const b = el('button', 'clip', `▶ ${label}`);
  b.type = 'button';
  b.dataset.label = label;
  b.setAttribute('aria-label', t('clipPlay', label));
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleClip(startMs, endMs, b); });
  return b;
}

function toggleClip(startMs, endMs, btn) {
  const a = audioEl();
  if (clip?.btn === btn && !a.paused) { a.pause(); return; } // the pause event ends the clip
  endClip();
  clip = { end: endMs + CLIP_TAIL_MS, btn };
  btn.textContent = `■ ${btn.dataset.label}`;
  btn.setAttribute('aria-label', t('clipStop', btn.dataset.label));
  btn.setAttribute('aria-pressed', 'true');
  a.currentTime = startMs / 1000;
  play(a);
}

/** Resets the playing line's button; the audio itself is paused by the caller when needed. */
function endClip() {
  if (!clip) return;
  const b = clip.btn;
  clip = null;
  b.textContent = `▶ ${b.dataset.label}`;
  b.setAttribute('aria-label', t('clipPlay', b.dataset.label));
  b.setAttribute('aria-pressed', 'false');
}

function stopClip() {
  if (!clip) return;
  endClip();
  audioEl().pause();
}

function togglePlay() {
  if (!hasAudio()) return;
  const a = audioEl();
  if (a.paused) play(a); else a.pause();
}

/** Index of the line at [ms]: the last one starting at or before it (binary search; lines are in time order). */
function lineAt(ms) {
  let lo = 0;
  let hi = S.segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (S.segs[mid].start <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found >= 0 && ms >= S.segs[found].end && (found + 1 >= S.segs.length || S.segs[found + 1].start > ms)) {
    // in a gap after the line: keep it highlighted only while inside it
    return ms < S.segs[found].end + 1500 ? found : -1;
  }
  return found;
}

function highlight(i, scroll = true) {
  const ol = $('#lines');
  ol.querySelector('.line.playing')?.classList.remove('playing');
  S.current = i;
  const row = i >= 0 ? rowOf(i) : null;
  if (!row) return;
  row.classList.add('playing');
  const typing = document.activeElement?.classList?.contains('ltext');
  if (scroll && prefs.autoscroll && !typing) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function updateTime() {
  const a = audioEl();
  const cur = hasAudio() ? a.currentTime : 0;
  const dur = hasAudio() && Number.isFinite(a.duration) ? a.duration : (S.doc?.durationMs || 0) / 1000;
  $('#time').textContent = `${clock(cur * 1000)} / ${clock(dur * 1000)}`;
  if (!seeking) $('#seek').value = dur > 0 ? String(Math.round((cur / dur) * 1000)) : '0';
  const i = hasAudio() ? lineAt(cur * 1000) : -1;
  if (i !== S.current) highlight(i);
}

function updatePlayButton() {
  const playing = hasAudio() && !audioEl().paused;
  const b = $('#play');
  b.textContent = playing ? '❚❚' : '▶';
  b.title = playing ? t('pause') : t('play');
  b.setAttribute('aria-label', b.title);
}

let seeking = false;
let raf = 0;
function tick() {
  if (clip && audioEl().currentTime * 1000 >= clip.end) audioEl().pause();
  updateTime();
  raf = audioEl().paused ? 0 : requestAnimationFrame(tick);
}

// ---------------- saving

function setSaveState(text) { $('#save-state').textContent = text; }

function scheduleSave() {
  setSaveState(t('saving'));
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  clearTimeout(S.versionTimer);
  S.versionTimer = setTimeout(autoVersion, VERSION_IDLE_MS);
}

/** Saves unsaved typing as a version, quietly: idle minute, Nazad, leaving or reloading the page. */
async function autoVersion() {
  clearTimeout(S.versionTimer);
  S.versionTimer = 0;
  if (!S.doc || !unsavedChanges()) return;
  commitEdit();
  await saveNow();
}

async function saveNow() {
  clearTimeout(S.saveTimer);
  S.saveTimer = 0;
  if (!S.doc) return;
  const doc = S.doc;
  doc.transcript.editedSegments = S.hasEdited ? S.segs.map(lineCopy) : null;
  doc.currentFp = await fingerprint(effective(doc.transcript));
  doc.savedAt = Date.now();
  try {
    await store.putDoc(doc);
    if (S.doc === doc && !S.saveTimer) setSaveState(t('saved'));
  } catch (e) {
    setSaveState('');
    flash(t('errStorage', e.message), true);
  }
}

async function flushSave() {
  if (S.saveTimer) await saveNow();
}

// ---------------- version history

const segsCopy = () => S.segs.map(lineCopy);

/** Records a version of the text as it is now (null = the machine text). */
function recordVersion(source, segments, from) {
  const tr = S.doc.transcript;
  tr.history = hist.record(tr, { source, device: 'web', segments, now: Date.now(), from });
  updateVersionChip();
}

/**
 * Typing is autosaved but makes no version: a version is saved by hand ("Sačuvaj verziju", Ctrl+S). Before an AI
 * apply, a revert, a restore or sending to the phone, unsaved typing is saved as an 'edit' version first, so it
 * never drops out of the history.
 */
function commitEdit() {
  if (!S.doc) return;
  S.pendingEdit = false;
  recordVersion('edit', S.hasEdited ? segsCopy() : null);
}

/** "Sačuvaj verziju": the text as it is now becomes the next version (nothing when it equals the last one). */
async function saveVersion() {
  if (!S.doc) return;
  const before = hist.currentVersion(S.doc.transcript.history);
  commitEdit();
  await saveNow();
  const n = hist.currentVersion(S.doc.transcript.history);
  flash(n > before ? t('versionSaved', n) : t('versionNoChange', n));
}

/** True when the text differs from the last saved version: the chip then reads "v4*". */
function unsavedChanges() {
  const tr = S.doc?.transcript;
  if (!tr) return false;
  const all = hist.versions(tr);
  return !hist.sameText(S.hasEdited ? S.segs : tr.segments, hist.textOf(tr, all[all.length - 1]));
}

function updateVersionChip() {
  const n = hist.currentVersion(S.doc?.transcript?.history);
  const dirty = unsavedChanges();
  const chip = $('#version-chip');
  chip.textContent = `v${n}${dirty ? '*' : ''}`;
  chip.title = dirty ? t('unsavedVersion') : t('historyTitle');
  $('#save-version').classList.toggle('primary', dirty);
}

const pad2 = (x) => String(x).padStart(2, '0');
const shortDate = (ms) => { const d = new Date(ms); return `${d.getDate()}.${d.getMonth() + 1}. ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

function sourceLabel(v) {
  if (v.source === 'restore') return t('histRestore', v.from ?? '?');
  const key = { original: 'histOriginal', edit: 'histEdit', ai: 'histAi', laptop: 'histLaptop', reset: 'histReset', phone: 'histPhone' }[v.source];
  return key ? t(key) : String(v.source ?? '');
}

/** "12 redova izmenjeno", with Serbian plural forms. */
function changedLabel(n) {
  const one = n % 10 === 1 && n % 100 !== 11;
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
  return t(one ? 'histChanged1' : few ? 'histChanged2' : 'histChanged5', n);
}

function openHistory() {
  const tr = S.doc.transcript;
  const all = hist.versions(tr);
  const list = $('#history-list');
  list.replaceChildren();
  for (let i = all.length - 1; i >= 0; i--) {
    const v = all[i];
    const text = hist.textOf(tr, v);
    const parts = [`v${v.n}`];
    if (v.at) parts.push(shortDate(v.at));
    parts.push(sourceLabel(v));
    if (v.device === 'phone' || v.device === 'web') parts.push(t(v.device === 'phone' ? 'devPhone' : 'devWeb'));
    if (i > 0) {
      const n = hist.linesChanged(hist.textOf(tr, all[i - 1]), text);
      // a version that only marks who is talking is not "0 redova izmenjeno"
      const onlySpeakers = n === 0 && hist.speakersChanged(hist.textOf(tr, all[i - 1]), text) > 0;
      parts.push(n == null ? t('histResplit') : onlySpeakers ? t('histSpeakersOnly') : changedLabel(n));
    }
    const li = el('li', i === all.length - 1 ? 'hist-item current' : 'hist-item');
    const head = el('div', 'hist-head');
    head.append(el('span', 'hist-label', parts.join(' · ')));
    if (i === all.length - 1) head.append(el('span', 'badge', t('histCurrent')));
    else {
      const btn = el('button', 'btn small', t('histRestoreBtn'));
      btn.type = 'button';
      btn.addEventListener('click', () => restoreVersion(v.n));
      head.append(btn);
    }
    const det = el('details', 'hist-preview');
    det.append(el('summary', '', t('histShow')));
    det.addEventListener('toggle', () => {
      if (!det.open || det.querySelector('ol')) return;
      // What this version changed against the one before: removed words struck through, new ones bold.
      const pairs = hist.previewPairs(i > 0 ? hist.textOf(tr, all[i - 1]) : null, text);
      const ol = el('ol', 'hist-lines');
      let changed = 0;
      for (const { seg, old, shown, regrouped } of pairs) {
        const now = display(shown);
        const was = old == null ? null : display(old);
        // a split or joined line is a change too: its "¶" shows where a line now ends or no longer does
        const isChanged = was != null && (regrouped || was.trim().replace(/\s+/g, ' ') !== now.trim().replace(/\s+/g, ' '));
        if (isChanged) changed++;
        const row = el('li', isChanged ? 'changed' : 'same');
        row.append(hasAudio() ? clipButton(seg.start, seg.end, clock(seg.start)) : el('span', 'hist-time', clock(seg.start)));
        if (isChanged) {
          const body = el('span', 'diff');
          for (const w of ai.diff(was, now)) {
            body.append(el(w.kind === 'removed' ? 'del' : w.kind === 'added' ? 'ins' : 'span', '', w.text), document.createTextNode(' '));
          }
          row.append(body);
        } else row.append(document.createTextNode(now));
        ol.append(row);
      }
      // Only what changed against the previous version; v1 (nothing before it) shows its whole text.
      if (i > 0) {
        ol.classList.add('only-changed');
        if (changed === 0) {
          const onlySpeakers = hist.speakersChanged(hist.textOf(tr, all[i - 1]), text) > 0;
          det.append(el('p', 'muted hist-none', t(onlySpeakers ? 'histOnlySpeakers' : 'histNoTextChange')));
          return;
        }
      }
      det.append(ol);
    });
    li.append(head, det);
    list.append(li);
  }
  $('#dlg-history').showModal();
}

async function restoreVersion(n) {
  if (!(await confirmBox(t('histRestoreTitle', n), t('histRestoreText', n), t('histRestoreBtn')))) return;
  $('#dlg-history').close();
  commitEdit();
  const target = hist.restoreTarget(S.doc.transcript, n);
  if (target === undefined) return;
  S.hasEdited = target !== null;
  S.segs = (target ?? S.doc.transcript.segments).map(lineCopy);
  spk.ensureSpeakers(S.doc.transcript, S.segs); // speakers merged or removed since that version come back, unnamed
  recordVersion('restore', target, n);
  renderLines();
  await saveNow();
  flash(t('histRestored', n));
}

// ---------------- toolbar actions

/** The transcript as a bundle (docs/bundle-format.md), with its recording, for the phone or another browser. */
async function savePhoneBundle() {
  commitEdit();  // the bundle's transcript.json carries the history, with this session's typing in it
  const editedSegments = S.hasEdited ? S.segs.map(lineCopy) : null;
  const done = await exportDoc(S.doc, editedSegments);
  if (!done) return;
  flash(done);
  saveNow();
}

/**
 * Downloads [doc] as a bundle (docs/bundle-format.md), asking first whether to include the recording when there is
 * one. Returns the message to show, or null when cancelled. Used by the editor and by the saved list.
 */
async function exportDoc(doc, editedSegments) {
  const tr = doc.transcript;
  let blob = doc.hasAudio ? await store.getAudio(doc.id) : null;
  if (blob) {
    // The second sync of a transcript the other side already has needs only the text: much smaller. A transcript
    // that came from the phone has its recording there, so that is the suggested choice for it.
    const fromPhone = tr.origin !== 'web';
    const pick = await choose(t('exportTitle'), t('exportText', mb(blob.size)), [
      { label: t('cancel'), value: null, cls: 'ghost' },
      { label: t('exportNoAudio'), value: 'text', cls: fromPhone ? 'primary' : '' },
      { label: t('exportWithAudio', mb(blob.size)), value: 'audio', cls: fromPhone ? '' : 'primary' },
    ]);
    if (pick === null) return null;
    if (pick === 'text') blob = null;
  }
  const audio = blob ? { name: audioEntry(blob.type, tr.sourceFile), data: new Uint8Array(await blob.arrayBuffer()) } : null;
  const { bytes, fileName } = buildBundle({ transcript: tr, editedSegments, baseFingerprint: doc.baseFp, baseSegments: doc.baseSegs ?? null, audio });
  downloadBlob(new Blob([bytes], { type: 'application/zip' }), fileName);
  return t(audio ? 'savedBundle' : 'savedBundleNoAudio', fileName);
}

/** "Sačuvaj kao…": a disclosure menu of the text formats. Escape or a click elsewhere closes it; arrows move. */
function wireSaveAs() {
  const btn = $('#save-as');
  const menu = $('#save-as-menu');
  const items = [...menu.querySelectorAll('[data-export]')];
  const close = (focus = false) => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  };
  btn.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) items[0].focus();
  });
  for (const b of items) b.addEventListener('click', () => { close(true); exportAs(b.dataset.export); });
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) close(); });
  menu.addEventListener('focusout', (e) => { if (!e.relatedTarget?.closest?.('.menu-wrap')) close(); });
}

/**
 * "Sačuvaj kao…" → this format: first the columns to include (time, speaker; the text always), remembered per format.
 * Subtitles always carry times, so there only the speaker is a choice; without speakers nothing is asked for them.
 */
const EXPORT_DEFAULTS = { docx: { time: false, speaker: true }, txt: { time: true, speaker: true }, srt: { time: true, speaker: true }, vtt: { time: true, speaker: true } };

function exportAs(kind) {
  const cols = { ...EXPORT_DEFAULTS[kind], ...(prefs.exportCols?.[kind] ?? {}) };
  const hasSpeakers = spk.speakerList(S.doc.transcript).length > 0;
  const subtitles = kind === 'srt' || kind === 'vtt';
  const d = $('#dlg-export');
  $('#export-title').textContent = t('exportTitleOf', { docx: 'Word (.docx)', txt: t('exportTxt'), srt: t('exportSrt'), vtt: t('exportVtt') }[kind]);
  const time = $('#ex-time');
  const who = $('#ex-speaker');
  time.checked = subtitles || cols.time;
  time.disabled = subtitles;
  $('#ex-time-note').hidden = !subtitles;
  who.checked = hasSpeakers && cols.speaker;
  $('#ex-speaker-field').hidden = !hasSpeakers;
  $('#ex-go').onclick = () => {
    // With no speakers the box is hidden and unticked: saving that switched the column off for the next transcript
    // that has them. Keep what was remembered.
    prefs.exportCols = { ...(prefs.exportCols ?? {}), [kind]: { time: time.checked, speaker: hasSpeakers ? who.checked : cols.speaker } };
    savePrefs();
    d.close();
    writeExport(kind, { time: time.checked, speaker: hasSpeakers && who.checked });
  };
  d.showModal();
  $('#ex-go').focus();
}

function writeExport(kind, cols) {
  const segs = displayedSegs();
  const base = baseName(S.doc.title);
  const tr = S.doc.transcript;
  const nameOf = (s) => (cols.speaker && s.speaker ? speakerLabel(s.speaker) : '');
  if (kind === 'docx') {
    // No times, no tag marks, the script as shown. With a column besides the text, the text is a table of the chosen
    // columns: one row per line with the time, else one row per run of a speaker's lines.
    const subtitle = callLine(tr) || [tr.createdAt ? new Date(tr.createdAt).toLocaleString('sr-Latn') : '', S.doc.durationMs ? clock(S.doc.durationMs) : ''].filter(Boolean).join(' · ');
    let table = null;
    if (cols.time || cols.speaker) {
      const head = [...(cols.time ? [t('colTime')] : []), ...(cols.speaker ? [t('colSpeaker')] : []), t('colText')];
      const widths = [...(cols.time ? [1250] : []), ...(cols.speaker ? [1900] : []), null]; // 1250: "Vreme" and 1:05:12 on one line
      const rows = cols.time
        ? segs.map((s) => [clock(s.start), ...(cols.speaker ? [nameOf(s)] : []), s.text])
        : spk.runs(segs).flatMap((r) => (r.speaker ? [[nameOf(r.lines[0]), r.lines.map((s) => s.text).join(' ')]] : r.lines.map((s) => ['', s.text])));
      table = { head, widths, rows };
    }
    const bytes = toDocx({ title: S.doc.title, subtitle, paragraphs: segs.map((s) => s.text), table, lang: docxLang(docLang(), prefs.latin) });
    downloadBlob(new Blob([bytes], { type: DOCX_TYPE }), `${base}.docx`);
  } else if (kind === 'txt') {
    downloadText(toTxt(segs, { header: [S.doc.title, callLine(tr)].filter(Boolean).join(' · '), tags: tagsOf(), nameOf, times: cols.time }), `${base}.txt`);
  } else if (kind === 'srt') downloadText(toSrt(segs, { nameOf }), `${base}.srt`, 'application/x-subrip');
  else if (kind === 'vtt') downloadText(toVtt(segs, { nameOf }), `${base}.vtt`, 'text/vtt');
}

async function revert() {
  if (!(await confirmBox(t('revertTitle'), t('revertText'), t('revert')))) return;
  commitEdit();
  S.hasEdited = false;
  S.segs = S.doc.transcript.segments.map(lineCopy);
  recordVersion('reset', null);
  renderLines();
  await saveNow();
  flash(t('revertDone'));
}

// ---------------- AI round trip

function aiRequest() {
  const shown = displayedSegs();
  if (shown.length === 0) { flash(t('aiNothing'), true); return; }
  const base = baseName(S.doc.title);
  const text = ai.request(shown, ai.mostlyLatin(shown.map((s) => s.text)), base, { lang: docLang() });
  $('#ai-request-text').value = text;
  $('#ai-request-note').textContent = t('aiRequestText', ai.answerFileName(base));
  showMsg($('#ai-request-msg'), '');
  updateGeminiButton();
  $('#dlg-ai-request').showModal();
}

// ---------------- Gemini with the user's own key

/** The running send's AbortController, or null. */
let gemAbort = null;

function updateGeminiButton() {
  const g = gemini.loadSettings();
  const b = $('#ai-gemini');
  b.hidden = !g;
  if (g && !gemAbort) b.textContent = `${t('gemSend')} (${g.model})`;
}

function gemMessage(e, model) {
  if (e instanceof gemini.GeminiError) {
    if (e.code === 'gemNoModel') return `${t('gemNoModel', model)} (${e.detail})`;
    // Google's text for these is long (a list of every quota); ours says it all.
    if (e.code === 'gemNotInTier') return t('gemNotInTier', model);
    if (e.code === 'gemQuotaDay') return t('gemQuotaDay', model);
    if (e.code === 'gemBusy') return t('gemBusy');
    if (e.code === 'gemNetwork' || e.code === 'gemFailed' || e.code === 'gemBlocked') return t(e.code, e.detail);
    // Google's own words after ours: which limit, which error.
    return e.detail ? `${t(e.code)} (${e.detail})` : t(e.code);
  }
  return t('gemFailed', e?.message || String(e));
}

async function aiGemini() {
  if (gemAbort) { gemAbort.abort(); return; }
  const g = gemini.loadSettings();
  if (!g) { openSettings(); return; }
  const shown = displayedSegs();
  if (shown.length === 0) { flash(t('aiNothing'), true); return; }
  const sent = ai.lines(shown);
  const n = sent.length;
  const prompt = ai.request(shown, ai.mostlyLatin(shown.map((s) => s.text)), baseName(S.doc.title), { direct: true, lang: docLang() });
  const msg = $('#ai-request-msg');
  const btn = $('#ai-gemini');
  gemAbort = new AbortController();
  btn.textContent = t('gemCancel');
  $('#ai-copy').disabled = true;
  $('#ai-download').disabled = true;
  const t0 = Date.now();
  let round = 1;
  let waitUntil = 0;
  let waitWhy = 'gemQuota';
  const tick = () => {
    const left = Math.ceil((waitUntil - Date.now()) / 1000);
    showMsg(msg, left > 0 ? t(waitWhy === 'gemBusy' ? 'gemBusyWaiting' : 'gemWaiting', left)
      : t(round === 1 ? 'gemSending' : 'gemSendingRound', round === 1 ? g.model : round, Math.round((Date.now() - t0) / 1000)));
  };
  tick();
  const timer = setInterval(tick, 1000);
  const docId = S.doc.id;
  let answer = null;
  try {
    answer = await gemini.correct(g.key, g.model, prompt, (all) => {
      const a = ai.parseAnswer(all, sent);
      return a.type === 'ok' ? a.continueFrom : null;
    }, {
      signal: gemAbort.signal,
      onRound: (r) => { round = r; tick(); },
      onWait: (ms, why) => { waitUntil = Date.now() + ms; waitWhy = why; tick(); },
      idOf: (from) => ai.id(from - 1, n),
    });
  } catch (e) {
    console.error(e);
    showMsg(msg, e?.name === 'AbortError' ? t('gemCancelled') : gemMessage(e, g.model), e?.name !== 'AbortError');
  } finally {
    clearInterval(timer);
    gemAbort = null;
    $('#ai-copy').disabled = false;
    $('#ai-download').disabled = false;
    updateGeminiButton();
  }
  if (answer == null || S.doc?.id !== docId) return;
  // The answer goes through the same check and review as a pasted one.
  $('#dlg-ai-request').close();
  aiOpenImport();
  $('#ai-answer').value = answer;
  aiCheck(answer);
}

function fillModels(models, selected) {
  const sel = $('#gem-model');
  sel.replaceChildren();
  const list = models.length ? models : [{ id: selected, label: selected }];
  for (const m of list) {
    const o = el('option', '', m.label);
    o.value = m.id;
    sel.append(o);
  }
  sel.value = list.some((m) => m.id === selected) ? selected : list[0].id;
}

function openSettings() {
  const g = gemini.loadSettings();
  const key = $('#gem-key');
  key.value = '';
  key.placeholder = g ? t('gemKeySaved', gemini.maskKey(g.key)) : t('gemKeyPlaceholder');
  fillModels(g?.models ?? [], g?.model ?? gemini.DEFAULT_MODEL);
  $('#gem-model').disabled = !g;
  $('#gem-clear').hidden = !g;
  showMsg($('#gem-msg'), '');
  if (ASR.ok) updateModelLine();
  $('#dlg-settings').showModal();
  // The key's models can change (new ones, a different tier): refresh the list quietly, keeping the choice.
  if (g) {
    gemini.listModels(g.key).then((models) => {
      const now = gemini.loadSettings();
      if (!models.length || !now || now.key !== g.key || !$('#dlg-settings').open) return;
      const model = models.some((m) => m.id === now.model) ? now.model : models[0].id;
      gemini.saveSettings({ key: now.key, model, models });
      fillModels(models, model);
    }).catch(() => { /* the saved list stays */ });
  }
}

async function saveGemini() {
  const msg = $('#gem-msg');
  const saved = gemini.loadSettings();
  const key = $('#gem-key').value.trim() || saved?.key || '';
  if (!key) { showMsg(msg, t('gemNoKeyTyped'), true); return; }
  showMsg(msg, t('gemChecking'));
  $('#gem-save').disabled = true;
  try {
    const models = await gemini.listModels(key);
    if (!models.length) { showMsg(msg, t('gemNoModels'), true); return; }
    const wanted = $('#gem-model').disabled ? (saved?.model ?? gemini.DEFAULT_MODEL) : $('#gem-model').value;
    fillModels(models, models.some((m) => m.id === wanted) ? wanted : models[0].id);
    const model = $('#gem-model').value;
    gemini.saveSettings({ key, model, models });
    $('#gem-key').value = '';
    $('#gem-key').placeholder = t('gemKeySaved', gemini.maskKey(key));
    $('#gem-model').disabled = false;
    $('#gem-clear').hidden = false;
    showMsg(msg, t('gemSaved', model));
  } catch (e) {
    console.error(e);
    showMsg(msg, gemMessage(e, ''), true);
  } finally {
    $('#gem-save').disabled = false;
  }
}

function clearGemini() {
  gemini.clearSettings();
  openSettings();
  showMsg($('#gem-msg'), t('gemCleared'));
}

async function aiCopy() {
  const ta = $('#ai-request-text');
  try {
    await navigator.clipboard.writeText(ta.value);
    showMsg($('#ai-request-msg'), t('copied'));
  } catch {
    ta.focus();
    ta.select();
    showMsg($('#ai-request-msg'), t('copyFailed'), true);
  }
}

function aiOpenImport() {
  $('#ai-answer').value = '';
  showMsg($('#ai-import-msg'), '');
  $('#dlg-ai-import').showModal();
}

function aiCheck(answer) {
  const msg = $('#ai-import-msg');
  if (!answer.trim()) { showMsg(msg, t('aiEmpty'), true); return; }
  const sent = ai.lines(displayedSegs());
  const n = sent.length;
  const a = ai.parseAnswer(answer, sent);
  if (a.type === 'mismatch') {
    if (a.unrelated) { showMsg(msg, t('aiUnrelated'), true); return; }
    const all = [...a.missing, ...a.duplicate, ...a.unknown];
    const ids = all.slice(0, 5).map((x) => ai.id(x - 1, n)).join(', ') + (all.length > 5 ? '…' : '');
    showMsg(msg, t('aiMismatch', a.found, n, ids), true);
    return;
  }
  if (a.changes.length === 0) {
    const note = a.continueFrom != null ? `. ${t('aiPartial', n - a.missing.length, n, ai.id(a.continueFrom - 1, n))}` : '';
    showMsg(msg, t('aiNoChanges') + note, a.continueFrom != null);
    return;
  }
  $('#dlg-ai-import').close();
  openReview({ sent, changes: a.changes, missing: a.missing, continueFrom: a.continueFrom });
}

async function aiFile(file) {
  const msg = $('#ai-import-msg');
  if (file.size > MAX_AI_ANSWER_BYTES) { showMsg(msg, t('errRead', t('aiFileTooLarge')), true); return; }
  const text = await file.text();
  $('#ai-answer').value = text;
  aiCheck(text);
}

function openReview(r) {
  S.review = { ...r, checked: new Set(r.changes.map((c) => c.index)) };
  const n = r.sent.length;
  const unsure = r.changes.filter((c) => c.doubtful).length;
  const big = r.changes.filter((c) => c.rewritten).length;
  $('#review-summary').textContent = t('aiSummary', r.changes.length, unsure, big);
  const covered = n - r.missing.length;
  $('#review-coverage').textContent = t('aiCoverage', covered, n);
  const prog = $('#review-progress');
  prog.max = Math.max(1, n);
  prog.value = covered;
  const partial = $('#review-partial');
  if (r.continueFrom != null) showMsg(partial, t('aiPartial', covered, n, ai.id(r.continueFrom - 1, n)));
  else showMsg(partial, '');
  const list = $('#review-list');
  list.replaceChildren();
  for (const c of r.changes) {
    const li = el('li', 'change');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    box.setAttribute('aria-label', t('aiAcceptLine', ai.id(c.index, n)));
    box.addEventListener('change', () => {
      if (box.checked) S.review.checked.add(c.index); else S.review.checked.delete(c.index);
      updateApply();
    });
    const head = el('div', 'change-head');
    const seg = S.segs[c.index];
    const label = `${ai.id(c.index, n)} · ${clock(seg ? seg.start : 0)}`;
    if (seg && hasAudio()) head.append(box, clipButton(seg.start, seg.end, label));
    else head.append(box, el('span', 'ltime', label));
    if (c.doubtful) head.append(el('span', 'badge unsure', t('aiUnsure')));
    if (c.rewritten) head.append(el('span', 'badge big', t('aiBig')));
    const body = el('p', 'diff');
    for (const w of ai.diff(c.old, c.new)) {
      const cls = w.kind === 'removed' ? 'del' : w.kind === 'added' ? 'ins' : 'same';
      const span = el(w.kind === 'removed' ? 'del' : w.kind === 'added' ? 'ins' : 'span', cls, w.text);
      if (/\[\?/.test(w.text)) span.classList.add('doubt');
      body.append(span, document.createTextNode(' '));
    }
    const bodyLabel = el('label', 'change-body');
    bodyLabel.append(body);
    li.append(head, bodyLabel);
    bodyLabel.addEventListener('click', () => { box.checked = !box.checked; box.dispatchEvent(new Event('change')); });
    list.append(li);
  }
  updateApply();
  $('#dlg-ai-review').showModal();
}

function updateApply() {
  const n = S.review ? S.review.checked.size : 0;
  const b = $('#review-apply');
  b.textContent = t('aiApply', n);
  b.disabled = n === 0;
}

function reviewSelect(all) {
  if (!S.review) return;
  S.review.checked = new Set(all ? S.review.changes.map((c) => c.index) : []);
  for (const box of document.querySelectorAll('#review-list input[type=checkbox]')) box.checked = all;
  updateApply();
}

async function reviewApply() {
  const r = S.review;
  if (!r) return;
  $('#dlg-ai-review').close();
  S.review = null;
  if (r.checked.size === 0) return;
  const now = ai.lines(displayedSegs());
  if (now.length !== r.sent.length || now.some((x, i) => x !== r.sent[i])) { flash(t('aiChanged'), true); return; }
  commitEdit();  // typing before the AI answer stays its own version
  let count = 0;
  for (const c of r.changes) {
    if (!r.checked.has(c.index)) continue;
    S.segs[c.index] = { ...S.segs[c.index], text: c.applied };
    count++;
  }
  S.hasEdited = true;
  recordVersion('ai', segsCopy());
  renderLines();
  await saveNow();
  flash(t('aiApplied', count));
}

// ---------------- script toggle

function updateScriptButtons() {
  const on = scriptApplies();
  for (const [sel, pressed] of [['#script-lat', prefs.latin], ['#script-cyr', !prefs.latin]]) {
    const b = $(sel);
    b.classList.toggle('on', on && pressed);
    b.setAttribute('aria-pressed', String(on && pressed));
    b.disabled = !on;
    b.title = on ? '' : t('scriptSerbianOnly');
  }
}

function setLatin(on) {
  if (prefs.latin === on) return;
  prefs.latin = on;
  savePrefs();
  updateScriptButtons();
  if (S.doc) renderLines(S.focused);
}

// ------------------------------------------------------------------ global keys

function moveLine(delta) {
  const from = S.focused >= 0 ? S.focused : Math.max(0, S.current);
  const i = Math.max(0, Math.min(S.segs.length - 1, from + delta));
  focusLine(i);
  S.focused = i;
  if (hasAudio()) audioEl().currentTime = S.segs[i].start / 1000;
  updateTime();
}

function onGlobalKey(e) {
  if (!S.doc || $('#editor').hidden) return;
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveVersion(); return; }
  if ((mod && (e.code === 'Space' || e.key === ' ')) || (e.key === 'Escape' && !mod)) { e.preventDefault(); togglePlay(); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveLine(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && (e.key === 'r' || e.key === 'R') && !e.shiftKey) {
    e.preventDefault();
    const i = S.focused >= 0 ? S.focused : S.current;
    if (i >= 0) playFrom(i);
  }
}

// ------------------------------------------------------------------ wiring

function wire() {
  applyI18n();
  for (const d of document.querySelectorAll('dialog:not(#dlg-asr)')) closeOnBackdrop(d);
  $('#dlg-asr').addEventListener('cancel', (e) => e.preventDefault());
  $('#asr-stop').addEventListener('click', stopAsr);
  $('#asr-file').addEventListener('change', (e) => { const fs = [...e.target.files]; if (fs.length) transcribeFiles(fs); e.target.value = ''; });
  $('#asr-bg').addEventListener('click', () => $('#dlg-asr').close());
  $('#asr-pill').addEventListener('click', () => { if (ASR.current != null) $('#dlg-asr').showModal(); else showStart(); });
  // Closing the tab ends a run; what is done is kept, but warn first.
  window.addEventListener('beforeunload', (e) => { if (ASR.current != null || ASR.queue.length) { e.preventDefault(); e.returnValue = ''; } });
  $('#asr-delete-model').addEventListener('click', deleteModel);
  $('#asr-lang').addEventListener('change', (e) => { prefs.asrLang = e.target.value; savePrefs(); });
  for (const box of [$('#asr-gentle'), $('#asr-gentle-dlg')]) {
    box.addEventListener('change', () => { prefs.asrGentle = box.checked; savePrefs(); syncGentle(); });
  }

  $('#asr-pick').addEventListener('click', () => $('#asr-file').click());
  const file = $('#file');
  $('#pick-bundle').addEventListener('click', () => file.click());
  file.addEventListener('change', () => { if (file.files[0]) importFile(file.files[0]); file.value = ''; });
  // A file dropped anywhere on the start screen is taken: audio is transcribed, a .zip opens as a phone package
  // (importFile tells them apart). In the editor a drop must not navigate away, so it is only swallowed.
  const drop = $('#drop');
  let dragEnd = 0;
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if ($('#start').hidden) return;
    drop.classList.add('over');
    clearTimeout(dragEnd); // dragover repeats while a file is over the page; its absence means the drag left
    dragEnd = setTimeout(() => drop.classList.remove('over'), 200);
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if ($('#start').hidden) return;
    // Several recordings go into the queue together; otherwise the one file is opened as before.
    const files = [...(e.dataTransfer?.files ?? [])];
    const audio = files.filter(isAudio);
    if (audio.length > 1) transcribeFiles(audio);
    else if (files[0]) importFile(audio[0] ?? files[0]);
  });

  $('#back').addEventListener('click', showStart);
  $('#save-phone').addEventListener('click', savePhoneBundle);
  wireSaveAs();
  $('#speakers').addEventListener('click', openSpeakers);
  $('#spk-add').addEventListener('click', () => { spk.addSpeaker(S.doc.transcript, { names: callNames() }); updateChips(); saveNow(); renderSpeakers(); });
  const spkMenu = $('#spk-menu');
  spkMenu.addEventListener('keydown', (e) => {
    const items = [...spkMenu.querySelectorAll('.menu-item')];
    const k = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(k + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(k - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSpeakerMenu(true); }
    else if (/^[1-9]$/.test(e.key) && items[Number(e.key) - 1]?.classList.contains('sw')) { e.preventDefault(); items[Number(e.key) - 1].click(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#spk-menu, .lspk')) closeSpeakerMenu(); });
  spkMenu.addEventListener('focusout', (e) => { if (!e.relatedTarget?.closest?.('#spk-menu')) closeSpeakerMenu(); });
  $('#revert').addEventListener('click', revert);
  $('#history').addEventListener('click', openHistory);
  $('#save-version').addEventListener('click', saveVersion);
  $('#version-chip').addEventListener('click', openHistory);
  $('#ai-request').addEventListener('click', aiRequest);
  $('#ai-copy').addEventListener('click', aiCopy);
  $('#ai-gemini').addEventListener('click', aiGemini);
  $('#dlg-ai-request').addEventListener('close', () => gemAbort?.abort());
  $('#dlg-ai-review').addEventListener('close', stopClip);
  $('#dlg-history').addEventListener('close', stopClip);
  $('#settings').addEventListener('click', openSettings);
  setupTheme();
  $('#gem-save').addEventListener('click', saveGemini);
  $('#gem-clear').addEventListener('click', clearGemini);
  $('#gem-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveGemini(); } });
  $('#gem-model').addEventListener('change', () => {
    const g = gemini.loadSettings();
    if (g) {
      gemini.saveSettings({ ...g, model: $('#gem-model').value });
      updateGeminiButton();
      showMsg($('#gem-msg'), t('gemModelSaved', $('#gem-model').value));
    }
  });
  $('#ai-download').addEventListener('click', () => downloadText($('#ai-request-text').value, `${baseName(S.doc.title)} - AI request.txt`));
  $('#ai-import').addEventListener('click', aiOpenImport);
  $('#ai-check').addEventListener('click', () => aiCheck($('#ai-answer').value));
  $('#ai-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) aiFile(f); e.target.value = ''; });
  $('#review-all').addEventListener('click', () => reviewSelect(true));
  $('#review-none').addEventListener('click', () => reviewSelect(false));
  $('#review-cancel').addEventListener('click', () => { S.review = null; $('#dlg-ai-review').close(); });
  $('#review-apply').addEventListener('click', reviewApply);
  $('#help').addEventListener('click', () => $('#dlg-help').showModal());
  $('#script-lat').addEventListener('click', () => setLatin(true));
  $('#script-cyr').addEventListener('click', () => setLatin(false));

  const a = audioEl();
  $('#play').addEventListener('click', togglePlay);
  a.addEventListener('play', () => { updatePlayButton(); if (!raf) raf = requestAnimationFrame(tick); });
  a.addEventListener('pause', () => { endClip(); updatePlayButton(); updateTime(); });
  a.addEventListener('ended', updatePlayButton);
  a.addEventListener('loadedmetadata', updateTime);
  a.addEventListener('seeked', updateTime);
  const seek = $('#seek');
  seek.addEventListener('input', () => {
    seeking = true;
    if (hasAudio() && Number.isFinite(a.duration)) a.currentTime = (Number(seek.value) / 1000) * a.duration;
  });
  seek.addEventListener('change', () => { seeking = false; updateTime(); });
  const speed = $('#speed');
  speed.value = String(prefs.speed);
  speed.addEventListener('change', () => { prefs.speed = Number(speed.value); a.playbackRate = prefs.speed; savePrefs(); });
  const auto = $('#autoscroll');
  auto.checked = prefs.autoscroll;
  auto.addEventListener('change', () => { prefs.autoscroll = auto.checked; savePrefs(); });

  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('resize', () => { for (const ta of document.querySelectorAll('.ltext')) autoGrow(ta); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave().then(autoVersion); });
  window.addEventListener('pagehide', () => { flushSave().then(autoVersion); });

  setupInstall();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  }
  renderSaved();
  setupAsr().catch((e) => console.warn('transcription', e));
}

/** The header's light/dark button (switches to the other one) and the theme choice in Podešavanja. */
function setupTheme() {
  const btn = $('#theme');
  const sel = $('#theme-select');
  const update = () => {
    const dark = self.isDark();
    btn.querySelector('.theme-icon').textContent = dark ? '☀' : '☾';
    btn.querySelector('.theme-label').textContent = t(dark ? 'themeToLight' : 'themeToDark');
    // 2.5.3: the visible text is the name (voice control says what it sees); the longer phrase is only a tooltip.
    btn.title = t(dark ? 'themeToLightAria' : 'themeToDarkAria');
    sel.value = self.themePref();
  };
  const choose = (pref) => {
    prefs.theme = pref;
    savePrefs();
    self.setTheme(pref);
  };
  btn.addEventListener('click', () => choose(self.isDark() ? 'light' : 'dark'));
  sel.addEventListener('change', () => choose(sel.value));
  self.addEventListener('themechange', update);
  update();
}

/**
 * "Instaliraj": shown when the browser offers installing (Chrome, Edge: the event kept by install.js), or on an
 * iPhone/iPad Safari as a how-to; hidden once the editor runs as an installed app.
 */
function setupInstall() {
  const btn = $('#install');
  const pwa = self.pwaInstall || { event: null, standalone: false };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const update = () => { btn.hidden = pwa.standalone || !(pwa.event || ios); };
  btn.title = t('installTitle');
  btn.addEventListener('click', async () => {
    if (pwa.event) {
      const e = pwa.event;
      pwa.event = null; // a prompt can be shown only once
      e.prompt();
      await e.userChoice.catch(() => null);
      update();
    } else if (ios) {
      await choose(t('installTitle'), t('installIos'), [{ label: t('ok'), value: true, cls: 'primary' }]);
    }
  });
  window.addEventListener('pwa-installable', update);
  window.addEventListener('pwa-installed', () => { update(); flash(t('installDone')); });
  update();
}

wire();
