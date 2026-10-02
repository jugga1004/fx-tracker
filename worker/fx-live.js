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
    if (request.method !== "GET" && request.method !== "PUT") {
      return json({ ok: false, error: "GET과 PUT만 지원합니다." }, 405, origin);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/v1/health" || path === "/") {
        return json(
          {
            ok: true,
            service: "fx-tracker 실시간 고시환율",
            keyConfigured: Boolean(env.KOREAEXIM_KEY),
            source: "한국수출입은행 오픈API (매매기준율) + 서울외국환중개 당일 직독",
            rev: "mobile-4",
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

        // 수출입은행이 오늘 자를 아직 안 내놨으면 서울외국환중개에서 직접 받는다.
        // 고시는 9시 이전에 나는데 중계는 10시가 넘어야 온다(2026-09-23 실측 34분 차).
        // 면세점 '내일 적용환율'이 그 시간만큼 늦게 뜨는 걸 막는 게 목적이다.
        if (!rates[today] && !isWeekend(today)) {
          const fast = await fetchSmbs(today);
          if (fast) {
            rates[today] = fast;
            const at = missing.indexOf(today);
            if (at >= 0) missing.splice(at, 1);
          }
        }

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
        const pu = new URL(request.url);
        const target = pu.searchParams.get("url") || "";
        const debug = pu.searchParams.get("debug") === "1";
        return json(await fetchProduct(target, debug), 200, origin);
      }

      if (path === "/v1/live") {
        // ?debug=1 이면 업스트림 원문 일부를 함께 돌려준다. 소스가 막히거나
        // 응답 형식이 바뀌었을 때 추측하지 않고 바로 확인하기 위한 것.
        const debug = new URL(request.url).searchParams.get("debug") === "1";
        return json(await fetchLiveRates(debug), 200, origin);
      }

      if (path === "/v1/smbs") {
        const iso = new URL(request.url).searchParams.get("date") || kstToday();
        return json(await probeSmbs(iso), 200, origin);
      }

      if (path === "/v1/state") {
        if (!env.FX_STATE) return stateUnavailable(origin);

        if (request.method === "GET") {
          return json({ ok: true, ...(await readState(env)) }, 200, origin);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "JSON 본문이 필요합니다." }, 400, origin);
        }
        const payload = JSON.stringify(body && body.data !== undefined ? body.data : null);
        if (payload.length > STATE_MAX_BYTES) {
          return json({ ok: false, error: "저장할 내용이 너무 큽니다." }, 413, origin);
        }
        const res = await writeState(env, body.data, body.rev);
        if (res.conflict) {
          // 다른 사람이 먼저 저장했다. 최신본을 같이 돌려줘 클라이언트가 다시 시도하게 한다.
          return json({ ok: false, conflict: true, ...res.current }, 409, origin);
        }
        return json({ ok: true, rev: res.current.rev, updatedAt: res.current.updatedAt }, 200, origin);
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
// 서브도메인까지 일일이 적어두면 모바일에서 공유한 주소(m. / mobile. 등)가
// 막힌다. 실제로 "모바일에서 복사한 링크가 안 붙는다"는 신고가 있었다.
// 그래서 등록 가능 도메인 기준으로 접미사 비교를 한다 — 범위는 여전히
// 면세점 네 곳으로 닫혀 있어서 열린 프록시가 되지는 않는다.
const ALLOWED_DOMAINS = ["lottedfs.com", "shilladfs.com", "ssgdfs.com", "hddfs.com"];

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith("." + d));
}

// 모바일에서 공유한 주소는 호스트도 경로도 다르다. m.lottedfs.com은 허용은
// 되지만 마크업이 달라 파싱이 안 됐다.
//
// 주소를 통째로 해석하려 들지 않고 상품번호만 뽑아 표준 주소로 바꿔 끼운다.
// 어느 서브도메인에서 복사했든, 파라미터 순서가 어떻든 같은 자리로 모인다.
function canonicalUrl(u) {
  const h = u.hostname.toLowerCase();
  if (h === "lottedfs.com" || h.endsWith(".lottedfs.com")) {
    const prdNo = u.searchParams.get("prdNo");
    if (prdNo) {
      const opt = u.searchParams.get("prdOptNo") || "";
      // PC 페이지가 아니라 **모바일** 페이지를 읽는다. 이게 핵심이다.
      // PC는 할인가를 자바스크립트가 그려서 서버 HTML이 비어 있는데,
      // 모바일은 서버에서 통째로 그려 내려준다:
      //   <li class="regular_price discount"><span class="currency">$206</span>
      //   <li class="benefit_price"><strong class="rate">20%</strong>
      //                             <strong class="price">$164.8</strong>
      // 덕분에 헤드리스 브라우저가 필요 없다 — 어차피 Incapsula(WAF)가
      // 헤드리스를 차단해서(차단 이미지를 돌려준다) 그 길은 막혀 있었다.
      return new URL(
        "https://m.kor.lottedfs.com/kr/product/productDetail?prdNo=" +
          encodeURIComponent(prdNo) +
          (opt ? "&prdOptNo=" + encodeURIComponent(opt) : "")
      );
    }
  }
  return u;
}

