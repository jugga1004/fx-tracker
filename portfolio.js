(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 내 매수 기록 / 평균단가 / 평가손익 / 분할매수 계획
  // ---------------------------------------------------------------------
  // 여기가 실제로 손실 원인을 짚어주는 부분이다.
  //
  // 설계상 중요한 두 가지:
  //  1) 매수는 "고시환율"이 아니라 지불한 원화와 받은 외화로 기록한다.
  //     실효환율 = 지불원화 / 받은외화 이면 스프레드·수수료가 자동으로 포함된다.
  //     고시환율을 적어두면 실제보다 유리하게 착각하게 된다.
  //  2) 평가손익에는 팔 때 물어야 할 스프레드를 반드시 뺀다. 안 빼면
  //     본전인데 이익처럼 보인다.
  //
  // 단위 주의: rows/rate는 표기 단위(달러 1, 엔 100) 기준이지만, 사용자가 입력하는
  // 외화 금액은 실제 통화 수량(달러 수, 엔 수)이다. units = foreign / meta.unit 로
  // 환산해서 계산한다.

  var STORE_KEY = "fx.portfolio";
  var STORE_VERSION = 1;

  var DEFAULT_SETTINGS = {
    // 은행 고시 스프레드(%). 현찰 USD는 통상 1.75% 내외 — 본인 거래 조건에 맞게 수정.
    sellSpreadPct: { USD: 1.75, JPY: 1.75 },
    // 환전 우대율(%). 80이면 스프레드의 80%를 깎아준다는 뜻.
    preferentialPct: { USD: 0, JPY: 0 },
    // 국내 매매기준율 JSON 주소. 비워두면 같은 저장소의 ./data/rates.json을 읽는다.
    // 앱을 다른 곳에 올렸을 때만 절대 주소를 넣는다 — 인증키는 GitHub Secrets에만 있다.
    ratesUrl: "",
  };


  var state = null;

  function uid() {
    return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function blank() {
    return {
      v: STORE_VERSION,
      buys: [],
      plans: [],
      alerts: [],
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    };
  }

  // 예전 버전이나 손상된 데이터가 들어와도 화면이 안 죽게 빠진 필드를 채운다.
  // load()와 importJSON() 양쪽에서 쓴다 — load()는 state가 이미 있으면 곧장 반환하므로
  // importJSON이 이 함수를 직접 부르지 않으면 가져온 데이터의 빈 필드가 그대로 남는다.
  function normalize(obj) {
    var s = obj && typeof obj === "object" ? obj : blank();
    if (!Array.isArray(s.buys)) s.buys = [];
    if (!Array.isArray(s.plans)) s.plans = [];
    if (!Array.isArray(s.alerts)) s.alerts = [];
    if (!s.settings) s.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!s.settings.sellSpreadPct) s.settings.sellSpreadPct = { USD: 1.75, JPY: 1.75 };
    if (!s.settings.preferentialPct) s.settings.preferentialPct = { USD: 0, JPY: 0 };
    if (typeof s.settings.ratesUrl !== "string") s.settings.ratesUrl = "";
    return s;
  }

  function load() {
    if (state) return state;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      state = normalize(raw ? JSON.parse(raw) : blank());
    } catch (err) {
      state = blank();
    }
    return state;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(load()));
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // 매수 기록
  // ---------------------------------------------------------------------

  function addBuy(rec) {
    var s = load();
    var krw = Number(rec.krw);
    var foreign = Number(rec.foreign);
    if (!rec.date || !global.FxData.CURRENCIES[rec.code]) throw new Error("날짜와 통화를 확인해주세요.");
    if (!(krw > 0) || !(foreign > 0)) throw new Error("지불 원화와 받은 외화는 0보다 커야 합니다.");
    s.buys.push({
      id: uid(),
      date: rec.date,
      code: rec.code,
      krw: krw,
      foreign: foreign,
      memo: rec.memo || "",
    });
    s.buys.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    save();
    return s.buys;
  }

  function removeBuy(id) {
    var s = load();
    s.buys = s.buys.filter(function (b) {
      return b.id !== id;
    });
    save();
    return s.buys;
  }

  function buysFor(code) {
    return load().buys.filter(function (b) {
      return b.code === code;
    });
  }

  // 실효환율 = 지불원화 / 표기단위 수량 (스프레드·수수료 포함된 진짜 내 환율)
  function effectiveRate(buy) {
    var meta = global.FxData.CURRENCIES[buy.code];
    var units = buy.foreign / meta.unit;
    return units > 0 ? buy.krw / units : NaN;
  }

  // 실제로 부담하는 매도 스프레드(소수). 우대율 적용 후.
  function effectiveSpread(code) {
    var s = load().settings;
    var base = Number(s.sellSpreadPct[code]);
    var pref = Number(s.preferentialPct[code]);
    if (!isFinite(base)) base = 0;
    if (!isFinite(pref)) pref = 0;
    return (base / 100) * (1 - clamp(pref, 0, 100) / 100);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ---------------------------------------------------------------------
  // 보유 요약
  // ---------------------------------------------------------------------
  // series: FxData.load(code) 결과 ({rows, lastRate, ...}). 없으면 시장가 관련 항목은 NaN.
  function summarize(code, series) {
    var meta = global.FxData.CURRENCIES[code];
    var buys = buysFor(code);
    if (!buys.length) return null;

    var totalKrw = 0;
    var totalUnits = 0;
    var totalForeign = 0;
    var fxCost = 0; // 그날 시장환율 대비 더 낸 돈 = 환전 비용
    var fxCostKnown = 0;

    buys.forEach(function (b) {
      var units = b.foreign / meta.unit;
      totalKrw += b.krw;
      totalUnits += units;
      totalForeign += b.foreign;

      if (series && series.rows && series.rows.length) {
        var mkt = global.FxData.rateOn(series.rows, b.date);
        if (mkt) {
          fxCost += b.krw - units * mkt.rate;
          fxCostKnown++;
        }
      }
    });

    var avgRate = totalUnits > 0 ? totalKrw / totalUnits : NaN;
    var marketRate = series && isFinite(series.lastRate) ? series.lastRate : NaN;
    var spread = effectiveSpread(code);
    // 지금 전부 되판다면 받게 될 환율
    var sellableRate = isFinite(marketRate) ? marketRate * (1 - spread) : NaN;
    var valueKrw = isFinite(sellableRate) ? totalUnits * sellableRate : NaN;
    var pnl = isFinite(valueKrw) ? valueKrw - totalKrw : NaN;

    // 매수 시점이 얼마나 몰려 있는지 — 손실의 주된 원인일 수 있어 별도로 본다.
    var concentration = concentrationOfBuys(buys);

    return {
      code: code,
      meta: meta,
      count: buys.length,
      firstDate: buys[0].date,
      lastDate: buys[buys.length - 1].date,
      totalKrw: totalKrw,
      totalForeign: totalForeign,
      totalUnits: totalUnits,
      avgRate: avgRate,
      marketRate: marketRate,
      marketDate: series ? series.lastDate : null,
      spreadPct: spread * 100,
      sellableRate: sellableRate,
      valueKrw: valueKrw,
      pnl: pnl,
      pnlPct: isFinite(pnl) && totalKrw > 0 ? (pnl / totalKrw) * 100 : NaN,
      // 손익분기 시장환율: 스프레드까지 물고 본전이 되려면 시장환율이 여기까지 와야 한다.
      breakEvenMarketRate: spread < 1 ? avgRate / (1 - spread) : NaN,
      fxCost: fxCostKnown === buys.length ? fxCost : NaN,
      fxCostPct: fxCostKnown === buys.length && totalKrw > 0 ? (fxCost / totalKrw) * 100 : NaN,
      concentration: concentration,
      buys: buys,
    };
  }

  // 매수 금액의 절반이 며칠 구간 안에 들어가는지 — 작을수록 한 시점에 몰빵한 것.
  function concentrationOfBuys(buys) {
    if (buys.length < 2) return null;
    var total = buys.reduce(function (s, b) {
      return s + b.krw;
    }, 0);
    var spanDays = daysBetween(buys[0].date, buys[buys.length - 1].date);
    if (spanDays <= 0) return { spanDays: 0, halfWindowDays: 0, halfSharePct: 100 };

    // 슬라이딩 윈도로 "가장 금액이 몰린 구간"을 찾는다.
    var best = { days: spanDays, share: 0 };
    for (var i = 0; i < buys.length; i++) {
      var acc = 0;
      for (var j = i; j < buys.length; j++) {
        acc += buys[j].krw;
        if (acc >= total / 2) {
          var d = daysBetween(buys[i].date, buys[j].date);
          if (d < best.days) best = { days: d, share: (acc / total) * 100 };
          break;
        }
      }
    }
    return { spanDays: spanDays, halfWindowDays: best.days, halfSharePct: best.share || 50 };
  }

  function daysBetween(a, b) {
    return Math.round((global.FxData.parseISO(b) - global.FxData.parseISO(a)) / 86400000);
  }

  // ---------------------------------------------------------------------
  // 분할매수 계획
  // ---------------------------------------------------------------------

  function addPlan(p) {
    var s = load();
    var totalKrw = Number(p.totalKrw);
    var count = Math.floor(Number(p.count));
    if (!(totalKrw > 0)) throw new Error("총 매수 금액을 확인해주세요.");
    if (!(count >= 2)) throw new Error("분할 횟수는 2회 이상이어야 합니다.");
    if (!p.startDate) throw new Error("시작일을 입력해주세요.");
    s.plans.push({
      id: uid(),
      code: p.code,
      totalKrw: totalKrw,
      count: count,
      periodUnit: p.periodUnit === "week" ? "week" : "month",
      startDate: p.startDate,
      done: 0,
    });
    save();
    return s.plans;
  }

  function removePlan(id) {
    var s = load();
    s.plans = s.plans.filter(function (p) {
      return p.id !== id;
    });
    save();
    return s.plans;
  }

  function markPlanExecuted(id, delta) {
    var s = load();
    s.plans.forEach(function (p) {
      if (p.id === id) p.done = clamp(p.done + delta, 0, p.count);
    });
    save();
    return s.plans;
  }

  function planStatus(plan) {
    var perAmount = plan.totalKrw / plan.count;
    var nextIndex = plan.done; // 0-based
    var nextDate = null;
    if (nextIndex < plan.count) {
      nextDate =
        plan.periodUnit === "week"
          ? global.FxData.shiftDays(plan.startDate, 7 * nextIndex)
          : global.FxData.shiftMonths(plan.startDate, nextIndex);
    }
    var today = global.FxData.todayISO();
    return {
      perAmount: perAmount,
      nextIndex: nextIndex,
      nextDate: nextDate,
      overdue: !!nextDate && nextDate < today,
      remainingKrw: perAmount * (plan.count - plan.done),
      donePct: (plan.done / plan.count) * 100,
      complete: plan.done >= plan.count,
    };
  }

  // ---------------------------------------------------------------------
  // 분할매수 vs 일시불 — 과거 데이터로 비교
  // ---------------------------------------------------------------------
  // "몰아서 샀다면 vs 매달 나눠 샀다면" 최종 평균단가가 어떻게 달랐는지.
  // 매수자 입장에선 평균단가가 낮을수록 좋다.
  // 주의: 이건 과거 특정 구간의 결과일 뿐 미래를 보장하지 않는다.
  function compareDcaVsLumpSum(rows, opts) {
    if (!rows || rows.length < 30) return null;
    var months = opts && opts.months ? opts.months : 36;
    var totalKrw = opts && opts.totalKrw ? opts.totalKrw : 12000000;

    var endDate = rows[rows.length - 1].date;
    var startDate = global.FxData.shiftMonths(endDate, -months);
    var first = global.FxData.rateOn(rows, startDate);
    if (!first) return null;

    // 일시불: 시작일에 전액
    var lumpUnits = totalKrw / first.rate;

    // 분할: 매달 같은 금액
    var per = totalKrw / months;
    var dcaUnits = 0;
    var used = 0;
    for (var i = 0; i < months; i++) {
      var d = global.FxData.shiftMonths(startDate, i);
      if (d > endDate) break;
      var r = global.FxData.rateOn(rows, d);
      if (!r) continue;
      dcaUnits += per / r.rate;
      used++;
    }
    if (!used) return null;

    var lumpAvg = totalKrw / lumpUnits;
    var dcaAvg = (per * used) / dcaUnits;

    return {
      months: months,
      installments: used,
      totalKrw: totalKrw,
      startDate: startDate,
      endDate: endDate,
      lumpAvgRate: lumpAvg,
      dcaAvgRate: dcaAvg,
      // 양수면 분할매수의 평균단가가 더 낮았다(= 유리했다)는 뜻
      dcaAdvantagePct: ((lumpAvg - dcaAvg) / lumpAvg) * 100,
    };
  }

  // ---------------------------------------------------------------------
  // 목표환율 알림
  // ---------------------------------------------------------------------
  // 브라우저 백그라운드 푸시는 서버가 있어야 가능하다. 정적 PWA라 서버가 없으므로
  // "앱을 연 시점에" 조건을 확인해서 화면에 띄우는 방식만 지원한다. 이 한계는
  // 화면에도 그대로 적어둔다.

  function addAlert(a) {
    var s = load();
    var rate = Number(a.rate);
    if (!(rate > 0)) throw new Error("목표 환율을 확인해주세요.");
    s.alerts.push({
      id: uid(),
      code: a.code,
      direction: a.direction === "above" ? "above" : "below",
      rate: rate,
    });
    save();
    return s.alerts;
  }

  function removeAlert(id) {
    var s = load();
    s.alerts = s.alerts.filter(function (a) {
      return a.id !== id;
    });
    save();
    return s.alerts;
  }

  function triggeredAlerts(seriesMap) {
    return load().alerts.filter(function (a) {
      var s = seriesMap[a.code];
      if (!s || !isFinite(s.lastRate)) return false;
      return a.direction === "below" ? s.lastRate <= a.rate : s.lastRate >= a.rate;
    });
  }

  // ---------------------------------------------------------------------
  // 설정 / 내보내기 / 가져오기
  // ---------------------------------------------------------------------

  function getSettings() {
    return load().settings;
  }

  function setSpread(code, spreadPct, prefPct) {
    var s = load();
    if (isFinite(Number(spreadPct))) s.settings.sellSpreadPct[code] = Number(spreadPct);
    if (isFinite(Number(prefPct))) s.settings.preferentialPct[code] = clamp(Number(prefPct), 0, 100);
    save();
    return s.settings;
  }

  function setRatesUrl(url) {
    var s = load();
    s.settings.ratesUrl = String(url || "").trim().replace(/\/+$/, "");
    save();
    return s.settings.ratesUrl;
  }

  function exportJSON() {
    return JSON.stringify(load(), null, 2);
  }

  // localStorage는 브라우저 정리 한 번이면 날아간다. 가져오기가 없으면 복구가 불가능하므로
  // 내보내기와 짝으로 반드시 있어야 한다.
  function importJSON(text) {
    var obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.buys)) throw new Error("이 파일은 환율 추적기 백업이 아닙니다.");
    state = normalize(obj);
    save();
    return state;
  }

  function resetAll() {
    state = blank();
    save();
    return state;
  }

  global.Portfolio = {
    load: load,
    save: save,
    addBuy: addBuy,
    removeBuy: removeBuy,
    buysFor: buysFor,
    effectiveRate: effectiveRate,
    effectiveSpread: effectiveSpread,
    summarize: summarize,
    addPlan: addPlan,
    removePlan: removePlan,
    markPlanExecuted: markPlanExecuted,
    planStatus: planStatus,
    compareDcaVsLumpSum: compareDcaVsLumpSum,
    addAlert: addAlert,
    removeAlert: removeAlert,
    triggeredAlerts: triggeredAlerts,
    getSettings: getSettings,
    setSpread: setSpread,
    setRatesUrl: setRatesUrl,
    exportJSON: exportJSON,
    importJSON: importJSON,
    resetAll: resetAll,
  };
})(window);
