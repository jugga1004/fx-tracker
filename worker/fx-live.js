/**
 * fx-tracker 실시간 고시환율 조회 (Cloudflare Workers)
 * ---------------------------------------------------------------------------
 * 왜 이게 필요한가
 *
 * GitHub Actions 예약(cron)만으로는 이 앱이 서비스가 안 된다. 사용자가 앱을 여는
 * 시점에 오늘 고시가 있어야 "오늘 살까 내일 살까"를 정할 수 있는데, cron은 GitHub이
 * 정해주는 시점에만 돌고 무료 러너에서는 통째로 건너뛰기도 한다.
 * (2026-09-11 실측: 11:17·11:37 예약 둘 다 실행되지 않아 정오까지 당일 값이 없었다)
 *
 * Worker는 요청이 올 때 실행되므로 스케줄 문제가 아예 없다. 앱을 여는 순간 조회한다.
 *
 * 역할 분담
 *   이 Worker        → 오늘·최근 며칠의 매매기준율 (앱 열 때 실시간)
 *   data/rates.json  → 과거 이력 (7일 표, 매수 기록 환전 비용). Actions가 계속 쌓는다.
 *   Worker가 죽어도 앱은 rates.json으로 폴백하므로 지금보다 나빠지지 않는다.
 *
 * 인증키는 Cloudflare Secret에만 둔다. 브라우저로는 내려가지 않는다.
 *
 * 라우트
 *   GET /v1/recent?days=5   최근 영업일들의 매매기준율 (기본 5일, 최대 10)
 *   GET /v1/live            지금 환율 (화면 상단 '현재 환율' 전용). ?debug=1 로 원문 확인
 *   GET /v1/product?url=…   면세점 상품 페이지에서 상품명·달러가 추출
 *   GET /v1/health          키 설정 여부만 확인 (키 값은 절대 노출 안 함)
 *
 * 환경변수
 *   KOREAEXIM_KEY   (secret, 필수)
 *   ALLOWED_ORIGIN  (var, 선택) 기본 "*". 배포 주소로 좁히는 걸 권장.
 */

const UPSTREAM = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";

// 앱이 쓰는 통화만. JPY는 수출입은행이 "JPY(100)" 단위로 주는데
// 마침 앱의 표기 단위(100엔 기준)와 같아서 그대로 쓰면 된다.
const WANTED = { USD: "USD", "JPY(100)": "JPY" };

const DEFAULT_DAYS = 5;
const MAX_DAYS = 10;

// 과거 날짜의 고시는 바뀌지 않으므로 길게 캐시한다.
// 오늘 자는 11시경에 생기므로 짧게 잡아 재조회 여지를 남긴다.
const TTL_PAST = 60 * 60 * 24 * 7; // 7일
const TTL_TODAY = 60 * 15; // 15분
const TTL_EMPTY = 60 * 10; // 아직 안 나온 오늘 자

export default {
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ ok: false, error: "GET만 지원합니다." }, 405, origin);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/v1/health" || path === "/") {
        return json(
          {
            ok: true,
            service: "fx-tracker 실시간 고시환율",
            keyConfigured: Boolean(env.KOREAEXIM_KEY),
            source: "한국수출입은행 오픈API (매매기준율)",
            rev: "smbs-probe-2",
          },
          200,
          origin
        );
      }

      if (!env.KOREAEXIM_KEY) {
        return json(
          { ok: false, error: "서버에 KOREAEXIM_KEY가 없습니다. Worker Settings → Variables and Secrets 에서 Secret으로 등록하세요." },
          500,
          origin
        );
      }

      if (path === "/v1/recent") {
        const url = new URL(request.url);
        let days = parseInt(url.searchParams.get("days") || DEFAULT_DAYS, 10);
        if (!Number.isFinite(days) || days < 1) days = DEFAULT_DAYS;
        if (days > MAX_DAYS) days = MAX_DAYS;

        // 오늘(KST)부터 거슬러 올라가며 영업일만 고른다. 주말은 애초에 고시가 없다.
        const today = kstToday();
        const targets = [];
        for (let i = 0; targets.length < days && i < days * 2 + 4; i++) {
          const iso = shift(today, -i);
          if (!isWeekend(iso)) targets.push(iso);
        }

        const rates = {};
        const missing = [];
        // 몇 건 안 되므로 한꺼번에 보낸다.
        const rows = await Promise.all(targets.map((iso) => fetchOneCached(iso, env, ctx)));
        rows.forEach((row, i) => {
          if (row) rates[targets[i]] = row;
          else missing.push(targets[i]);
        });

        const found = Object.keys(rates).sort();
        return json(
          {
            ok: true,
            today,
            latest: found.length ? found[found.length - 1] : null,
            rates,
            missing,
            source: "한국수출입은행 매매기준율(deal_bas_r)",
          },
          200,
          origin
        );
      }

      if (path === "/v1/product") {
        const target = new URL(request.url).searchParams.get("url") || "";
        return json(await fetchProduct(target), 200, origin);
      }

      if (path === "/v1/live") {
        // ?debug=1 이면 업스트림 원문 일부를 함께 돌려준다. 소스가 막히거나
        // 응답 형식이 바뀌었을 때 추측하지 않고 바로 확인하기 위한 것.
        const debug = new URL(request.url).searchParams.get("debug") === "1";
        return json(await fetchLiveRates(debug), 200, origin);
      }

      if (path === "/v1/smbs") {
        const which = new URL(request.url).searchParams.get("page") || "today";
        return json(await probeSmbs(which), 200, origin);
      }

      return json({ ok: false, error: "없는 경로입니다. /v1/recent, /v1/product, /v1/health 를 쓰세요." }, 404, origin);
    } catch (err) {
      const status = err && err.httpStatus ? err.httpStatus : 502;
      return json({ ok: false, error: String((err && err.message) || err) }, status, origin);
    }
  },
};

