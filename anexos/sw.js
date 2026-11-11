/* Separador de Anexos — trabajo sin conexión. La versión cambia en cada publicación. */
const VERSION = '09d7ab4b0744';
const CACHE = 'anexos-' + VERSION;
const SHELL = [
 "./",
 "index.html",
 "manifest.webmanifest",
 "icons/apple-touch-icon.png",
 "icons/favicon-64.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "lib/acceso.js",
 "lib/jszip.min.js",
 "lib/local-db.js",
 "lib/ocr-worker.js",
 "lib/pdf-lib.min.js",
 "lib/pdf.min.js",
 "lib/pdf.worker.min.js",
 "lib/spa-traineddata.txt",
 "lib/tesseract-core-lstm.wasm.js",
 "lib/tesseract-core-simd-lstm.wasm.js",
 "lib/wasm/jbig2.wasm",
 "lib/wasm/jbig2_nowasm_fallback.js",
 "lib/wasm/openjpeg.wasm",
 "lib/wasm/openjpeg_nowasm_fallback.js",
 "lib/wasm/qcms_bg.wasm"
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('anexos-') && k !== CACHE && k !== 'anexos-ext').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* Página: primero la red (para recibir mejoras), si no hay conexión la guardada. */
  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return r; })
      .catch(() => caches.match('./').then(r => r || caches.match('index.html'))));
    return;
  }
  /* Archivos propios: de la caché. */
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }
  /* Librerías de Firebase y fuentes: la guardada al tiro y se renueva por detrás. Nada de datos de Firebase. */
  if (url.hostname === 'www.gstatic.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open('anexos-ext').then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