const PRODUCT_TTL = 60 * 30; // 가격은 자주 안 바뀐다. 30분 캐시.

async function fetchProduct(rawUrl, debug) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "주소 형식이 올바르지 않습니다." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "http/https 주소만 됩니다." };
  }
  if (!hostAllowed(u.hostname)) {
    return {
      ok: false,
      error: `지원하지 않는 사이트입니다(${u.hostname}). 현재는 롯데·신라·신세계·현대 면세점만 읽을 수 있습니다.`,
    };
  }

  // 모바일 주소는 여기서 표준형으로 바뀐다.
  u = canonicalUrl(u);

  let res;
  try {
    res = await fetch(u.toString(), {
      // 봇으로 차단당하지 않게 일반 브라우저처럼 요청한다.
      headers: {
        // 모바일 호스트에 데스크톱 UA로 가면 다른 화면이 온다. 우리가 원하는
        // 서버 렌더링 가격표는 모바일 화면에만 있으므로 UA도 모바일로 맞춘다.
        "user-agent": /^m\./.test(u.hostname)
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
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
  if (debug) {
    // 가격처럼 생긴 JSON 필드를 전부 보여준다. 어느 키가 '할인가'인지
    // 추측하지 않고 실제 응답을 보고 고르기 위한 것이다.
    const fields = {};
    const re = /"([A-Za-z_][A-Za-z0-9_]*(?:[Pp]rc|[Pp]rice|[Aa]mt|[Dd]c)[A-Za-z0-9_]*)"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (fields[m[1]] === undefined) fields[m[1]] = m[2];
      if (Object.keys(fields).length > 60) break;
    }
    // 할인가는 JSON이 아니라 마크업에 들어 있다. 그 부분도 같이 보여준다.
    const marks = {};
    ["grdSrpDscntAmt", "grdDscntRt", "grdSrpAmt", "DscntAmt"].forEach((k) => {
      const at = html.indexOf(k);
      marks[k] = at < 0 ? null : html.slice(Math.max(0, at - 80), at + 120).replace(/\s+/g, " ");
    });
    const areaRaw = pick(html, /<div class="detail_price_area">([\s\S]{0,1500}?)<\/ul>/i);
    return {
      ok: true,
      debug: true,
      host: u.hostname,
      bytes: html.length,
      fields,
      marks,
      priceAreaFound: areaRaw !== null,
      priceArea: areaRaw ? decodeEntities(areaRaw).replace(/\s+/g, " ").slice(0, 500) : null,
    };

  }
  const parsed = parseProduct(html, u.hostname);
  if (!parsed.usd && !parsed.name) {
    return { ok: false, error: "이 페이지에서 상품 정보를 찾지 못했습니다. 상품 상세 페이지 주소가 맞는지 확인해주세요." };
  }

  const canonical = u.toString();

  return { ok: true, url: canonical, host: u.hostname, ...parsed };
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
  // 정가. 롯데는 saleUntPrc 가 달러, saleUntPrcGlbl 이 원화 환산가다.
  let listUsd = toNum(pick(html, /"saleUntPrc"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));
  if (listUsd === null) listUsd = toNum(pick(html, /"dutyFreePrice"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));
  if (listUsd === null) listUsd = toNum(pick(html, /"salePrice"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));

  // 가격 영역만 떼어 엔티티를 풀고 거기서만 찾는다. 600KB 전체를 해독할
  // 이유도 없고, 좁혀 놓으면 엉뚱한 숫자를 집을 일도 없다.
  const priceArea = decodeEntities(
    pick(html, /<div class="detail_price_area">([\s\S]{0,1500}?)<\/ul>/i) || ""
  );

  // 정가. 할인이 걸려 있으면 class가 "regular_price discount"가 된다.
  const listFromArea = toNum(
    pick(priceArea, /class="regular_price[^"]*"[\s\S]{0,200}?class="currency">\s*\$?\s*([0-9][0-9,]*\.?[0-9]*)/i)
  );
  if (listFromArea !== null) listUsd = listFromArea;

  // 할인가. 여기가 실제로 내는 돈이라 비교에 써야 할 값이다.
  const saleUsd = toNum(
    pick(priceArea, /class="benefit_price"[\s\S]{0,300}?class="price">\s*\$?\s*([0-9][0-9,]*\.?[0-9]*)/i)
  );
  const discountPct = toNum(pick(priceArea, /class="rate">\s*([0-9]+(?:\.[0-9]+)?)\s*%/i));

  // 할인가가 정가보다 크면 뭔가 잘못 집은 것이다. 그럴 땐 안 쓴다.
  const sale = saleUsd !== null && listUsd !== null && saleUsd > listUsd ? null : saleUsd;

  // usd는 '실제로 낼 달러'다. 할인가가 있으면 그쪽.
  const usd = sale !== null ? sale : listUsd;

  return { name, brand, usd, listUsd, saleUsd: sale, discountPct, parsedFrom: host };
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
    .replace(/&nbsp;/g, " ")
    // 모바일 페이지는 $ 와 % 까지 16진 엔티티로 보낸다(&#x0024; &#x0025;).
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
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
    "access-control-allow-methods": "GET, PUT, OPTIONS",
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
// 서울외국환중개 — 당일 매매기준율 (빠른 경로)
// ---------------------------------------------------------------------------
// 매매기준율을 실제로 고시하는 곳은 여기다. 수출입은행 오픈API는 중계일 뿐이고
// 늦는다. 2026-09-23 실측: 서울외국환중개는 09:36 이전에 이미 1,360.00이었고
// 수출입은행은 10:10:17에야 같은 값을 내놨다 — 34분 차이.
//
// 면세점 적용환율은 전일 고시분이라, 오늘 고시가 늦게 들어오면 "내일 적용환율"이
// 그만큼 늦게 뜬다. 그 34분이 이 경로를 붙이는 이유다.
//
// 이 주소는 브라우저 개발자도구로 찾았다. 페이지(TodayExRate.jsp)에는 표가 없고
// 값은 이 엔드포인트가 따로 내려준다. tr_date를 안 붙이면 오류 페이지가 온다.
//
// 응답이 쿼리스트링 모양이라 파싱이 간단하다:
//   ?test0=test&updown=0&USD=1,360.00&...&JPY=863.68&...&loading=ok&
//
// https는 526(인증서 검증 실패)이 난다. 체인이 불완전하고 Workers는 검증을
// 끌 수 없어서 http로 간다. 공개된 고시 환율이라 비밀이 오가지 않는다.
const SMBS_FLASH = "http://www.smbs.biz/Flash/TodayExRate_flash.jsp?tr_date=";
const SMBS_TTL = 60 * 10; // 하루 한 번 고시라 오래 잡아도 되지만, 고시 전 빈 응답을 오래 물지 않게

function smbsNum(raw) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 성공하면 { USD, JPY }, 아니면 null. 실패는 조용히 삼킨다 —
// 이건 어디까지나 빠른 경로고, 없으면 수출입은행이 받쳐준다.
async function fetchSmbs(iso) {
  try {
    const res = await fetch(SMBS_FLASH + iso, {
      headers: {
        // 기본 UA로는 막는 경우가 있다.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: "http://www.smbs.biz/ExRate/TodayExRate.jsp",
      },
      cf: { cacheTtl: SMBS_TTL, cacheEverything: true },
    });
    if (!res.ok) return null;
    const text = await res.text();
    // 아직 고시 전이면 loading=ok가 안 붙거나 값이 비어서 온다.
    if (!/loading=ok/.test(text)) return null;
    const q = text.slice(text.indexOf("?") + 1);
    const params = new URLSearchParams(q);
    const USD = smbsNum(params.get("USD"));
    const JPY = smbsNum(params.get("JPY")); // 이미 100엔 기준이라 그대로 쓴다
    if (!USD && !JPY) return null;
    const row = {};
    if (USD) row.USD = USD;
    if (JPY) row.JPY = JPY;
    return row;
  } catch {
    return null;
  }
}

// 조사용으로 남겨둔다. 파싱이 깨졌을 때 원문을 봐야 고칠 수 있다.
async function probeSmbs(iso) {
  const url = SMBS_FLASH + iso;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: "http://www.smbs.biz/ExRate/TodayExRate.jsp",
      },
    });
    const text = await res.text();
    return { ok: res.ok, url, status: res.status, bytes: text.length, parsed: await fetchSmbs(iso), raw: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, url, error: String(err && err.message ? err.message : err) };
  }
}