// ---------------------------------------------------------------------------
// 실시간 환율
// ---------------------------------------------------------------------------
// 매매기준율은 하루 한 번뿐이라 "지금 환율"로는 맞지 않다. 은행 고시환율은 하루
// 수십 회 갱신되고 모바일 환전도 그 최신 회차로 체결된다. 그래서 화면 상단의
// '현재 환율'만 이 값으로 보여준다.
//
// 차트·백분위·평가손익·면세점 적용환율은 여전히 매매기준율(확정값)을 쓴다.
// 하루 여러 번 바뀌는 값으로는 일별 시계열을 만들 수 없고, 면세점 규칙 자체가
// 전일 '고시 매매기준율' 기준이기 때문이다.
//
// 소스 선택 (2026-09-11 실측):
//   네이버 금융(하나은행 고시회차)은 내 PC에서는 되는데 Cloudflare에서 온 요청에는
//   closePrice가 없는 응답을 준다. 데이터센터 IP를 막는 것으로 보인다. 그래서 제외했다.
//   야후는 Worker에서 정상 동작하고 값 차이도 작다 — 같은 시점에
//   네이버 1,345.00 vs 야후 1,344.84 (0.16원). 은행 고시가 아니라 은행 간 시장
//   중간환율이라는 점은 화면에 밝힌다.
const YAHOO_FX = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_CODES = { USD: "KRW=X", JPY: "JPYKRW=X" };
// 야후는 JPY를 1엔당으로 준다. 앱 표기는 100엔 기준이라 맞춰준다.
const YAHOO_UNIT = { USD: 1, JPY: 100 };
const LIVE_TTL = 120; // 2분. 그보다 자주 볼 이유가 없다.

async function fetchLiveRates(debug) {
  const out = {};
  const errors = [];
  const raw = {};

  await Promise.all(
    Object.keys(YAHOO_CODES).map(async (code) => {
      try {
        const res = await fetch(`${YAHOO_FX}${YAHOO_CODES[code]}?interval=1d&range=5d`, {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
            accept: "application/json",
          },
          cf: { cacheTtl: LIVE_TTL, cacheEverything: true },
        });
        const text = await res.text();
        if (debug) raw[code] = { status: res.status, body: text.slice(0, 300) };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
        const price = toNum(meta && meta.regularMarketPrice);
        if (price === null) throw new Error("regularMarketPrice 없음");

        const unit = YAHOO_UNIT[code];
        const rate = price * unit;
        // previousClose가 없는 경우가 있어 chartPreviousClose로 떨어진다.
        const prev = toNum(meta.previousClose) ?? toNum(meta.chartPreviousClose);
        const prevScaled = prev === null ? null : prev * unit;

        out[code] = {
          rate: Math.round(rate * 100) / 100,
          change: prevScaled === null ? null : Math.round((rate - prevScaled) * 100) / 100,
          changePct: prevScaled ? Math.round(((rate - prevScaled) / prevScaled) * 10000) / 100 : null,
          at: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        };
      } catch (err) {
        errors.push(`${code}: ${err.message}`);
      }
    })
  );

  if (!Object.keys(out).length) {
    return {
      ok: false,
      error: `실시간 환율을 가져오지 못했습니다. ${errors.join(" / ")}`,
      debug: debug ? raw : undefined,
    };
  }
  return {
    ok: true,
    rates: out,
    source: "은행 간 시장 중간환율 (Yahoo Finance)",
    notes: errors.length ? errors : undefined,
    debug: debug ? raw : undefined,
  };
}

