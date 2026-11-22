// Offline support. Pages, scripts and data are fetched fresh whenever the network answers and
// fall back to the last copy when it does not; fonts and icons are served from the cache.
const CACHE = 'wave-research-v3';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/palettes.js', 'assets/js/app.js', 'assets/js/util.js', 'assets/js/charts.js', 'assets/js/cards.js', 'assets/js/wave.js',
  'assets/js/similarity.js', 'assets/js/view-today.js', 'assets/js/view-papers.js', 'assets/js/view-funding.js',
  'assets/js/view-profile.js',
  'assets/fonts/inter-var.woff2',
  'assets/icons/favicon.svg', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
  'data/profile.json', 'data/papers.json', 'data/grants.json', 'data/citations.json', 'data/peers.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isStatic = (url) => /\.(woff2|png|jpg|jpeg|svg|webmanifest)$/i.test(url.pathname);
const passThrough = (url) => /\.ics$/i.test(url.pathname);        // calendar apps fetch this themselves

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const key = request.url.split('?')[0];          // "?t=…" from pull-to-refresh must not pile up copies
  try {
    const fresh = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    if (fresh && fresh.ok) cache.put(key, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(key) || (request.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || passThrough(url)) return;   // live searches go straight out
  event.respondWith(isStatic(url) ? cacheFirst(event.request) : networkFirst(event.request));
});
