const CACHE_NAME = 'joyful-prayer-dev-v6';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // 개발/운영 모두 최신 배포본을 우선 사용하기 위해 캐시 저장 없이 네트워크만 사용
  event.respondWith(fetch(event.request));
});