/* Service worker: offline support + daily reminder notifications */
importScripts('db.js', 'srs.js');

const CACHE = 'kotoba-v4';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'srs.js', 'manifest.webmanifest', 'starter-deck.json',
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

async function reminderText() {
  try {
    const cards = (await KDB.all()).filter((c) => !c.deleted);
    const perDay = (await KDB.getKV('newPerDay')) || 10;
    const jp = SRS.counts(cards, 'jp', perDay);
    const en = SRS.counts(cards, 'en', perDay);
    const total = jp.left + jp.due + en.left + en.due;
    if (!cards.length) return 'Add some words to start studying.';
    if (!total) return 'Nothing due today — great job! Add a few new words from your book?';
    const parts = [];
    if (jp.left + jp.due) parts.push(`日→英: ${jp.left + jp.due} cards`);
    if (en.left + en.due) parts.push(`英→日: ${en.left + en.due} cards`);
    return parts.join(' · ');
  } catch {
    return 'Time for your daily Japanese words.';
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = '言葉 — time to study';
    let body = await reminderText();
    try {
      const data = event.data && event.data.json();
      if (data && data.title) title = data.title;
      if (data && data.body) body = data.body;
    } catch { /* push without payload */ }
    await self.registration.showNotification(title, {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      tag: 'kotoba-daily',
      renotify: true,
      data: { url: './' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