// ---------------------------------------------------------------------------
// 공유 상태 저장소 (KV)
// ---------------------------------------------------------------------------
// 기본값은 브라우저 localStorage다. 그러면 사람마다·기기마다 다른 화면을 본다.
// 기획을 같이 하려면 한 벌을 공유해야 해서 KV에 통째로 얹는다.
//
// 충돌은 rev(정수)로 막는다. 클라이언트는 자기가 받아간 rev를 같이 보내고,
// 그 사이 누가 먼저 저장했으면 409와 최신본을 돌려준다. 클라이언트가 최신본을
// 받아 다시 시도하는 구조라 "모르는 새 덮어쓰기"는 일어나지 않는다.
//
// 주의: 이 주소를 아는 사람은 누구나 읽고 쓸 수 있다. 테스트·기획 단계용이며
// 개인정보나 비밀을 넣으면 안 된다. 실제 서비스로 가면 인증이 앞에 붙어야 한다.
const STATE_KEY = "shared-state-v1";
const STATE_MAX_BYTES = 256 * 1024; // KV 값 한도(25MB)보다 훨씬 낮게. 실수로 큰 걸 밀어넣는 걸 막는다.

function stateUnavailable(origin) {
  return json(
    {
      ok: false,
      error:
        "공유 저장소가 아직 연결되지 않았습니다. Cloudflare에서 KV 네임스페이스를 만들고 " +
        "변수 이름 FX_STATE 로 바인딩해야 합니다.",
      bound: false,
    },
    503,
    origin
  );
}

