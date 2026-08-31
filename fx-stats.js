(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 현황 지표 — "지금 환율이 과거 분포의 어디쯤인가"만 계산한다.
  // ---------------------------------------------------------------------
  // 여기 있는 건 전부 과거를 요약한 값이지 미래에 대한 주장이 아니다.
  // 예측은 fx-models.js가 담당하고, 그쪽은 성적표를 항상 달고 다닌다.

  var TRADING_DAYS_PER_YEAR = 252;

  function sliceSince(rows, iso) {
    var out = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].date < iso) break;
      out.push(rows[i]);
    }
    return out.reverse();
  }

  function values(rows) {
    return rows.map(function (r) {
      return r.rate;
    });
  }

  function mean(arr) {
    if (!arr.length) return NaN;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  // 표본표준편차 (n-1). 표본이 2개 미만이면 NaN.
  function stdev(arr) {
    if (arr.length < 2) return NaN;
    var m = mean(arr);
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / (arr.length - 1));
  }

  // value 이하인 관측치의 비율(%). 0에 가까울수록 과거 대비 낮은 환율.
  function percentileRank(arr, value) {
    if (!arr.length) return NaN;
    var count = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] <= value) count++;
    }
    return (count / arr.length) * 100;
  }

  // 마지막 n개의 단순이동평균. 데이터가 모자라면 NaN(억지로 짧게 계산하지 않는다).
  function sma(rows, n) {
    if (rows.length < n) return NaN;
    var s = 0;
    for (var i = rows.length - n; i < rows.length; i++) s += rows[i].rate;
    return s / n;
  }

  function minMax(rows) {
    if (!rows.length) return { min: NaN, max: NaN, minDate: null, maxDate: null };
    var min = rows[0];
    var max = rows[0];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].rate < min.rate) min = rows[i];
      if (rows[i].rate > max.rate) max = rows[i];
    }
    return { min: min.rate, max: max.rate, minDate: min.date, maxDate: max.date };
  }

  // 연속한 두 관측치의 로그수익률. 주말이 껴서 간격이 고르지 않지만,
  // 영업일 기준으로는 연속이므로 그대로 쓴다(환율 분석의 일반적 관행).
  function logReturns(rows) {
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1].rate;
      var cur = rows[i].rate;
      if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
    }
    return out;
  }

  // 최근 n영업일 로그수익률의 일간 표준편차.
  function dailyVolatility(rows, n) {
    var window = n && rows.length > n ? rows.slice(rows.length - n - 1) : rows;
    return stdev(logReturns(window));
  }

  // ---------------------------------------------------------------------
  // 변동성 밴드 — 예측이 아니라 "불확실성의 크기"
  // ---------------------------------------------------------------------
  // 환율이 기하 브라운 운동을 따른다고 가정했을 때 h영업일 뒤 값의 구간.
  // 중심이 현재값이라는 건 곧 "제일 그럴듯한 예측은 오늘 값"이라는 뜻이고,
  // 그게 바로 랜덤워크다. 밴드 폭을 눈으로 보면 왜 방향 예측이 무의미한지
  // 바로 이해된다 — 그게 이 지표를 넣은 이유다.
  function volatilityBand(lastRate, dailySigma, horizonDays, z) {
    if (!isFinite(lastRate) || !isFinite(dailySigma)) return { low: NaN, high: NaN };
    var sigmaH = dailySigma * Math.sqrt(horizonDays);
    return {
      low: lastRate * Math.exp(-z * sigmaH),
      high: lastRate * Math.exp(z * sigmaH),
      sigmaH: sigmaH,
    };
  }

  // ---------------------------------------------------------------------
  // 화면에 필요한 지표 한 묶음
  // ---------------------------------------------------------------------
  function summary(rows) {
    if (!rows || rows.length < 2) return null;

    var last = rows[rows.length - 1];
    var prev = rows[rows.length - 2];
    var today = last.date;

    function windowStats(label, startISO) {
      var w = sliceSince(rows, startISO);
      if (w.length < 2) return null;
      var vals = values(w);
      var mm = minMax(w);
      var m = mean(vals);
      var sd = stdev(vals);
      return {
        label: label,
        count: w.length,
        from: w[0].date,
        percentile: percentileRank(vals, last.rate),
        mean: m,
        min: mm.min,
        max: mm.max,
        minDate: mm.minDate,
        maxDate: mm.maxDate,
        z: isFinite(sd) && sd > 0 ? (last.rate - m) / sd : NaN,
      };
    }

    var dailySigma = dailyVolatility(rows, 120);

    return {
      lastDate: last.date,
      lastRate: last.rate,
      prevDate: prev.date,
      changeAbs: last.rate - prev.rate,
      changePct: ((last.rate - prev.rate) / prev.rate) * 100,

      ma20: sma(rows, 20),
      ma60: sma(rows, 60),
      ma120: sma(rows, 120),

      dailySigma: dailySigma,
      annualVolPct: isFinite(dailySigma) ? dailySigma * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100 : NaN,

      // 68%/95%는 각각 z=1, z=1.96
      band5d68: volatilityBand(last.rate, dailySigma, 5, 1),
      band5d95: volatilityBand(last.rate, dailySigma, 5, 1.96),
      band20d68: volatilityBand(last.rate, dailySigma, 20, 1),
      band20d95: volatilityBand(last.rate, dailySigma, 20, 1.96),

      windows: [
        windowStats("최근 1년", global.FxData.shiftYears(today, -1)),
        windowStats("최근 3년", global.FxData.shiftYears(today, -3)),
        windowStats("최근 5년", global.FxData.shiftYears(today, -5)),
      ].filter(Boolean),

      week52: minMax(sliceSince(rows, global.FxData.shiftYears(today, -1))),
    };
  }

  global.FxStats = {
    sliceSince: sliceSince,
    values: values,
    mean: mean,
    stdev: stdev,
    percentileRank: percentileRank,
    sma: sma,
    minMax: minMax,
    logReturns: logReturns,
    dailyVolatility: dailyVolatility,
    volatilityBand: volatilityBand,
    summary: summary,
    TRADING_DAYS_PER_YEAR: TRADING_DAYS_PER_YEAR,
  };
})(window);
