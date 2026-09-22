(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 화면 로직
  // ---------------------------------------------------------------------
  // 계산은 전부 fx-stats / portfolio 가 하고, 여기서는 그리기만 한다.

  var state = {
    series: {}, // code -> FxData.load 결과
    view: "overview",
    ccy: "USD",
    costCcy: "JPY", // 결제비용 탭은 여행지 통화가 기본이라 엔으로 연다
    costAmount: 100000,
    rangeDays: 0, // 0보다 크면 일 단위, 아니면 rangeMonths를 쓴다
    rangeMonths: 12,
    domesticError: null, // 국내 고시환율 연동 실패 메시지 (있으면 ECB로 폴백)
  };

  // ---------------------------------------------------------------------
  // 환율 소스 분리
  // ---------------------------------------------------------------------
  // ECB(state.series)      → 장기 시계열: 추이 차트
  // 국내 매매기준율(FxDomestic) → 금액이 걸린 곳: 상단 오늘 고시, 면세점 적용환율
  //
  // 차트에 두 소스를 섞으면 0.4%짜리 계단이 생겨 추세를 왜곡한다. 그래서 차트는
  // ECB만 쓰고, 하루 한 번 확정되는 고시가 필요한 곳만 FxDomestic을 직접 읽는다.

  function domesticRows(code) {
    var dom = FxDomestic.all(code);
    return Object.keys(dom)
      .sort()
      .map(function (d) {
        return { date: d, rate: dom[d] };
      });
  }

  // GitHub Actions가 커밋해둔 rates.json을 읽어와 화면을 다시 그린다.
  // 실패해도 ECB로 계속 돌아가야 하므로 절대 예외를 위로 던지지 않는다.
  // (file://로 열면 fetch가 막혀 항상 실패한다 — 그래도 앱은 정상 동작한다)
  function syncDomestic() {
    return FxDomestic.sync().then(function (res) {
      state.domesticError = res && res.error ? res.error : null;
      renderHeader();
      setView(state.view);
      // 실시간 환율은 상단 표시용이라 늦게 붙어도 되고, 실패해도 무시한다.
      FxDomestic.refreshLiveRates().then(function (changed) {
        if (changed) renderHeader();
      });
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

  // 야후는 UTC ISO 문자열을 준다. 문자열을 그냥 잘라 쓰면 9시간 어긋나므로
  // Date로 파싱해 브라우저 현지시각(= 사용자에겐 KST)으로 찍는다.
  function hhmmLocal(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = function (n) {
      return n < 10 ? "0" + n : String(n);
    };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ---------------------------------------------------------------------
  // 부팅
  // ---------------------------------------------------------------------

  function init() {
    buildCurrencySelectors();
    wireTabs();
    wireOverview();
    wireBackup();
    wireDutyFree();
    wireInstall();
    wireCost();

    $("footerSource").textContent =
      "추이 차트: " +
      FxData.sourceLabel() +
      ", 최근 " +
      FxData.HISTORY_YEARS +
      "년 · 금액 계산: " +
      FxDomestic.SOURCE_LABEL +
      " (없으면 ECB)";

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

  // 통화 토글은 현황과 결제비용 두 곳이 같은 모양으로 쓴다.
  function ccySegHtml(active) {
    return Object.keys(FxData.CURRENCIES)
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

  function buildCurrencySelectors() {
    var segHtml = ccySegHtml;

    $("ccyToggle").innerHTML = segHtml(state.ccy);
    $("ccyToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-ccy]");
      if (!btn) return;
      state.ccy = btn.dataset.ccy;
      $("ccyToggle").innerHTML = segHtml(state.ccy);
      renderOverview();
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

    // 면세점환율 탭은 전부 '확정 고시' 기준이라, 상단의 실시간 환율이 같이 보이면
    // 어느 쪽을 봐야 하는지 헷갈린다. 이 탭에서는 상단 환율을 숨긴다.
    var hideRates = view === "dutyfree";
    $("rateCards").hidden = hideRates;
    $("dataStatus").hidden = hideRates;
    if (view === "overview") renderOverview();
    if (view === "cost") renderCost();
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

        // 상단 '현재 환율'은 실시간(은행 고시회차)이 맞다. 매매기준율은 하루 한 번뿐이라
        // 모바일 환전으로 실제 체결되는 값과 어긋난다.
        // 단 차트·백분위·면세점은 확정된 매매기준율을 그대로 쓴다(아래 dom 분기).
        var live = FxDomestic.liveRate(c);
        if (live) {
          domShown = true;
          primary = { date: FxData.todayISO(), rate: live.rate };
          if (isFinite(live.change)) {
            delta = { abs: live.change, pct: isFinite(live.changePct) ? live.changePct : NaN };
          }
          // 실시간 값 옆에 '매매기준율 1,338.2' 를 나란히 찍었더니 같은 성격의 값으로
          // 보였다. 둘은 소스도 성격도 다르다 — 무엇의 값인지 앞에 붙여 구분한다.
          sub = "시장환율" + (live.at ? " " + hhmmLocal(live.at) : "") + " 기준";
          if (dom.length) {
            sub +=
              '<br /><span class="muted">오늘 고시 ' +
              rate(dom[dom.length - 1].rate) +
              " (" +
              dom[dom.length - 1].date.slice(5) +
              ")</span>";
          }
        } else if (dom.length) {
          // 국내 매매기준율이 있으면 그쪽을 대표값으로 쓴다. 전일 대비도
          // 반드시 같은 소스끼리 비교해야 해서 국내 값끼리만 뺀다.
          domShown = true;
          primary = dom[dom.length - 1];
          if (dom.length >= 2) {
            var prev = dom[dom.length - 2];
            delta = { abs: primary.rate - prev.rate, pct: ((primary.rate - prev.rate) / prev.rate) * 100 };
          }
          // 어느 날짜 고시인지 값 바로 옆에 적는다. 이게 없으면 면세점 탭의
          // '오늘 적용환율'(= 전일 고시분)과 같은 숫자로 보일 때 구분이 안 된다.
          sub = "매매기준율 " + primary.date.slice(5) + " 고시";
          if (ecb && ecb.rows && ecb.rows.length) {
            sub += " · ECB " + rate(ecb.lastRate) + " (" + ecb.lastDate.slice(5) + ")";
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
    var liveAny = Object.keys(FxData.CURRENCIES).some(function (c) { return !!FxDomestic.liveRate(c); });
    if (domShown) {
      // 상단은 실시간, 아래는 확정값 — 이 구분이 안 보이면 왜 숫자가 다른지 혼란스럽다.
      statusHtml = liveAny
        ? "위 환율은 <strong>실시간</strong> (" +
          esc(FxDomestic.liveRatesSource() || "은행 고시회차") +
          ") · 면세점은 <strong>확정 고시</strong> (매매기준율 " +
          esc(FxDomestic.latestDate() || "—") +
          ") · 추이는 ECB 시계열"
        : "국내 매매기준율 <strong>" +
          esc(FxDomestic.latestDate() || "—") +
          "</strong> (한국수출입은행) · 추이는 ECB 시계열 기준";
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
  }
  // ---------------------------------------------------------------------
  // 현황 탭
  // ---------------------------------------------------------------------

  function wireOverview() {
    $("rangeToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-months], button[data-days]");
      if (!btn) return;
      // 1주만 일수로 센다. 달은 말일 보정이 필요해 일수로 환산하지 않고
      // FxData.shiftMonths에 맡긴다 (3/31에서 한 달 전은 2/31이 아니다).
      state.rangeDays = Number(btn.dataset.days || 0);
      state.rangeMonths = btn.dataset.days ? 0 : Number(btn.dataset.months);
      Array.prototype.forEach.call($("rangeToggle").children, function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      renderChart();
    });  }

  function renderOverview() {
    renderChart();
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
    if (state.rangeDays > 0) {
      rows = FxStats.sliceSince(rows, FxData.shiftDays(s.lastDate, -state.rangeDays));
    } else if (state.rangeMonths > 0) {
      rows = FxStats.sliceSince(rows, FxData.shiftMonths(s.lastDate, -state.rangeMonths));
    }
    if (rows.length < 2) rows = s.rows;

    // 이동평균은 잘라낸 구간 안에서만 계산된다. 1주치처럼 구간이 평균 기간보다
    // 짧으면 선이 한 점도 안 그려지는데 범례만 남아 "선이 왜 없지"가 된다.
    // 그릴 수 있을 때만 넣고 범례도 같이 여닫는다.
    var ma = [];
    var show20 = rows.length >= 20;
    var show60 = rows.length >= 60;
    if (show20) ma.push({ values: Chart.movingAverage(rows, 20) });
    if (show60) ma.push({ values: Chart.movingAverage(rows, 60) });
    $("legendMa20").hidden = !show20;
    $("legendMa60").hidden = !show60;

    Chart.line(box, { rows: rows, height: 280, ma: ma });
  }

  // ---------------------------------------------------------------------
  // 홈 화면 설치
  // ---------------------------------------------------------------------
  // 안드로이드·데스크톱 크롬은 beforeinstallprompt를 던져주므로 버튼 한 번으로 끝난다.
  // iOS 사파리엔 그런 이벤트가 자체가 없다 — 공유 시트를 거쳐야 해서 문구로만 안내한다.
  // 이미 홈 화면에서 연 경우나 한 번 닫은 경우에는 아무것도 띄우지 않는다.

  var deferredInstall = null;
  var INSTALL_HIDE_KEY = "fx.installHidden";

  function isStandalone() {
    var mm = window.matchMedia && window.matchMedia("(display-mode: standalone)");
    // navigator.standalone은 iOS 사파리 전용이고, iOS는 display-mode를 안 알려준다.
    return (mm && mm.matches) || window.navigator.standalone === true;
  }

  function isIosSafari() {
    var ua = navigator.userAgent;
    // 아이패드는 iPadOS 13부터 데스크톱 UA를 쓴다 — 터치 포인트 수로 가려낸다.
    var ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    // 크롬·파이어폭스의 iOS판은 사파리 UA를 달고 다니지만 홈 화면 추가 메뉴가 없다.
    return ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  }

  function dismissInstall(remember) {
    $("installBox").hidden = true;
    if (!remember) return;
    try {
      localStorage.setItem(INSTALL_HIDE_KEY, "1");
    } catch (err) {
      /* 사파리 사생활 보호 모드 등 — 안내가 다시 떠도 앱 동작엔 지장 없다 */
    }
  }

  function wireInstall() {
    var box = $("installBox");
    if (!box || isStandalone()) return;
    try {
      if (localStorage.getItem(INSTALL_HIDE_KEY) === "1") return;
    } catch (err) {
      /* 못 읽으면 그냥 안내를 띄운다 */
    }

    $("installClose").addEventListener("click", function () {
      dismissInstall(true);
    });

    $("installBtn").addEventListener("click", function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () {
        // 거절해도 이벤트는 다시 오지 않는다. 계속 띄워둬도 눌릴 게 없으니 닫는다.
        deferredInstall = null;
        dismissInstall(false);
      });
    });

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault(); // 크롬 기본 배너를 막고 우리 버튼으로 받는다
      deferredInstall = e;
      $("installText").textContent = "홈 화면에 앱처럼 설치할 수 있습니다.";
      $("installBtn").hidden = false;
      box.hidden = false;
    });

    window.addEventListener("appinstalled", function () {
      dismissInstall(true);
    });

    if (isIosSafari()) {
      $("installText").innerHTML =
        '홈 화면에 추가하려면 아래 <strong>공유</strong> 버튼 → <strong>홈 화면에 추가</strong>를 누르세요.';
      box.hidden = false;
    }
  }

  // ---------------------------------------------------------------------
  // 데이터 백업
  // ---------------------------------------------------------------------
  // 관심 상품과 목표 알림은 이 브라우저의 localStorage에만 있다.
  // 브라우저 데이터를 한 번 지우면 그대로 사라지므로 내보내기는 손 닿는 곳에 있어야 한다.

  function wireBackup() {
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
          renderDutyFree();
          renderChart();
          syncDomestic();
        } catch (err) {
          $("backupMsg").textContent = "가져오기 실패: " + err.message;
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });  }

  // ---------------------------------------------------------------------
  // 결제비용 탭
  // ---------------------------------------------------------------------
  // 은행 앱도 카드사 앱도 이 비교를 해주지 않는다. 어느 칸에서든 자기 상품이
  // 불리하게 나오기 때문이다. 그래서 여기서는 전부 한 표에 늘어놓는다.

  var COST_RATE_FIELDS = [
    { key: "ttSpreadPct", label: "전신환 스프레드", hint: "카드 청구에 쓰이는 환율의 가산폭" },
    { key: "brandFeePct", label: "국제브랜드 수수료", hint: "비자·마스터 등" },
    { key: "issuerFeePct", label: "카드사 해외수수료", hint: "카드사가 따로 떼는 몫" },
    { key: "travelFeePct", label: "트래블카드 수수료", hint: "무료 환전 구간이면 0" },
    { key: "dccMarkupPct", label: "DCC 가산", hint: "현지에서 원화결제할 때. 통상 3~8%" }
  ];

  function costMeta() {
    return FxData.CURRENCIES[state.costCcy];
  }

  function wireCost() {
    $("costAmount").value = state.costAmount;

    $("costCcyToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-ccy]");
      if (!btn) return;
      state.costCcy = btn.dataset.ccy;
      // 통화를 바꾸면 자릿수가 통째로 달라진다(10만엔 vs 1000달러). 앞 통화의
      // 금액을 그대로 두면 0이 두 개 붙은 표가 나오므로 기본값으로 되돌린다.
      state.costAmount = state.costCcy === "JPY" ? 100000 : 1000;
      $("costAmount").value = state.costAmount;
      renderCost();
    });

    $("costAmount").addEventListener("input", function () {
      state.costAmount = Number($("costAmount").value) || 0;
      renderCost();
    });

    $("costForm").addEventListener("submit", function (e) {
      e.preventDefault(); // 엔터로 새로고침되는 것만 막는다
    });

    $("costRateForm").addEventListener("change", function (e) {
      var input = e.target.closest("input[data-rate]");
      if (!input) return;
      var key = input.dataset.rate;
      if (key === "cashSpreadPct" || key === "prefPct") {
        // 현찰 조건만 통화별로 저장된다. 두 칸을 함께 넘겨야 한쪽이 지워지지 않는다.
        Portfolio.setSpread(state.costCcy, $("rate_cashSpreadPct").value, $("rate_prefPct").value);
      } else {
        var patch = {};
        patch[key] = input.value;
        Portfolio.setCostRates(patch);
      }
      $("costRateMsg").textContent = "저장했습니다.";
      renderCost();
      renderDfItems(); // 면세점 탭의 현지가 비교도 같은 요율을 쓴다
    });
  }

  function renderCost() {
    $("costCcyToggle").innerHTML = ccySegHtml(state.costCcy);
    var meta = costMeta();
    $("costAmountLabel").textContent = "현지 금액 (" + meta.amountLabel + ")";
    renderCostRates();

    var box = $("costResult");
    var base = FxDomestic.latest(state.costCcy);
    if (!base) {
      box.innerHTML = '<p class="muted small">매매기준율을 아직 받지 못했습니다. 잠시 뒤 다시 확인해주세요.</p>';
      return;
    }
    if (!(state.costAmount > 0)) {
      box.innerHTML = '<p class="muted small">금액을 넣으면 수단별 실부담액을 계산합니다.</p>';
      return;
    }

    // 면세점 적용환율은 오늘 고시가 아니라 전일 고시다. 오늘 값과 다르기 때문에
    // 면세점이 늘 최저인 것도 아니다 — 그 역전을 표에서 그대로 보여준다.
    var applied = FxDomestic.appliedOn(state.costCcy, FxData.todayISO());
    var res = Cost.compare(
      state.costAmount,
      base.rate,
      applied ? applied.rate : NaN,
      meta.unit,
      Portfolio.costOptions(state.costCcy)
    );

    var rows = res.rows
      .map(function (r) {
        return (
          "<tr" + (r.isBest ? ' class="row--best"' : "") + ">" +
          "<th>" + esc(r.label) + (r.isBest ? ' <span class="badge">최저</span>' : "") +
          '<br /><span class="muted small">' + esc(r.note) + "</span></th>" +
          "<td>" + rate(r.rate) + "원</td>" +
          "<td><strong>" + won(r.krw) + "</strong></td>" +
          '<td class="' + (r.vsBestKrw > 0 ? "neg" : "pos") + '">' +
          (r.vsBestKrw > 0 ? "+" + won(r.vsBestKrw) : "—") +
          "</td></tr>"
        );
      })
      .join("");

    var worst = res.rows[res.rows.length - 1];
    var gap = worst.krw - res.rows[0].krw;

    box.innerHTML =
      '<div class="table-scroll"><table class="data-table">' +
      "<thead><tr><th>수단</th><th>실효환율</th><th>실부담액</th><th>최저 대비</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>" +
      '<p class="muted small mt">환율은 ' + esc(meta.unitLabel) + " 기준 · 매매기준율 그대로면 " +
      won(res.baseKrw) + " · 오늘 고시 " + rate(base.rate) + " (" + esc(base.date.slice(5)) + ")</p>" +
      '<div class="note note--warn mt"><strong>가장 싼 수단과 가장 비싼 수단의 차이가 ' +
      won(gap) + "입니다.</strong> 같은 금액을 쓰는데 " + esc(worst.label) +
      " 쪽을 고르면 그만큼 더 냅니다. 요율은 카드사·상품마다 다르니 본인 약관 확인이 필요합니다.</div>";
  }

  function renderCostRates() {
    var st = Portfolio.getSettings();
    var meta = costMeta();

    function row(key, label, hint, value) {
      return (
        "<label>" + esc(label) +
        '<input id="rate_' + key + '" data-rate="' + key +
        '" type="number" step="0.01" min="0" value="' + value + '" />' +
        '<span class="muted small">' + esc(hint) + "</span></label>"
      );
    }

    $("costRateForm").innerHTML =
      row("cashSpreadPct", "현찰 스프레드 (%)", meta.label + " 기준", st.sellSpreadPct[state.costCcy]) +
      row("prefPct", "환전 우대율 (%)", meta.label + " 기준", st.preferentialPct[state.costCcy]) +
      COST_RATE_FIELDS.map(function (f) {
        return row(f.key, f.label + " (%)", f.hint, st.costRates[f.key]);
      }).join("");
  }

  // ---------------------------------------------------------------------
  // 면세점 탭
  // ---------------------------------------------------------------------
  // 적용환율은 매매기준율에서 그대로 유도되므로(전일 고시분) 사용자가 직접 적을 게 없다.
  // 면세점별로 다르게 다루지도 않는다 — 표시가가 달러 기준이라 USD 하나만 본다.

  var DF_WEEK_DAYS = 7;
  var WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

  function wireDutyFree() {
    $("dfItemUsd").addEventListener("input", updateDfItemPreview);

    $("dfItemForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var box = $("dfItemError");
      box.hidden = true;
      try {
        Portfolio.addItem({ name: $("dfItemName").value, usd: $("dfItemUsd").value, url: $("dfItemUrl").value });
        $("dfItemName").value = "";
        $("dfItemUsd").value = "";
        $("dfItemUrl").value = "";
        updateDfItemPreview();
        renderDfItems();
      } catch (err) {
        box.textContent = err.message;
        box.hidden = false;
      }
    });

    // 링크를 붙여넣고 누르면 Worker가 상품 페이지를 읽어 이름·달러가를 채워준다.
    $("dfItemFetch").addEventListener("click", function () {
      var box = $("dfItemError");
      var url = ($("dfItemUrl").value || "").trim();
      box.hidden = true;
      $("dfItemPreview").innerHTML = '<span class="loading">상품 정보를 가져오는 중...</span>';
      Promise.resolve()
        .then(function () {
          return FxDomestic.fetchProduct(url);
        })
        .then(
          function (p) {
            // 가져온 값은 그대로 덮어쓰되, 사용자가 이미 적어둔 이름은 건드리지 않는다.
            if (p.usd) $("dfItemUsd").value = p.usd;
            if (p.name && !$("dfItemName").value.trim()) $("dfItemName").value = p.name;
            updateDfItemPreview();
            if (!p.usd) {
              box.textContent = "상품명은 가져왔지만 가격을 못 찾았습니다. 가격은 직접 입력해주세요.";
              box.hidden = false;
            }
          },
          function (err) {
            $("dfItemPreview").textContent = "";
            box.textContent = err.message;
            box.hidden = false;
          }
        );
    });

    $("dfItems").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-del]");
      if (!btn) return;
      Portfolio.removeItem(btn.dataset.del);
      renderDfItems();
    });
  }

  function renderDutyFree() {
    renderDfEstimate();
    renderDfWeek();
    renderDfItems();
  }

  // 입력 중인 금액이 오늘 얼마인지 즉시 보여준다 — 등록 전에도 계산기처럼 쓸 수 있게.
  function updateDfItemPreview() {
    var usd = Number($("dfItemUsd").value);
    var applied = dfTodayRate();
    $("dfItemPreview").textContent =
      usd > 0 && applied ? "오늘 기준 " + won(usd * applied.rate) + " (" + rate(applied.rate) + "원 적용)" : "";
  }

  function dfTodayRate() {
    return FxDomestic.available() ? FxDomestic.appliedOn("USD", FxData.todayISO()) : null;
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
    // 고시는 오전 중에 나온다(2026-09-14 실측 10:20에 이미 있었음).
    // 그 시각을 넘겼는데도 없으면 '아직 안 나온 것'이 아니라 '우리가 못 받은 것'이다.
    var h = new Date().getHours();
    return h >= 10 ? "오늘 고시 반영 대기 중" : "오늘 고시 후 확정";
  }

  // ---------------------------------------------------------------------
  // 오늘 / 내일 적용환율
  // ---------------------------------------------------------------------
  // 값 카드 한 칸. 내 보유 탭에서 쓰던 것을 그 탭과 함께 지웠다가 되살렸다 —
  // 면세점 적용환율 카드가 같은 모양을 쓰고 있었는데 놓쳤다.
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
  // 관심 상품 — 등록한 달러 표시가의 오늘/내일 원화가
  // ---------------------------------------------------------------------
  function renderDfItems() {
    var box = $("dfItems");
    if (!box) return;

    var items = Portfolio.listItems();
    if (!items.length) {
      box.innerHTML = '<p class="muted small mt">등록한 상품이 없습니다. 위에 가격을 넣고 추가해보세요.</p>';
      return;
    }

    // 환율이 없어도 목록은 반드시 그린다. 내가 입력한 데이터가 사라진 것처럼 보이면 안 된다.
    // 원화가만 '—'로 비우고, 왜 비었는지는 표 아래에 적는다.
    var todayApplied = dfTodayRate();
    var tomorrowApplied = FxDomestic.appliedTomorrow("USD");
    var yesterdayApplied = todayApplied
      ? FxDomestic.appliedOn("USD", FxData.shiftDays(FxData.todayISO(), -1))
      : null;

    var totalUsd = 0;
    var rowsHtml = items
      .map(function (it) {
        totalUsd += it.usd;
        var yesterdayKrw = yesterdayApplied ? it.usd * yesterdayApplied.rate : NaN;
        var todayKrw = todayApplied ? it.usd * todayApplied.rate : NaN;
        var tomorrowKrw = tomorrowApplied ? it.usd * tomorrowApplied.rate : NaN;
        var d = isFinite(tomorrowKrw) && isFinite(todayKrw) ? tomorrowKrw - todayKrw : NaN;
        var label = it.name ? esc(it.name) : '<span class="muted">이름 없음</span>';
        return (
          "<tr>" +
          "<th>" +
          // 링크가 있으면 상품명을 그대로 링크로 만든다. 이름이 없으면 '링크'라고만.
          (it.url
            ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + label + " ↗</a>"
            : label) +
          "</th>" +
          "<td>$" +
          num(it.usd, 2) +
          "</td>" +
          '<td class="muted">' +
          (isFinite(yesterdayKrw) ? won(yesterdayKrw) : "—") +
          "</td>" +
          "<td>" +
          (isFinite(todayKrw) ? won(todayKrw) : '<span class="muted">—</span>') +
          "</td>" +
          "<td>" +
          (isFinite(tomorrowKrw) ? won(tomorrowKrw) : '<span class="muted">미정</span>') +
          "</td>" +
          '<td class="' +
          (isFinite(d) ? (d > 0 ? "neg" : d < 0 ? "pos" : "muted") : "muted") +
          '">' +
          (isFinite(d) ? signedWon(d) : "—") +
          "</td>" +
          '<td><button type="button" class="link-btn" data-del="' +
          esc(it.id) +
          '">삭제</button></td>' +
          "</tr>"
        );
      })
      .join("");

    var totalYesterday = yesterdayApplied ? totalUsd * yesterdayApplied.rate : NaN;
    var totalToday = todayApplied ? totalUsd * todayApplied.rate : NaN;
    var totalTomorrow = tomorrowApplied ? totalUsd * tomorrowApplied.rate : NaN;
    var totalDiff = isFinite(totalTomorrow) && isFinite(totalToday) ? totalTomorrow - totalToday : NaN;

    // 합계 행은 tfoot에 둬서 상품이 많아져도 눈에 띄게 한다.
    var footHtml =
      '<tr class="row-hi"><th>합계 ' +
      items.length +
      "건</th><td>$" +
      num(totalUsd, 2) +
      '</td><td class="muted">' +
      (isFinite(totalYesterday) ? won(totalYesterday) : "—") +
      "</td><td><strong>" +
      (isFinite(totalToday) ? won(totalToday) : "&mdash;") +
      "</strong></td><td><strong>" +
      (isFinite(totalTomorrow) ? won(totalTomorrow) : '<span class="muted">미정</span>') +
      '</strong></td><td class="' +
      (isFinite(totalDiff) ? (totalDiff > 0 ? "neg" : totalDiff < 0 ? "pos" : "muted") : "muted") +
      '"><strong>' +
      (isFinite(totalDiff) ? signedWon(totalDiff) : "—") +
      "</strong></td><td></td></tr>";

    var verdict = "";
    if (!todayApplied) {
      verdict =
        '<p class="muted small mt">적용환율이 아직 없어 원화가를 못 채웠습니다. ' +
        "등록한 상품은 그대로 남아 있으며, 환율이 들어오면 자동으로 계산됩니다.</p>";
    } else if (isFinite(totalDiff) && Math.round(totalDiff) !== 0) {
      verdict =
        '<p class="note mt">등록한 ' +
        items.length +
        "건을 전부 산다면 <strong>" +
        (totalDiff < 0 ? "내일" : "오늘") +
        "</strong>이 <strong>" +
        won(Math.abs(totalDiff)) +
        "</strong> 저렴합니다.</p>";
    } else if (isFinite(totalDiff)) {
      verdict = '<p class="muted small mt">오늘과 내일 적용환율이 같아 가격 차이가 없습니다.</p>';
    }

    box.innerHTML =
      '<div class="table-scroll mt"><table class="data-table">' +
      "<thead><tr><th>상품</th><th>달러</th><th>어제</th><th>오늘</th><th>내일</th><th>내일−오늘</th><th></th></tr></thead>" +
      "<tbody>" +
      rowsHtml +
      "</tbody><tfoot>" +
      footHtml +
      "</tfoot></table></div>" +
      verdict;
  }


  document.addEventListener("DOMContentLoaded", init);
})();
