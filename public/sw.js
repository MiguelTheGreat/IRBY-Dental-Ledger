// Service worker: caches the app shell so the UI loads instantly on clinic
// tablets. API responses (patient data) are never cached.
const CACHE = 'irby-shell-v1';
const SHELL = [
  '/', '/index.html', '/print.html', '/css/app.css', '/css/fonts.css', '/css/print.css', '/manifest.webmanifest', '/icons/icon.svg',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/state.js', '/js/camera.js', '/js/teeth.js', '/js/symbols.js', '/js/money.js', '/js/print.js',
  '/js/views/dashboard.js', '/js/views/directory.js', '/js/views/intake.js', '/js/views/chart.js', '/js/views/ledger.js', '/js/views/security.js',
  '/fonts/plus-jakarta-sans-latin-500-normal.woff2', '/fonts/plus-jakarta-sans-latin-600-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-700-normal.woff2', '/fonts/plus-jakarta-sans-latin-800-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first (so updates apply immediately), cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
