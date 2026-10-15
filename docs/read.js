/* Kotoba — 読む: daily casual-Japanese reading lessons */
'use strict';

const DAY_LABELS = [[1, '月'], [2, '火'], [3, '水'], [4, '木'], [5, '金'], [6, '土'], [0, '日']];
let lessonIndex = null; // summaries, newest first
let lessonCfg = null;
let reading = null; // { lesson, playing }

/* ---------- cache (works offline) ---------- */
async function cachedIndex() {
  if (lessonIndex) return lessonIndex;
  try { lessonIndex = (await KDB.getKV('lessonIndex')) || []; } catch { lessonIndex = []; }
  return lessonIndex;
}
async function saveIndex(list) {
  lessonIndex = list;
  try { await KDB.setKV('lessonIndex', list); } catch {}
}
async function getLesson(id) {
  let lesson = null;
  try { lesson = await KDB.getKV('lesson:' + id); } catch {}
  if (lesson) return lesson;
  const r = await api('/lesson?id=' + encodeURIComponent(id));
  try { await KDB.setKV('lesson:' + id, r.lesson); } catch {}
  return r.lesson;
}
async function refreshIndex() {
  try {
    const r = await api('/lessons');
    await saveIndex(r.lessons || []);
    return true;
  } catch (e) {
    if (/Not found/i.test(e.message)) throw new Error('Your Worker is an older version. Paste the new worker code in Cloudflare to use lessons.');
    throw e;
  }
}
function oldWorkerMsg(e) {
  return /Not found/i.test(e.message) ? 'Your Worker is an older version. Paste the new worker code in Cloudflare to use lessons.' : e.message;
}

/* ---------- schedule (stored on the server) ---------- */
function scheduleText(cfg) {
  if (!cfg) return '';
  if (!cfg.enabled) return 'Daily lessons are off';
  const days = DAY_LABELS.filter(([d]) => cfg.days.includes(d)).map(([, l]) => l);
  const range = days.length === 6 && !cfg.days.includes(0) ? '月〜土' : days.length === 7 ? '毎日' : days.join('・');
  return `New lesson ${range} at ${cfg.time}`;
}
async function loadLessonCfg() {
  const r = await api('/lesson/settings');
  lessonCfg = r.settings;
  return lessonCfg;
}

function renderLessonSettings(box) {
  if (!box) return;
  if (!settings.workerUrl) {
    box.innerHTML = '<div class="stack"><span class="muted small">Connect the server above to get a new AI reading lesson each day.</span></div>';
    return;
  }
  box.innerHTML = '<div class="stack"><span class="muted small"><span class="spinner"></span> Loading…</span></div>';
  loadLessonCfg().then((cfg) => {
    box.innerHTML = `
      <div class="row">
        <div class="lbl">New lesson every day<small>AI writes a ~15-minute casual-Japanese reading and sends a notification.</small></div>
        <label class="switch"><input type="checkbox" id="lsOn" ${cfg.enabled ? 'checked' : ''} /><span></span></label>
      </div>
      <div class="row">
        <div class="lbl">Days</div>
        <div class="days" role="group" aria-label="Days">${DAY_LABELS.map(([d, l]) => `<button type="button" class="day ${cfg.days.includes(d) ? 'on' : ''}" data-day="${d}" aria-pressed="${cfg.days.includes(d)}">${l}</button>`).join('')}</div>
      </div>
      <div class="row">
        <div class="lbl">Time</div>
        <input type="time" id="lsTime" value="${esc(cfg.time)}" />
      </div>
      <div class="stack">
        <div class="btn-row"><button class="btn primary" id="lsSave">Save schedule</button></div>
        <span class="muted small">The notification goes to every device where the daily reminder is turned on.</span>
      </div>`;
    $$('.day', box).forEach((b) => (b.onclick = () => {
      b.classList.toggle('on');
      b.setAttribute('aria-pressed', b.classList.contains('on'));
    }));
    $('#lsSave', box).onclick = async () => {
      const days = $$('.day.on', box).map((b) => +b.dataset.day);
      try {
        const r = await api('/lesson/settings', {
          enabled: $('#lsOn', box).checked,
          days,
          time: $('#lsTime', box).value || '20:00',
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo',
        });
        lessonCfg = r.settings;
        toast(lessonCfg.enabled ? `Saved — ${scheduleText(lessonCfg)}` : 'Saved — daily lessons are off');
      } catch (e) { toast(oldWorkerMsg(e), 'err'); }
    };
  }).catch((e) => {
    box.innerHTML = `<div class="stack"><span class="muted small">${esc(oldWorkerMsg(e))}</span></div>`;
  });
}

