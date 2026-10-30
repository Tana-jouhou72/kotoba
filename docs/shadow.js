/* Kotoba — 話す: daily shadowing with videos from your YouTube playlist.
 * The server picks today's video. An unfinished video comes back the next day at the point where you stopped;
 * after you finish one, a new random video comes the next day. */
'use strict';

let shadowData = null;   // last answer from GET /shadow
let shadowCfgCache = null;
let yt = null;           // the player on screen: { id, player, timer, lastSentPos, lastSentAt, rate }
let ytApi = null;
let shTx = null;         // the current video's transcript, once loaded: { id, lines:[{ t, sp, ja, tr }] }
const AWAY_KEY = 'kotoba-shadow-away'; // set when you open the video in the YouTube app
const POS_KEY = 'kotoba-shadow-pos';
const SEND_EVERY_MS = 60000; // while playing, the server copy of your position is updated about once a minute

/* ---------- small helpers ---------- */
const tzName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function fmtMinutes(s) {
  if (!s) return '';
  return s < 60 ? `${s}秒` : `${Math.round(s / 60)}分`;
}
/** Today's date in the app's sense (the day rolls over at 4am), as YYYY-MM-DD. */
function shadowToday() {
  return new Date(Date.now() - 4 * 3600000).toLocaleDateString('en-CA');
}
function shadowOldWorker(e) {
  return /Not found/i.test(e.message) ? 'Your Worker is an older version. Paste the new worker code in Cloudflare to use shadowing.' : e.message;
}
function localPos(id) {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    return p && p.id === id ? p : null;
  } catch { return null; }
}
function saveLocalPos(id, pos) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ id, pos, t: Date.now() })); } catch {}
}
/** Where to resume: the newer of this device's position and the server's (which may come from your other device). */
function resumePos(c) {
  const loc = localPos(c.id);
  if (loc && loc.t > (c.updatedAt || 0)) return loc.pos;
  return c.pos || 0;
}
function shadowSchedule(cfg) {
  if (!cfg || !cfg.enabled) return 'Shadowing reminder is off';
  const days = DAY_LABELS.filter(([d]) => cfg.days.includes(d)).map(([, l]) => l);
  const range = days.length === 7 ? '毎日' : days.length === 6 && !cfg.days.includes(0) ? '月〜土' : days.join('・');
  return `Reminder ${range} at ${cfg.time}`;
}
function ytWatchUrl(id, pos) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${pos > 5 ? `&t=${Math.floor(pos)}s` : ''}`;
}

/* ---------- YouTube player ---------- */
function loadYTApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('Could not load the YouTube player. Check your connection.')); };
    document.head.appendChild(s);
  });
  return ytApi;
}

function playerPos() {
  try { return yt && yt.player && yt.player.getCurrentTime ? yt.player.getCurrentTime() || 0 : 0; } catch { return 0; }
}
function playerDur() {
  try { return (yt && yt.player && yt.player.getDuration && yt.player.getDuration()) || (shadowData && shadowData.current && shadowData.current.dur) || 0; } catch { return 0; }
}
/** Close enough to the end to count as finished (videos often end with a few seconds of end screen). */
function nearEnd(pos, dur) {
  return dur > 0 && dur - pos <= Math.max(5, Math.min(20, dur * 0.05));
}

/** Saves your position on the server. beacon = the page is closing, so use a request that survives that. */
async function sendProgress({ finished, beacon = false } = {}) {
  const c = shadowData && shadowData.current;
  if (!yt || !c || yt.id !== c.id) return null;
  const pos = playerPos();
  const dur = playerDur();
  saveLocalPos(c.id, pos);
  if (finished === undefined && !c.finished && !yt.noAuto && nearEnd(pos, dur) && pos > 0) finished = true;
  const body = { id: c.id, pos, dur, tz: tzName(), ...(finished !== undefined ? { finished } : {}) };
  yt.lastSentPos = pos;
  yt.lastSentAt = Date.now();
  if (beacon) {
    try {
      fetch(settings.workerUrl.replace(/\/+$/, '') + '/shadow/progress', {
        method: 'POST', keepalive: true,
        headers: { Authorization: 'Bearer ' + settings.password, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch {}
    return null;
  }
  try {
    const r = await api('/shadow/progress', body);
    if (r.ok && r.current) {
      const wasFinished = c.finished;
      shadowData.current = r.current;
      if (r.current.finished !== wasFinished) { drawShadowStatus(); refreshShadowHistory(); }
      if (r.current.finished && !wasFinished) toast('お疲れさま！ Finished ✓ — a new video comes tomorrow');
    }
    return r;
  } catch { return null; } // offline: this device still remembers the position
}

function tick() {
  if (!yt || !yt.player) return;
  const pos = playerPos(), dur = playerDur();
  const el = $('#shTime');
  if (el) el.textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
  const bar = $('#shBar');
  if (bar && dur) bar.style.width = Math.min(100, (pos / dur) * 100) + '%';
  saveLocalPos(yt.id, pos);
  if (Date.now() - yt.lastSentAt > SEND_EVERY_MS && Math.abs(pos - yt.lastSentPos) > 5) sendProgress();
}

function destroyPlayer() {
  if (!yt) return;
  clearInterval(yt.timer);
  clearInterval(yt.loopTimer);
  try { yt.player && yt.player.destroy && yt.player.destroy(); } catch {}
  yt = null;
}

/** Called by the app when you leave the 話す tab. */
function leaveShadow() {
  if (!yt) return;
  if (Math.abs(playerPos() - yt.lastSentPos) > 2) sendProgress();
  destroyPlayer();
}

async function mountPlayer(c) {
  destroyPlayer();
  const start = Math.max(0, resumePos(c) - 3); // a few seconds of run-up before where you stopped
  yt = { id: c.id, player: null, timer: null, lastSentPos: resumePos(c), lastSentAt: Date.now(), rate: 1 };
  const mine = yt;
  let YTapi;
  try { YTapi = await loadYTApi(); } catch (e) { return playerFallback(c, e.message); }
  if (yt !== mine || !$('#ytPlayer')) return; // left the page meanwhile
  mine.player = new YTapi.Player('ytPlayer', {
    videoId: c.id,
    playerVars: { start: Math.floor(start), playsinline: 1, rel: 0, hl: 'ja', cc_lang_pref: 'ja' },
    events: {
      onReady: () => { tick(); },
      onStateChange: (e) => {
        if (yt !== mine) return;
        clearInterval(mine.timer);
        mine.playing = e.data === YTapi.PlayerState.PLAYING || e.data === YTapi.PlayerState.BUFFERING;
        const pb = $('#shPlay');
        if (pb) { pb.textContent = mine.playing ? '⏸' : '▶'; pb.setAttribute('aria-label', mine.playing ? 'Pause' : 'Play'); }
        if (e.data === YTapi.PlayerState.PLAYING) mine.timer = setInterval(tick, 1000);
        else if (e.data === YTapi.PlayerState.PAUSED) { tick(); sendProgress(); }
        else if (e.data === YTapi.PlayerState.ENDED) { tick(); if (!shadowData.current.finished) sendProgress({ finished: true }); }
      },
      onError: (e) => {
        if (yt !== mine) return;
        // 101 / 150: the owner doesn't allow playing it on other sites; 100: removed or private
        if ([101, 150, 153].includes(e.data)) playerFallback(c, 'This video can\'t play inside the app (its owner turned that off).');
        else if (e.data === 100) playerFallback(c, 'This video was removed or made private. Tap “Skip this video” to get another one.');
      },
    },
  });
}

function playerFallback(c, msg) {
  const box = $('.sh-player');
  if (!box) return;
  box.classList.add('fallback');
  box.innerHTML = `<div class="sh-fallback"><p>${esc(msg)}</p>
    <a class="btn primary" data-ytopen href="${esc(ytWatchUrl(c.id, resumePos(c)))}" target="_blank" rel="noopener">▶ Watch in YouTube${resumePos(c) > 5 ? ` from ${fmtTime(resumePos(c))}` : ''}</a>
    <p class="muted small">When you come back, Kotoba asks how far you got.</p></div>`;
  $('#shTools') && ($('#shTools').hidden = true);
}

/* ---------- 話す tab ---------- */
function renderShadow() {
  // Keep the player alive when the app re-renders for other reasons (sync, coming back to the app)
  if (yt && $('#shadowRoot') && shadowData && shadowData.date === shadowToday()) return;
  destroyPlayer();
  if (!settings.workerUrl) {
    view().innerHTML = `
      <div class="hello"><h1>話す</h1><p>Shadowing — listen, then speak along with the speaker.</p></div>
      <div class="panel"><h2>Connect the server first</h2><p class="muted small">Your playlist is read by your server. Add your Worker URL and password in Settings.</p><a class="btn" href="#/settings">Open settings</a></div>`;
    return;
  }
  view().innerHTML = `
    <div class="hello"><h1>話す</h1><p>Shadowing — listen, then speak along with the speaker.</p></div>
    <div class="panel muted small"><span class="spinner"></span> Getting today's video…</div>`;
  api('/shadow?tz=' + encodeURIComponent(tzName()))
    .then((r) => {
      shadowData = r;
      shadowCfgCache = r.settings;
      if (route().name === 'shadow') drawShadow();
    })
    .catch((e) => {
      if (route().name !== 'shadow') return;
      view().innerHTML = `
        <div class="hello"><h1>話す</h1><p>Shadowing — listen, then speak along with the speaker.</p></div>
        <div class="panel"><p>${esc(shadowOldWorker(e))}</p><button class="btn" id="shRetry">Try again</button></div>`;
      $('#shRetry').onclick = renderShadow;
    });
}

