/* エイル PWA service worker — アプリの見た目だけをキャッシュ。GASへの通信はキャッシュしない */
const VERSION = 'eile-v0.3.0';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json',
  './img/eile_idle.png', './img/eile_listening.png', './img/eile_thinking.png', './img/eile_done.png', './img/eile_warn.png',
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // GAS・フォント等はそのまま通す
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => { if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
