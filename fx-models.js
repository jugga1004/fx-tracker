(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 예측 모델 + walk-forward 백테스트
  // ---------------------------------------------------------------------
  // 이 파일의 본체는 예측이 아니라 "성적표"다.
  //
  // 단기 환율 예측은 Meese-Rogoff(1983) 이후 40년 넘게 랜덤워크(= 내일도 오늘과
  // 같다)를 안정적으로 이기는 모델이 나오지 않은 영역이다. 그래서 여기 있는
  // 모델들은 전부 랜덤워크를 기준선으로 두고 채점당하며, 화면에는 예측값 옆에
  // 반드시 그 채점 결과가 함께 나간다. 성적표 없는 예측 숫자는 내보내지 않는다.
  //
  // look-ahead(미래 참조) 차단 규칙:
  //   predict(rates, logRet, t, h)는 인덱스 t 이하만 읽는다. 절대 t+1 이상을
  //   건드리지 않는다. 이 규칙이 깨지면 성적이 좋아 보이는데 실전에선 무의미해진다.
  //   검증: randomWalk를 자기 자신으로 채점하면 Theil's U가 정확히 1.000이어야 한다.

  var MIN_TRAIN = 250; // 첫 예측 전에 최소 1년치는 쌓고 시작
  var Z95 = 1.96;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ---------------------------------------------------------------------
  // 모델들 — 전부 (rates, logRet, t, h) → 예측값
  // ---------------------------------------------------------------------

  var MODELS = [
    {
      key: "randomWalk",
      label: "랜덤워크 (기준선)",
      note: "내일도 오늘과 같다고 본다. 다른 모델은 전부 이걸 이겨야 의미가 있다.",
      predict: function (rates, logRet, t) {
        return rates[t];
      },
    },

    {
      key: "maReversion",
      label: "이동평균 회귀",
      note: "최근 20일 평균 쪽으로 30%만큼 되돌아온다고 가정.",
      params: { n: 20, lambda: 0.3 },
      predict: function (rates, logRet, t) {
        var n = 20;
        if (t + 1 < n) return rates[t];
        var s = 0;
        for (var i = t - n + 1; i <= t; i++) s += rates[i];
        var ma = s / n;
        return rates[t] + 0.3 * (ma - rates[t]);
      },
    },

    {
      key: "linearDrift",
      label: "선형 추세 연장",
      note: "최근 60일 회귀직선의 기울기가 h일 더 이어진다고 가정.",
      params: { n: 60 },
      predict: function (rates, logRet, t, h) {
        var n = 60;
        if (t + 1 < n) return rates[t];
        // x = 0..n-1 로 두면 sumX, sumXX가 상수라 매번 계산할 필요가 없다.
        var sumX = (n * (n - 1)) / 2;
        var sumXX = ((n - 1) * n * (2 * n - 1)) / 6;
        var sumY = 0;
        var sumXY = 0;
        for (var k = 0; k < n; k++) {
          var y = rates[t - n + 1 + k];
          sumY += y;
          sumXY += k * y;
        }
        var denom = n * sumXX - sumX * sumX;
        if (denom === 0) return rates[t];
        var slope = (n * sumXY - sumX * sumY) / denom;
        return rates[t] + slope * h;
      },
    },

    {
      key: "ar1",
      label: "로그수익률 AR(1)",
      note: "어제 움직인 방향이 오늘도 이어지는지(자기상관)를 최근 60일로 추정.",
      params: { n: 60 },
      predict: function (rates, logRet, t, h) {
        var n = 60;
        // logRet[i]는 i>=1에서만 유효. (r_{i-1}, r_i) 쌍이 n개 필요.
        if (t < n + 1) return rates[t];
        var start = t - n + 1;
        var sx = 0;
        var sy = 0;
        var sxx = 0;
        var sxy = 0;
        for (var i = start; i <= t; i++) {
          var x = logRet[i - 1];
          var y = logRet[i];
          sx += x;
          sy += y;
          sxx += x * x;
          sxy += x * y;
        }
        var denom = n * sxx - sx * sx;
        if (denom === 0 || !isFinite(denom)) return rates[t];
        var phi = clamp((n * sxy - sx * sy) / denom, -0.95, 0.95); // 폭발 방지
        var c = sy / n - (phi * sx) / n;

        // h스텝 앞까지 반복 대입해 누적 기대 로그수익률을 구한다.
        var r = logRet[t];
        var cum = 0;
        for (var step = 0; step < h; step++) {
          r = c + phi * r;
          cum += r;
        }
        if (!isFinite(cum)) return rates[t];
        return rates[t] * Math.exp(cum);
      },
    },
  ];

  function modelByKey(key) {
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].key === key) return MODELS[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // walk-forward 백테스트
  // ---------------------------------------------------------------------
  // 각 시점 t에서 t 이하만 보고 t+h를 예측 → 실제값과 비교. 이걸 데이터 전체에
  // 대해 굴린다. 학습/검증을 한 번 나누는 방식보다 표본이 훨씬 많고,
  // "그때그때 가진 정보만으로 예측했다면" 이라는 실제 상황과 같다.

  function computeLogReturns(rates) {
    var out = new Array(rates.length);
    out[0] = NaN;
    for (var i = 1; i < rates.length; i++) {
      out[i] = Math.log(rates[i] / rates[i - 1]);
    }
    return out;
  }

  // Wilson 점수구간 — 표본 비율의 신뢰구간. 정규근사보다 소표본/극단값에서 안정적.
  function wilsonInterval(hits, n, z) {
    if (!n) return { low: NaN, high: NaN };
    var p = hits / n;
    var z2 = z * z;
    var denom = 1 + z2 / n;
    var center = (p + z2 / (2 * n)) / denom;
    var half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return { low: (center - half) * 100, high: (center + half) * 100 };
  }

  // rows: [{date, rate}], horizons: [1, 5, 20] 같은 영업일 수
  // 반환: { horizons: [{ h, n, results: [{...모델별 성적...}] }], trainStart, ... }
  function backtest(rows, horizons) {
    if (!rows || rows.length < MIN_TRAIN + 30) return null;
    horizons = horizons || [1, 5, 20];

    var rates = rows.map(function (r) {
      return r.rate;
    });
    var logRet = computeLogReturns(rates);

    var byHorizon = horizons.map(function (h) {
      var last = rates.length - 1 - h;
      if (last < MIN_TRAIN) return null;

      // 모델별 누적기
      var acc = MODELS.map(function (m) {
        return { model: m, sse: 0, sae: 0, n: 0, hits: 0, decided: 0 };
      });

      for (var t = MIN_TRAIN; t <= last; t++) {
        var actual = rates[t + h];
        var base = rates[t];
        var actualDir = actual > base ? 1 : actual < base ? -1 : 0;

        for (var mi = 0; mi < acc.length; mi++) {
          var a = acc[mi];
          var pred = a.model.predict(rates, logRet, t, h);
          if (!isFinite(pred)) continue;
          var err = pred - actual;
          a.sse += err * err;
          a.sae += Math.abs(err);
          a.n++;

          var predDir = pred > base ? 1 : pred < base ? -1 : 0;
          // 랜덤워크는 항상 predDir=0(방향을 안 찍음)이라 방향 적중률이 정의되지 않는다.
          if (predDir !== 0 && actualDir !== 0) {
            a.decided++;
            if (predDir === actualDir) a.hits++;
          }
        }
      }

      var rwRmse = null;
      acc.forEach(function (a) {
        if (a.model.key === "randomWalk" && a.n) rwRmse = Math.sqrt(a.sse / a.n);
      });

      var results = acc
        .filter(function (a) {
          return a.n > 0;
        })
        .map(function (a) {
          var rmse = Math.sqrt(a.sse / a.n);
          var ci = wilsonInterval(a.hits, a.decided, Z95);
          var hitRate = a.decided ? (a.hits / a.decided) * 100 : NaN;
          return {
            key: a.model.key,
            label: a.model.label,
            note: a.model.note,
            n: a.n,
            rmse: rmse,
            mae: a.sae / a.n,
            // U < 1 이면 랜덤워크보다 오차가 작다는 뜻. 실제로는 거의 1 이상이 나온다.
            theilU: rwRmse ? rmse / rwRmse : NaN,
            decided: a.decided,
            hits: a.hits,
            hitRate: hitRate,
            hitCiLow: ci.low,
            hitCiHigh: ci.high,
            // 50%가 신뢰구간 밖에 있어야 "동전 던지기와 다르다"고 말할 수 있다.
            directionSignificant: isFinite(ci.low) && (ci.low > 50 || ci.high < 50),
            beatsRandomWalk: rwRmse ? rmse < rwRmse : false,
            isBaseline: a.model.key === "randomWalk",
          };
        });

      return { h: h, count: last - MIN_TRAIN + 1, results: results };
    });

    return {
      horizons: byHorizon.filter(Boolean),
      trainStart: rows[MIN_TRAIN] ? rows[MIN_TRAIN].date : null,
      dataFrom: rows[0].date,
      dataTo: rows[rows.length - 1].date,
      minTrain: MIN_TRAIN,
    };
  }

  // 지금 시점에서 각 모델이 내놓는 h일 뒤 예측값.
  // 화면에서는 이 값을 backtest 성적과 반드시 짝지어 보여준다.
  function predictNow(rows, h) {
    if (!rows || rows.length < 2) return [];
    var rates = rows.map(function (r) {
      return r.rate;
    });
    var logRet = computeLogReturns(rates);
    var t = rates.length - 1;
    return MODELS.map(function (m) {
      var pred = m.predict(rates, logRet, t, h);
      return {
        key: m.key,
        label: m.label,
        value: isFinite(pred) ? pred : NaN,
        changePct: isFinite(pred) ? ((pred - rates[t]) / rates[t]) * 100 : NaN,
      };
    });
  }

  global.FxModels = {
    MODELS: MODELS,
    modelByKey: modelByKey,
    backtest: backtest,
    predictNow: predictNow,
    computeLogReturns: computeLogReturns,
    wilsonInterval: wilsonInterval,
    MIN_TRAIN: MIN_TRAIN,
  };
})(window);