/* ---------- Read tab ---------- */
function renderRead(id) {
  if (id) return renderLesson(id);
  stopReading();
  if (!settings.workerUrl) {
    view().innerHTML = `
      <div class="hello"><h1>読む</h1><p>Casual Japanese, the way friends really talk.</p></div>
      <div class="panel"><h2>Connect the server first</h2><p class="muted small">Lessons are written by AI on your server. Add your Worker URL and password in Settings.</p><a class="btn" href="#/settings">Open settings</a></div>`;
    return;
  }
  const draw = (list, loading) => {
    if (route().name !== 'read' || route().arg) return;
    const today = new Date().toLocaleDateString('en-CA');
    view().innerHTML = `
      <div class="hello"><h1>読む</h1><p>Casual Japanese, the way friends really talk.</p></div>
      <div class="read-top">
        <span class="muted small" id="schedLine">${lessonCfg ? esc(scheduleText(lessonCfg)) : ''} · <a href="#/settings">change</a></span>
        <button class="btn primary" id="genNow">✦ New lesson now</button>
      </div>
      ${loading && !list.length ? '<div class="panel muted small"><span class="spinner"></span> Loading lessons…</div>' : ''}
      ${!loading && !list.length ? '<div class="panel empty"><div class="big">読</div><h2>No lessons yet</h2><p class="muted small">Tap “New lesson now” to try one, or turn on the daily lesson in Settings.</p></div>' : ''}
      ${list.length ? `<ul class="lesson-list">${list.map((l) => `
        <li><a href="#/read/${esc(l.id)}" class="lesson-row ${l.done ? 'done' : ''}">
          <div class="lr-top"><span class="chip">${esc(l.formatLabel)}</span><span class="muted small">${l.date === today ? 'Today' : esc(l.date)}</span>${l.done ? '<span class="done-mark">✓ done</span>' : ''}</div>
          <div class="lr-title" lang="ja">${esc(l.title)}</div>
          <div class="muted small">${esc(l.titleEn)}</div>
        </a></li>`).join('')}</ul>` : ''}`;
    $('#genNow').onclick = generateNow;
  };
  cachedIndex().then((list) => {
    draw(list, true);
    Promise.allSettled([refreshIndex(), lessonCfg ? null : loadLessonCfg()]).then(([r]) => {
      if (r.status === 'rejected') toast(r.reason.message, 'err');
      draw(lessonIndex || [], false);
    });
  });
}

