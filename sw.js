/* エイル PWA service worker — アプリの見た目だけをキャッシュ。GASへの通信はキャッシュしない */
const VERSION = 'eile-v0.9.0';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json',
  './img/eile_idle.png', './img/eile_listening.png', './img/eile_thinking.png', './img/eile_done.png', './img/eile_warn.png',
  './img/room_study.png', // v0.8.0 エイルの部屋の背景。app.js の ROOM_IMG と同じ文字列にする（?v= は付けない）
  './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  // v0.8.0：事前保存はブラウザの HTTP キャッシュを使わず、必ずサーバーから取り直す（GitHub Pages の10分キャッシュで古いファイルが保存されるのを防ぐ）
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
