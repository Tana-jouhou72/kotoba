/* Service worker: offline support + daily reminder notifications */
importScripts('db.js', 'srs.js');

const CACHE = 'kotoba-v14';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'read.js', 'shadow.js', 'db.js', 'srs.js', 'manifest.webmanifest', 'starter-deck.json', 'starter-deck-km.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isFont) return; // API calls go straight to the network

  if (isFont) {
    // cache-first: fonts never change
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // App files: network first (always fresh when online), cache when offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});

/** The daily word reminder: its text, and the card session it opens (日→英 first, then 英→日). */
async function reminder() {
  try {
    const cards = (await KDB.all()).filter((c) => !c.deleted);
    const perDay = (await KDB.getKV('newPerDay')) || 10;
    const jp = SRS.counts(cards, 'jp', perDay);
    const en = SRS.counts(cards, 'en', perDay);
    const total = jp.left + jp.due + en.left + en.due;
    if (!cards.length) return { body: 'Add some words to start studying.', url: './#/' };
    if (!total) return { body: 'Nothing due today — great job! Add a few new words from your book?', url: './#/' };
    const parts = [];
    if (jp.left + jp.due) parts.push(`日→英: ${jp.left + jp.due} cards`);
    if (en.left + en.due) parts.push(`英→日: ${en.left + en.due} cards`);
    return { body: parts.join(' · '), url: jp.left + jp.due ? './#/study/jp' : './#/study/en' };
  } catch {
    return { body: 'Time for your daily Japanese words.', url: './#/study/jp' };
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = null;
    try { data = event.data && event.data.json(); } catch { /* push without payload */ }
    const title = (data && data.title) || '言葉 — time to study';
    const daily = data && data.body ? null : await reminder();
    const body = (data && data.body) || daily.body;
    await self.registration.showNotification(title, {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      tag: (data && data.tag) || 'kotoba-daily',
      renotify: true,
      data: { url: (data && data.url) || (daily && daily.url) || './' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
    // Remember where to go. Android often freezes or reloads an app that is in the background, and then a message
    // sent to it is lost; the app reads this note when it opens or comes back, so it still lands on the right tab.
    try { await KDB.setKV('pendingOpen', { url: target, t: Date.now() }); } catch {}
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        try { await w.focus(); } catch {}
        try { w.postMessage({ type: 'open', url: target }); } catch {}
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
