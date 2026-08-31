(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // SVG 라인차트 — 외부 라이브러리 없이 직접 그린다.
  // ---------------------------------------------------------------------
  // 빌드 스텝이 없는 프로젝트라 CDN 차트 라이브러리를 붙이면 오프라인에서 깨진다.
  // 필요한 기능이 선 하나 + 이동평균 + 매수 시점 점 정도라 직접 그리는 게 낫다.
  //
  // viewBox 고정 좌표계(W×H)로 그리고 CSS로 100% 폭을 주면 반응형이 공짜로 된다.

  var W = 720;
  var PAD_L = 8;
  var PAD_R = 62; // 오른쪽에 y축 라벨
  var PAD_T = 12;
  var PAD_B = 26;

  function el(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) {
      node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  // 사람이 읽기 좋은 눈금 간격 (1, 2, 5 × 10^n)
  function niceStep(range, targetCount) {
    if (!(range > 0)) return 1;
    var raw = range / targetCount;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function fmt(v) {
    return v.toLocaleString("ko-KR", { maximumFractionDigits: v >= 100 ? 0 : 2 });
  }

  function shortDate(iso) {
    var p = iso.split("-");
    return p[0].slice(2) + "." + p[1];
  }

  // opts: { rows, height, ma:[{rows,label}], markers:[{date,rate,label}], color }
  function line(container, opts) {
    container.innerHTML = "";
    var rows = opts.rows || [];
    if (rows.length < 2) {
      container.innerHTML = '<p class="muted small">차트를 그릴 데이터가 부족합니다.</p>';
      return;
    }

    var H = opts.height || 280;
    var plotW = W - PAD_L - PAD_R;
    var plotH = H - PAD_T - PAD_B;

    // --- y 범위: 데이터 범위에 5% 여유. 매수 마커도 범위 안에 들어와야 한다.
    var lo = Infinity;
    var hi = -Infinity;
    rows.forEach(function (r) {
      if (r.rate < lo) lo = r.rate;
      if (r.rate > hi) hi = r.rate;
    });
    (opts.markers || []).forEach(function (m) {
      if (m.rate < lo) lo = m.rate;
      if (m.rate > hi) hi = m.rate;
    });
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    var padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;

    // --- x는 날짜가 아니라 "관측 순번" 기준. 주말 공백이 안 생겨서 보기 좋다.
    var indexByDate = {};
    rows.forEach(function (r, i) {
      indexByDate[r.date] = i;
    });

    function x(i) {
      return PAD_L + (i / (rows.length - 1)) * plotW;
    }
    function y(v) {
      return PAD_T + (1 - (v - lo) / (hi - lo)) * plotH;
    }

    var svg = el("svg", {
      viewBox: "0 0 " + W + " " + H,
      class: "chart",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "환율 추이 차트",
    });

    // --- 가로 그리드 + y 라벨
    var step = niceStep(hi - lo, 4);
    var start = Math.ceil(lo / step) * step;
    for (var v = start; v <= hi; v += step) {
      svg.appendChild(
        el("line", { x1: PAD_L, y1: y(v), x2: PAD_L + plotW, y2: y(v), class: "chart__grid" })
      );
      var lab = el("text", { x: PAD_L + plotW + 6, y: y(v) + 4, class: "chart__ylabel" });
      lab.textContent = fmt(v);
      svg.appendChild(lab);
    }

    // --- x 라벨 (5개 내외)
    var xTicks = 5;
    for (var k = 0; k < xTicks; k++) {
      var idx = Math.round((k / (xTicks - 1)) * (rows.length - 1));
      var t = el("text", {
        x: x(idx),
        y: H - 8,
        class: "chart__xlabel",
        "text-anchor": k === 0 ? "start" : k === xTicks - 1 ? "end" : "middle",
      });
      t.textContent = shortDate(rows[idx].date);
      svg.appendChild(t);
    }

    // --- 본선 + 아래 면적
    var d = "";
    rows.forEach(function (r, i) {
      d += (i ? "L" : "M") + x(i).toFixed(2) + " " + y(r.rate).toFixed(2) + " ";
    });
    svg.appendChild(
      el("path", {
        d: d + "L" + x(rows.length - 1).toFixed(2) + " " + (PAD_T + plotH) + " L" + PAD_L + " " + (PAD_T + plotH) + " Z",
        class: "chart__area",
      })
    );
    svg.appendChild(el("path", { d: d, class: "chart__line" }));

    // --- 이동평균 오버레이 (점선)
    (opts.ma || []).forEach(function (series, si) {
      var md = "";
      var started = false;
      series.values.forEach(function (val, i) {
        if (!isFinite(val)) return;
        md += (started ? "L" : "M") + x(i).toFixed(2) + " " + y(val).toFixed(2) + " ";
        started = true;
      });
      if (started) svg.appendChild(el("path", { d: md, class: "chart__ma chart__ma--" + si }));
    });

    // --- 내 매수 시점
    (opts.markers || []).forEach(function (m) {
      var i = indexByDate[m.date];
      if (i === undefined) {
        // 주말/공휴일에 산 경우: 그 이전 가장 가까운 영업일 자리에 찍는다.
        for (var j = rows.length - 1; j >= 0; j--) {
          if (rows[j].date <= m.date) {
            i = j;
            break;
          }
        }
      }
      if (i === undefined) return;
      var c = el("circle", { cx: x(i), cy: y(m.rate), r: 4, class: "chart__marker" });
      var title = el("title", {});
      title.textContent = m.label || m.date;
      c.appendChild(title);
      svg.appendChild(c);
    });

    // --- 마지막 점 강조
    var lastIdx = rows.length - 1;
    svg.appendChild(el("circle", { cx: x(lastIdx), cy: y(rows[lastIdx].rate), r: 3.5, class: "chart__last" }));

    container.appendChild(svg);
  }

  // rows에 대응하는 이동평균 값 배열(앞쪽은 NaN). 차트 오버레이용.
  function movingAverage(rows, n) {
    var out = new Array(rows.length);
    var sum = 0;
    for (var i = 0; i < rows.length; i++) {
      sum += rows[i].rate;
      if (i >= n) sum -= rows[i - n].rate;
      out[i] = i >= n - 1 ? sum / n : NaN;
    }
    return out;
  }

  global.Chart = { line: line, movingAverage: movingAverage };
})(window);