// ---------------------------------------------------------------------------
// 면세점 상품 조회
// ---------------------------------------------------------------------------
// 브라우저는 다른 도메인을 못 읽으므로(CORS) 여기서 대신 읽어 상품명과 달러가를 뽑는다.
//
// 아무 주소나 받아주면 이 Worker가 열린 프록시가 되어 남의 서버를 찌르는 데 쓰일 수 있다.
// 그래서 면세점 도메인만 허용한다.
const ALLOWED_HOSTS = [
  "kor.lottedfs.com",
  "www.lottedfs.com",
  "www.shilladfs.com",
  "m.shilladfs.com",
  "www.ssgdfs.com",
  "www.hddfs.com",
];

const PRODUCT_TTL = 60 * 30; // 가격은 자주 안 바뀐다. 30분 캐시.

async function fetchProduct(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "주소 형식이 올바르지 않습니다." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "http/https 주소만 됩니다." };
  }
  if (!ALLOWED_HOSTS.includes(u.hostname)) {
    return {
      ok: false,
      error: `지원하지 않는 사이트입니다(${u.hostname}). 현재는 롯데·신라·신세계·현대 면세점만 읽을 수 있습니다.`,
    };
  }

  let res;
  try {
    res = await fetch(u.toString(), {
      // 봇으로 차단당하지 않게 일반 브라우저처럼 요청한다.
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko-KR,ko;q=0.9",
      },
      cf: { cacheTtl: PRODUCT_TTL, cacheEverything: true },
    });
  } catch (err) {
    return { ok: false, error: `상품 페이지에 연결하지 못했습니다: ${err.message}` };
  }
  if (!res.ok) return { ok: false, error: `상품 페이지 응답 오류 (HTTP ${res.status})` };

  const html = await res.text();
  const parsed = parseProduct(html, u.hostname);
  if (!parsed.usd && !parsed.name) {
    return { ok: false, error: "이 페이지에서 상품 정보를 찾지 못했습니다. 상품 상세 페이지 주소가 맞는지 확인해주세요." };
  }
  return { ok: true, url: u.toString(), host: u.hostname, ...parsed };
}

