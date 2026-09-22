(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 해외 결제 수단별 실부담액
  // ---------------------------------------------------------------------
  // 기준은 하나다 — 매매기준율(R). 스프레드도 수수료도 전부 여기에 얹힌다.
  // 그래야 "원가 대비 얼마가 새는가"를 한 눈금으로 비교할 수 있다.
  //
  // 은행 앱도 카드사 앱도 이 비교를 안 해준다. 자기 상품이 불리하게 나오는
  // 칸이 반드시 생기기 때문이다. 그게 이 계산기를 만드는 이유다.
  //
  // 요율 기본값은 2026년 9월 기준 통상값이고 카드사·상품·통화마다 다르다.
  // 전부 설정에서 고칠 수 있게 두고, 화면에도 '확인 필요'를 붙인다.

  var DEFAULT_RATES = {
    cashSpreadPct: 1.75, // 현찰 매도 스프레드 (은행이 현찰을 팔 때 얹는 폭)
    prefPct: 0, // 환전 우대율 — 위 스프레드를 깎아주는 비율
    ttSpreadPct: 1.0, // 전신환매도율 스프레드. 카드 결제는 이 환율로 청구된다
    brandFeePct: 1.0, // 국제브랜드(비자·마스터) 수수료
    issuerFeePct: 0.25, // 카드사 해외서비스 수수료
    travelFeePct: 0, // 트래블카드 환전 수수료. 무료 구간이면 0
    dccMarkupPct: 5.0, // DCC 가산. 통상 3~8%라 가운데를 기본값으로 둔다
  };

  function n(v, fallback) {
    var x = Number(v);
    return isFinite(x) ? x : fallback;
  }

  // 설정 객체(일부만 있어도 됨)를 기본값 위에 얹는다.
  function withDefaults(opt) {
    var out = {};
    Object.keys(DEFAULT_RATES).forEach(function (k) {
      out[k] = n(opt && opt[k], DEFAULT_RATES[k]);
    });
    return out;
  }

  // 우대율을 반영한 현찰 스프레드(%). 우대 80%면 1.75% -> 0.35%.
  function effectiveCashSpreadPct(opt) {
    var o = withDefaults(opt);
    var pref = Math.min(Math.max(o.prefPct, 0), 100);
    return o.cashSpreadPct * (1 - pref / 100);
  }

  // 카드 실효환율은 곱으로 쌓인다. 전신환 스프레드가 붙은 환율에
  // 브랜드·카드사 수수료가 다시 퍼센트로 얹히기 때문이다.
  function cardRate(baseRate, opt) {
    var o = withDefaults(opt);
    return baseRate * (1 + o.ttSpreadPct / 100) * (1 + (o.brandFeePct + o.issuerFeePct) / 100);
  }

  // baseRate       오늘 매매기준율 (원 / 기준단위. USD는 1달러, JPY는 100엔)
  // dutyFreeRate   면세점 적용환율 = 전일 영업일 고시. 없으면 면세점 행을 뺀다.
  //                오늘 고시와 다른 값이라 면세점이 늘 최저인 것도 아니다.
  function methods(baseRate, dutyFreeRate, opt) {
    var o = withDefaults(opt);
    var rows = [];
    var card = cardRate(baseRate, o);

    if (isFinite(dutyFreeRate) && dutyFreeRate > 0) {
      rows.push({
        key: "dutyfree",
        label: "면세점 원화결제",
        rate: dutyFreeRate,
        note: "적용환율(전일 고시) 그대로 · 스프레드 없음",
      });
    }
    rows.push({
      key: "travel",
      label: "트래블 카드",
      rate: baseRate * (1 + o.travelFeePct / 100),
      note: o.travelFeePct > 0 ? "환전 수수료 " + o.travelFeePct + "%" : "무료 환전 구간",
    });
    rows.push({
      key: "cash",
      label: "현찰 환전",
      rate: baseRate * (1 + effectiveCashSpreadPct(o) / 100),
      note: "스프레드 " + o.cashSpreadPct + "% · 우대 " + o.prefPct + "%",
    });
    rows.push({
      key: "card",
      label: "신용·체크카드",
      rate: card,
      note: "전신환 " + o.ttSpreadPct + "% + 브랜드 " + o.brandFeePct + "% + 카드사 " + o.issuerFeePct + "%",
    });
    rows.push({
      key: "dcc",
      label: "DCC (현지에서 원화결제)",
      rate: card * (1 + o.dccMarkupPct / 100),
      note: "카드 경로에 DCC " + o.dccMarkupPct + "% 가산",
    });
    return rows;
  }

  // amount  현지통화 금액 (달러면 달러 수, 엔이면 엔 수)
  // unit    기준단위 (USD 1, JPY 100) — baseRate가 그 단위 기준이라 나눠줘야 한다
  //
  // 반환: 싼 순으로 정렬. base는 매매기준율 그대로 낸다고 쳤을 때의 '원가'이며
  // 실제로 그 값에 살 수 있는 수단은 없을 수도 있다 — 비교 눈금일 뿐이다.
  function compare(amount, baseRate, dutyFreeRate, unit, opt) {
    var units = n(amount, 0) / n(unit, 1);
    var baseKrw = units * baseRate;
    var rows = methods(baseRate, dutyFreeRate, opt).map(function (m) {
      var krw = units * m.rate;
      return {
        key: m.key,
        label: m.label,
        note: m.note,
        rate: m.rate,
        krw: krw,
        extraKrw: krw - baseKrw,
        extraPct: baseKrw > 0 ? ((krw - baseKrw) / baseKrw) * 100 : 0,
      };
    });
    rows.sort(function (a, b) {
      return a.krw - b.krw;
    });
    var best = rows.length ? rows[0].krw : 0;
    rows.forEach(function (r) {
      r.vsBestKrw = r.krw - best; // 최저 수단 대비 더 내는 금액
      r.isBest = r.krw === best;
    });
    return { baseKrw: baseKrw, rows: rows };
  }

  // ---------------------------------------------------------------------
  // 여행자 휴대품 면세한도
  // ---------------------------------------------------------------------
  // 기본 한도는 미화 800달러(2022년 9월 상향, 관세청). 주류·담배·향수는
  // 이 한도와 별도로 계산되며 품목별 조건이 따로 있다.
  //
  // 세율은 품목마다 다르다. 여기서는 간이세율 하나를 받아 초과분에 곱하는
  // '대략'만 낸다 — 실제 세액은 품목 분류에 따라 달라지므로 관세청 확인이
  // 필요하고, 세무 판단은 전문가 확인을 권장한다. 자진신고 감면(관세의 30%,
  // 한도 있음)도 반영하지 않는다. 목적은 정확한 세액이 아니라
  // "한도를 넘기면 면세점 이득이 사라지는 지점"을 보여주는 것이다.

  var DEFAULT_ALLOWANCE_USD = 800;
  var DEFAULT_SIMPLE_TAX_PCT = 20;

  function dutyEstimate(totalUsd, allowanceUsd, simpleTaxPct) {
    var total = Math.max(n(totalUsd, 0), 0);
    var allowance = Math.max(n(allowanceUsd, DEFAULT_ALLOWANCE_USD), 0);
    var pct = Math.max(n(simpleTaxPct, DEFAULT_SIMPLE_TAX_PCT), 0);
    var over = Math.max(total - allowance, 0);
    return {
      totalUsd: total,
      allowanceUsd: allowance,
      overUsd: over,
      taxPct: pct,
      taxUsd: over * (pct / 100),
      overLimit: over > 0,
    };
  }

  global.Cost = {
    DEFAULT_RATES: DEFAULT_RATES,
    DEFAULT_ALLOWANCE_USD: DEFAULT_ALLOWANCE_USD,
    DEFAULT_SIMPLE_TAX_PCT: DEFAULT_SIMPLE_TAX_PCT,
    withDefaults: withDefaults,
    effectiveCashSpreadPct: effectiveCashSpreadPct,
    cardRate: cardRate,
    methods: methods,
    compare: compare,
    dutyEstimate: dutyEstimate,
  };
})(window);
