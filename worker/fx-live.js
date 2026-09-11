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

      return json({ ok: false, error: "없는 경로입니다. /v1/recent 또는 /v1/health 를 쓰세요." }, 404, origin);
    } catch (err) {
      const status = err && err.httpStatus ? err.httpStatus : 502;
      return json({ ok: false, error: String((err && err.message) || err) }, status, origin);
    }
  },
};

// ---------------------------------------------------------------------------
// 조회
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