function shadowStatus(c, date) {
  const days = (c.days || []).length;
  if (c.finished) return { chip: c.finishedDate === date ? '✓ Finished today' : '✓ Finished', cls: 'done' };
  if ((c.days || []).includes(date)) return { chip: `Day ${days}`, cls: '' };
  if (days || c.pos > 5) return { chip: `Continue · Day ${days + 1}`, cls: 'cont' };
  return { chip: "Today's video", cls: 'new' };
}

function drawShadow() {
  const r = shadowData;
  const head = `<div class="hello"><h1>話す</h1><p>Shadowing — listen, then speak along with the speaker.</p></div>`;
  if (!r.settings.playlist) {
    view().innerHTML = `${head}
      <div class="panel empty"><div class="big">話</div><h2>Add your YouTube playlist</h2>
        <p class="muted small">Each day you get one video from it to shadow. An unfinished video continues the next day; after you finish one, a new random video comes the next day.</p>
        <a class="btn primary" href="#/settings">Set up in Settings</a></div>`;
    return;
  }
  const c = r.current;
  if (!c) {
    view().innerHTML = `${head}
      <div class="panel"><h2>Couldn't get a video</h2><p class="muted small">${esc(r.error || 'Try again in a moment.')}</p>
        <div class="btn-row"><button class="btn" id="shRetry">Try again</button><a class="btn ghost" href="#/settings">Settings</a></div></div>`;
    $('#shRetry').onclick = renderShadow;
    return;
  }
  const pos = resumePos(c);
  view().innerHTML = `
    <div id="shadowRoot" class="shadow">
      ${head}
      <div class="read-top"><span class="muted small">${esc(shadowSchedule(r.settings))} · <a href="#/settings">change</a></span></div>
      <div id="shReturn"></div>
      <div class="sh-head">
        <div class="lr-top"><span class="chip" id="shChip"></span><span class="muted small">${c.dur ? fmtTime(c.dur) : ''}</span></div>
        <h2 class="sh-title" lang="ja">${esc(c.title)}</h2>
        ${c.channel ? `<div class="muted small">${esc(c.channel)}</div>` : ''}
      </div>
      <div class="sh-stage">
        <div class="sh-player"><div id="ytPlayer"></div></div>
        <div id="shTools">
          <div class="sh-ctrl">
            <button class="ctrl play" id="shPlay" aria-label="Play">▶</button>
            <button class="ctrl" id="shBack" aria-label="Back 5 seconds">↺ 5s</button>
            <button class="ctrl loop" id="shLoop">🔁 Repeat sentence</button>
          </div>
          <div class="sh-sub">
            <span class="seg" role="group" aria-label="Speed">${[0.5, 0.75, 1].map((r) => `<button class="btn sm ${r === 1 ? 'on' : ''}" data-rate="${r}">${r}×</button>`).join('')}</span>
            <span class="spacer"></span>
            <span class="muted small sh-time" id="shTime">${fmtTime(pos)} / ${fmtTime(c.dur)}</span>
          </div>
          <div class="sh-bar"><span id="shBar" style="width:${c.dur ? Math.min(100, (pos / c.dur) * 100) : 0}%"></span></div>
          <div class="sh-loop" id="shLoopInfo" hidden>
            <div class="sh-loop-top">
              <span class="chip">🔁 Repeating</span><span class="spacer"></span>
              <button class="btn sm" id="loopPrev" aria-label="Previous sentence">◀</button>
              <button class="btn sm" id="loopNext" aria-label="Next sentence">▶</button>
              <button class="btn sm" id="loopStop">■ Stop</button>
            </div>
            <p class="jp" lang="ja" id="shLoopText"></p>
          </div>
        </div>
      </div>
      <div class="sh-status" id="shStatus"></div>
      <div class="btn-row">
        <button class="btn" id="shTxBtn">文字 Show transcript</button>
        <a class="btn" data-ytopen href="${esc(ytWatchUrl(c.id, pos))}" target="_blank" rel="noopener">▶ YouTube app</a>
        <button class="btn" id="shFinish"></button>
      </div>
      <div class="sh-links">
        <button class="link" id="shSkip">Skip this video</button>
      </div>
      <section id="txBox" class="tx en-hidden" hidden></section>
      <div class="panel sh-progress" id="shHistory"></div>
    </div>`;

  drawShadowStatus();
  drawShadowHistory();
  $('#shPlay').onclick = playPause;
  $('#shBack').onclick = back5;
  $('#shLoop').onclick = () => (yt && yt.loop ? stopLoop() : loopHere());
  $('#loopPrev').onclick = () => yt && yt.loop && startLoop(yt.loop.i - 1);
  $('#loopNext').onclick = () => yt && yt.loop && startLoop(yt.loop.i + 1);
  $('#loopStop').onclick = stopLoop;
  $$('[data-rate]').forEach((b) => (b.onclick = () => {
    if (!yt || !yt.player || !yt.player.setPlaybackRate) return;
    yt.player.setPlaybackRate(+b.dataset.rate);
    $$('[data-rate]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#shTxBtn').onclick = toggleTranscript;
  $('#shFinish').onclick = toggleFinished;
  $('#shSkip').onclick = skipVideo;
  window.scrollTo(0, 0);
  if (c.embed === false) playerFallback(c, 'This video can\'t play inside the app (its owner turned that off).');
  else mountPlayer(c);
  checkReturn();
}

function drawShadowStatus() {
  const r = shadowData;
  const c = r && r.current;
  if (!c || !$('#shadowRoot')) return;
  const s = shadowStatus(c, r.date);
  const chip = $('#shChip');
  chip.textContent = s.chip;
  chip.className = 'chip ' + s.cls;
  const left = c.dur ? c.dur - resumePos(c) : 0;
  let msg;
  if (c.finished) msg = 'Finished ✓ A new random video comes tomorrow. You can keep practicing this one today.';
  else if (resumePos(c) > 5) msg = `Starts where you stopped${left > 0 ? ` — ${fmtMinutes(left)} left` : ''}. If you don't finish today, it continues tomorrow.`;
  else msg = `If you don't finish it today, it continues tomorrow from where you stopped.`;
  $('#shStatus').textContent = msg;
  const fin = $('#shFinish');
  fin.textContent = c.finished ? 'Not finished? Undo' : 'Mark as finished ✓';
  fin.className = c.finished ? 'btn ghost' : 'btn';
}

function drawShadowHistory() {
  const r = shadowData;
  const box = $('#shHistory');
  if (!box) return;
  const hist = (r.history || []).slice(0, 5);
  box.innerHTML = `
    <h2>Your progress</h2>
    <p class="muted small">Finished ${r.stats.done} of ${r.stats.total} videos in this round. Finished videos don't come back until you've done the whole playlist.</p>
    ${hist.length ? `<ul class="sh-hist">${hist.map((h) => `<li><span class="done-mark">✓</span><span class="t" lang="ja">${esc(h.title)}</span><span class="muted small">${esc(h.date)}${h.days > 1 ? ` · ${h.days} days` : ''}</span></li>`).join('')}</ul>` : ''}`;
}

async function toggleFinished() {
  const c = shadowData.current;
  const btn = $('#shFinish');
  const want = !c.finished;
  btn.disabled = true;
  const hasPlayer = !!(yt && yt.player && yt.id === c.id);
  const pos = hasPlayer ? playerPos() : resumePos(c);
  if (hasPlayer) { yt.lastSentPos = pos; yt.lastSentAt = Date.now(); yt.noAuto = !want; } // after "Undo", don't auto-finish again
  try {
    const res = await api('/shadow/progress', { id: c.id, pos, dur: (hasPlayer && playerDur()) || c.dur, tz: tzName(), finished: want });
    if (res.current) shadowData.current = res.current;
    if (want && res.current && res.current.finished) toast('お疲れさま！ Finished ✓ — a new video comes tomorrow');
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false;
  drawShadowStatus();
  refreshShadowHistory();
}

async function refreshShadowHistory() {
  try {
    const fresh = await api('/shadow?tz=' + encodeURIComponent(tzName()));
    if (!shadowData || !fresh.current || !shadowData.current || fresh.current.id !== shadowData.current.id) return;
    shadowData.stats = fresh.stats;
    shadowData.history = fresh.history;
    drawShadowHistory();
  } catch {}
}

async function skipVideo() {
  if (!confirm('Skip this video and get another random one? (It can come back later.)')) return;
  const c = shadowData.current;
  const btn = $('#shSkip');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    destroyPlayer();
    const r = await api('/shadow/skip', { id: c.id, tz: tzName() });
    shadowData = r;
    try { localStorage.removeItem(POS_KEY); } catch {}
    drawShadow();
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.textContent = 'Skip this video';
  }
}

/* ---------- controls ---------- */
function playPause() {
  if (!yt || !yt.player || !yt.player.playVideo) return;
  if (yt.playing) yt.player.pauseVideo(); else yt.player.playVideo();
}
function back5() {
  if (!yt || !yt.player || !yt.player.seekTo) return;
  if (yt.loop) stopLoop();
  yt.player.seekTo(Math.max(0, playerPos() - 5), true);
}

/* ---------- repeat one sentence (uses the transcript's start times) ---------- */
function timedLines() {
  return shTx && shadowData && shTx.id === shadowData.current.id ? shTx.lines : null;
}
function loopRange(i) {
  const L = timedLines();
  const l = L[i];
  const next = L.slice(i + 1).find((x) => x.t != null && x.t > l.t);
  // the AI's times are rounded to whole seconds, so leave a little room on both sides
  const start = Math.max(0, l.t - 0.4);
  const end = next ? next.t + 0.4 : l.t + Math.max(3, l.ja.length * 0.2);
  return { start, end };
}
/** The sentence you just heard: the one playing a moment ago. */
function lineAt(t) {
  const L = timedLines();
  let found = -1;
  L.forEach((l, i) => { if (l.t != null && l.t <= t) found = i; });
  if (found < 0) found = L.findIndex((l) => l.t != null);
  return found;
}
async function ensureTranscript() {
  const id = shadowData.current.id;
  if (timedLines()) return true;
  let t = null;
  try { t = await KDB.getKV('tx:' + id); } catch {}
  if (!t) {
    if (!confirm('Repeating a sentence uses the transcript to find where each sentence starts. Make the transcript now? (about 1 min, only once per video)')) return false;
    t = await fetchTranscript(id, false);
  }
  if (!t || shadowData.current.id !== id) return false;
  shTx = t;
  return true;
}
async function loopHere() {
  if (!yt || !yt.player || !yt.player.seekTo) return;
  const now = playerPos();
  if (!(await ensureTranscript())) return;
  startLoop(lineAt(Math.max(0, now - 1)));
}
function startLoop(i) {
  const L = timedLines();
  if (!L || !yt || !yt.player) return;
  // skip lines without a time
  while (i >= 0 && i < L.length && L[i].t == null) i += i > (yt.loop ? yt.loop.i : -1) ? 1 : -1;
  if (i < 0 || i >= L.length) return;
  clearInterval(yt.loopTimer);
  yt.loop = { i, ...loopRange(i), since: Date.now() };
  yt.player.seekTo(yt.loop.start, true);
  yt.player.playVideo();
  yt.loopTimer = setInterval(checkLoop, 150);
  $('#shLoopInfo').hidden = false;
  $('#shLoopText').textContent = L[i].ja;
  $('#loopPrev').disabled = !L.slice(0, i).some((l) => l.t != null);
  $('#loopNext').disabled = !L.slice(i + 1).some((l) => l.t != null);
  $('#shLoop').textContent = '■ Stop repeat';
  $('#shLoop').classList.add('on');
  markLoopLine(i);
}
function checkLoop() {
  const lp = yt && yt.loop;
  if (!lp) return;
  const p = playerPos();
  if (Date.now() - lp.since > 1500 && (p < lp.start - 2 || p > lp.end + 3)) return stopLoop(); // you jumped somewhere else
  if (p >= lp.end) { lp.since = Date.now(); yt.player.seekTo(lp.start, true); }
}
function stopLoop() {
  if (!yt || !yt.loop) return;
  clearInterval(yt.loopTimer);
  yt.loop = null;
  if ($('#shLoopInfo')) $('#shLoopInfo').hidden = true;
  const b = $('#shLoop');
  if (b) { b.textContent = '🔁 Repeat sentence'; b.classList.remove('on'); }
  markLoopLine(-1);
}
function markLoopLine(i) {
  $$('.tx-line.looping').forEach((el) => el.classList.remove('looping'));
  if (i >= 0) { const el = $(`.tx-line[data-i="${i}"]`); if (el) el.classList.add('looping'); }
}

/* ---------- watching in the YouTube app, then coming back ---------- */
function readAway() {
  try { return JSON.parse(localStorage.getItem(AWAY_KEY) || 'null'); } catch { return null; }
}
function clearAway() {
  try { localStorage.removeItem(AWAY_KEY); } catch {}
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ytopen]');
  if (!a || !shadowData || !shadowData.current) return;
  const c = shadowData.current;
  const pos = yt && yt.player && yt.player.getCurrentTime ? playerPos() : resumePos(c);
  a.href = ytWatchUrl(c.id, pos);
  stopLoop();
  if (yt && yt.player && yt.player.pauseVideo) yt.player.pauseVideo();
  try { localStorage.setItem(AWAY_KEY, JSON.stringify({ id: c.id, pos, t: Date.now() })); } catch {}
}, true);

/** Back from the YouTube app: ask how far you got, so tomorrow continues from there. */
function checkReturn() {
  const a = readAway();
  const c = shadowData && shadowData.current;
  if (!a || !c || !$('#shadowRoot') || $('#shReturnBox')) return;
  if (a.id !== c.id) return clearAway(); // that video is no longer today's
  if (Date.now() - a.t < 20000) return clearAway(); // came straight back without watching
  const m = Math.floor(a.pos / 60), sec = Math.floor(a.pos % 60);
  $('#shReturn').innerHTML = `
    <div class="panel sh-return" id="shReturnBox">
      <h2>Welcome back 👋</h2>
      <p class="muted small">How far did you get in the YouTube app? Kotoba will continue from there.</p>
      <div class="btn-row"><button class="btn primary" id="rtDone">✓ I finished it</button></div>
      <div class="rt-time">
        <span>I stopped at</span>
        <input id="rtMin" type="number" inputmode="numeric" min="0" value="${m}" aria-label="Minutes" />
        <span>:</span>
        <input id="rtSec" type="number" inputmode="numeric" min="0" max="59" value="${String(sec).padStart(2, '0')}" aria-label="Seconds" />
        <button class="btn" id="rtSave">Save</button>
      </div>
      <button class="link" id="rtClose">I didn't watch — close</button>
    </div>`;
  window.scrollTo(0, 0);
  const close = () => { clearAway(); $('#shReturn').innerHTML = ''; };
  $('#rtClose').onclick = close;
  $('#rtDone').onclick = async () => {
    try {
      const r = await api('/shadow/progress', { id: c.id, pos: c.dur || a.pos, tz: tzName(), finished: true });
      if (r.current) shadowData.current = r.current;
      close();
      drawShadowStatus();
      refreshShadowHistory();
      toast('お疲れさま！ Finished ✓ — a new video comes tomorrow');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#rtSave').onclick = async () => {
    const pos = Math.max(0, (+$('#rtMin').value || 0) * 60 + Math.min(59, +$('#rtSec').value || 0));
    if (c.dur && pos > c.dur) return toast(`The video is only ${fmtTime(c.dur)} long.`, 'err');
    try {
      const r = await api('/shadow/progress', { id: c.id, pos, tz: tzName() });
      if (r.current) shadowData.current = r.current;
      saveLocalPos(c.id, pos);
      if (yt) { yt.lastSentPos = pos; yt.lastSentAt = Date.now(); }
      if (yt && yt.player && yt.player.cueVideoById) yt.player.cueVideoById({ videoId: c.id, startSeconds: Math.max(0, pos - 3) });
      if ($('#shTime')) $('#shTime').textContent = `${fmtTime(pos)} / ${fmtTime(c.dur)}`;
      if ($('#shBar') && c.dur) $('#shBar').style.width = Math.min(100, (pos / c.dur) * 100) + '%';
      close();
      drawShadowStatus();
      toast(`Saved — continues from ${fmtTime(pos)}`);
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* PC keyboard: Space = play/pause, ← = back 5s, R = repeat sentence */
document.addEventListener('keydown', (e) => {
  if (route().name !== 'shadow' || !yt || !yt.player) return;
  if ($('dialog[open]') || /input|textarea|select/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.preventDefault(); playPause(); }
  else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') { e.preventDefault(); back5(); }
  else if (e.key.toLowerCase() === 'r') { e.preventDefault(); yt.loop ? stopLoop() : loopHere(); }
});

/* ---------- transcript ---------- */
async function toggleTranscript() {
  const box = $('#txBox');
  const btn = $('#shTxBtn');
  if (!box.hidden) {
    box.hidden = true;
    $('#shadowRoot').classList.remove('tx-open');
    btn.textContent = '文字 Show transcript';
    return;
  }
  const id = shadowData.current.id;
  let t = null;
  try { t = await KDB.getKV('tx:' + id); } catch {}
  if (!t) t = await fetchTranscript(id, false);
  if (!t || !$('#txBox') || shadowData.current.id !== id) return;
  shTx = t;
  drawTranscript(t);
}

async function fetchTranscript(id, redo) {
  const btn = $('#shTxBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${redo ? 'Rewriting' : 'Writing'} the transcript… (about 1 min, only the first time)`;
  try {
    const { transcript } = await api('/shadow/transcript', { id, redo });
    try { await KDB.setKV('tx:' + id, transcript); } catch {}
    return transcript;
  } catch (e) {
    toast(shadowOldWorker(e), 'err');
    return null;
  } finally {
    if ($('#shTxBtn')) { btn.disabled = false; btn.textContent = $('#txBox').hidden ? '文字 Show transcript' : '文字 Hide transcript'; }
  }
}

function drawTranscript(t) {
  const box = $('#txBox');
  const multi = new Set(t.lines.map((l) => l.sp).filter(Boolean)).size > 1;
  box.innerHTML = `
    <div class="read-tools">
      <button class="btn sm" id="txEn">Show all translations</button>
      <span class="muted small">Tap a time to jump there, 🔁 to repeat a sentence, or a line for its translation.</span>
    </div>
    <div class="tx-lines">${t.lines.map((l, i) => `
      <div class="tx-line" data-i="${i}">
        ${l.t != null ? `<button class="tx-t" data-t="${l.t}">${fmtTime(l.t)}</button>` : '<span></span>'}
        <div>
          <p class="jp" lang="ja">${multi && l.sp ? `<span class="tx-sp">${esc(l.sp)}</span>` : ''}${esc(l.ja)}</p>
          <p class="en-text tr" ${trAttr()}>${esc(l.tr)}</p>
        </div>
        ${l.t != null ? `<button class="tx-rep" data-rep="${i}" aria-label="Repeat this sentence">🔁</button>` : '<span></span>'}
      </div>`).join('')}</div>
    <p class="muted small tx-note">Written by AI from the audio, so it can have small mistakes. For YouTube's own captions (when the video has them), use the CC button in the player. <button class="link" id="txRedo">Rewrite it</button></p>`;
  box.hidden = false;
  $('#shadowRoot').classList.add('tx-open');
  $('#shTxBtn').textContent = '文字 Hide transcript';
  shTx = t;
  if (yt && yt.loop) markLoopLine(yt.loop.i);
  $$('.tx-line', box).forEach((el) => (el.onclick = (e) => {
    const rb = e.target.closest('[data-rep]');
    if (rb) { startLoop(+rb.dataset.rep); return; }
    const tb = e.target.closest('[data-t]');
    if (tb) {
      if (yt && yt.player && yt.player.seekTo) { stopLoop(); yt.player.seekTo(+tb.dataset.t, true); yt.player.playVideo(); }
      return;
    }
    el.classList.toggle('show-en');
  }));
  $('#txEn').onclick = () => {
    box.classList.toggle('en-hidden');
    $('#txEn').textContent = box.classList.contains('en-hidden') ? 'Show all translations' : 'Hide translations';
  };
  $('#txRedo').onclick = async () => {
    if (!confirm('Ask the AI to write the transcript again? (Uses some of your free Gemini quota.)')) return;
    const id = shadowData.current.id;
    const fresh = await fetchTranscript(id, true);
    if (fresh && $('#txBox') && shadowData.current.id === id) { stopLoop(); drawTranscript(fresh); }
  };
}

/* ---------- settings (on the Settings tab) ---------- */
function renderShadowSettings(box) {
  if (!box) return;
  if (!settings.workerUrl) {
    box.innerHTML = '<div class="stack"><span class="muted small">Connect the server above to use shadowing.</span></div>';
    return;
  }
  box.innerHTML = '<div class="stack"><span class="muted small"><span class="spinner"></span> Loading…</span></div>';
  const load = shadowCfgCache ? Promise.resolve({ settings: shadowCfgCache }) : api('/shadow?tz=' + encodeURIComponent(tzName()));
  load.then((r) => {
    const cfg = r.settings;
    shadowCfgCache = cfg;
    box.innerHTML = `
      <div class="stack">
        <label>YouTube playlist link<input id="shList" type="url" inputmode="url" autocomplete="off" placeholder="https://www.youtube.com/playlist?list=…" value="${cfg.playlist ? esc('https://www.youtube.com/playlist?list=' + cfg.playlist) : ''}" /></label>
        <span class="muted small">In YouTube, set the playlist to <b>Public</b> or <b>Unlisted</b> (Private can't be read). AI transcripts work for Public videos.</span>
      </div>
      <div class="row">
        <div class="lbl">Daily shadowing reminder<small>Tells you today's video. Skipped on days you've already practiced.</small></div>
        <label class="switch"><input type="checkbox" id="shOn" ${cfg.enabled ? 'checked' : ''} /><span></span></label>
      </div>
      <div class="row">
        <div class="lbl">Days</div>
        <div class="days" role="group" aria-label="Days">${DAY_LABELS.map(([d, l]) => `<button type="button" class="day ${cfg.days.includes(d) ? 'on' : ''}" data-day="${d}" aria-pressed="${cfg.days.includes(d)}">${l}</button>`).join('')}</div>
      </div>
      <div class="row">
        <div class="lbl">Time</div>
        <input type="time" id="shTimeIn" value="${esc(cfg.time)}" />
      </div>
      <div class="stack">
        <div class="btn-row"><button class="btn primary" id="shSave">Save</button></div>
        <span class="muted small">The notification goes to every device where the daily reminder is turned on. Videos you add to the playlist are picked up automatically.</span>
      </div>`;
    $$('.day', box).forEach((b) => (b.onclick = () => {
      b.classList.toggle('on');
      b.setAttribute('aria-pressed', b.classList.contains('on'));
    }));
    $('#shSave', box).onclick = async () => {
      const btn = $('#shSave', box);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Checking the playlist…';
      try {
        const res = await api('/shadow/settings', {
          playlist: $('#shList', box).value.trim(),
          enabled: $('#shOn', box).checked,
          days: $$('.day.on', box).map((b) => +b.dataset.day),
          time: $('#shTimeIn', box).value || '21:00',
          tz: tzName(),
        });
        shadowCfgCache = res.settings;
        shadowData = null;
        toast(res.settings.playlist
          ? `Saved — ${res.count} videos in your playlist${res.settings.enabled ? ` · ${shadowSchedule(res.settings)}` : ''}`
          : 'Saved');
      } catch (e) { toast(shadowOldWorker(e), 'err'); }
      btn.disabled = false;
      btn.textContent = 'Save';
    };
  }).catch((e) => {
    box.innerHTML = `<div class="stack"><span class="muted small">${esc(shadowOldWorker(e))}</span></div>`;
  });
}

/* Save your place when the app goes to the background or closes */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && route().name === 'shadow') setTimeout(checkReturn, 300);
  if (document.visibilityState === 'hidden' && yt && yt.player) {
    try { yt.player.pauseVideo && yt.player.pauseVideo(); } catch {}
    sendProgress({ beacon: true });
  }
});
window.addEventListener('pagehide', () => { if (yt && yt.player) sendProgress({ beacon: true }); });