async function generateNow() {
  const btn = $('#genNow');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Writing… (about 30 s)';
  try {
    const { lesson } = await api('/lesson/generate', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo' });
    try { await KDB.setKV('lesson:' + lesson.id, lesson); } catch {}
    await saveIndex([{ id: lesson.id, date: lesson.date, title: lesson.title, titleEn: lesson.titleEn, formatLabel: lesson.formatLabel, done: false }, ...(lessonIndex || [])]);
    location.hash = '#/read/' + lesson.id;
  } catch (e) {
    toast(oldWorkerMsg(e), 'err');
    btn.disabled = false;
    btn.textContent = '✦ New lesson now';
  }
}

/* ---------- one lesson ---------- */
const SPEAKER_HUES = ['s0', 's1', 's2', 's3'];
function vocabRegex(vocab) {
  const words = vocab.map((v) => v.word).filter((w) => w && w.length > 0).sort((a, b) => b.length - a.length);
  if (!words.length) return null;
  return new RegExp(words.map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
}

async function renderLesson(id) {
  stopReading();
  view().innerHTML = '<div class="panel muted small"><span class="spinner"></span> Opening lesson…</div>';
  let lesson;
  try { lesson = await getLesson(id); } catch (e) {
    view().innerHTML = `<div class="panel"><p>${esc(oldWorkerMsg(e))}</p><a class="btn" href="#/read">Back</a></div>`;
    return;
  }
  if (route().name !== 'read' || route().arg !== id) return;
  reading = { lesson, playing: false };
  const speakers = [...new Set(lesson.lines.map((l) => l.speaker).filter(Boolean))];
  const hue = (sp) => SPEAKER_HUES[speakers.indexOf(sp) % SPEAKER_HUES.length];
  const chat = ['line', 'sns', 'qa'].includes(lesson.format);
  const re = vocabRegex(lesson.vocab || []);
  const marked = (t) => (re ? esc(t).replace(re, (m) => `<mark>${m}</mark>`) : esc(t));
  const yourKey = 'kotoba-yt-' + lesson.id;
  let yourText = '';
  try { yourText = localStorage.getItem(yourKey) || ''; } catch {}

  view().innerHTML = `
    <article class="lesson en-hidden">
      <div class="lesson-nav">
        <a class="icon-btn" href="#/read" aria-label="All lessons">${ICON.back}</a>
        <span class="chip">${esc(lesson.formatLabel)}</span>
        <span class="muted small">${esc(lesson.date)} · 約15分</span>
      </div>
      <h1 class="lesson-title" lang="ja">${esc(lesson.title)}</h1>
      <p class="muted lesson-sub">${esc(lesson.titleEn)}</p>
      <div class="setting-box">
        <p lang="ja">${esc(lesson.setting)}</p>
        <p class="en-text muted small">${esc(lesson.settingEn)}</p>
      </div>

      <section>
        <h2 class="sec-title"><span>1</span>まずは単語 <small>Key words</small></h2>
        <ul class="vocab-list">${(lesson.vocab || []).map((v, i) => `
          <li class="vocab-item">
            <div class="vh">
              <span class="vw" lang="ja">${esc(v.word)}</span>
              ${v.reading && v.reading !== v.word ? `<span class="vr" lang="ja">${esc(v.reading)}</span>` : ''}
              <button class="icon-btn" data-speak="${esc(v.word)}" aria-label="Play">${ICON.speak}</button>
              <span class="spacer"></span>
              <button class="btn sm add-word" data-addword="${i}" ${findByWord(v.word) ? 'disabled' : ''}>${findByWord(v.word) ? 'In my words ✓' : '＋ My words'}</button>
            </div>
            <div class="vm">${esc(v.meaning)}</div>
            ${v.meaningJa ? `<div class="vj" lang="ja">${esc(v.meaningJa)}</div>` : ''}
            ${v.note ? `<div class="vn">${esc(v.note)}</div>` : ''}
          </li>`).join('')}</ul>
      </section>

      <section>
        <h2 class="sec-title"><span>2</span>読んでみよう <small>Read</small></h2>
        <div class="read-tools">
          <button class="btn sm" id="playAll">▶ Play all</button>
          <button class="btn sm" id="enAll">Show all English</button>
          <span class="muted small">Tap a line to see its English.</span>
        </div>
        <div class="lines ${chat ? 'chat' : 'prose'}">${lesson.lines.map((l, i) => `
          <div class="line ${l.speaker ? 'has-sp ' + hue(l.speaker) : 'narr'}" data-line="${i}">
            ${l.speaker ? `<div class="sp">${esc(l.speaker)}</div>` : ''}
            <div class="bubble">
              <p class="jp" lang="ja">${marked(l.text)}</p>
              <p class="en-text tr">${esc(l.en)}</p>
            </div>
            <button class="icon-btn line-say" data-say="${i}" aria-label="Play line">${ICON.speak}</button>
          </div>`).join('')}</div>
      </section>

      ${(lesson.expressions || []).length ? `<section>
        <h2 class="sec-title"><span>3</span>表現 <small>Casual patterns</small></h2>
        <ul class="expr-list">${lesson.expressions.map((e) => `
          <li>
            <div class="ep" lang="ja">${esc(e.pattern)} <span class="muted">→ ${esc(e.standard)}</span></div>
            <p>${esc(e.explanation)}</p>
            ${e.example ? `<p class="ex" lang="ja">${marked(e.example)}</p>` : ''}
          </li>`).join('')}</ul>
      </section>` : ''}

      ${(lesson.questions || []).length ? `<section>
        <h2 class="sec-title"><span>4</span>確認 <small>Check</small></h2>
        <ol class="q-list">${lesson.questions.map((q, i) => `
          <li><p lang="ja">${esc(q.q)}</p>
            <button class="link" data-ans="${i}">答えを見る</button>
            <p class="ans" lang="ja" hidden>${esc(q.a)}</p></li>`).join('')}</ol>
      </section>` : ''}

      <section>
        <h2 class="sec-title"><span>5</span>あなたの番 <small>Your turn</small></h2>
        <p lang="ja">${esc(lesson.yourTurn?.promptJa)}</p>
        <p class="muted small">${esc(lesson.yourTurn?.promptEn)}</p>
        <textarea id="yourTurn" rows="3" lang="ja" placeholder="ここに書いてみよう…">${esc(yourText)}</textarea>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn sm" id="sayMine">🔊 Hear mine</button>
          <button class="link" id="showSample">Show a sample answer</button>
        </div>
        <p class="sample" lang="ja" hidden>${esc(lesson.yourTurn?.sample)}</p>
      </section>

      <div class="lesson-end">
        <button class="btn ${lesson.done ? '' : 'primary'} block" id="doneBtn">${lesson.done ? '✓ Done — mark as not done' : 'Mark as done ✓'}</button>
      </div>
    </article>`;

  const root = $('.lesson');
  $$('.line', root).forEach((el) => (el.onclick = (e) => {
    if (e.target.closest('button')) return;
    el.classList.toggle('show-en');
  }));
  $$('[data-say]', root).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const l = lesson.lines[+b.dataset.say];
    stopReading();
    speak(l.text, { pitch: pitchFor(speakers, l.speaker) });
  }));
  $('#enAll').onclick = () => {
    root.classList.toggle('en-hidden');
    $('#enAll').textContent = root.classList.contains('en-hidden') ? 'Show all English' : 'Hide English';
  };
  $('#playAll').onclick = () => (reading.playing ? stopReading() : playAll(speakers));
  $$('[data-addword]', root).forEach((b) => (b.onclick = () => addLessonWord(lesson.vocab[+b.dataset.addword], b)));
  $$('[data-ans]', root).forEach((b) => (b.onclick = () => {
    const a = b.nextElementSibling;
    a.hidden = !a.hidden;
    b.textContent = a.hidden ? '答えを見る' : '答えを隠す';
  }));
  const yt = $('#yourTurn');
  yt.oninput = () => { try { localStorage.setItem(yourKey, yt.value); } catch {} };
  $('#sayMine').onclick = () => yt.value.trim() && speak(yt.value.trim());
  $('#showSample').onclick = () => {
    const s = $('.sample', root);
    s.hidden = !s.hidden;
    $('#showSample').textContent = s.hidden ? 'Show a sample answer' : 'Hide the sample';
  };
  $('#doneBtn').onclick = () => toggleDone(lesson);
  window.scrollTo(0, 0);
}

