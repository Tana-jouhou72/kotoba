/* Kotoba — Japanese vocabulary PWA */
'use strict';

/* ---------- helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAS_KANJI = /[㐀-鿿々]/;
const IS_KANA = /^[぀-ヿー〜・]+$/;

const ICON = {
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

/* ---------- settings (per device) ---------- */
const SETTINGS_KEY = 'kotoba-settings';
const DEFAULTS = { workerUrl: '', password: '', newPerDay: 10, notifyTime: '20:00', pushOn: false, theme: 'auto', lastSync: 0 };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
  KDB.setKV('newPerDay', settings.newPerDay).catch(() => {});
}
function applyTheme() {
  if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}

/* ---------- data ---------- */
let cards = [];
const live = () => cards.filter((c) => !c.deleted);
async function reload() { cards = await KDB.all(); }
async function saveCards(list, { sync = true } = {}) {
  if (!list.length) return;
  await KDB.putMany(list);
  const idx = new Map(cards.map((c, i) => [c.id, i]));
  for (const c of list) {
    if (idx.has(c.id)) cards[idx.get(c.id)] = c;
    else cards.push(c);
  }
  if (sync) scheduleSync();
}
/* Merge duplicate words (e.g. the starter deck loaded on two devices).
   The keeper is chosen the same way on every device (smallest id), so devices never delete each other's copy. */
async function dedupeWords() {
  const groups = new Map();
  for (const c of cards) {
    if (c.deleted || !c.word) continue;
    const k = c.word.trim();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const changed = [];
  const now = Date.now();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [keep, ...dups] = list;
    const merged = { ...keep, srs: { ...(keep.srs || {}) } };
    for (const d of dups) {
      for (const dir of SRS.DIRS) {
        const s = d.srs && d.srs[dir];
        const k = merged.srs[dir];
        if (s && (!k || (s.t || 0) > (k.t || 0))) merged.srs[dir] = s; // keep the most recent study progress
      }
      changed.push({ ...d, deleted: true, updatedAt: now });
    }
    if (JSON.stringify(merged) !== JSON.stringify(keep)) changed.push(merged);
  }
  if (changed.length) await saveCards(changed);
  return changed.length;
}
function nextOrder() { return cards.reduce((m, c) => Math.max(m, c.order ?? 0), 0) + 1; }
function newCard(fields) {
  return {
    id: uid(), word: '', reading: '', meaning: '', note: '', nuance: '', examples: [],
    order: nextOrder(), createdAt: Date.now(), updatedAt: Date.now(), deleted: false,
    srs: { jp: null, en: null }, ...fields,
  };
}
const hasAI = (c) => !!(c.nuance && c.examples && c.examples.length);
const findByWord = (w) => live().find((c) => c.word === w);
function newLimit(dir) {
  let extra = 0;
  try { extra = +localStorage.getItem(`kotoba-extra-${dir}-${SRS.today()}`) || 0; } catch {}
  return (+settings.newPerDay || 10) + extra;
}

/* ---------- parsing your word-list format ---------- */
function parseWordLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\s　]+/);
    const word = parts.shift();
    if (!/[぀-ヿ㐀-鿿]/.test(word)) continue; // skip headers like "Book Title:"
    let reading = '';
    if (parts.length && HAS_KANJI.test(word) && IS_KANA.test(parts[0])) reading = parts.shift();
    const meaning = parts.join(' ').replace(/^[.,、。]\s*/, '').trim();
    out.push({ word, reading, note: meaning, meaning });
  }
  return out;
}

/* ---------- import / export ---------- */
async function importCards(incoming) {
  let added = 0, updated = 0;
  const now = Date.now();
  const toSave = [];
  let order = nextOrder();
  for (const raw of incoming) {
    if (!raw || !raw.word) continue;
    const existing = (raw.id && cards.find((c) => c.id === raw.id)) || findByWord(raw.word);
    if (existing) {
      const merged = SRS.mergeCard(existing, { ...existing, ...raw, id: existing.id, srs: raw.srs || existing.srs });
      if (JSON.stringify(merged) !== JSON.stringify(existing)) { toSave.push(merged); updated++; }
    } else {
      toSave.push({
        ...newCard({}), ...raw,
        id: raw.id || uid(), order: order++,
        srs: raw.srs || { jp: null, en: null },
        createdAt: raw.createdAt || now, updatedAt: raw.updatedAt || now, deleted: !!raw.deleted,
      });
      added++;
    }
  }
  await saveCards(toSave);
  await dedupeWords();
  return { added, updated };
}

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportBackup() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  download(`kotoba-backup-${stamp}.json`, JSON.stringify({ app: 'kotoba', version: 1, exportedAt: d.toISOString(), cards }, null, 1));
  toast(`Exported ${live().length} words`);
}
async function handleFile(file) {
  const text = await file.text();
  let list;
  if (/\.json$/i.test(file.name) || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    const data = JSON.parse(text);
    list = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(list)) throw new Error('That JSON file has no "cards" list.');
  } else {
    list = parseWordLines(text);
  }
  const { added, updated } = await importCards(list);
  toast(`Imported: ${added} new, ${updated} updated`);
  render();
  const needAI = live().filter((c) => !hasAI(c));
  if (added && needAI.length && settings.workerUrl) {
    if (confirm(`${needAI.length} words have no nuance/examples yet. Fill them in with AI now?`)) runEnrich(needAI);
  }
}
async function loadStarter() {
  const res = await fetch('starter-deck.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load starter-deck.json');
  const data = await res.json();
  const { added, updated } = await importCards(data.cards || data);
  toast(`Starter deck: ${added} words added${updated ? `, ${updated} updated` : ''}`);
  render();
}

