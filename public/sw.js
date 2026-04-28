const CACHE_NAME = 'joyful-prayer-network-only-v7';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // 앱 업데이트 반영을 최우선으로 하기 위해 캐시 저장 없이 항상 네트워크에서 새로 가져온다.
  // cache: 'reload'는 브라우저 HTTP 캐시까지 우회하도록 요청한다.
  const freshRequest = new Request(event.request, { cache: 'reload' });
  event.respondWith(fetch(freshRequest));
});