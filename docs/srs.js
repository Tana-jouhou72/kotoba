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

  /** Counts for the home screen. newLimit = how many new cards may be introduced today. */
  function counts(cards, dir, newLimit, T = today()) {
    let due = 0, newAvail = 0, introToday = 0;
    for (const c of cards) {
      if (!eligible(c, dir)) continue;
      const s = stateOf(c, dir);
      if (!s) { newAvail++; continue; }
      if (s.intro === T) introToday++;
      if (s.due <= T) due++;
    }
    const newToday = Math.max(0, Math.min(newAvail, newLimit - introToday));
    return { due, newToday, newAvail, introToday };
  }

  /** Build today's study queue: due reviews first (oldest first), then new cards in book order. */
  function buildQueue(cards, dir, newLimit, T = today()) {
    const reviews = [], fresh = [];
    const seen = new Set(); // never put the same word in one session twice
    for (const c of cards) {
      if (!eligible(c, dir)) continue;
      const key = c.word.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const s = stateOf(c, dir);
      if (!s) fresh.push(c);
      else if (s.due <= T) reviews.push(c);
    }
    reviews.sort((a, b) => stateOf(a, dir).due - stateOf(b, dir).due || Math.random() - 0.5);
    fresh.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const { newToday } = counts(cards, dir, newLimit, T);
    return {
      ids: [...reviews.map((c) => c.id), ...fresh.slice(0, newToday).map((c) => c.id)],
      reviewCount: reviews.length,
      newCount: Math.min(newToday, fresh.length),
    };
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

  g.SRS = { DIRS, today, eligible, stateOf, counts, buildQueue, nextIntervals, grade, formatInterval, mergeCard };
})(self);
