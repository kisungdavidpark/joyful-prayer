// Service Worker kill-switch
// 기존 iOS PWA 캐시/구버전 고착 문제 해결을 위해 SW를 스스로 해제한다.
const CACHE_NAME = 'joyful-prayer-kill-sw-v9';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // 모든 캐시 삭제
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));

      // 모든 열린 탭/창 강제 새로고침 (새 배포 후 블랙 스크린 방지)
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => client.navigate(client.url));

      // 현재 SW 등록 해제
      await self.registration.unregister();
    })()
  );
});

self.addEventListener('fetch', event => {
  // 더 이상 캐시를 사용하지 않고 항상 네트워크로 통과시킨다.
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request, { cache: 'no-store' }));
});