/* ---------- server (Cloudflare Worker) ---------- */
async function api(path, body) {
  if (!settings.workerUrl) throw new Error('Add your Worker URL in Settings first.');
  const url = settings.workerUrl.trim().replace(/\/+$/, '') + path;
  let res;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + settings.password, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine ? 'Could not reach the Worker. Check the URL.' : 'You are offline.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

let syncTimer = null, syncing = false, syncAgain = false;
function setSyncState(state) { $('#syncDot').dataset.state = state; }
function scheduleSync(delay = 4000) {
  if (!settings.workerUrl) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), delay);
}
async function syncNow(quiet = false) {
  if (!settings.workerUrl) { if (!quiet) toast('Set up the server in Settings to sync.'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncState('busy');
  try {
    const { cards: merged } = await api('/sync', { cards });
    await reload();
    const local = new Map(cards.map((c) => [c.id, c]));
    const changed = [];
    for (const m of merged) {
      const loc = local.get(m.id);
      const mc = SRS.mergeCard(loc, m);
      if (!loc || JSON.stringify(mc) !== JSON.stringify(loc)) changed.push(mc);
    }
    if (changed.length) await saveCards(changed, { sync: false });
    const deduped = await dedupeWords();
    if (deduped) scheduleSync(1500);
    settings.lastSync = Date.now();
    saveSettings();
    setSyncState('ok');
    if (!quiet) toast('Synced');
    if ((changed.length || deduped) && !session) render();
  } catch (e) {
    setSyncState('err');
    if (!quiet) toast(e.message, 'err');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}

/* ---------- AI enrichment ---------- */
let enriching = false;
async function enrichBatch(batch) {
  const { results } = await api('/enrich', {
    words: batch.map((c) => ({ word: c.word, reading: c.reading || '', meaning: c.note || c.meaning || '' })),
  });
  const now = Date.now();
  const updated = [];
  batch.forEach((c, i) => {
    const r = (results || []).find((x) => x && x.word === c.word) || (results || [])[i];
    if (!r) return;
    updated.push({
      ...c,
      reading: c.reading || r.reading || '',
      meaning: r.meaning || c.meaning,
      nuance: r.nuance || c.nuance,
      examples: Array.isArray(r.examples) && r.examples.length ? r.examples.slice(0, 2) : c.examples,
      updatedAt: now,
    });
  });
  await saveCards(updated);
  return updated;
}
async function runEnrich(list) {
  if (enriching) return toast('AI is already working…');
  if (!list.length) return toast('Nothing to fill in.');
  enriching = true;
  const size = 8;
  let done = 0;
  const t = toast(`✦ Filling in 0 / ${list.length}…`, '', 0);
  try {
    for (let i = 0; i < list.length; i += size) {
      const batch = list.slice(i, i + size).map((c) => cards.find((x) => x.id === c.id) || c);
      await enrichBatch(batch);
      done += batch.length;
      t.textContent = `✦ Filling in ${done} / ${list.length}…`;
      if (!session) render();
      if (i + size < list.length) await sleep(4500); // stay under free-tier per-minute limits
    }
    toast(`✦ Done — ${done} words filled in`);
  } catch (e) {
    toast(`AI stopped after ${done}: ${e.message}`, 'err');
  } finally {
    t.remove();
    enriching = false;
    if (!session) render();
  }
}

/* ---------- speech ---------- */
let jaVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  jaVoice = voices.find((v) => /ja[-_]JP/i.test(v.lang) && /google|kyoko|o-ren|nanami|haruka/i.test(v.name)) || voices.find((v) => /^ja/i.test(v.lang)) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Speech is not supported in this browser.', 'err');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  if (jaVoice) u.voice = jaVoice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

/* ---------- toasts ---------- */
function toast(msg, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

/* ---------- card rendering ---------- */
function highlight(sentence, word) {
  const s = esc(sentence);
  const candidates = [];
  for (const part of String(word || '').split(/[、,/]/)) {
    const w = part.trim().replace(/^[ー〜~]/, '');
    if (!w) continue;
    candidates.push(w);
    const stem = w.replace(/[぀-ゟ]+$/, ''); // drop okurigana so 沈む matches 沈んだ
    if (stem && stem !== w && HAS_KANJI.test(stem)) candidates.push(stem);
    else if (!HAS_KANJI.test(w) && w.length >= 3) candidates.push(w.slice(0, -1)); // あきらめる → あきらめない
    if (w.startsWith('に') && w.length > 1) candidates.push(w.slice(1)); // に関心 → 関心
  }
  for (const k of candidates) {
    const ek = esc(k);
    if (s.includes(ek)) return s.split(ek).join(`<mark>${ek}</mark>`);
  }
  return s;
}
function speakText(c) { return c.word.replace(/^[ー〜~]/, '').split(/[、,]/)[0]; }

function detailHTML(c) {
  const showReading = c.reading && c.reading !== c.word;
  const noteDiffers = c.note && c.note.trim() && c.note.trim().toLowerCase() !== (c.meaning || '').trim().toLowerCase();
  const ex = (c.examples || []).filter((e) => e && e.ja);
  return `
    <div class="answer">
      <div>
        <div class="head">
          <span class="word" lang="ja">${esc(c.word)}</span>
          <button class="icon-btn" data-speak="${esc(speakText(c))}" aria-label="Play pronunciation">${ICON.speak}</button>
          <span class="spacer"></span>
          <button class="icon-btn" data-edit="${esc(c.id)}" aria-label="Edit word">${ICON.edit}</button>
        </div>
        ${showReading ? `<div class="reading" lang="ja">${esc(c.reading)}</div>` : ''}
      </div>
      ${c.meaning ? `<div class="meaning">${esc(c.meaning)}</div>` : ''}
      ${noteDiffers ? `<div class="note">My note: ${esc(c.note)}</div>` : ''}
      ${c.nuance ? `<div class="nuance"><h4>Nuance</h4><p>${esc(c.nuance)}</p></div>` : ''}
      ${ex.length ? `<div><h4>Examples</h4><ol class="examples">${ex.map((e) => `
        <li>
          <div class="ja-line"><p lang="ja">${highlight(e.ja, c.word)}</p>
            <button class="icon-btn" data-speak="${esc(e.ja)}" aria-label="Play example">${ICON.speak}</button></div>
          ${e.en ? `<p class="en">${esc(e.en)}</p>` : ''}
        </li>`).join('')}</ol></div>` : ''}
      ${!hasAI(c) ? `<div class="missing"><span>No nuance or examples yet.</span>
        <button class="btn sm" data-ai="${esc(c.id)}">✦ Fill with AI</button></div>` : ''}
    </div>`;
}

/* ---------- views ---------- */
const view = () => $('#view');
let session = null;

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  return { name: name || 'home', arg };
}

function render() {
  const r = route();
  document.body.classList.toggle('in-session', r.name === 'study');
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (r.name === 'study' ? 'home' : r.name)));
  if (r.name !== 'study' && session) endSession(false);
  if (r.name === 'words') return renderWords();
  if (r.name === 'settings') return renderSettings();
  if (r.name === 'study') return startOrRenderSession(r.arg === 'en' ? 'en' : 'jp');
  return renderHome();
}

/* Home */
function renderHome() {
  const all = live();
  if (!all.length) {
    view().innerHTML = `
      <div class="panel empty">
        <div class="big">言葉</div>
        <h2>No words yet</h2>
        <p class="muted">Load the starter deck made from your word list, or add your own.</p>
        <div class="btn-row" style="justify-content:center">
          <button class="btn primary" id="starterBtn">Load starter deck</button>
          <button class="btn" id="bulkBtn">Paste words</button>
          <button class="btn ghost" id="importBtn">Import file</button>
        </div>
      </div>`;
    $('#starterBtn').onclick = () => loadStarter().catch((e) => toast(e.message, 'err'));
    $('#bulkBtn').onclick = openBulk;
    $('#importBtn').onclick = () => $('#fileInput').click();
    return;
  }
  const T = SRS.today();
  const studiedToday = all.filter((c) => SRS.DIRS.some((d) => c.srs?.[d]?.t && SRS.today(c.srs[d].t) === T)).length;
  const deck = (dir, a, b) => {
    const k = SRS.counts(all, dir, newLimit(dir));
    const total = k.due + k.newToday;
    return `
      <div class="deck">
        <div class="deck-head">
          <div class="deck-title">${a}<span class="arrow">→</span>${b}</div>
          <div class="deck-sub">${dir === 'jp' ? 'See the word, recall the meaning' : 'See the meaning, recall the word'}</div>
        </div>
        <div class="deck-stats">
          <div class="stat due"><b>${k.due}</b><span>to review</span></div>
          <div class="stat new"><b>${k.newToday}</b><span>new today</span></div>
        </div>
        ${total
          ? `<a class="btn primary block" href="#/study/${dir}">Study ${total} card${total > 1 ? 's' : ''}</a>`
          : `<div class="btn-row">${k.newAvail ? `<button class="btn block" data-more="${dir}">Learn ${settings.newPerDay} more new words</button>` : '<span class="muted">All done for today ✓</span>'}</div>`}
      </div>`;
  };
  const missing = all.filter((c) => !hasAI(c)).length;
  view().innerHTML = `
    <div class="hello">
      <h1>${greeting()}</h1>
      <p>${all.length} words · ${studiedToday} studied today</p>
    </div>
    <div class="deck-grid">
      ${deck('jp', '日本語', 'English')}
      ${deck('en', 'English', '日本語')}
    </div>
    ${missing && settings.workerUrl ? `<div class="panel"><h2>${missing} words need nuance &amp; examples</h2><p class="muted small">AI can fill in the reading, nuance and two example sentences.</p><button class="btn" id="fillAll">✦ Fill in with AI</button></div>` : ''}
    ${!settings.workerUrl ? `<div class="panel"><h2>Finish setup</h2><p class="muted small">Connect your free server to get daily notifications, AI examples, and sync between your phone and PC.</p><a class="btn" href="#/settings">Open settings</a></div>` : ''}
    <div class="home-foot">
      <button class="btn" id="addBtn">＋ Add word</button>
      <button class="btn ghost" id="bulkBtn">Paste many</button>
    </div>`;
  $('#addBtn').onclick = () => openEditor(null);
  $('#bulkBtn').onclick = openBulk;
  const fill = $('#fillAll');
  if (fill) fill.onclick = () => runEnrich(live().filter((c) => !hasAI(c)));
  $$('[data-more]').forEach((b) => (b.onclick = () => {
    const dir = b.dataset.more;
    const key = `kotoba-extra-${dir}-${SRS.today()}`;
    try { localStorage.setItem(key, (+localStorage.getItem(key) || 0) + (+settings.newPerDay || 10)); } catch {}
    location.hash = `#/study/${dir}`;
  }));
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'こんばんは' : h < 11 ? 'おはよう' : h < 18 ? 'こんにちは' : 'こんばんは';
}

/* Study session */
function startOrRenderSession(dir) {
  if (!session || session.dir !== dir) {
    const q = SRS.buildQueue(live(), dir, newLimit(dir));
    session = { dir, queue: q.ids, pos: 0, revealed: false, total: q.ids.length, reviewed: 0, again: 0, hint: 0 };
  }
  renderSession();
}
function endSession(goHome = true) {
  session = null;
  scheduleSync(800);
  if (goHome) location.hash = '#/';
}
function currentCard() {
  if (!session) return null;
  const id = session.queue[session.pos];
  return cards.find((c) => c.id === id) || null;
}
function renderSession() {
  const s = session;
  const c = currentCard();
  if (!c) return renderDone();
  const st = SRS.stateOf(c, s.dir);
  const isNew = !st;
  const ivls = SRS.nextIntervals(st);
  const pct = s.total ? Math.min(100, Math.round((s.pos / s.queue.length) * 100)) : 0;
  const remaining = s.queue.length - s.pos;
  let front;
  if (s.dir === 'jp') {
    front = `<div class="big-word" lang="ja">${esc(c.word)}</div>`;
  } else {
    const hintText = (c.reading || c.word).slice(0, s.hint);
    front = `<div class="big-meaning">${esc(c.meaning || c.note)}</div>
      <div class="hint" lang="ja">${s.hint ? esc(hintText) + '…' : ''}</div>`;
  }
  view().innerHTML = `
    <div class="session">
      <div class="session-top">
        <button class="icon-btn" id="quit" aria-label="End session">${ICON.back}</button>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="session-count">${remaining} left</div>
      </div>
      <div class="flash" id="flash">
        <span class="tag ${isNew ? 'new' : ''}">${isNew ? 'New' : 'Review'} · ${s.dir === 'jp' ? '日→英' : '英→日'}</span>
        ${s.revealed ? detailHTML(c) : `<div class="front">${front}<div class="tap-hint">Tap to show answer</div></div>`}
      </div>
      <div class="actions">
        ${s.revealed ? `
          <div class="grades">
            <button class="grade again" data-g="again">Again<small>now <span class="kbd">· 1</span></small></button>
            <button class="grade hard" data-g="hard">Hard<small>${SRS.formatInterval(ivls.hard)} <span class="kbd">· 2</span></small></button>
            <button class="grade good" data-g="good">Good<small>${SRS.formatInterval(ivls.good)} <span class="kbd">· 3</span></small></button>
            <button class="grade easy" data-g="easy">Easy<small>${SRS.formatInterval(ivls.easy)} <span class="kbd">· 4</span></small></button>
          </div>` : `
          <div class="btn-row">
            ${s.dir === 'en' ? `<button class="btn" id="hintBtn" ${s.hint >= (c.reading || c.word).length ? 'disabled' : ''}>Hint</button>` : ''}
            <button class="btn primary" id="showBtn" style="flex:1">Show answer <span class="kbd">· Space</span></button>
          </div>`}
      </div>
    </div>`;
  $('#quit').onclick = () => endSession(true);
  if (!s.revealed) {
    $('#flash').onclick = reveal;
    $('#showBtn').onclick = reveal;
    const hb = $('#hintBtn');
    if (hb) hb.onclick = (e) => { e.stopPropagation(); s.hint++; renderSession(); };
  } else {
    $$('.grade').forEach((b) => (b.onclick = () => answer(b.dataset.g)));
  }
}
function reveal() {
  if (!session || session.revealed) return;
  session.revealed = true;
  renderSession();
  const c = currentCard();
  if (c && session.dir === 'en') speak(speakText(c));
}
async function answer(g) {
  const s = session;
  const c = currentCard();
  if (!s || !c || !s.revealed) return;
  const updated = { ...c, srs: { ...(c.srs || {}), [s.dir]: SRS.grade(SRS.stateOf(c, s.dir), g) } };
  await saveCards([updated], { sync: false });
  s.reviewed++;
  if (g === 'again') {
    s.again++;
    const at = Math.min(s.queue.length, s.pos + 4);
    s.queue.splice(at, 0, c.id); // see it again a few cards later
  }
  s.pos++;
  s.revealed = false;
  s.hint = 0;
  renderSession();
  window.scrollTo(0, 0);
}
function renderDone() {
  const s = session;
  const k = SRS.counts(live(), s.dir, newLimit(s.dir));
  view().innerHTML = `
    <div class="done">
      <div class="big" lang="ja">お疲れさま！</div>
      <p class="muted">${s.reviewed ? `You answered ${s.reviewed} card${s.reviewed > 1 ? 's' : ''} (${s.again} “Again”).` : 'Nothing due right now.'}</p>
      <div class="btn-row" style="justify-content:center;margin-top:18px">
        ${k.newAvail ? `<button class="btn" id="moreBtn">Learn ${settings.newPerDay} more new words</button>` : ''}
        <button class="btn primary" id="homeBtn">Back home</button>
      </div>
    </div>`;
  $('#homeBtn').onclick = () => endSession(true);
  const more = $('#moreBtn');
  if (more) more.onclick = () => {
    const dir = s.dir;
    const key = `kotoba-extra-${dir}-${SRS.today()}`;
    try { localStorage.setItem(key, (+localStorage.getItem(key) || 0) + (+settings.newPerDay || 10)); } catch {}
    session = null;
    startOrRenderSession(dir);
  };
  scheduleSync(800);
}

/* Words list */
let wordFilter = '';
let wordLimit = 200;
function statusChip(c) {
  if (!hasAI(c)) return '<span class="chip noai">no examples</span>';
  const s = SRS.stateOf(c, 'jp');
  if (!s) return '<span class="chip new">new</span>';
  const d = s.due - SRS.today();
  if (d <= 0) return '<span class="chip due">due</span>';
  return `<span class="chip">in ${SRS.formatInterval(d)}</span>`;
}
function renderWords() {
  const q = wordFilter.trim().toLowerCase();
  const all = live().sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  const list = q ? all.filter((c) => [c.word, c.reading, c.meaning, c.note].some((v) => (v || '').toLowerCase().includes(q))) : all;
  const missing = all.filter((c) => !hasAI(c));
  view().innerHTML = `
    <div class="words-head">
      <input class="search" id="search" type="search" placeholder="Search words, readings, meanings" value="${esc(wordFilter)}" lang="ja" />
      <button class="btn primary" id="addBtn">＋ Add</button>
      <button class="btn" id="bulkBtn">Paste many</button>
    </div>
    <div class="list-meta">
      <span>${list.length} of ${all.length} words · newest first</span>
      ${missing.length ? `<button class="btn sm" id="fillAll" ${settings.workerUrl ? '' : 'disabled title="Set up the server first"'}>✦ Fill ${missing.length} with AI</button>` : ''}
    </div>
    ${list.length ? `<ul class="word-list">${list.slice(0, wordLimit).map((c) => `
      <li class="word-row" data-id="${esc(c.id)}">
        <div class="w" lang="ja">${esc(c.word)}${c.reading && c.reading !== c.word ? `<small>${esc(c.reading)}</small>` : ''}</div>
        ${statusChip(c)}
        <div class="m">${esc(c.meaning || c.note || '—')}</div>
      </li>`).join('')}</ul>` : `<div class="panel empty"><p class="muted">${all.length ? 'No matches.' : 'No words yet.'}</p></div>`}
    ${list.length > wordLimit ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="moreRows">Show more</button></div>` : ''}`;
  const search = $('#search');
  search.oninput = () => {
    wordFilter = search.value;
    wordLimit = 200;
    const pos = search.selectionStart;
    renderWords();
    const s2 = $('#search');
    s2.focus();
    try { s2.setSelectionRange(pos, pos); } catch {}
  };
  $('#addBtn').onclick = () => openEditor(null);
  $('#bulkBtn').onclick = openBulk;
  const fill = $('#fillAll');
  if (fill) fill.onclick = () => runEnrich(missing);
  const more = $('#moreRows');
  if (more) more.onclick = () => { wordLimit += 300; renderWords(); };
  $$('.word-row').forEach((row) => (row.onclick = () => openEditor(cards.find((c) => c.id === row.dataset.id))));
}

/* Settings */
function renderSettings() {
  const lastSync = settings.lastSync ? new Date(settings.lastSync).toLocaleString() : 'never';
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  view().innerHTML = `
    <div class="settings">
      <h2>Study</h2>
      <div class="card-group">
        <div class="row">
          <div class="lbl">New words per day<small>Per direction. Reviews of older words come on top.</small></div>
          <input type="number" id="newPerDay" min="1" max="100" value="${esc(settings.newPerDay)}" />
        </div>
        <div class="row">
          <div class="lbl">Theme</div>
          <select id="theme">
            ${['auto', 'light', 'dark'].map((t) => `<option value="${t}" ${settings.theme === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
          </select>
        </div>
      </div>

      <h2>Server (Cloudflare Worker)</h2>
      <div class="card-group">
        <div class="stack">
          <label>Worker URL<input id="workerUrl" type="url" placeholder="https://kotoba-api.yourname.workers.dev" value="${esc(settings.workerUrl)}" autocomplete="off" /></label>
          <label>App password<input id="password" type="password" placeholder="The APP_PASSWORD you set on the Worker" value="${esc(settings.password)}" autocomplete="current-password" /></label>
          <div class="btn-row">
            <button class="btn primary" id="saveServer">Save &amp; test</button>
            <button class="btn" id="syncBtn" ${settings.workerUrl ? '' : 'disabled'}>Sync now</button>
          </div>
          <span class="muted small">Last sync: ${esc(lastSync)}. Words sync automatically between devices that use the same Worker.</span>
        </div>
      </div>

      <h2>Daily reminder</h2>
      <div class="card-group">
        ${pushSupported ? `
        <div class="row">
          <div class="lbl">Reminder time<small>${settings.pushOn ? 'On for this device' : 'Off on this device'}</small></div>
          <input type="time" id="notifyTime" value="${esc(settings.notifyTime)}" />
        </div>
        <div class="stack">
          <div class="btn-row">
            <button class="btn primary" id="pushOn" ${settings.workerUrl ? '' : 'disabled'}>${settings.pushOn ? 'Update reminder' : 'Turn on reminder'}</button>
            ${settings.pushOn ? '<button class="btn" id="pushTest">Send test</button><button class="btn ghost" id="pushOff">Turn off</button>' : ''}
          </div>
          <span class="muted small">On Android, install the app first (browser menu → “Add to Home screen” / “Install app”). On PC, notifications arrive while Chrome or Edge is running.</span>
        </div>` : `<div class="stack"><span class="muted small">This browser doesn't support push notifications. Use Chrome or Edge, and install the app to your home screen.</span></div>`}
      </div>

      <h2>Data &amp; backup</h2>
      <div class="card-group">
        <div class="stack">
          <div class="btn-row">
            <button class="btn" id="exportBtn">Export backup (.json)</button>
            <button class="btn" id="importBtn">Import file</button>
            <button class="btn ghost" id="starterBtn">Load starter deck</button>
          </div>
          <span class="muted small">Import accepts a Kotoba backup (.json) or a word list in your notes format (.txt). Importing merges — it never deletes words.</span>
        </div>
      </div>
      <p class="muted small" style="text-align:center;margin-top:24px">${live().length} words on this device</p>
    </div>`;

  $('#newPerDay').onchange = (e) => { settings.newPerDay = Math.max(1, Math.min(100, +e.target.value || 10)); saveSettings(); };
  $('#theme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
  $('#saveServer').onclick = async () => {
    settings.workerUrl = $('#workerUrl').value.trim().replace(/\/+$/, '');
    settings.password = $('#password').value;
    saveSettings();
    try {
      const r = await api('/ping');
      toast(r.ai ? 'Connected ✓ (AI ready)' : 'Connected ✓ — but GEMINI_API_KEY is not set on the Worker', r.ai ? '' : 'err');
      await syncNow(true);
    } catch (e) { toast(e.message, 'err'); }
    renderSettings();
  };
  $('#syncBtn').onclick = () => syncNow(false).then(renderSettings);
  const nt = $('#notifyTime');
  if (nt) nt.onchange = () => { settings.notifyTime = nt.value || '20:00'; saveSettings(); };
  const on = $('#pushOn');
  if (on) on.onclick = async () => {
    on.disabled = true;
    try { await enablePush(); toast(`Reminder set for ${settings.notifyTime} every day`); }
    catch (e) { toast(e.message, 'err'); }
    renderSettings();
  };
  const off = $('#pushOff');
  if (off) off.onclick = async () => { try { await disablePush(); toast('Reminder turned off'); } catch (e) { toast(e.message, 'err'); } renderSettings(); };
  const test = $('#pushTest');
  if (test) test.onclick = async () => { try { await testPush(); toast('Test sent — it should arrive in a few seconds'); } catch (e) { toast(e.message, 'err'); } };
  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#fileInput').click();
  $('#starterBtn').onclick = () => loadStarter().catch((e) => toast(e.message, 'err'));
}

/* ---------- push notifications ---------- */
function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push notifications are not supported here.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted. Allow it in your browser/app settings.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (sub && settings.vapidKey && settings.vapidKey !== publicKey) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await api('/push/subscribe', {
    subscription: sub.toJSON(),
    time: settings.notifyTime,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo',
  });
  settings.vapidKey = publicKey;
  settings.pushOn = true;
  saveSettings();
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  settings.pushOn = false;
  saveSettings();
}
async function testPush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) throw new Error('No subscription on this device. Turn the reminder on first.');
  await api('/push/test', { endpoint: sub.endpoint });
}

/* ---------- editor dialog ---------- */
let editing = null;
function openEditor(card) {
  editing = card ? { ...card } : null;
  const f = $('#editForm');
  const c = card || {};
  const ex = c.examples || [];
  $('#editTitle').textContent = card ? 'Edit word' : 'Add word';
  f.word.value = c.word || '';
  f.reading.value = c.reading || '';
  f.meaning.value = c.meaning || '';
  f.note.value = c.note || '';
  f.nuance.value = c.nuance || '';
  f.ex1ja.value = ex[0]?.ja || ''; f.ex1en.value = ex[0]?.en || '';
  f.ex2ja.value = ex[1]?.ja || ''; f.ex2en.value = ex[1]?.en || '';
  $('#editDelete').hidden = !card;
  $('#editAI').disabled = !settings.workerUrl;
  $('#editAI').title = settings.workerUrl ? '' : 'Set up the server in Settings first';
  $('#editDialog').showModal();
  if (!card) setTimeout(() => f.word.focus(), 50);
}
function formToFields() {
  const f = $('#editForm');
  const examples = [[f.ex1ja.value, f.ex1en.value], [f.ex2ja.value, f.ex2en.value]]
    .map(([ja, en]) => ({ ja: ja.trim(), en: en.trim() }))
    .filter((e) => e.ja);
  return {
    word: f.word.value.trim(), reading: f.reading.value.trim(), meaning: f.meaning.value.trim(),
    note: f.note.value.trim(), nuance: f.nuance.value.trim(), examples,
  };
}
function initEditor() {
  const dlg = $('#editDialog');
  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = formToFields();
    if (!fields.word) return;
    if (!editing) {
      if (findByWord(fields.word)) return toast(`“${fields.word}” is already in your list.`, 'err');
      const c = newCard({ ...fields, meaning: fields.meaning || fields.note });
      await saveCards([c]);
      dlg.close();
      toast(`Added ${c.word}`);
      if (!hasAI(c) && settings.workerUrl) runEnrich([c]);
    } else {
      await saveCards([{ ...editing, ...fields, updatedAt: Date.now() }]);
      dlg.close();
      toast('Saved');
    }
    session ? renderSession() : render();
  });
  $('#editCancel').onclick = () => dlg.close();
  $('#editDelete').onclick = async () => {
    if (!editing || !confirm(`Delete “${editing.word}”? Its review history is removed too.`)) return;
    await saveCards([{ ...editing, deleted: true, updatedAt: Date.now() }]);
    if (session) {
      session.queue = session.queue.filter((id, i) => i < session.pos || id !== editing.id);
    }
    dlg.close();
    toast('Deleted');
    session ? renderSession() : render();
  };
  $('#editAI').onclick = async () => {
    const fields = formToFields();
    if (!fields.word) return toast('Type the word first.', 'err');
    const btn = $('#editAI');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Thinking…';
    try {
      const { results } = await api('/enrich', { words: [{ word: fields.word, reading: fields.reading, meaning: fields.note || fields.meaning }] });
      const r = results && results[0];
      if (!r) throw new Error('The AI returned nothing. Try again.');
      const f = $('#editForm');
      if (!f.reading.value) f.reading.value = r.reading || '';
      f.meaning.value = r.meaning || f.meaning.value;
      f.nuance.value = r.nuance || '';
      const ex = r.examples || [];
      f.ex1ja.value = ex[0]?.ja || ''; f.ex1en.value = ex[0]?.en || '';
      f.ex2ja.value = ex[1]?.ja || ''; f.ex2en.value = ex[1]?.en || '';
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
    btn.textContent = '✦ Fill with AI';
  };
}

/* ---------- bulk add dialog ---------- */
function openBulk() {
  const f = $('#bulkForm');
  f.text.value = '';
  f.ai.checked = !!settings.workerUrl;
  f.ai.disabled = !settings.workerUrl;
  $('#bulkDialog').showModal();
}
function initBulk() {
  $('#bulkCancel').onclick = () => $('#bulkDialog').close();
  $('#bulkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const parsed = parseWordLines(f.text.value);
    if (!parsed.length) return toast('No Japanese words found in that text.', 'err');
    const fresh = [];
    let skipped = 0;
    for (const p of parsed) {
      if (findByWord(p.word) || fresh.some((c) => c.word === p.word)) { skipped++; continue; }
      fresh.push(p);
    }
    let order = nextOrder();
    const created = fresh.map((p) => newCard({ ...p, order: order++ }));
    await saveCards(created);
    $('#bulkDialog').close();
    toast(`Added ${created.length} word${created.length === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already in your list` : ''}`);
    render();
    if (f.ai.checked && created.length) runEnrich(created);
  });
}

