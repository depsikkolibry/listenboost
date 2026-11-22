const CACHE = 'sluh-v4-vosk';
const ASSETS = [
  './', './index.html', './styles.css', './app.js',
  './processor.js', './manifest.json', './icon.svg',
  // Модель Vosk кэшируется автоматически при первом запросе
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});

// ХИТРОСТЬ: Добавляем заголовки COOP/COEP, чтобы Vosk (WebAssembly) мог использовать SharedArrayBuffer
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((response) => {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
        newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