function pitchFor(speakers, sp) {
  return [1, 1.25, 0.85, 1.12][Math.max(0, speakers.indexOf(sp)) % 4];
}

function playAll(speakers) {
  const lesson = reading.lesson;
  reading.playing = true;
  $('#playAll').textContent = '■ Stop';
  speechSynthesis.cancel();
  let i = 0;
  const next = () => {
    $$('.line.playing').forEach((el) => el.classList.remove('playing'));
    if (!reading || !reading.playing || i >= lesson.lines.length) return stopReading();
    const el = $(`.line[data-line="${i}"]`);
    if (el) { el.classList.add('playing'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    const l = lesson.lines[i++];
    speak(l.text, { pitch: pitchFor(speakers, l.speaker), onend: next, keep: true });
  };
  next();
}
function stopReading() {
  if (reading && reading.playing) {
    reading.playing = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
  $$('.line.playing').forEach((el) => el.classList.remove('playing'));
  const b = $('#playAll');
  if (b) b.textContent = '▶ Play all';
}

async function addLessonWord(v, btn) {
  if (findByWord(v.word)) { btn.disabled = true; btn.textContent = 'In my words ✓'; return; }
  const c = newCard({ word: v.word, reading: v.reading, meaning: v.meaning, note: v.meaning, meaningJa: v.meaningJa });
  await saveCards([c]);
  btn.disabled = true;
  btn.textContent = 'In my words ✓';
  toast(`Added ${v.word} to your words`);
  if (settings.workerUrl) runEnrich([c]); // fill in nuance + examples
}

async function toggleDone(lesson) {
  const done = !lesson.done;
  try {
    await api('/lesson/done', { id: lesson.id, done });
    lesson.done = done;
    try { await KDB.setKV('lesson:' + lesson.id, lesson); } catch {}
    await saveIndex((lessonIndex || []).map((l) => (l.id === lesson.id ? { ...l, done } : l)));
    if (done) { toast('お疲れさま！ Lesson done ✓'); location.hash = '#/read'; }
    else renderLesson(lesson.id);
  } catch (e) { toast(e.message, 'err'); }
}

/* Open the lesson when its notification is tapped while the app is already open */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.url) {
      const h = new URL(e.data.url, location.href).hash;
      if (h) location.hash = h;
    }
  });
}
