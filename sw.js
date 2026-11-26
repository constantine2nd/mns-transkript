// Offline app shell (the vendor/ files for transcription are cached when first used): files come from the network when it answers and from the cache when offline, so a page
// never runs a mix of versions. The cache is named after version.js: bump APP_VERSION there to replace it.
importScripts('version.js', 'brand.js');
// Per brand: two brands on one origin keep separate caches and never delete each other's.
const PREFIX = `${self.BRAND.storage}-`;
const VERSION = `${PREFIX}${self.APP_VERSION}`;
const SHELL = [
  './', 'index.html', 'version.js', 'theme.js', 'install.js', 'style.css', 'app.js', 'i18n.js', 'zip.js', 'bundle.js', 'ai.js', 'text.js', 'store.js', 'history.js',
  'speech.js', 'asr.js', 'asr-model.js', 'asr-worker.js', 'opfs.js', 'gemini.js', 'docx.js',
  'brand.js', 'brand.css', 'manifest.webmanifest', self.BRAND.logo, ...self.BRAND.icons,
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : req;
    // Network first, the cache only when offline. Serving the cache first and refreshing behind it mixed old and
    // new modules after a release (25 Nov 2026: editing stopped working until the cache caught up).
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') e.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch {
      return (await cache.match(key, { ignoreSearch: true })) || new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
