(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 환율 데이터 계층
  // ---------------------------------------------------------------------
  // 화면/계산 로직은 정규화된 { date, rate } 배열만 다루고, API별 스키마 차이와
  // 단위 관례(엔화 100엔 기준 등)는 전부 이 파일 안에 가둔다.
  // (다이소 앱의 BRANDS 어댑터와 같은 구조 — 소스를 갈아끼워도 위층은 안 바뀐다.)
  //
  // 2026-08-31 소스 조사 결과:
  //  - Frankfurter(ECB 공시 기준)만 브라우저에서 직접 호출 가능. 무료·키 불필요·CORS 허용.
  //  - 한국수출입은행 API는 인증키가 필요하고 CORS를 안 열어줌 → 브라우저에서 불가.
  //  - 네이버/하나은행 고시환율 페이지는 CORS 차단 → 서버 프록시가 있어야 함.
  //  나중에 서버를 두게 되면 SOURCES에 같은 모양의 어댑터를 추가하면 된다.
  //
  // ※ ECB 기준환율은 서울외국환중개 매매기준율과 다르다. 참고용이지 결제용이 아니다.
  // ※ 유럽시간 16:00경 공시라 한국시간으로는 밤에야 당일 값이 들어온다.

  var API_BASE = "https://api.frankfurter.dev/v1";
  var HISTORY_YEARS = 15; // 백분위 계산엔 5년이면 충분하지만 여유를 둔다
  var CACHE_PREFIX = "fx.series.";
  var CACHE_VERSION = 1;

  // unit: 한국에서 쓰는 표기 단위. JPY는 100엔 기준이 관례라서 API가 준
  // "1엔당 원" 값에 100을 곱해 저장한다. 아래 rows의 rate는 전부
  // "unitLabel 하나당 원화"로 이미 환산된 값이다 — 위층에서 또 곱하면 안 된다.
  var CURRENCIES = {
    USD: { code: "USD", label: "미국 달러", unit: 1, unitLabel: "1달러", amountLabel: "달러" },
    JPY: { code: "JPY", label: "일본 엔", unit: 100, unitLabel: "100엔", amountLabel: "엔" },
  };

  // ---------------------------------------------------------------------
  // 날짜 유틸 (전부 로컬 기준 YYYY-MM-DD 문자열)
  // ---------------------------------------------------------------------

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toISO(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function todayISO() {
    return toISO(new Date());
  }

  function parseISO(iso) {
    var p = iso.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function shiftDays(iso, days) {
    var d = parseISO(iso);
    d.setDate(d.getDate() + days);
    return toISO(d);
  }

  function shiftMonths(iso, months) {
    var d = parseISO(iso);
    var targetMonth = d.getMonth() + months;
    d.setDate(1);
    d.setMonth(targetMonth);
    // 말일 보정 (1/31 + 1개월 → 2/28)
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    var origDay = Number(iso.split("-")[2]);
    d.setDate(Math.min(origDay, lastDay));
    return toISO(d);
  }

  function shiftYears(iso, years) {
    return shiftMonths(iso, years * 12);
  }

  // ---------------------------------------------------------------------
  // Frankfurter 어댑터
  // ---------------------------------------------------------------------

  function apiGet(path) {
    return fetch(API_BASE + path, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("환율 서버 응답 오류 (" + res.status + ")");
      return res.json();
    });
  }

  var SOURCES = {
    frankfurter: {
      key: "frankfurter",
      label: "ECB 기준환율 (Frankfurter API)",

      // start~end 구간의 일별 환율. 주말·유럽 공휴일은 애초에 데이터가 없다.
      // 반환: [{ date, rate }] — 날짜 오름차순, rate는 표기 단위로 환산 완료.
      fetchSeries: function (code, start, end) {
        var meta = CURRENCIES[code];
        return apiGet("/" + start + ".." + end + "?base=" + code + "&symbols=KRW").then(function (data) {
          return normalizeRates(data && data.rates, meta.unit);
        });
      },

      fetchLatest: function (code) {
        var meta = CURRENCIES[code];
        return apiGet("/latest?base=" + code + "&symbols=KRW").then(function (data) {
          if (!data || !data.rates || typeof data.rates.KRW !== "number") {
            throw new Error("환율 응답에 KRW가 없습니다");
          }
          return { date: data.date, rate: data.rates.KRW * meta.unit };
        });
      },
    },
  };

  var activeSource = SOURCES.frankfurter;

  function normalizeRates(rates, unit) {
    var out = [];
    if (!rates) return out;
    Object.keys(rates).forEach(function (date) {
      var v = rates[date] && rates[date].KRW;
      if (typeof v !== "number" || !isFinite(v)) return;
      out.push({ date: date, rate: v * unit });
    });
    out.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // localStorage 캐시
  // ---------------------------------------------------------------------
  // 15년치 × 2통화면 대략 8,000행. [["2020-01-02",1157.23], ...] 형태로 저장하면
  // 400KB 안쪽이라 localStorage 한도(보통 5MB) 에 넉넉히 들어간다.
  // 최초 1회만 전체를 받고, 이후엔 마지막 저장일 다음날부터 오늘까지만 증분 요청한다.

  function cacheKey(code) {
    return CACHE_PREFIX + code;
  }

  function readCache(code) {
    try {
      var raw = localStorage.getItem(cacheKey(code));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || obj.v !== CACHE_VERSION || !obj.rows || !obj.rows.length) return null;
      return {
        rows: obj.rows.map(function (pair) {
          return { date: pair[0], rate: pair[1] };
        }),
        fetchedAt: obj.fetchedAt || null,
      };
    } catch (err) {
      return null; // 깨진 캐시는 없는 셈 친다
    }
  }

  function writeCache(code, rows) {
    try {
      localStorage.setItem(
        cacheKey(code),
        JSON.stringify({
          v: CACHE_VERSION,
          fetchedAt: new Date().toISOString(),
          rows: rows.map(function (r) {
            return [r.date, r.rate];
          }),
        })
      );
      return true;
    } catch (err) {
      // 용량 초과 등. 캐시가 없어도 앱은 돌아가야 하므로 조용히 넘어간다.
      return false;
    }
  }

  // 같은 날짜는 뒤(새로 받은 값)가 이긴다.
  function mergeRows(oldRows, newRows) {
    var byDate = {};
    var i;
    for (i = 0; i < oldRows.length; i++) byDate[oldRows[i].date] = oldRows[i].rate;
    for (i = 0; i < newRows.length; i++) byDate[newRows[i].date] = newRows[i].rate;
    return Object.keys(byDate)
      .sort()
      .map(function (d) {
        return { date: d, rate: byDate[d] };
      });
  }

  // ---------------------------------------------------------------------
  // 공개 API
  // ---------------------------------------------------------------------

  // 캐시를 먼저 쓰고 모자란 구간만 채운다.
  // 반환: { code, meta, rows, lastDate, lastRate, fetchedAt, stale, error, source }
  //  - stale=true 는 "네트워크가 안 돼서 캐시만 보여주는 중"이라는 뜻.
  function load(code) {
    var meta = CURRENCIES[code];
    if (!meta) return Promise.reject(new Error("지원하지 않는 통화: " + code));

    var cached = readCache(code);
    var today = todayISO();
    var start = cached
      ? shiftDays(cached.rows[cached.rows.length - 1].date, 1)
      : shiftYears(today, -HISTORY_YEARS);

    // 이미 오늘까지 받아둔 경우엔 굳이 다시 안 부른다.
    if (cached && start > today) {
      return Promise.resolve(pack(code, cached.rows, cached.fetchedAt, false, null));
    }

    return activeSource
      .fetchSeries(code, start, today)
      .then(function (fresh) {
        var rows = cached ? mergeRows(cached.rows, fresh) : fresh;
        if (!rows.length) throw new Error("환율 데이터를 받지 못했습니다");
        writeCache(code, rows);
        return pack(code, rows, new Date().toISOString(), false, null);
      })
      .catch(function (err) {
        if (cached) return pack(code, cached.rows, cached.fetchedAt, true, err);
        throw err; // 캐시도 없고 네트워크도 안 되면 보여줄 게 없다
      });
  }

  function pack(code, rows, fetchedAt, stale, error) {
    var last = rows[rows.length - 1];
    return {
      code: code,
      meta: CURRENCIES[code],
      rows: rows,
      lastDate: last.date,
      lastRate: last.rate,
      fetchedAt: fetchedAt,
      stale: !!stale,
      error: error ? error.message : null,
      source: activeSource.label,
    };
  }

  function loadAll() {
    var codes = Object.keys(CURRENCIES);
    return Promise.all(
      codes.map(function (c) {
        return load(c).then(
          function (r) {
            return r;
          },
          function (err) {
            return { code: c, meta: CURRENCIES[c], rows: [], stale: true, error: err.message };
          }
        );
      })
    ).then(function (list) {
      var out = {};
      list.forEach(function (r) {
        out[r.code] = r;
      });
      return out;
    });
  }

  // 특정 날짜의 환율. 그날 데이터가 없으면(주말·공휴일) 그 이전 가장 가까운 영업일 값.
  // 요청 날짜가 데이터 시작보다 앞서면 null.
  function rateOn(rows, iso) {
    var lo = 0;
    var hi = rows.length - 1;
    var best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (rows[mid].date <= iso) {
        best = rows[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function clearCache() {
    Object.keys(CURRENCIES).forEach(function (c) {
      try {
        localStorage.removeItem(cacheKey(c));
      } catch (err) {
        /* 무시 */
      }
    });
  }

  global.FxData = {
    CURRENCIES: CURRENCIES,
    HISTORY_YEARS: HISTORY_YEARS,
    load: load,
    loadAll: loadAll,
    rateOn: rateOn,
    clearCache: clearCache,
    todayISO: todayISO,
    toISO: toISO,
    parseISO: parseISO,
    shiftDays: shiftDays,
    shiftMonths: shiftMonths,
    shiftYears: shiftYears,
    sourceLabel: function () {
      return activeSource.label;
    },
  };
})(window);
