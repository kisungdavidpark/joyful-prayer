const CACHE_NAME = 'joyful-prayer-v4';
const BASE = self.registration.scope;

const ASSETS = [
  BASE,
  new URL('index.html', BASE).toString(),
  new URL('icons/icon-192.png', BASE).toString(),
  new URL('icons/icon-512.png', BASE).toString(),
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// 푸시 알림 이벤트 리스너 추가
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const options = {
    body: data.body || '기도 시간 알림',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: data.data || {}
  };
  e.waitUntil(
    self.registration.showNotification(data.title || 'Joyful 중보기도', options)
  );
});

// 알림 클릭 이벤트 리스너 추가
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow(self.registration.scope)
  );
});