/* Spaced repetition + merge logic — shared by the app and the service worker.
 *
 * Each card has two independent review states, one per direction:
 *   card.srs.jp  (Japanese → English)
 *   card.srs.en  (English → Japanese)
 * A state is null until the card is first studied in that direction.
 * State: { intro, due, ivl, ease, reps, lapses, t }
 *   intro/due are "day numbers" (days since 1970 in local time, day rolls over at 4am)
 *   t is the timestamp of the last review (used when syncing devices)
 */
(function (g) {
  const DAY = 86400000;
  const ROLLOVER_HOURS = 4; // studying at 1am still counts as "yesterday", like Anki
  const DIRS = ['jp', 'en'];

  function today(ts = Date.now()) {
    const d = new Date(ts - ROLLOVER_HOURS * 3600000);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
  }

  function eligible(card, dir) {
    if (!card || card.deleted || !card.word) return false;
    return dir === 'jp' ? true : !!(card.meaning || card.note);
  }

  function stateOf(card, dir) {
    return (card.srs && card.srs[dir]) || null;
  }

  /** Today's plan for one direction.
   *  todaySet  = the day's fixed words: those started today, topped up from the book order to `perDay`.
   *              It stays the same all day (it only grows if you raise "words per day" in Settings).
   *  remaining = words from todaySet not finished yet (never answered, or last answered "Again").
   *  reviews   = older words (started on an earlier day) whose review is due today. */
  function todayPlan(cards, dir, perDay, T = today()) {
    const started = [], fresh = [], reviews = [];
    const seen = new Set(); // never count the same word twice
    for (const c of cards) {
      if (!eligible(c, dir)) continue;
      const key = c.word.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const s = stateOf(c, dir);
      if (!s) fresh.push(c);
      else if (s.intro === T) started.push(c);
      else if (s.due <= T) reviews.push(c);
    }
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
    started.sort(byOrder);
    fresh.sort(byOrder);
    reviews.sort((a, b) => stateOf(a, dir).due - stateOf(b, dir).due);
    const todaySet = [...started, ...fresh.slice(0, Math.max(0, perDay - started.length))];
    const remaining = todaySet.filter((c) => { const s = stateOf(c, dir); return !s || s.due <= T; });
    return { todaySet, remaining, reviews, newLeft: fresh.length };
  }

  /** Numbers for the home screen and the reminder notification. */
  function counts(cards, dir, perDay, T = today()) {
    const p = todayPlan(cards, dir, perDay, T);
    return {
      total: p.todaySet.length,
      left: p.remaining.length,
      done: p.todaySet.length - p.remaining.length,
      due: p.reviews.length,
      newLeft: p.newLeft,
    };
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** The cards for a session. If today's words aren't finished: reviews + remaining words.
   *  If everything is finished: practice mode — today's words again in random order (doesn't change the schedule). */
  function buildQueue(cards, dir, perDay, T = today()) {
    const p = todayPlan(cards, dir, perDay, T);
    const study = [...p.reviews, ...p.remaining];
    if (study.length) return { mode: 'study', ids: study.map((c) => c.id) };
    return { mode: 'practice', ids: shuffle(p.todaySet).map((c) => c.id) };
  }

  /** Next interval (days) for each answer button. */
  function nextIntervals(s) {
    if (!s || s.reps === 0) return { again: 0, hard: 1, good: 2, easy: 4 };
    const hard = Math.max(s.ivl + 1, Math.round(s.ivl * 1.2));
    const good = Math.max(hard + 1, Math.round(s.ivl * s.ease));
    const easy = Math.max(good + 1, Math.round(s.ivl * s.ease * 1.3));
    return { again: 0, hard, good, easy };
  }

  /** Apply an answer. grade: 'again' | 'hard' | 'good' | 'easy'. Returns a new state. */
  function grade(s, answer, T = today(), now = Date.now()) {
    const n = s ? { ...s } : { intro: T, due: T, ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
    if (n.intro == null) n.intro = T;
    n.t = now;
    if (answer === 'again') {
      if (n.reps > 0) n.lapses++;
      n.reps = 0;
      n.ivl = 0;
      n.ease = Math.max(1.3, +(n.ease - 0.2).toFixed(2));
      n.due = T; // stays due today; the session shows it again
      return n;
    }
    let ivl = nextIntervals(n)[answer];
    if (answer === 'hard') n.ease = Math.max(1.3, +(n.ease - 0.15).toFixed(2));
    if (answer === 'easy') n.ease = +(n.ease + 0.15).toFixed(2);
    if (ivl >= 7) ivl += Math.round((Math.random() * 2 - 1) * ivl * 0.05); // small fuzz so cards don't clump
    n.ivl = ivl;
    n.reps++;
    n.due = T + ivl;
    return n;
  }

  function formatInterval(days) {
    if (days <= 0) return 'now';
    if (days < 30) return days + 'd';
    if (days < 365) return (days / 30).toFixed(days < 60 ? 1 : 0) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  /** Merge two copies of the same card (from two devices).
   *  Content: newest updatedAt wins. Each direction's review state: newest review wins. */
  function mergeCard(a, b) {
    if (!a) return b;
    if (!b) return a;
    const base = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
    const out = { ...base, srs: { ...(base.srs || {}) } };
    for (const d of DIRS) {
      const sa = a.srs && a.srs[d];
      const sb = b.srs && b.srs[d];
      out.srs[d] = !sa ? sb || null : !sb ? sa : (sb.t || 0) > (sa.t || 0) ? sb : sa;
    }
    return out;
  }

  g.SRS = { DIRS, today, eligible, stateOf, todayPlan, counts, buildQueue, nextIntervals, grade, formatInterval, mergeCard };
})(self);
