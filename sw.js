// Najpierw sieć (świeża wersja apki), a bez internetu — kopia z pamięci, żeby powtórki działały offline.
const CACHE = 'fr-clips-v4';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/srs.js', './js/gemini.js', './js/youtube.js',
  './vendor/ts-fsrs.mjs', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Udostępniony link przychodzi jako ./?text=… — z cache serwujemy samą stronę.
  const key = e.request.mode === 'navigate' ? './' : e.request;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key, { ignoreSearch: true })),
  );
});