/* ---------- global events ---------- */
document.addEventListener('click', (e) => {
  const sp = e.target.closest('[data-speak]');
  if (sp) { e.stopPropagation(); speak(sp.dataset.speak); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) { e.stopPropagation(); openEditor(cards.find((c) => c.id === ed.dataset.edit)); return; }
  const ai = e.target.closest('[data-ai]');
  if (ai) {
    e.stopPropagation();
    const c = cards.find((x) => x.id === ai.dataset.ai);
    if (!settings.workerUrl) return toast('Set up the server in Settings to use AI.', 'err');
    ai.disabled = true;
    ai.innerHTML = '<span class="spinner"></span>';
    enrichBatch([c]).then(() => (session ? renderSession() : render())).catch((err) => { toast(err.message, 'err'); ai.disabled = false; ai.textContent = '✦ Fill with AI'; });
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (!session || route().name !== 'study') return;
  if ($('dialog[open]') || /input|textarea|select/i.test(e.target.tagName)) return;
  if (e.key === 'Escape') return endSession(true);
  if (!session.revealed) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
    if (e.key.toLowerCase() === 'h' && session.dir === 'en') { session.hint++; renderSession(); }
  } else {
    const map = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy', ' ': 'good', Enter: 'good' };
    if (map[e.key]) { e.preventDefault(); answer(map[e.key]); }
  }
});

$('#syncDot').onclick = () => syncNow(false);
$('#fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { await handleFile(file); } catch (err) { toast('Import failed: ' + err.message, 'err'); }
};
window.addEventListener('hashchange', render);
window.addEventListener('online', () => scheduleSync(1000));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleSync(500);
    if (!session) render();
  }
});

/* ---------- boot ---------- */
(async function boot() {
  applyTheme();
  initEditor();
  initBulk();
  try { await reload(); await dedupeWords(); } catch (e) { toast('Could not open local storage: ' + e.message, 'err'); }
  KDB.setKV('newPerDay', settings.newPerDay).catch(() => {});
  setSyncState(settings.workerUrl ? (settings.lastSync ? 'ok' : 'off') : 'off');
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (settings.workerUrl) syncNow(true);
})();
