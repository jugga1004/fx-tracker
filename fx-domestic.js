(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 국내 고시환율(매매기준율) — GitHub Actions가 만들어둔 정적 JSON을 읽는다
  // ---------------------------------------------------------------------
  // GitHub Pages는 정적 호스팅이라 서버 코드를 못 돌린다. 그래서 요청 시점에
  // 한국수출입은행 API를 호출하는 대신, Actions가 매 영업일 미리 받아
  // data/rates.json에 커밋해두고 앱은 그 파일 하나만 읽는다.
  //
  //   - 인증키는 GitHub Secrets 안에만 있고 배포물에는 들어가지 않는다.
  //   - raw.githubusercontent.com / GitHub Pages 모두 CORS(*)를 열어줘서 그냥 읽힌다.
  //   - 같은 저장소에서 서빙되므로 기본값이 상대경로다 → 설정할 게 없다.
  //
  // ECB 시계열(fx-data.js)과 역할을 나눈다:
  //   ECB      → 장기 시계열이 필요한 곳 (차트, 백분위, 이동평균, 백테스트)
  //   매매기준율 → 금액이 걸린 곳 (현재 환율, 평가손익, 환전 비용, 면세점)
  // 두 소스는 0.4%가량 차이 나므로 차트에 섞으면 계단이 생긴다.

  var DEFAULT_URL = "./data/rates.json";
  var STORE_KEY = "fx.domestic";
  var STORE_VERSION = 2;
  var REQUEST_TIMEOUT_MS = 15000;

  var cache = null;

  function blank() {
    return { v: STORE_VERSION, byDate: {}, latestDate: null, updatedAt: null, source: null };
  }

  function load() {
    if (cache) return cache;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      cache = obj && obj.v === STORE_VERSION && obj.byDate ? obj : blank();
    } catch (err) {
      cache = blank();
    }
    return cache;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(load()));
    } catch (err) {
      /* 용량 초과 등 — 캐시가 없어도 이번 세션은 메모리로 돈다 */
    }
  }

  // ---------------------------------------------------------------------
  // 주소
  // ---------------------------------------------------------------------
  // 보통은 앱과 같은 저장소에서 서빙되므로 상대경로면 충분하다.
  // 앱을 다른 곳에 올렸을 때만 raw.githubusercontent.com 주소 등을 직접 넣는다.

  function configuredUrl() {
    return (global.Portfolio.getSettings().ratesUrl || "").trim();
  }

  function effectiveUrl() {
    return configuredUrl() || DEFAULT_URL;
  }

  function setUrl(url) {
    var clean = String(url || "").trim();
    global.Portfolio.setRatesUrl(clean);
    cache = blank();
    save();
    return clean;
  }

  // 실제로 쓸 수 있는 데이터가 있는지. 파일이 없거나(Actions가 아직 안 돌았거나)
  // file://로 열어 fetch가 막힌 경우 false가 되고 앱은 조용히 ECB로 돌아간다.
  function available() {
    var c = load();
    return !!c.latestDate && Object.keys(c.byDate).length > 0;
  }

  // ---------------------------------------------------------------------
  // 수집
  // ---------------------------------------------------------------------

  function fetchJson(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl
      ? setTimeout(function () {
          ctrl.abort();
        }, REQUEST_TIMEOUT_MS)
      : null;

    function done() {
      if (timer) clearTimeout(timer);
    }

    // 캐시 무시. Actions가 방금 커밋한 값을 봐야 하는데 브라우저가 옛 사본을
    // 물고 있으면 "어제 환율"이 계속 보인다.
    var bust = url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();

    return fetch(bust, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error("환율 파일을 받지 못했습니다 (HTTP " + res.status + ")");
        return res.json();
      })
      .then(
        function (body) {
          done();
          return body;
        },
        function (err) {
          done();
          if (err && err.name === "AbortError") throw new Error("응답이 너무 느립니다 (15초 초과).");
          if (err instanceof SyntaxError) throw new Error("환율 파일이 JSON 형식이 아닙니다.");
          throw err;
        }
      );
  }

  function adopt(body) {
    if (!body || typeof body !== "object" || !body.rates || typeof body.rates !== "object") {
      throw new Error("환율 파일 형식이 올바르지 않습니다 (rates 없음).");
    }
    var dates = Object.keys(body.rates).sort();
    if (!dates.length) {
      throw new Error("환율 파일이 비어 있습니다. GitHub Actions의 「환율 갱신」을 한 번 실행하세요.");
    }
    var c = blank();
    dates.forEach(function (iso) {
      var row = body.rates[iso];
      if (row && (typeof row.USD === "number" || typeof row.JPY === "number")) c.byDate[iso] = row;
    });
    c.latestDate = dates[dates.length - 1];
    c.updatedAt = body.updatedAt || null;
    c.source = body.source || null;
    cache = c;
    save();
    return { latest: c.latestDate, count: Object.keys(c.byDate).length, updatedAt: c.updatedAt };
  }

  // 앱 시작 시 호출. 실패해도 예외를 위로 던지지 않는다 — 국내 환율이 없다고
  // 앱 전체가 멈추면 안 되고, ECB만으로도 대부분의 화면은 정상이다.
  function sync() {
    // .then(onOk, onErr) 이 아니라 .then().catch() 여야 한다.
    // 같은 then의 두 번째 인자는 첫 번째 인자가 던진 예외를 잡지 못해서,
    // adopt()가 형식 오류로 던지면 그대로 unhandled rejection이 된다.
    return fetchJson(effectiveUrl())
      .then(function (body) {
        return adopt(body);
      })
      .catch(function (err) {
        return { error: err.message };
      });
  }

  // 주소를 바꿀 때만 쓰는 검증용. 이쪽은 실패를 그대로 던진다.
  function check(url) {
    var clean = String(url || "").trim();
    if (!clean) throw new Error("주소를 입력해주세요.");
    return fetchJson(clean).then(function (body) {
      var res = adopt(body);
      global.Portfolio.setRatesUrl(clean);
      return res;
    });
  }

  // ---------------------------------------------------------------------
  // 읽기
  // ---------------------------------------------------------------------

  // 해당 날짜의 값. 없으면 null (호출부가 ECB로 넘어가면 된다).
  function get(code, iso) {
    var row = load().byDate[iso];
    return row && typeof row[code] === "number" ? row[code] : null;
  }

  // { "YYYY-MM-DD": rate } — 통화 하나에 대한 전체 데이터
  function all(code) {
    var out = {};
    var byDate = load().byDate;
    Object.keys(byDate).forEach(function (iso) {
      var v = byDate[iso][code];
      if (typeof v === "number") out[iso] = v;
    });
    return out;
  }

  function latest(code) {
    var c = load();
    if (!c.latestDate) return null;
    var v = get(code, c.latestDate);
    return v === null ? null : { date: c.latestDate, rate: v };
  }

  function latestDate() {
    return load().latestDate;
  }

  function updatedAt() {
    return load().updatedAt;
  }

  function count() {
    return Object.keys(load().byDate).length;
  }

  function clear() {
    cache = blank();
    save();
  }

  global.FxDomestic = {
    DEFAULT_URL: DEFAULT_URL,
    configuredUrl: configuredUrl,
    effectiveUrl: effectiveUrl,
    setUrl: setUrl,
    available: available,
    sync: sync,
    check: check,
    get: get,
    all: all,
    latest: latest,
    latestDate: latestDate,
    updatedAt: updatedAt,
    count: count,
    clear: clear,
    SOURCE_LABEL: "한국수출입은행 매매기준율",
  };
})(window);
