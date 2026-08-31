// 앱 셸(정적 파일)만 오프라인 캐싱한다. 환율 API(api.frankfurter.dev)는 캐싱하지 않고
// 그대로 네트워크로 흘려보낸다 — 최신 데이터 관리는 fx-data.js의 localStorage 캐시가
// 담당하고 있어서, 여기서 또 캐싱하면 두 겹이 되어 어느 쪽이 최신인지 알기 어려워진다.
//
// 배포할 때마다 CACHE_NAME을 바꿔야 새 버전이 적용된다(예: v1 -> v2).
//
// 참고: 서비스워커는 https 또는 localhost에서만 등록된다. index.html을 file://로 열면
// 등록이 안 되지만, app.js가 그 경우를 건너뛰도록 처리해두어서 앱 자체는 정상 동작한다.
var CACHE_NAME = "fx-tracker-v3";
var APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./fx-data.js",
  "./fx-stats.js",
  "./fx-models.js",
  "./portfolio.js",
  "./fx-domestic.js",
  "./chart.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(APP_SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // 다른 오리진(환율 API)은 캐시 없이 그대로 통과.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  // 네트워크 우선. 캐시는 오프라인일 때만 쓴다.
  //
  // 캐시 우선으로 짜면 배포를 해도 사용자가 옛 버전에 갇힌다 — 캐시된 응답을 즉시
  // 돌려주고 새 파일은 다음 방문에나 반영되는데, 그 사이 index.html은 새 버전인데
  // app.js는 옛 버전인 식으로 섞이기도 한다. 첫 로딩이 조금 느려지는 대신
  // "고쳤는데 사용자 화면은 그대로"인 상황을 없애는 쪽을 택한다.
  // cache: "no-cache" 는 "캐시를 쓰지 말라"가 아니라 "매번 서버에 물어보라"는 뜻이다.
  // 이게 없으면 fetch()가 브라우저 HTTP 캐시를 그대로 타는데, GitHub Pages가
  // max-age=600으로 내려주기 때문에 배포 후 10분간 옛 파일이 계속 나온다.
  // (조건부 요청이라 안 바뀌었으면 304로 끝나서 트래픽 낭비도 거의 없다)
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then(function (response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function () {
        // 네트워크가 안 될 때만 캐시로 떨어진다.
        return caches.match(event.request);
      })
  );
});