async function readState(env) {
  const raw = await env.FX_STATE.get(STATE_KEY);
  if (!raw) return { rev: 0, updatedAt: null, data: null };
  try {
    const obj = JSON.parse(raw);
    return {
      rev: Number(obj.rev) || 0,
      updatedAt: obj.updatedAt || null,
      data: obj.data === undefined ? null : obj.data,
    };
  } catch {
    // 저장된 게 깨졌으면 없는 것으로 친다. 여기서 던지면 앱이 통째로 멈춘다.
    return { rev: 0, updatedAt: null, data: null };
  }
}

async function writeState(env, data, baseRev) {
  const current = await readState(env);
  if (Number(baseRev) !== current.rev) {
    return { conflict: true, current };
  }
  const next = {
    rev: current.rev + 1,
    updatedAt: new Date().toISOString(),
    data,
  };
  await env.FX_STATE.put(STATE_KEY, JSON.stringify(next));
  return { conflict: false, current: next };
}

// 네이버 쇼핑 검색 API는 2026-07-31에 종료됐다(개발자센터 공지 32564).
// 유예도 대체 API도 없고 API HUB 이관 대상에서도 빠졌다.
// 남은 공식 API는 11번가·쿠팡처럼 한 몰짜리라 '최저가'라고 부를 수가 없다.
// 그래서 자동 조회를 걷어내고, 앱은 면세점가를 원화로 환산해 주는 데까지만 한다.
// 비교는 다나와·네이버쇼핑 검색 링크로 넘긴다 — 키도 쿼터도 필요 없고 안 깨진다.

// 참고 — 한때 Cloudflare Browser Rendering으로 PC 페이지를 렌더해 할인가를
// 읽으려 했다. 두 가지 이유로 걷어냈다.
//   1) 모바일 페이지가 할인가를 서버에서 그려 내려준다. 렌더링이 필요 없다.
//   2) 어차피 막혔을 것이다 — Incapsula가 헤드리스 크롬을 감지해
//      HTML 대신 차단 이미지를 돌려준다(로컬 크롬으로 실측).
// 키도 과금도 없이 끝났다.
