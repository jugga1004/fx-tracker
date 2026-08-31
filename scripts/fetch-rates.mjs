/**
 * 국내 매매기준율 수집 스크립트 (GitHub Actions에서 실행)
 * ---------------------------------------------------------------------------
 * GitHub Pages는 정적 호스팅이라 서버 코드를 못 돌린다. 그래서 "요청이 올 때마다
 * 조회"하는 대신, Actions가 하루 한 번 미리 받아서 data/rates.json에 커밋해두고
 * 앱은 그 파일 하나만 읽는다.
 *
 * 이 방식의 이점:
 *   - 인증키가 GitHub Secrets 안에만 있고 배포물에는 들어가지 않는다.
 *   - raw.githubusercontent.com / GitHub Pages 모두 CORS(*)를 열어줘서 브라우저가 바로 읽는다.
 *   - 한 번 받은 날짜는 파일에 남으므로 시간이 갈수록 히스토리가 저절로 쌓인다.
 *     (수출입은행 API는 날짜 하나씩만 조회돼서 과거를 한 번에 못 받는다)
 *
 * 환경변수
 *   KOREAEXIM_KEY  (필수) 한국수출입은행 오픈API 인증키
 *   FROM, TO       (선택) YYYY-MM-DD. 과거 구간을 메울 때만 쓴다. 없으면 최근 며칠만 확인.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const UPSTREAM = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";
const DATA_PATH = "data/rates.json";

// 수출입은행이 주는 통화 단위 → 앱이 쓰는 키.
// JPY는 "JPY(100)" 즉 100엔 기준이라 앱 표기 단위와 그대로 맞는다.
const WANTED = { USD: "USD", "JPY(100)": "JPY" };

const MAX_CALLS = 800; // 일일 1,000회 제한에 여유를 둔다
const DEFAULT_LOOKBACK_DAYS = 10;
const RETRY_MISSING_WITHIN_DAYS = 7; // 이 기간 안의 '데이터 없음'은 다시 확인 (공휴일 아닐 수 있음)
const CALL_DELAY_MS = 120;

const KEY = process.env.KOREAEXIM_KEY;
if (!KEY) {
  console.error("KOREAEXIM_KEY가 없습니다. 저장소 Settings → Secrets and variables → Actions 에 등록하세요.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 날짜 유틸 (전부 KST 기준으로 다룬다 — 고시환율이 한국 영업일 기준이므로)
// ---------------------------------------------------------------------------

function kstToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
  return toIso(kst);
}

function toIso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shift(iso, days) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

function isWeekend(iso) {
  const day = parseIso(iso).getDay();
  return day === 0 || day === 6;
}

function daysBetween(a, b) {
  return Math.round((parseIso(b) - parseIso(a)) / 86400000);
}

function toYmd(iso) {
  return iso.replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// 데이터 파일
// ---------------------------------------------------------------------------

async function loadData() {
  try {
    const raw = await readFile(DATA_PATH, "utf8");
    const obj = JSON.parse(raw);
    return {
      rates: obj.rates && typeof obj.rates === "object" ? obj.rates : {},
      missing: Array.isArray(obj.missing) ? obj.missing : [],
    };
  } catch {
    return { rates: {}, missing: [] };
  }
}

async function saveData({ rates, missing }) {
  const dates = Object.keys(rates).sort();
  // 키 순서를 항상 날짜 오름차순으로 고정한다. 그래야 커밋 diff가 "추가된 줄"만 남는다.
  const sorted = {};
  for (const d of dates) sorted[d] = rates[d];

  const body = {
    source: "한국수출입은행 오픈API 매매기준율(deal_bas_r)",
    note: "USD는 1달러, JPY는 100엔 기준. 영업일만 존재하며 주말·공휴일은 없음.",
    updatedAt: new Date().toISOString(),
    latest: dates.length ? dates[dates.length - 1] : null,
    count: dates.length,
    missing: [...new Set(missing)].sort(),
    rates: sorted,
  };

  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, JSON.stringify(body, null, 1) + "\n", "utf8");
  return body;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

function toNumber(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchOne(iso) {
  const url = `${UPSTREAM}?authkey=${encodeURIComponent(KEY)}&searchdate=${toYmd(iso)}&data=AP01`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("예상과 다른 응답 형식");
  if (data.length === 0) return null; // 주말·공휴일·11시 이전

  const code = data[0]?.result;
  if (code === 3) {
    // 오타뿐 아니라 개인정보 보유기간(2년) 만료로 키가 파기된 경우에도 3이 나온다.
    throw new Error(
      "인증키가 유효하지 않습니다 (result 3). 오타이거나, 보유기간 2년이 지나 키가 파기됐을 수 있습니다. " +
        "후자라면 수출입은행 「Open API 인증키 발급 재동의」로 연장하거나 신규 발급이 필요합니다."
    );
  }
  if (code === 4) throw new Error("일일 호출 한도(1,000회) 초과 (result 4). 내일 다시 실행됩니다.");
  if (code === 2) throw new Error("요청 DATA 코드 오류 (result 2)");

  const row = {};
  for (const item of data) {
    if (item?.result !== 1) continue;
    const key = WANTED[item.cur_unit];
    if (!key) continue;
    const value = toNumber(item.deal_bas_r);
    if (value !== null) row[key] = value;
  }
  return Object.keys(row).length ? row : null;
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function buildTargets(store, today) {
  const from = (process.env.FROM || "").trim();
  const to = (process.env.TO || "").trim() || today;

  let candidates = [];
  if (from) {
    // 과거 메우기 모드
    for (let d = from; d <= to; d = shift(d, 1)) candidates.push(d);
  } else {
    for (let i = DEFAULT_LOOKBACK_DAYS - 1; i >= 0; i--) candidates.push(shift(today, -i));
  }

  const missingSet = new Set(store.missing);
  return candidates.filter((iso) => {
    if (iso > today) return false;
    if (isWeekend(iso)) return false; // 주말은 애초에 고시가 없다 — 호출 낭비
    if (store.rates[iso]) return false; // 이미 있음
    // '데이터 없음'으로 기록된 날짜: 오래됐으면 공휴일로 확정, 최근이면 한 번 더 확인
    if (missingSet.has(iso) && daysBetween(iso, today) > RETRY_MISSING_WITHIN_DAYS) return false;
    return true;
  });
}

async function main() {
  const today = kstToday();
  const store = await loadData();
  const before = Object.keys(store.rates).length;

  let targets = buildTargets(store, today);
  if (targets.length > MAX_CALLS) {
    console.log(`대상 ${targets.length}일 중 ${MAX_CALLS}일만 처리합니다 (일일 호출 한도). 나머지는 다음 실행에서 이어갑니다.`);
    targets = targets.slice(0, MAX_CALLS);
  }

  console.log(`오늘(KST) ${today} · 조회 대상 ${targets.length}일 · 기존 ${before}일치 보유`);

  let added = 0;
  let empty = 0;
  let fatal = null;

  for (const iso of targets) {
    try {
      const row = await fetchOne(iso);
      if (row) {
        store.rates[iso] = row;
        store.missing = store.missing.filter((d) => d !== iso);
        added++;
        console.log(`  ${iso}  USD ${row.USD ?? "-"}  JPY(100) ${row.JPY ?? "-"}`);
      } else {
        if (!store.missing.includes(iso)) store.missing.push(iso);
        empty++;
      }
    } catch (err) {
      // 인증·한도 문제는 남은 날짜도 다 실패하므로 즉시 중단한다.
      fatal = err.message;
      console.error(`  ${iso}  실패: ${err.message}`);
      break;
    }
    await new Promise((r) => setTimeout(r, CALL_DELAY_MS));
  }

  const saved = await saveData(store);
  const summary =
    `수집 ${added}일 추가 · 데이터 없음 ${empty}일 · 총 ${saved.count}일치` +
    (saved.latest ? ` · 최신 ${saved.latest}` : "") +
    (fatal ? `\n\n**중단됨:** ${fatal}` : "");
  console.log(summary.replace(/\*\*/g, ""));

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `### 환율 수집 결과\n\n${summary}\n`, { flag: "a" });
  }

  // 인증키가 죽었으면 워크플로를 실패시켜 알림이 가게 한다.
  // 단순히 '오늘 데이터가 아직 없음'인 경우는 실패가 아니다.
  if (fatal) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
