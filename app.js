(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 화면 로직
  // ---------------------------------------------------------------------
  // 계산은 전부 fx-stats / fx-models / portfolio 가 하고, 여기서는 그리기만 한다.
  // 백테스트는 무거워서(수만 번 예측) 탭을 처음 열 때 한 번만 돌리고 캐시한다.

  var state = {
    series: {}, // code -> FxData.load 결과
    view: "overview",
    ccy: "USD",
    modelCcy: "USD",
    rangeMonths: 12,
    dcaMonths: 36,
    backtestCache: {}, // code -> backtest 결과
    domesticError: null, // 국내 고시환율 연동 실패 메시지 (있으면 ECB로 폴백)
  };

  var HORIZONS = [1, 5, 20];

  // ---------------------------------------------------------------------
  // 환율 소스 분리
  // ---------------------------------------------------------------------
  // ECB(state.series)      → 장기 시계열이 필요한 곳: 차트, 백분위, 이동평균, 백테스트
  // 국내 매매기준율(FxDomestic) → 금액이 걸린 곳: 현재 환율, 평가손익, 환전 비용, 면세점
  //
  // 차트에 두 소스를 섞으면 0.4%짜리 계단이 생겨 추세를 왜곡하므로 차트는 ECB만 쓴다.
  // 반대로 손익은 실제 국내 환율로 내야 의미가 있어서 그쪽만 갈아끼운다.

  var hybridCache = {};
  var domesticVersion = 0;

  function bumpDomestic() {
    domesticVersion++;
    hybridCache = {};
  }

  function domesticRows(code) {
    var dom = FxDomestic.all(code);
    return Object.keys(dom)
      .sort()
      .map(function (d) {
        return { date: d, rate: dom[d] };
      });
  }

  // 금액 계산용 시계열. 국내 환율이 있는 날짜는 그 값으로 덮고, 없으면 ECB로 떨어진다.
  // Portfolio.summarize()가 기대하는 형태를 그대로 유지하므로 portfolio.js는 손댈 필요가 없다.
  function ratesSeries(code) {
    var base = state.series[code];
    if (!base || !base.rows || !base.rows.length) return base;
    if (!FxDomestic.available()) return base;

    var key = code + ":" + domesticVersion;
    if (hybridCache[key]) return hybridCache[key];

    var dom = FxDomestic.all(code);
    var domDates = Object.keys(dom);
    if (!domDates.length) return base;

    var map = {};
    base.rows.forEach(function (r) {
      map[r.date] = r.rate;
    });
    domDates.forEach(function (d) {
      map[d] = dom[d];
    });
    var rows = Object.keys(map)
      .sort()
      .map(function (d) {
        return { date: d, rate: map[d] };
      });

    var latest = FxDomestic.latest(code);
    var last = rows[rows.length - 1];
    var out = {
      code: code,
      meta: base.meta,
      rows: rows,
      lastDate: latest ? latest.date : last.date,
      lastRate: latest ? latest.rate : last.rate,
      fetchedAt: base.fetchedAt,
      stale: base.stale,
      error: base.error,
      source: FxDomestic.SOURCE_LABEL,
      domestic: true,
    };
    hybridCache[key] = out;
    return out;
  }

  function moneySeriesMap() {
    var out = {};
    Object.keys(FxData.CURRENCIES).forEach(function (c) {
      out[c] = ratesSeries(c);
    });
    return out;
  }

  // GitHub Actions가 커밋해둔 rates.json을 읽어와 화면을 다시 그린다.
  // 실패해도 ECB로 계속 돌아가야 하므로 절대 예외를 위로 던지지 않는다.
  // (file://로 열면 fetch가 막혀 항상 실패한다 — 그래도 앱은 정상 동작한다)
  function syncDomestic() {
    return FxDomestic.sync().then(function (res) {
      state.domesticError = res && res.error ? res.error : null;
      bumpDomestic();
      renderHeader();
      setView(state.view);
      return res;
    });
  }

  // ---------------------------------------------------------------------
  // 포맷터
  // ---------------------------------------------------------------------

  function num(v, digits) {
    if (!isFinite(v)) return "—";
    return v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // 환율은 소수점 한 자리까지만 보여준다. 매매기준율 자체가 1,380.3 처럼
  // 한 자리로 고시되므로 두 자리로 늘려 봐야 없는 정밀도를 지어내는 셈이다.
  // (저장값은 원본 그대로 두고 표시만 반올림한다)
  function rate(v) {
    return num(v, 1);
  }

  function won(v) {
    if (!isFinite(v)) return "—";
    return Math.round(v).toLocaleString("ko-KR") + "원";
  }

  function signedWon(v) {
    if (!isFinite(v)) return "—";
    return (v > 0 ? "+" : "") + Math.round(v).toLocaleString("ko-KR") + "원";
  }

  function pct(v, digits) {
    if (!isFinite(v)) return "—";
    return num(v, digits === undefined ? 2 : digits) + "%";
  }

  function signedPct(v, digits) {
    if (!isFinite(v)) return "—";
    return (v > 0 ? "+" : "") + pct(v, digits);
  }

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function $(id) {
    return document.getElementById(id);
  }

  function pnlClass(v) {
    return !isFinite(v) ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "";
  }

  // ---------------------------------------------------------------------
  // 부팅
  // ---------------------------------------------------------------------

  function init() {
    buildCurrencySelectors();
    wireTabs();
    wireOverview();
    wireHoldings();
    wirePlan();
    wireDutyFree();
    wireRatesSource();

    $("footerSource").textContent =
      "시계열(차트·통계): " +
      FxData.sourceLabel() +
      ", 최근 " +
      FxData.HISTORY_YEARS +
      "년 · 금액 계산: " +
      FxDomestic.SOURCE_LABEL +
      " (없으면 ECB)";

    // 오늘 날짜를 기본값으로
    var today = FxData.todayISO();
    $("buyDate").value = today;
    $("planStart").value = today;


    FxData.loadAll()
      .then(function (map) {
        state.series = map;
        $("globalLoading").hidden = true;
        var failed = Object.keys(map).filter(function (c) {
          return !map[c].rows || !map[c].rows.length;
        });
        if (failed.length === Object.keys(map).length) {
          showGlobalError(
            "환율 데이터를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해주세요. (" +
              (map[failed[0]].error || "원인 불명") +
              ")"
          );
          return;
        }
        renderAll();
        // ECB로 먼저 그려놓고, 국내 환율은 붙는 대로 덮어쓴다.
        // 프록시가 느리거나 죽어 있어도 화면은 이미 떠 있다.
        syncDomestic();
      })
      .catch(function (err) {
        $("globalLoading").hidden = true;
        showGlobalError("환율 데이터를 불러오지 못했습니다: " + err.message);
      });

    registerServiceWorker();
  }

  function showGlobalError(msg) {
    var box = $("globalError");
    box.textContent = msg;
    box.hidden = false;
  }

  // 서비스워커는 https 또는 localhost에서만 동작한다. file:// 로 열면 등록이 실패하는데,
  // 오프라인 캐싱만 못 쓸 뿐 앱 자체는 정상 동작해야 하므로 조용히 넘어간다.
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost") return;
    navigator.serviceWorker.register("sw.js").catch(function () {
      /* 무시 */
    });
  }

  function buildCurrencySelectors() {
    var codes = Object.keys(FxData.CURRENCIES);

    function segHtml(active) {
      return codes
        .map(function (c) {
          var m = FxData.CURRENCIES[c];
          return (
            '<button type="button" data-ccy="' +
            c +
            '"' +
            (c === active ? ' class="is-active"' : "") +
            ">" +
            esc(m.label) +
            "</button>"
          );
        })
        .join("");
    }

    $("ccyToggle").innerHTML = segHtml(state.ccy);
    $("modelCcyToggle").innerHTML = segHtml(state.modelCcy);

    var optsHtml = codes
      .map(function (c) {
        return '<option value="' + c + '">' + esc(FxData.CURRENCIES[c].label) + "</option>";
      })
      .join("");
    ["buyCcy", "planCcy", "alertCcy"].forEach(function (id) {
      $(id).innerHTML = optsHtml;
    });

    $("ccyToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-ccy]");
      if (!btn) return;
      state.ccy = btn.dataset.ccy;
      $("ccyToggle").innerHTML = segHtml(state.ccy);
      renderOverview();
    });

    $("modelCcyToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-ccy]");
      if (!btn) return;
      state.modelCcy = btn.dataset.ccy;
      $("modelCcyToggle").innerHTML = segHtml(state.modelCcy);
      renderModels();
    });
  }

  function wireTabs() {
    $("tabs").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-view]");
      if (!btn) return;
      setView(btn.dataset.view);
    });
  }

  function setView(view) {
    state.view = view;
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) {
      b.setAttribute("aria-selected", b.dataset.view === view ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".view"), function (s) {
      s.hidden = s.id !== "view-" + view;
    });
    if (view === "models") renderModels();
    if (view === "plan") renderPlan();
    if (view === "holdings") renderHoldings();
    if (view === "overview") renderOverview();
    if (view === "dutyfree") renderDutyFree();
  }

  function renderAll() {
    renderHeader();
    setView(state.view);
  }

  // ---------------------------------------------------------------------
  // 헤더 (환율 카드 / 데이터 상태 / 알림)
  // ---------------------------------------------------------------------

  function renderHeader() {
    var codes = Object.keys(FxData.CURRENCIES);
    var useDom = FxDomestic.available();
    var domShown = false;

    $("rateCards").innerHTML = codes
      .map(function (c) {
        var m = FxData.CURRENCIES[c];
        var ecb = state.series[c];
        var dom = useDom ? domesticRows(c) : [];

        var primary = null;
        var delta = null;
        var sub = "";

        if (dom.length) {
          // 국내 매매기준율이 있으면 그쪽을 대표값으로 쓴다. 전일 대비도
          // 반드시 같은 소스끼리 비교해야 해서 국내 값끼리만 뺀다.
          domShown = true;
          primary = dom[dom.length - 1];
          if (dom.length >= 2) {
            var prev = dom[dom.length - 2];
            delta = { abs: primary.rate - prev.rate, pct: ((primary.rate - prev.rate) / prev.rate) * 100 };
          }
          if (ecb && ecb.rows && ecb.rows.length) {
            sub = "ECB " + rate(ecb.lastRate) + " (" + ecb.lastDate.slice(5) + ")";
          }
        } else if (ecb && ecb.rows && ecb.rows.length) {
          var st = FxStats.summary(ecb.rows);
          primary = { date: ecb.lastDate, rate: ecb.lastRate };
          if (st) delta = { abs: st.changeAbs, pct: st.changePct };
        }

        if (!primary) {
          return (
            '<div class="rate-card"><div class="rate-card__label">' +
            esc(m.label) +
            '</div><div class="rate-card__value">—</div></div>'
          );
        }

        return (
          '<div class="rate-card">' +
          '<div class="rate-card__label">' +
          esc(m.label) +
          " <span>" +
          esc(m.unitLabel) +
          "</span></div>" +
          '<div class="rate-card__value">' +
          rate(primary.rate) +
          "<small>원</small></div>" +
          '<div class="rate-card__delta ' +
          pnlClass(delta ? delta.abs : NaN) +
          '">' +
          (delta
            ? (delta.abs > 0 ? "▲ " : delta.abs < 0 ? "▼ " : "") +
              rate(Math.abs(delta.abs)) +
              " (" +
              signedPct(delta.pct) +
              ")"
            : "") +
          "</div>" +
          (sub ? '<div class="rate-card__sub">' + sub + "</div>" : "") +
          "</div>"
        );
      })
      .join("");

    var ecbAny = codes
      .map(function (c) {
        return state.series[c];
      })
      .filter(function (s) {
        return s && s.rows && s.rows.length;
      })[0];

    var stale = codes.some(function (c) {
      return state.series[c] && state.series[c].stale;
    });

    var statusHtml = "";
    if (domShown) {
      statusHtml =
        "국내 매매기준율 <strong>" +
        esc(FxDomestic.latestDate() || "—") +
        "</strong> (한국수출입은행) · 차트·통계는 ECB 시계열 기준";
    } else if (ecbAny) {
      statusHtml = "기준일 <strong>" + esc(ecbAny.lastDate) + "</strong> · ECB 공시 기준(은행 고시환율과 다름)";
    }
    if (stale) statusHtml += ' <span class="badge badge--warn">오프라인 — 저장된 데이터</span>';
    // 국내 환율이 아예 없는 건 흔한 정상 상태(file://로 열었거나 Actions 첫 실행 전)라
    // 헤더에서 경고하지 않는다. 저장된 값은 있는데 갱신만 실패한 경우에만 알린다.
    if (domShown && state.domesticError) {
      statusHtml += ' <span class="badge badge--warn">환율 파일 갱신 실패 — 저장된 값 사용 중</span>';
    }
    $("dataStatus").innerHTML = statusHtml;

    renderAlertBanner();
  }

  function renderAlertBanner() {
    var seriesMap = moneySeriesMap();
    var hits = Portfolio.triggeredAlerts(seriesMap);
    var box = $("alertBanner");
    if (!hits.length) {
      box.hidden = true;
      return;
    }
    box.innerHTML =
      "<strong>목표 환율 도달</strong> " +
      hits
        .map(function (a) {
          var m = FxData.CURRENCIES[a.code];
          return (
            esc(m.label) +
            " " +
            rate(seriesMap[a.code].lastRate) +
            "원 (" +
            rate(a.rate) +
            " " +
            (a.direction === "below" ? "이하" : "이상") +
            ")"
          );
        })
        .join(" · ");
    box.hidden = false;
  }

  // ---------------------------------------------------------------------
  // 현황 탭
  // ---------------------------------------------------------------------

  function wireOverview() {
    $("rangeToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-months]");
      if (!btn) return;
      state.rangeMonths = Number(btn.dataset.months);
      Array.prototype.forEach.call($("rangeToggle").children, function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      renderChart();
    });

    $("alertForm").addEventListener("submit", function (e) {
      e.preventDefault();
      try {
        Portfolio.addAlert({
          code: $("alertCcy").value,
          direction: $("alertDir").value,
          rate: $("alertRate").value,
        });
        $("alertRate").value = "";
        renderAlerts();
        renderAlertBanner();
      } catch (err) {
        alert(err.message);
      }
    });

    $("alertList").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-del]");
      if (!btn) return;
      Portfolio.removeAlert(btn.dataset.del);
      renderAlerts();
      renderAlertBanner();
    });
  }

  function renderOverview() {
    renderChart();
    renderPosition();
    renderBand();
    renderAlerts();
  }

  function currentSeries() {
    return state.series[state.ccy];
  }

  function renderChart() {
    var s = currentSeries();
    var box = $("chartBox");
    if (!s || !s.rows || !s.rows.length) {
      box.innerHTML = '<p class="muted small">데이터가 없습니다.</p>';
      return;
    }

    var rows = s.rows;
    if (state.rangeMonths > 0) {
      rows = FxStats.sliceSince(rows, FxData.shiftMonths(s.lastDate, -state.rangeMonths));
    }
    if (rows.length < 2) rows = s.rows;

    var markers = Portfolio.buysFor(state.ccy)
      .filter(function (b) {
        return b.date >= rows[0].date;
      })
      .map(function (b) {
        var er = Portfolio.effectiveRate(b);
        return { date: b.date, rate: er, label: b.date + " · 실효 " + rate(er) + "원 · " + won(b.krw) };
      });

    Chart.line(box, {
      rows: rows,
      height: 280,
      ma: [{ values: Chart.movingAverage(rows, 20) }, { values: Chart.movingAverage(rows, 60) }],
      markers: markers,
    });
  }

  function renderPosition() {
    var s = currentSeries();
    var box = $("positionBox");
    if (!s || !s.rows || s.rows.length < 2) {
      box.innerHTML = '<p class="muted small">데이터가 없습니다.</p>';
      return;
    }
    var st = FxStats.summary(s.rows);
    var m = s.meta;

    var rowsHtml = st.windows
      .map(function (w) {
        var below = w.percentile;
        return (
          "<tr><th>" +
          esc(w.label) +
          "</th>" +
          "<td><strong>" +
          num(below, 0) +
          " 백분위</strong><br /><span class=\"muted small\">이 기간 관측치의 " +
          num(below, 0) +
          "%가 지금 이하였음</span></td>" +
          "<td>" +
          rate(w.min) +
          " ~ " +
          rate(w.max) +
          "</td>" +
          "<td>" +
          rate(w.mean) +
          "</td>" +
          "<td>" +
          num(w.z, 2) +
          "</td></tr>"
        );
      })
      .join("");

    function maRow(label, v) {
      if (!isFinite(v)) return "";
      var gap = ((st.lastRate - v) / v) * 100;
      return (
        "<tr><th>" +
        label +
        "</th><td>" +
        rate(v) +
        "원</td><td class=\"" +
        pnlClass(gap) +
        '">이격도 ' +
        signedPct(gap) +
        "</td></tr>"
      );
    }

    box.innerHTML =
      '<div class="table-scroll"><table class="data-table">' +
      "<thead><tr><th>기간</th><th>현재 위치</th><th>최저 ~ 최고</th><th>평균</th><th>z-score</th></tr></thead>" +
      "<tbody>" +
      rowsHtml +
      "</tbody></table></div>" +
      '<div class="table-scroll"><table class="data-table mt">' +
      "<thead><tr><th>이동평균</th><th>값 (" +
      esc(m.unitLabel) +
      " 기준)</th><th>현재 대비</th></tr></thead><tbody>" +
      maRow("20일", st.ma20) +
      maRow("60일", st.ma60) +
      maRow("120일", st.ma120) +
      "</tbody></table></div>" +
      '<p class="muted small mt">52주 최저 ' +
      rate(st.week52.min) +
      " (" +
      esc(st.week52.minDate || "—") +
      ") · 52주 최고 " +
      rate(st.week52.max) +
      " (" +
      esc(st.week52.maxDate || "—") +
      ")</p>";
  }

  function renderBand() {
    var s = currentSeries();
    var box = $("bandBox");
    if (!s || !s.rows || s.rows.length < 30) {
      box.innerHTML = '<p class="muted small">데이터가 부족합니다.</p>';
      return;
    }
    var st = FxStats.summary(s.rows);

    function bandRow(label, b68, b95) {
      return (
        "<tr><th>" +
        label +
        "</th><td>" +
        rate(b68.low) +
        " ~ " +
        rate(b68.high) +
        "</td><td>" +
        rate(b95.low) +
        " ~ " +
        rate(b95.high) +
        "</td></tr>"
      );
    }

    box.innerHTML =
      '<div class="table-scroll"><table class="data-table">' +
      "<thead><tr><th>기간</th><th>68% 구간</th><th>95% 구간</th></tr></thead><tbody>" +
      bandRow("5영업일 뒤", st.band5d68, st.band5d95) +
      bandRow("20영업일 뒤", st.band20d68, st.band20d95) +
      "</tbody></table></div>" +
      '<p class="muted small mt">최근 120영업일 변동성 기준 · 연환산 변동성 ' +
      pct(st.annualVolPct, 1) +
      "</p>";
  }

  function renderAlerts() {
    var alerts = Portfolio.load().alerts;
    var list = $("alertList");
    if (!alerts.length) {
      list.innerHTML = '<li class="muted small">등록된 알림이 없습니다.</li>';
      return;
    }
    list.innerHTML = alerts
      .map(function (a) {
        var m = FxData.CURRENCIES[a.code];
        var s = ratesSeries(a.code);
        var hit = s && isFinite(s.lastRate) && (a.direction === "below" ? s.lastRate <= a.rate : s.lastRate >= a.rate);
        return (
          "<li" +
          (hit ? ' class="hit"' : "") +
          "><span>" +
          esc(m.label) +
          " " +
          esc(m.unitLabel) +
          "당 <strong>" +
          rate(a.rate) +
          "원</strong> " +
          (a.direction === "below" ? "이하" : "이상") +
          (hit ? " — 조건 충족" : "") +
          '</span><button type="button" class="link-btn" data-del="' +
          esc(a.id) +
          '">삭제</button></li>'
        );
      })
      .join("");
  }

  // ---------------------------------------------------------------------
  // 내 보유 탭
  // ---------------------------------------------------------------------

  function wireHoldings() {
    ["buyKrw", "buyForeign", "buyCcy"].forEach(function (id) {
      $(id).addEventListener("input", updateBuyPreview);
      $(id).addEventListener("change", updateBuyPreview);
    });

    $("buyForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var box = $("buyError");
      box.hidden = true;
      try {
        Portfolio.addBuy({
          date: $("buyDate").value,
          code: $("buyCcy").value,
          krw: $("buyKrw").value,
          foreign: $("buyForeign").value,
          memo: $("buyMemo").value,
        });
        $("buyKrw").value = "";
        $("buyForeign").value = "";
        $("buyMemo").value = "";
        updateBuyPreview();
        renderHoldings();
        renderChart();
      } catch (err) {
        box.textContent = err.message;
        box.hidden = false;
      }
    });

    $("buyList").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-del]");
      if (!btn) return;
      if (!confirm("이 매수 기록을 삭제할까요?")) return;
      Portfolio.removeBuy(btn.dataset.del);
      renderHoldings();
      renderChart();
    });

    $("spreadSettings").addEventListener("change", function (e) {
      var input = e.target.closest("input[data-ccy]");
      if (!input) return;
      var code = input.dataset.ccy;
      var spread = $("spread_" + code).value;
      var pref = $("pref_" + code).value;
      Portfolio.setSpread(code, spread, pref);
      renderHoldings();
    });

    $("exportBtn").addEventListener("click", function () {
      var blob = new Blob([Portfolio.exportJSON()], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "fx-tracker-backup-" + FxData.todayISO() + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
      }, 1000);
      $("backupMsg").textContent = "내보냈습니다.";
    });

    $("importInput").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          Portfolio.importJSON(String(reader.result));
          $("backupMsg").textContent = "가져왔습니다.";
          $("ratesUrl").value = FxDomestic.configuredUrl();
          renderHoldings();
          renderPlan();
          renderDutyFree();
          renderAlerts();
          renderAlertBanner();
          renderChart();
          syncDomestic(); // 가져온 매수 기록의 날짜들도 국내 환율을 채워야 한다
        } catch (err) {
          $("backupMsg").textContent = "가져오기 실패: " + err.message;
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });

    $("resetBtn").addEventListener("click", function () {
      if (!confirm("매수 기록·계획·설정을 모두 지웁니다. 되돌릴 수 없습니다. 계속할까요?")) return;
      Portfolio.resetAll();
      FxDomestic.clear();
      bumpDomestic();
      $("ratesUrl").value = "";
      renderHeader();
      renderHoldings();
      renderPlan();
      renderDutyFree();
      renderAlerts();
      renderChart();
      $("backupMsg").textContent = "전체 삭제했습니다.";
    });
  }

  function updateBuyPreview() {
    var code = $("buyCcy").value;
    var meta = FxData.CURRENCIES[code];
    var krw = Number($("buyKrw").value);
    var foreign = Number($("buyForeign").value);
    if (!(krw > 0) || !(foreign > 0)) {
      $("buyPreview").textContent = "";
      return;
    }
    var er = krw / (foreign / meta.unit);
    $("buyPreview").textContent = "실효환율 " + meta.unitLabel + "당 " + rate(er) + "원";
  }

  function renderHoldings() {
    renderHoldingSummary();
    renderBuyList();
    renderSpreadSettings();
    renderRatesStatus();
  }

  // ---------------------------------------------------------------------
  // 국내 고시환율 데이터 소스
  // ---------------------------------------------------------------------
  // 기본값은 같은 저장소의 ./data/rates.json이라 보통은 설정할 게 없다.
  // 앱을 GitHub Pages가 아닌 곳에 올렸을 때만 절대 주소를 직접 넣는다.

  function wireRatesSource() {
    $("ratesUrl").value = FxDomestic.configuredUrl();
    $("ratesUrl").placeholder = FxDomestic.DEFAULT_URL + " (기본값)";

    $("ratesForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var url = ($("ratesUrl").value || "").trim();
      var box = $("ratesStatus");
      box.innerHTML = '<span class="loading">확인 중...</span>';

      // 비워서 저장하면 기본 경로로 되돌아간다.
      if (!url) {
        FxDomestic.setUrl("");
        syncDomestic().then(renderRatesStatus);
        return;
      }
      FxDomestic.check(url).then(
        function () {
          state.domesticError = null;
          bumpDomestic();
          renderHeader();
          setView(state.view);
          renderRatesStatus();
        },
        function (err) {
          box.innerHTML = '<span class="neg">' + esc(err.message) + "</span>";
        }
      );
    });

    $("ratesReload").addEventListener("click", function () {
      $("ratesStatus").innerHTML = '<span class="loading">다시 받는 중...</span>';
      syncDomestic().then(renderRatesStatus);
    });
  }

  function renderRatesStatus() {
    var box = $("ratesStatus");
    if (!box) return;

    if (!FxDomestic.available()) {
      box.innerHTML =
        '<span class="neg">국내 환율 데이터가 없습니다.</span> 지금은 ECB 공시 환율로 계산하고 있습니다.<br />' +
        (state.domesticError ? "사유: " + esc(state.domesticError) + "<br />" : "") +
        '<span class="muted">GitHub Actions의 「환율 갱신」이 한 번 실행돼야 <code>' +
        esc(FxDomestic.effectiveUrl()) +
        "</code> 가 생깁니다. 파일을 로컬에서 직접 열었다면(file://) 브라우저가 읽기를 막으므로 정상입니다.</span>";
      return;
    }

    var updated = FxDomestic.updatedAt();
    box.innerHTML =
      '<span class="pos">사용 중</span> · 최신 고시일 <strong>' +
      esc(FxDomestic.latestDate() || "—") +
      "</strong> · 보유 " +
      FxDomestic.count() +
      "일치 · " +
      esc(FxDomestic.SOURCE_LABEL) +
      (updated ? '<br /><span class="muted">파일 갱신 ' + esc(String(updated).slice(0, 16).replace("T", " ")) + " UTC</span>" : "") +
      (state.domesticError ? '<br /><span class="neg">최근 갱신 실패: ' + esc(state.domesticError) + " (저장된 값 사용 중)</span>" : "");
  }

  function renderHoldingSummary() {
    var box = $("holdingSummary");
    var codes = Object.keys(FxData.CURRENCIES);
    var cards = codes
      .map(function (c) {
        return Portfolio.summarize(c, ratesSeries(c));
      })
      .filter(Boolean);
    var rateSource = FxDomestic.available() && FxDomestic.count() ? "국내 매매기준율" : "ECB 공시 환율";

    if (!cards.length) {
      box.innerHTML =
        '<div class="card"><h2>아직 매수 기록이 없습니다</h2><p class="muted small">' +
        "아래에 실제로 낸 원화와 받은 외화를 입력하면 평균단가·평가손익·환전 비용이 자동으로 계산됩니다." +
        "</p></div>";
      return;
    }

    box.innerHTML = cards
      .map(function (h) {
        var conc = h.concentration;
        var concHtml = "";
        if (conc && conc.spanDays > 0) {
          // halfWindowDays가 0이면 하루 안에 절반이 채워졌다는 뜻(한 건일 수도, 같은 날 여러 건일 수도).
          // "0일 구간에 몰려 있다"는 표현은 오해를 부르므로 문장을 따로 쓴다.
          var concText =
            conc.halfWindowDays === 0
              ? "금액의 절반 이상이 하루에 몰려 있습니다."
              : "금액의 절반이 " + conc.halfWindowDays + "일 구간에 몰려 있습니다.";
          concHtml =
            '<p class="muted small mt">매수 기간 ' +
            conc.spanDays +
            "일 · " +
            concText +
            (conc.halfWindowDays * 4 < conc.spanDays ? " <strong>한 시점에 집중된 편입니다.</strong>" : "") +
            "</p>";
        }

        return (
          '<div class="card">' +
          '<div class="card__head"><h2>' +
          esc(h.meta.label) +
          "</h2><span class=\"muted small\">" +
          h.count +
          "건 · " +
          esc(h.firstDate) +
          " ~ " +
          esc(h.lastDate) +
          " · " +
          esc(rateSource) +
          " 기준</span></div>" +
          '<div class="stat-grid">' +
          stat("보유", num(h.totalForeign, 2) + " " + h.meta.amountLabel) +
          stat("투입 원화", won(h.totalKrw)) +
          stat("평균단가", rate(h.avgRate) + "원 / " + h.meta.unitLabel) +
          stat("현재 시장환율", rate(h.marketRate) + "원") +
          stat("지금 팔면", rate(h.sellableRate) + "원", "스프레드 " + pct(h.spreadPct) + " 반영") +
          stat("평가금액", won(h.valueKrw)) +
          stat("평가손익", signedWon(h.pnl), signedPct(h.pnlPct), pnlClass(h.pnl)) +
          stat("본전 시장환율", rate(h.breakEvenMarketRate) + "원", "여기까지 와야 손실 0") +
          "</div>" +
          // fxCost가 음수면 시장환율보다 유리하게 환전했다는 뜻이라 문장을 뒤집어야 한다.
          // ("환전 비용으로 -9만원을 냈습니다" 같은 문장이 나오면 안 됨)
          (isFinite(h.fxCost)
            ? '<p class="note mt">' +
              (h.fxCost >= 0
                ? "지금까지 <strong>환전 비용으로 " +
                  won(h.fxCost) +
                  "</strong>을 냈습니다 (투입액의 " +
                  pct(h.fxCostPct) +
                  ")."
                : "기록상으로는 같은 날 시장환율보다 <strong>" +
                  won(-h.fxCost) +
                  " 유리하게</strong> 환전했습니다 (투입액의 " +
                  pct(-h.fxCostPct) +
                  ").") +
              ' <span class="muted">매수일 ' +
              esc(rateSource) +
              "과 실제 지불액의 차이를 모두 더한 값입니다." +
              (rateSource === "ECB 공시 환율"
                ? " ECB 기준이라 국내 고시환율과는 0.4% 안팎 차이가 날 수 있습니다 — 「국내 고시환율 연동」을 설정하면 정확해집니다."
                : "") +
              "</span></p>"
            : "") +
          concHtml +
          "</div>"
        );
      })
      .join("");
  }

  function stat(label, value, sub, cls) {
    return (
      '<div class="stat"><div class="stat__label">' +
      esc(label) +
      '</div><div class="stat__value ' +
      (cls || "") +
      '">' +
      value +
      "</div>" +
      (sub ? '<div class="stat__sub">' + sub + "</div>" : "") +
      "</div>"
    );
  }

  function renderBuyList() {
    var buys = Portfolio.load().buys;
    var box = $("buyList");
    if (!buys.length) {
      box.innerHTML = '<p class="muted small">기록이 없습니다.</p>';
      return;
    }

    var rowsHtml = buys
      .slice()
      .reverse()
      .map(function (b) {
        var meta = FxData.CURRENCIES[b.code];
        var er = Portfolio.effectiveRate(b);
        var s = ratesSeries(b.code);
        var mkt = s && s.rows && s.rows.length ? FxData.rateOn(s.rows, b.date) : null;
        var costPct = mkt ? ((er - mkt.rate) / mkt.rate) * 100 : NaN;
        return (
          "<tr>" +
          "<td>" +
          esc(b.date) +
          "</td>" +
          "<td>" +
          esc(meta.label) +
          "</td>" +
          "<td>" +
          won(b.krw) +
          "</td>" +
          "<td>" +
          num(b.foreign, 2) +
          "</td>" +
          "<td><strong>" +
          rate(er) +
          "</strong></td>" +
          "<td>" +
          (mkt ? rate(mkt.rate) : "—") +
          "</td>" +
          '<td class="' +
          (isFinite(costPct) && costPct > 0 ? "neg" : "") +
          '">' +
          (isFinite(costPct) ? signedPct(costPct) : "—") +
          "</td>" +
          "<td>" +
          esc(b.memo) +
          "</td>" +
          '<td><button type="button" class="link-btn" data-del="' +
          esc(b.id) +
          '">삭제</button></td>' +
          "</tr>"
        );
      })
      .join("");

    box.innerHTML =
      '<div class="table-scroll"><table class="data-table">' +
      "<thead><tr><th>날짜</th><th>통화</th><th>지불 원화</th><th>받은 외화</th><th>실효환율</th><th>그날 시장환율</th><th>차이</th><th>메모</th><th></th></tr></thead>" +
      "<tbody>" +
      rowsHtml +
      "</tbody></table></div>" +
      '<p class="muted small mt">「차이」는 그날 시장환율보다 얼마나 비싸게 샀는지 — 스프레드·수수료로 나간 몫입니다.</p>';
  }

  function renderSpreadSettings() {
    var s = Portfolio.getSettings();
    $("spreadSettings").innerHTML = Object.keys(FxData.CURRENCIES)
      .map(function (c) {
        var m = FxData.CURRENCIES[c];
        return (
          "<label>" +
          esc(m.label) +
          " 스프레드 (%)<input id=\"spread_" +
          c +
          '" data-ccy="' +
          c +
          '" type="number" step="0.01" min="0" max="10" value="' +
          esc(s.sellSpreadPct[c]) +
          '" /></label>' +
          "<label>" +
          esc(m.label) +
          " 우대율 (%)<input id=\"pref_" +
          c +
          '" data-ccy="' +
          c +
          '" type="number" step="1" min="0" max="100" value="' +
          esc(s.preferentialPct[c]) +
          '" /></label>'
        );
      })
      .join("");
  }

  // ---------------------------------------------------------------------
  // 계획 탭
  // ---------------------------------------------------------------------

  function wirePlan() {
    $("dcaRange").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-months]");
      if (!btn) return;
      state.dcaMonths = Number(btn.dataset.months);
      Array.prototype.forEach.call($("dcaRange").children, function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      renderDca();
    });

    ["planTotal", "planCount"].forEach(function (id) {
      $(id).addEventListener("input", updatePlanPreview);
    });

    $("planForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var box = $("planError");
      box.hidden = true;
      try {
        Portfolio.addPlan({
          code: $("planCcy").value,
          totalKrw: $("planTotal").value,
          count: $("planCount").value,
          periodUnit: $("planPeriod").value,
          startDate: $("planStart").value,
        });
        renderPlanList();
        updatePlanPreview();
      } catch (err) {
        box.textContent = err.message;
        box.hidden = false;
      }
    });

    $("planList").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "del") {
        if (!confirm("이 계획을 삭제할까요?")) return;
        Portfolio.removePlan(btn.dataset.id);
      } else {
        Portfolio.markPlanExecuted(btn.dataset.id, btn.dataset.act === "done" ? 1 : -1);
      }
      renderPlanList();
    });
  }

  function updatePlanPreview() {
    var total = Number($("planTotal").value);
    var count = Number($("planCount").value);
    $("planPreview").textContent =
      total > 0 && count >= 2 ? "1회당 " + won(total / count) : "";
  }

  function renderPlan() {
    renderDca();
    renderPlanList();
  }

  function renderDca() {
    var box = $("dcaCompare");
    var codes = Object.keys(FxData.CURRENCIES);
    var html = codes
      .map(function (c) {
        var s = state.series[c];
        if (!s || !s.rows || !s.rows.length) return "";
        var r = Portfolio.compareDcaVsLumpSum(s.rows, { months: state.dcaMonths, totalKrw: 12000000 });
        if (!r) return "";
        var m = FxData.CURRENCIES[c];
        var better = r.dcaAdvantagePct > 0;
        return (
          '<div class="dca-block">' +
          "<h3>" +
          esc(m.label) +
          '</h3><p class="muted small">' +
          esc(r.startDate) +
          " ~ " +
          esc(r.endDate) +
          " · 총 " +
          won(r.totalKrw) +
          " · " +
          r.installments +
          "회 분할 기준</p>" +
          '<div class="stat-grid stat-grid--2">' +
          stat("일시불 평균단가", rate(r.lumpAvgRate) + "원") +
          stat("분할매수 평균단가", rate(r.dcaAvgRate) + "원") +
          "</div>" +
          '<p class="note">이 구간에서는 <strong>' +
          (better ? "분할매수" : "일시불") +
          "</strong>의 평균단가가 " +
          pct(Math.abs(r.dcaAdvantagePct)) +
          " 더 낮았습니다." +
          "</p>" +
          "</div>"
        );
      })
      .join("");

    box.innerHTML =
      html ||
      '<p class="muted small">비교할 데이터가 부족합니다.</p>';
  }

  function renderPlanList() {
    var plans = Portfolio.load().plans;
    var box = $("planList");
    if (!plans.length) {
      box.innerHTML = '<p class="muted small">진행 중인 계획이 없습니다.</p>';
      return;
    }
    box.innerHTML = plans
      .map(function (p) {
        var st = Portfolio.planStatus(p);
        var m = FxData.CURRENCIES[p.code];
        return (
          '<div class="plan-item">' +
          '<div class="plan-item__head"><strong>' +
          esc(m.label) +
          "</strong> " +
          won(p.totalKrw) +
          " · " +
          p.count +
          "회 " +
          (p.periodUnit === "week" ? "매주" : "매월") +
          '<button type="button" class="link-btn" data-act="del" data-id="' +
          esc(p.id) +
          '">삭제</button></div>' +
          '<div class="progress"><div class="progress__bar" style="width:' +
          st.donePct.toFixed(1) +
          '%"></div></div>' +
          '<div class="plan-item__body">' +
          "<span>" +
          p.done +
          " / " +
          p.count +
          "회 완료 · 1회당 " +
          won(st.perAmount) +
          "</span>" +
          (st.complete
            ? "<span>계획 완료</span>"
            : "<span>다음 예정 <strong>" +
              esc(st.nextDate) +
              "</strong>" +
              (st.overdue ? ' <span class="badge badge--warn">지남</span>' : "") +
              " · 남은 금액 " +
              won(st.remainingKrw) +
              "</span>") +
          "</div>" +
          '<div class="form-actions form-actions--left">' +
          '<button type="button" data-act="done" data-id="' +
          esc(p.id) +
          '"' +
          (st.complete ? " disabled" : "") +
          ">1회 실행 처리</button>" +
          '<button type="button" class="ghost" data-act="undo" data-id="' +
          esc(p.id) +
          '"' +
          (p.done === 0 ? " disabled" : "") +
          ">되돌리기</button>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  // ---------------------------------------------------------------------
  // 면세점 탭
  // ---------------------------------------------------------------------
  // 적용환율은 매매기준율에서 그대로 유도되므로(전일 고시분) 사용자가 직접 적을 게 없다.
  // 면세점별로 다르게 다루지도 않는다 — 표시가가 달러 기준이라 USD 하나만 본다.

  var DF_WEEK_DAYS = 7;
  var WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
  var dfCalcRateTouched = false;

  function wireDutyFree() {
    $("dfCalcPrice").addEventListener("input", renderDfCalc);
    // 사용자가 환율 칸을 직접 건드렸으면 그 값을 존중하고, 아니면 오늘 적용환율을 따라간다.
    $("dfCalcRate").addEventListener("input", function () {
      dfCalcRateTouched = true;
      renderDfCalc();
    });
    $("dfCalcForm").addEventListener("submit", function (e) {
      e.preventDefault();
    });
  }

  function renderDutyFree() {
    renderDfEstimate();
    renderDfWeek();
    renderDfCalc();
  }

  function dfDayLabel(iso) {
    return iso.slice(5) + " (" + WEEKDAY_KO[FxData.parseISO(iso).getDay()] + ")";
  }

  // 내일 적용분이 '미정'인 이유는 두 가지인데 사용자 입장에서 뜻이 전혀 다르다.
  //  (1) 아직 오늘 고시(11시경) 전 — 기다리는 수밖에 없다
  //  (2) 고시는 나왔는데 우리 데이터가 아직 못 따라옴 — GitHub Actions 예약 실행이
  //      몇 시간씩 밀리는 일이 흔하다. 이건 잠시 뒤 다시 보면 해결된다.
  // 둘을 구분해줘야 "왜 안 나오지"를 헤매지 않는다.
  function tomorrowSubLabel(tomorrowApplied) {
    if (tomorrowApplied) return tomorrowApplied.quoteDate.slice(5) + " 고시";
    var now = new Date();
    var afterQuoteTime = now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() >= 30);
    return afterQuoteTime ? "오늘 고시 반영 대기 중" : "오늘 고시(11시경) 후 확정";
  }

  // ---------------------------------------------------------------------
  // 오늘 / 내일 적용환율
  // ---------------------------------------------------------------------
  function renderDfEstimate() {
    var box = $("dutyFreeEstimate");
    if (!box) return;

    if (!FxDomestic.available()) {
      box.innerHTML =
        '<div class="card"><h2>적용환율</h2><p class="muted small">' +
        "국내 매매기준율이 있어야 계산할 수 있습니다. GitHub Actions의 「환율 갱신」이 한 번 실행되면 " +
        "<strong>직전 영업일 매매기준율</strong>로 오늘·내일 적용환율을 계산해 보여드립니다. " +
        "(상태는 「내 보유 → 국내 고시환율」에서 확인할 수 있습니다)" +
        "</p></div>";
      return;
    }

    var today = FxData.todayISO();
    var yesterday = FxData.shiftDays(today, -1);
    var yesterdayApplied = FxDomestic.appliedOn("USD", yesterday);
    var todayApplied = FxDomestic.appliedOn("USD", today);
    var tomorrowApplied = FxDomestic.appliedTomorrow("USD");

    if (!todayApplied) {
      box.innerHTML =
        '<div class="card"><h2>적용환율</h2><p class="muted small">' +
        "오늘 이전의 매매기준율이 아직 없습니다. 「환율 갱신」을 한 번 더 실행해 과거 데이터를 채워주세요." +
        "</p></div>";
      return;
    }

    var diff = tomorrowApplied ? tomorrowApplied.rate - todayApplied.rate : NaN;
    var diffYd = yesterdayApplied ? todayApplied.rate - yesterdayApplied.rate : NaN;

    box.innerHTML =
      '<div class="card">' +
      '<div class="card__head"><h2>적용환율 (미국 달러)</h2>' +
      '<span class="muted small">전일 고시 매매기준율 기준</span></div>' +
      '<div class="stat-grid stat-grid--3">' +
      // 라벨은 어제/오늘/내일만 두고 날짜는 아래 작은 줄로 내린다.
      // 좁은 화면에서도 세 칸이 한 줄에 들어가야 비교가 된다.
      stat(
        "어제",
        yesterdayApplied ? rate(yesterdayApplied.rate) + "원" : "—",
        dfDayLabel(yesterday) + (yesterdayApplied ? "<br />" + yesterdayApplied.quoteDate.slice(5) + " 고시" : "")
      ) +
      stat(
        "오늘",
        rate(todayApplied.rate) + "원",
        dfDayLabel(today) + "<br />" + todayApplied.quoteDate.slice(5) + " 고시",
        isFinite(diffYd) ? (diffYd > 0 ? "neg" : diffYd < 0 ? "pos" : "") : ""
      ) +
      stat(
        "내일",
        tomorrowApplied ? rate(tomorrowApplied.rate) + "원" : "미정",
        dfDayLabel(FxData.shiftDays(today, 1)) + "<br />" + tomorrowSubLabel(tomorrowApplied),
        isFinite(diff) ? (diff > 0 ? "neg" : diff < 0 ? "pos" : "") : ""
      ) +
      "</div>" +
      (isFinite(diff)
        ? '<p class="note mt">내일 적용환율은 오늘보다 <strong>' +
          rate(Math.abs(diff)) +
          "원 " +
          (diff > 0 ? "올라갑니다" : diff < 0 ? "내려갑니다" : "같습니다") +
          "</strong>." +
          (diff < 0 ? " 구매는 내일이 유리합니다." : diff > 0 ? " 구매는 오늘이 유리합니다." : "") +
          "</p>"
        : "") +
      "</div>";
  }

  // ---------------------------------------------------------------------
  // 최근 일주일 적용환율
  // ---------------------------------------------------------------------
  // 주말·공휴일에는 고시가 없어 직전 영업일 값이 그대로 이어진다. 같은 값이
  // 며칠 반복되는 게 정상이고, 그 사실이 보이도록 '고시일' 열을 같이 보여준다.
  function renderDfWeek() {
    var box = $("dutyFreeWeek");
    if (!box) return;
    if (!FxDomestic.available()) {
      box.innerHTML = "";
      return;
    }

    var series = FxDomestic.appliedSeries("USD", DF_WEEK_DAYS);
    if (!series.length) {
      box.innerHTML = "";
      return;
    }

    var tomorrow = FxDomestic.appliedTomorrow("USD");
    var withTomorrow = tomorrow ? series.concat([tomorrow]) : series;

    // 최신이 위로 오게 뒤집는다.
    var rowsHtml = withTomorrow
      .slice()
      .reverse()
      .map(function (r, idxFromTop) {
        var pos = withTomorrow.length - 1 - idxFromTop; // 원래 배열 인덱스
        var prev = pos > 0 ? withTomorrow[pos - 1] : null;
        var d = prev ? r.rate - prev.rate : NaN;
        var isTomorrow = tomorrow && r.appliedDate === tomorrow.appliedDate;
        var isToday = r.appliedDate === FxData.todayISO();
        var carried = prev && prev.quoteDate === r.quoteDate; // 고시가 안 바뀐 날(주말 등)

        return (
          '<tr class="' +
          (isTomorrow ? "row-hi" : "") +
          '">' +
          "<th>" +
          esc(dfDayLabel(r.appliedDate)) +
          (isTomorrow ? " <span class=\"badge badge--info\">내일</span>" : isToday ? " <span class=\"badge badge--info\">오늘</span>" : "") +
          "</th>" +
          "<td><strong>" +
          rate(r.rate) +
          "</strong>원</td>" +
          '<td class="' +
          (isFinite(d) ? (d > 0 ? "neg" : d < 0 ? "pos" : "muted") : "muted") +
          '">' +
          (!isFinite(d) ? "—" : d === 0 ? rate(0) : (d > 0 ? "▲ " : "▼ ") + rate(Math.abs(d))) +
          "</td>" +
          '<td class="muted">' +
          esc(r.quoteDate.slice(5)) +
          (carried ? " (이어짐)" : "") +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    box.innerHTML =
      '<div class="card">' +
      "<h2>최근 " +
      DF_WEEK_DAYS +
      "일 적용환율</h2>" +
      '<div class="table-scroll"><table class="data-table">' +
      "<thead><tr><th>적용일</th><th>적용환율</th><th>전일 대비</th><th>고시일</th></tr></thead>" +
      "<tbody>" +
      rowsHtml +
      "</tbody></table></div>" +
      '<p class="muted small mt">고시일이 「이어짐」이면 그날 새 고시가 없어 직전 영업일 값이 그대로 적용된 것입니다(주말·공휴일).</p>' +
      "</div>";
  }

  // ---------------------------------------------------------------------
  // 상품가 환산 계산기
  // ---------------------------------------------------------------------
  function renderDfCalc() {
    var meta = FxData.CURRENCIES.USD;
    var price = Number($("dfCalcPrice").value);

    // 사용자가 안 건드렸으면 오늘 적용환율을 기본값으로 채운다.
    if (!dfCalcRateTouched) {
      var todayApplied = FxDomestic.available() ? FxDomestic.appliedOn("USD", FxData.todayISO()) : null;
      $("dfCalcRate").value = todayApplied ? todayApplied.rate.toFixed(2) : "";
    }
    var applied = Number($("dfCalcRate").value);

    if (!(price > 0) || !(applied > 0)) {
      $("dfCalcResult").innerHTML = "";
      return;
    }

    var krw = price * applied;

    // 같은 금액을 '달러 현찰을 환전해서' 준비했다면 얼마였을지 — 스프레드 차이를 보여준다.
    var spread = Portfolio.effectiveSpread("USD");
    var cashRate = applied * (1 + spread);
    var cashKrw = price * cashRate;

    $("dfCalcResult").innerHTML =
      '<div class="stat-grid stat-grid--2 mt">' +
      stat("원화 결제액", won(krw), num(price, 2) + " 달러 × " + rate(applied) + "원") +
      stat(
        "현찰 환전 시",
        won(cashKrw),
        "스프레드 " + pct(spread * 100) + " 반영 (" + rate(cashRate) + "원)"
      ) +
      "</div>" +
      '<p class="note mt">같은 상품이라도 달러 현찰을 환전해 결제하면 <strong class="neg">' +
      signedWon(cashKrw - krw) +
      "</strong> (" +
      signedPct((spread * 100)) +
      ") 더 듭니다. 스프레드는 「내 보유 → 환전 조건 설정」에서 본인 조건으로 바꿀 수 있습니다.</p>";
  }


  // ---------------------------------------------------------------------
  // 모델 성적표 탭
  // ---------------------------------------------------------------------

  function renderModels() {
    var code = state.modelCcy;
    var s = state.series[code];
    if (!s || !s.rows || s.rows.length < FxModels.MIN_TRAIN + 30) {
      $("predictBox").innerHTML = '<p class="muted small">데이터가 부족합니다.</p>';
      $("backtestBox").innerHTML = "";
      return;
    }

    if (state.backtestCache[code]) {
      drawModels(code, s, state.backtestCache[code]);
      return;
    }

    // 수만 번 예측을 돌리므로 먼저 안내를 그리고 다음 틱에 계산한다(화면이 멈춘 것처럼 보이지 않게).
    $("backtestBox").innerHTML = '<p class="loading">백테스트 계산 중...</p>';
    setTimeout(function () {
      var bt = FxModels.backtest(s.rows, HORIZONS);
      state.backtestCache[code] = bt;
      drawModels(code, s, bt);
    }, 20);
  }

  function drawModels(code, s, bt) {
    var meta = FxData.CURRENCIES[code];

    // --- 현재 예측값. 성적(Theil's U)을 옆에 붙이지 않으면 아예 표시하지 않는다.
    var scoreByKey = {};
    if (bt) {
      bt.horizons.forEach(function (hz) {
        hz.results.forEach(function (r) {
          scoreByKey[hz.h + ":" + r.key] = r;
        });
      });
    }

    var predHtml = HORIZONS.map(function (h) {
      var preds = FxModels.predictNow(s.rows, h);
      var rows = preds
        .map(function (p) {
          var sc = scoreByKey[h + ":" + p.key];
          return (
            "<tr><th>" +
            esc(p.label) +
            "</th><td>" +
            rate(p.value) +
            "원</td><td class=\"" +
            pnlClass(p.changePct) +
            '">' +
            signedPct(p.changePct) +
            "</td><td>" +
            (sc ? (sc.isBaseline ? "기준선" : "U " + num(sc.theilU, 3)) : "—") +
            "</td><td>" +
            (sc && isFinite(sc.hitRate) ? pct(sc.hitRate, 1) : "—") +
            "</td></tr>"
          );
        })
        .join("");
      return (
        "<h3>" +
        h +
        "영업일 뒤</h3>" +
        '<div class="table-scroll"><table class="data-table"><thead><tr><th>모델</th><th>예측값</th><th>변화</th><th>Theil&rsquo;s U</th><th>방향 적중률</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>"
      );
    }).join("");

    $("predictBox").innerHTML =
      '<p class="muted small">' +
      esc(meta.label) +
      " · " +
      esc(meta.unitLabel) +
      " 기준 · 현재 " +
      rate(s.lastRate) +
      "원 (" +
      esc(s.lastDate) +
      ")</p>" +
      predHtml +
      '<p class="note note--warn mt">위 숫자를 근거로 매수 시점을 정하지 마세요. 오른쪽 두 열이 그 이유입니다.</p>';

    // --- 백테스트 성적표
    if (!bt) {
      $("backtestBox").innerHTML = '<p class="muted small">백테스트를 돌리기에 데이터가 부족합니다.</p>';
      return;
    }

    $("backtestMeta").textContent =
      esc(meta.label) +
      " · 평가 구간 " +
      bt.trainStart +
      " ~ " +
      bt.dataTo +
      " (첫 " +
      bt.minTrain +
      "영업일은 학습용으로만 사용)";

    var winners = 0;
    var significant = 0;

    var tables = bt.horizons
      .map(function (hz) {
        var body = hz.results
          .map(function (r) {
            if (!r.isBaseline && r.beatsRandomWalk) winners++;
            if (!r.isBaseline && r.directionSignificant) significant++;
            var verdict = r.isBaseline
              ? '<span class="muted">기준선</span>'
              : r.beatsRandomWalk
              ? '<span class="pos">랜덤워크보다 오차 작음</span>'
              : '<span class="neg">랜덤워크보다 못함</span>';
            var dirVerdict = r.isBaseline
              ? '<span class="muted">방향을 찍지 않음</span>'
              : r.directionSignificant
              ? '<span class="pos">동전 던지기와 다름</span>'
              : '<span class="muted">동전 던지기와 구분 불가</span>';
            return (
              "<tr>" +
              "<th>" +
              esc(r.label) +
              "</th>" +
              "<td>" +
              num(r.rmse, 3) +
              "</td>" +
              "<td>" +
              num(r.mae, 3) +
              "</td>" +
              "<td><strong>" +
              (r.isBaseline ? "1.000" : num(r.theilU, 3)) +
              "</strong></td>" +
              "<td>" +
              verdict +
              "</td>" +
              "<td>" +
              (isFinite(r.hitRate)
                ? pct(r.hitRate, 1) +
                  '<br /><span class="muted small">95% CI ' +
                  num(r.hitCiLow, 1) +
                  "~" +
                  num(r.hitCiHigh, 1) +
                  "%</span>"
                : "—") +
              "</td>" +
              "<td>" +
              dirVerdict +
              "</td>" +
              "</tr>"
            );
          })
          .join("");

        return (
          "<h3>" +
          hz.h +
          "영업일 예측 <span class=\"muted small\">(" +
          hz.count.toLocaleString("ko-KR") +
          "회 예측)</span></h3>" +
          '<div class="table-scroll"><table class="data-table"><thead><tr>' +
          "<th>모델</th><th>RMSE</th><th>MAE</th><th>Theil&rsquo;s U</th><th>오차 판정</th><th>방향 적중률</th><th>방향 판정</th>" +
          "</tr></thead><tbody>" +
          body +
          "</tbody></table></div>"
        );
      })
      .join("");

    var total = bt.horizons.length * (FxModels.MODELS.length - 1);
    var conclusion =
      '<div class="note note--warn mt"><strong>결론:</strong> 랜덤워크보다 오차가 작았던 경우 ' +
      winners +
      " / " +
      total +
      "건, 방향 적중률이 동전 던지기와 통계적으로 구분된 경우 " +
      significant +
      " / " +
      total +
      "건입니다. " +
      (winners === 0 && significant === 0
        ? "어떤 모델도 아무것도 안 하는 것보다 낫지 않았습니다 — 예측으로 매수 시점을 정할 근거가 없다는 뜻입니다."
        : "일부 항목이 기준선을 넘었더라도, 겹치는 구간 때문에 신뢰구간이 좁게 나온다는 점을 감안하면 실전 우위로 보기는 어렵습니다.") +
      "</div>";

    $("backtestBox").innerHTML = tables + conclusion;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