function parseProduct(html, host) {
  // 상품명: og:title 이 가장 안정적이다(속성 순서가 뒤바뀌는 경우가 있어 양쪽 다 본다).
  let name =
    pick(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    pick(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    "";
  name = decodeEntities(name).trim();
  // "롯데면세점" 같은 사이트명만 온 경우는 상품명이 아니다.
  if (/^(롯데면세점|신라면세점|신세계면세점|현대면세점)$/.test(name)) name = "";

  const brand = decodeEntities(pick(html, /"brndNm"\s*:\s*"([^"]+)"/) || "").trim();

  // 달러 표시가. 롯데는 saleUntPrc 가 달러, saleUntPrcGlbl 이 원화 환산가다.
  let usd = toNum(pick(html, /"saleUntPrc"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));
  if (usd === null) usd = toNum(pick(html, /"dutyFreePrice"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));
  if (usd === null) usd = toNum(pick(html, /"salePrice"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));

  return { name, brand, usd, parsedFrom: host };
}

function pick(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// 환율 조회
// ---------------------------------------------------------------------------

async function fetchOneCached(iso, env, ctx) {
  // 인증키가 캐시 키에 들어가지 않도록 업스트림 URL이 아닌 합성 URL을 키로 쓴다.
  const cacheKey = new Request(`https://fx-live.internal/rate/${iso}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = await hit.json();
    return cached.found ? cached.row : null;
  }

  const row = await fetchOne(iso, env);
  const isToday = iso === kstToday();
  const ttl = row ? (isToday ? TTL_TODAY : TTL_PAST) : TTL_EMPTY;

  const toStore = new Response(JSON.stringify({ found: Boolean(row), row }), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toStore.clone()));
  else await cache.put(cacheKey, toStore.clone());

  return row;
}

async function fetchOne(iso, env) {
  const ymd = iso.replace(/-/g, "");
  const target = `${UPSTREAM}?authkey=${encodeURIComponent(env.KOREAEXIM_KEY)}&searchdate=${ymd}&data=AP01`;

  let res;
  try {
    res = await fetch(target, { headers: { accept: "application/json" } });
  } catch (err) {
    throw httpError(`한국수출입은행 API에 연결하지 못했습니다: ${err.message}`, 502);
  }
  if (!res.ok) throw httpError(`한국수출입은행 API 응답 오류 (HTTP ${res.status})`, 502);

  let data;
  try {
    data = await res.json();
  } catch {
    throw httpError("한국수출입은행 API가 JSON이 아닌 응답을 보냈습니다.", 502);
  }
  if (!Array.isArray(data)) throw httpError("예상과 다른 응답 형식입니다.", 502);

  // 주말·공휴일·당일 11시 이전이면 빈 배열.
  if (data.length === 0) return null;

  const code = data[0] && data[0].result;
  // result 3은 오타뿐 아니라 키가 파기된 경우에도 나온다. 수출입은행은 개인정보
  // 보유기간(2년)이 지나면 키를 파기하며, 파기 전 등록 이메일로 재동의 안내가 간다.
  if (code === 3) {
    throw httpError(
      "인증키가 유효하지 않습니다 (result 3). 오타이거나, 보유기간 2년이 지나 키가 파기됐을 수 있습니다.",
      502
    );
  }
  if (code === 4) throw httpError("일일 호출 한도(1,000회)를 초과했습니다 (result 4).", 429);
  if (code === 2) throw httpError("요청 DATA 코드가 잘못되었습니다 (result 2).", 502);

  const row = {};
  for (const item of data) {
    if (!item || item.result !== 1) continue;
    const key = WANTED[item.cur_unit];
    if (!key) continue;
    const n = Number(String(item.deal_bas_r ?? "").replace(/,/g, "").trim());
    if (Number.isFinite(n) && n > 0) row[key] = n;
  }
  return Object.keys(row).length ? row : null;
}

// ---------------------------------------------------------------------------
// 유틸 — 전부 KST 기준 (고시가 한국 영업일 기준이므로)
// ---------------------------------------------------------------------------

function kstToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function shift(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(iso) {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

function httpError(message, httpStatus) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  return err;
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

// ---------------------------------------------------------------------------
// 서울외국환중개 직독 (조사용)
// ---------------------------------------------------------------------------
// 매매기준율을 실제로 고시하는 곳은 여기다. 수출입은행은 중계일 뿐이고 늦는다.
// 2026-09-23 09:36 실측: 서울외국환중개 값(1,360.0)은 이미 나와 있었는데
// 수출입은행은 missing이었다.
//
// 주소는 하드코딩한다. 바깥에서 받은 주소를 그대로 fetch하면 이 Worker가
// 열린 프록시가 되어 남의 서버를 찌르는 데 쓰인다.
// https는 526(인증서 검증 실패)이 났다. 체인이 불완전한 사이트에서 흔하다.
// Workers는 인증서 검증을 끌 수 없으므로 http와 다른 호스트명을 같이 시도한다.
const SMBS_PAGES = {
  today: "https://www.smbs.biz/ExRate/TodayExRate.jsp",
  todayHttp: "http://www.smbs.biz/ExRate/TodayExRate.jsp",
  todayPopHttp: "http://www.smbs.biz/ExRate/TodayExRate_p.jsp",
  bareHttp: "http://smbs.biz/ExRate/TodayExRate.jsp",
  bareHttps: "https://smbs.biz/ExRate/TodayExRate.jsp",
  stdHttp: "http://www.smbs.biz/ExRate/StdExRate.jsp",
  rootHttp: "http://www.smbs.biz/",
};

async function probeSmbs(which) {
  const url = SMBS_PAGES[which] || SMBS_PAGES.today;
  try {
    const res = await fetch(url, {
      headers: {
        // 기본 UA로 가면 막는 사이트가 있다.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const text = await res.text();
    // 숫자가 HTML에 실려 오는지가 관건이다. 1,3xx.x / 8xx.xx 패턴을 세어 본다.
    const nums = text.match(/\b[0-9]{1,2},[0-9]{3}\.[0-9]{1,2}\b|\b[0-9]{3}\.[0-9]{2}\b/g) || [];
    return {
      ok: res.ok,
      url,
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes: text.length,
      numbersFound: nums.slice(0, 20),
      numberCount: nums.length,
      hasScript: /<script/i.test(text),
      head: text.slice(0, 1200),
    };
  } catch (err) {
    return { ok: false, url, error: String(err && err.message ? err.message : err) };
  }
}
