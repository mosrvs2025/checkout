// Network-first app shell: always fresh when online, still opens with no signal
// (store back corners and freezer aisles are notorious dead zones).
const CACHE = 'exitpass-v5';
const SHELL = [
  './', 'index.html', 'css/app.css', 'icon.svg', 'icon-180.png', 'icon-192.png', 'manifest.webmanifest',
  'js/main.js', 'js/shared.js', 'js/shopper.js', 'js/scanner.js', 'js/products.js',
  'js/store.js', 'js/pos.js', 'js/pos-gateway.js', 'vendor/qrcode.js', 'vendor/barcode-detector.js', 'vendor/zxing_reader.wasm',
];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
