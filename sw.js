// ============================================================
// SSTfolio Service Worker
// ============================================================
// PWA 설치(모바일 "홈 화면에 추가"/"설치") 요건 충족을 위해서만 존재한다.
// 의도적으로 아무것도 캐싱하지 않는다 — 오프라인 지원 없음.
//
// 왜 이렇게 만들었나:
// 과거에 이 사이트와 무관한 Service Worker가 브라우저에 잘못 등록되면서
// 현재가 API 응답을 캐시해버려, 며칠 지난 가격을 계속 보여주는 사고가
// 있었다. SSTfolio는 실시간성이 생명인 서비스라 "똑똑한 캐싱"보다
// "아무것도 안 하는 것"이 훨씬 안전하다고 판단했다. 오프라인 지원이
// 필요해지면 그때 아주 신중하게(정적 자산만, API 응답은 절대 캐시하지
// 않는 방식으로) 재설계할 것.
// ============================================================

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 혹시 예전에 어떤 이유로든 생성된 캐시가 있다면 전부 삭제 (안전 우선)
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// fetch 리스너는 PWA 설치 요건 충족을 위해 등록하되, 캐싱 없이
// 항상 네트워크로 그대로 통과시킨다.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
