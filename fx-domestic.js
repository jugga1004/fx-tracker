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
        // 이 함수는 환율 파일·Worker 여러 경로에 쓰인다. "환율 파일"이라고 못 박으면
        // 상품 조회가 404일 때 엉뚱한 안내가 나간다.
        if (res.status === 404) {
          throw new Error(
            "요청한 경로가 없습니다 (404). Worker에 최신 코드가 배포됐는지 확인해주세요 — " +
              "상품 가져오기는 worker/fx-live.js의 새 버전이 필요합니다."
          );
        }
        if (!res.ok) throw new Error("응답을 받지 못했습니다 (HTTP " + res.status + ")");
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
          if (err instanceof SyntaxError) throw new Error("응답이 JSON 형식이 아닙니다.");
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
      })
      .then(function (res) {
        // rates.json은 GitHub Actions 예약에 의존하는데 그 예약이 통째로 건너뛰는 일이
        // 잦다. 그러면 정작 필요한 당일 값이 없어 '내일 적용환율'을 못 보여준다.
        // 그래서 파일이 오늘을 못 따라왔을 때만 Worker에 직접 물어본다.
        return topUpFromLive().then(function (live) {
          if (!live) return res;
          if (res && res.error) return { latest: latestDate(), count: count(), live: true };
          res.live = true;
          res.latest = latestDate();
          res.count = count();
          return res;
        });
      });
  }

  // ---------------------------------------------------------------------
  // 실시간 보충 (Cloudflare Worker)
  // ---------------------------------------------------------------------
  // 예약 갱신이 밀려도 앱을 여는 순간 오늘 값을 채우기 위한 경로다.
  // 파일이 이미 최신이면 아예 호출하지 않는다 — 수출입은행 API는 하루 1,000회 제한이 있다.

  var LIVE_RETRY_MS = 10 * 60 * 1000; // 실패했더라도 10분 안에는 다시 조르지 않는다
  var lastLiveTry = 0;

  function liveUrl() {
    return (global.Portfolio.getSettings().liveUrl || "").trim();
  }

  function liveEnabled() {
    return !!liveUrl();
  }

  // 보충이 필요한 상황인지. 오늘 자가 이미 있으면 볼 필요가 없다.
  function needsLive() {
    if (!liveEnabled()) return false;
    if (latestDate() === global.FxData.todayISO()) return false;
    if (Date.now() - lastLiveTry < LIVE_RETRY_MS) return false;
    // 고시는 11시경이라 그전에 물어봐야 빈손이다. 주말도 마찬가지.
    var now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return false;
    return now.getHours() >= 11;
  }

  // 성공하면 true. 실패는 조용히 삼킨다 — 파일 데이터만으로도 앱은 돌아가야 한다.
  // force=true 면 시간·중복 조건을 무시한다(설정 화면의 「지금 받기」용).
  function topUpFromLive(force) {
    if (!liveEnabled()) return Promise.resolve(false);
    if (!force && !needsLive()) return Promise.resolve(false);
    lastLiveTry = Date.now();
    return fetchJson(liveUrl() + "/v1/recent?days=5")
      .then(function (body) {
        if (!body || body.ok === false || !body.rates) throw new Error((body && body.error) || "형식 오류");
        var c = load();
        var added = 0;
        Object.keys(body.rates).forEach(function (iso) {
          var row = body.rates[iso];
          if (!row || (typeof row.USD !== "number" && typeof row.JPY !== "number")) return;
          if (!c.byDate[iso]) added++;
          c.byDate[iso] = row;
        });
        var all = Object.keys(c.byDate).sort();
        c.latestDate = all[all.length - 1];
        save();
        return added > 0;
      })
      .catch(function () {
        return false;
      });
  }

  // 설정 화면에서 주소를 확인할 때 쓴다. 실패를 그대로 던진다.
  function checkLive(url) {
    var clean = String(url || "").trim().replace(/\/+$/, "");
    if (!clean) throw new Error("주소를 입력해주세요.");
    if (!/^https:\/\//i.test(clean)) throw new Error("https:// 로 시작하는 주소여야 합니다.");
    return fetchJson(clean + "/v1/health").then(function (body) {
      if (!body || body.ok === false) throw new Error((body && body.error) || "응답 오류");
      if (!body.keyConfigured) {
        throw new Error("Worker는 살아 있지만 인증키(KOREAEXIM_KEY)가 없습니다. Settings → Variables and Secrets 에서 Secret으로 등록하세요.");
      }
      global.Portfolio.setLiveUrl(clean);
      lastLiveTry = 0; // 방금 붙였으니 바로 한 번 받아온다
      return body;
    });
  }

  // 「지금 받기」 버튼용. 시간·중복 조건을 무시하고 강제로 한 번 조회한다.
  function forceLive() {
    return topUpFromLive(true);
  }

  // ---------------------------------------------------------------------
  // 실시간 환율 (화면 상단 '현재 환율' 전용)
  // ---------------------------------------------------------------------
  // 은행 고시환율은 하루 수십 회 바뀌고 모바일 환전도 그 값으로 체결된다.
  // 매매기준율(하루 1회)만 보여주면 "지금 환율"과 실제 거래가 어긋난다.
  //
  // 다만 이 값은 상단 표시에만 쓴다. 차트·백분위·면세점 적용환율은 확정된
  // 매매기준율을 그대로 쓴다 — 하루에 여러 번 바뀌는 값으로는 일별 시계열을
  // 만들 수 없고, 면세점 규칙 자체가 '전일 고시 매매기준율' 기준이다.
  //
  // 메모리에만 둔다. 새로고침하면 다시 받는 게 맞는 성격의 값이다.
  var liveRates = null;
  var LIVE_RATES_TTL_MS = 2 * 60 * 1000;
  var liveRatesAt = 0;

  function liveRate(code) {
    return liveRates && liveRates[code] ? liveRates[code] : null;
  }

  // 실패해도 조용히 넘어간다 — 상단이 매매기준율로 표시될 뿐이다.
  function refreshLiveRates(force) {
    if (!liveEnabled()) return Promise.resolve(false);
    if (!force && liveRates && Date.now() - liveRatesAt < LIVE_RATES_TTL_MS) return Promise.resolve(false);
    return fetchJson(liveUrl() + "/v1/live")
      .then(function (body) {
        if (!body || body.ok === false || !body.rates) throw new Error("형식 오류");
        liveRates = body.rates;
        liveRatesAt = Date.now();
        liveSource = body.source || null;
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  var liveSource = null;
  function liveRatesSource() {
    return liveSource;
  }

  // 면세점 상품 페이지에서 상품명·달러가를 가져온다. 브라우저는 다른 도메인을
  // 못 읽으므로(CORS) Worker가 대신 읽어준다. 실패는 그대로 던져 화면에 사유를 보여준다.
  function fetchProduct(url) {
    if (!liveEnabled()) throw new Error("실시간 조회 Worker가 연결돼 있어야 상품 정보를 가져올 수 있습니다.");
    var clean = String(url || "").trim();
    if (!clean) throw new Error("상품 링크를 입력해주세요.");
    return fetchJson(liveUrl() + "/v1/product?url=" + encodeURIComponent(clean)).then(function (body) {
      if (!body || body.ok === false) throw new Error((body && body.error) || "상품 정보를 가져오지 못했습니다.");
      return body;
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

  function sortedDates() {
    return Object.keys(load().byDate).sort();
  }

  // ---------------------------------------------------------------------
  // 면세점 적용환율
  // ---------------------------------------------------------------------
  // 면세점은 '전일 고시 매매기준율'을 적용한다. 그래서 어떤 날짜 D의 적용환율은
  // D보다 앞선 가장 최근 고시분이다. 주말·공휴일에는 고시가 없으므로 직전 영업일
  // 값이 그대로 이어진다 (예: 토·일·월 모두 금요일 고시분).
  //
  // 반환: { appliedDate, quoteDate, rate } — 데이터가 모자라면 null
  function appliedOn(code, iso) {
    var dates = sortedDates();
    for (var i = dates.length - 1; i >= 0; i--) {
      if (dates[i] >= iso) continue; // 당일 고시는 '내일' 적용분이라 여기서 제외
      var v = get(code, dates[i]);
      if (v !== null) return { appliedDate: iso, quoteDate: dates[i], rate: v };
    }
    return null;
  }

  // 오늘을 포함한 최근 days일치 적용환율 (과거 → 오늘 순).
  function appliedSeries(code, days) {
    var out = [];
    var today = global.FxData.todayISO();
    for (var i = days - 1; i >= 0; i--) {
      var r = appliedOn(code, global.FxData.shiftDays(today, -i));
      if (r) out.push(r);
    }
    return out;
  }

  // 내일 적용분은 '오늘 고시'가 나와야 확정된다(영업일 11시 전후).
  // 아직 안 나왔으면 null — 이걸 오늘 값으로 때우면 안 된다.
  function appliedTomorrow(code) {
    var today = global.FxData.todayISO();
    if (latestDate() !== today) return null;
    var v = get(code, today);
    if (v === null) return null;
    return { appliedDate: global.FxData.shiftDays(today, 1), quoteDate: today, rate: v };
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
    appliedOn: appliedOn,
    appliedSeries: appliedSeries,
    appliedTomorrow: appliedTomorrow,
    liveUrl: liveUrl,
    liveEnabled: liveEnabled,
    checkLive: checkLive,
    forceLive: forceLive,
    fetchProduct: fetchProduct,
    liveRate: liveRate,
    refreshLiveRates: refreshLiveRates,
    liveRatesSource: liveRatesSource,
    count: count,
    clear: clear,
    SOURCE_LABEL: "한국수출입은행 매매기준율",
  };
})(window);
