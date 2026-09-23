(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 공유 상태 동기화
  // ---------------------------------------------------------------------
  // 기본은 localStorage라 사람마다·기기마다 다른 화면을 본다. 기획을 같이
  // 하려면 한 벌을 공유해야 해서, Worker의 KV 저장소를 정본으로 삼는다.
  //
  // localStorage는 버리지 않고 오프라인 캐시로 남긴다. 공유 저장소가 아직
  // 안 붙었거나 네트워크가 죽어도 앱은 그대로 돌아야 한다.
  //
  // 충돌은 서버가 rev로 잡고, 여기서는 **합쳐서** 다시 올린다. 이 앱의 데이터는
  // 대부분 id를 가진 배열이라 합치기가 정확하게 된다 — 남의 추가분을 버리지도,
  // 내 추가분을 잃지도 않는다.

  var PUSH_DEBOUNCE_MS = 900;

  // KV는 최종 일관성이고 엣지 읽기 캐시가 60초다(2026-09-23 실측: 쓰고 나서
  // 다른 엣지에 보이기까지 1분 가까이 걸렸다). 그보다 자주 물어봐야 같은
  // 캐시값이 돌아올 뿐이라 요청만 버린다. 그래서 주기를 캐시 수명에 맞춘다.
  //
  // 그 사이 남의 저장을 덮어쓸 수 있지만(stale rev로 통과), 손실이 남지는
  // 않는다 — pull이 '교체'가 아니라 '합치기'라서, 데이터를 갖고 있던 쪽이
  // 다음 동기화 때 자기 항목을 도로 밀어 올린다. 스스로 아문다.
  var POLL_MS = 60 * 1000;

  var rev = 0; // 마지막으로 받아간 서버 리비전
  var state = "off"; // off | ok | offline | unbound | error
  var updatedAt = null;
  var pushTimer = null;
  var inFlight = false;
  var listeners = [];

  function notify() {
    listeners.forEach(function (fn) {
      try {
        fn(status());
      } catch (err) {
        /* 표시가 실패해도 동기화는 계속 */
      }
    });
  }

  function onStatus(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function status() {
    return { state: state, rev: rev, updatedAt: updatedAt };
  }

  function endpoint() {
    var base = global.FxDomestic && global.FxDomestic.liveUrl ? global.FxDomestic.liveUrl() : "";
    return base ? base + "/v1/state" : "";
  }

  // ---------------------------------------------------------------------
  // 합치기
  // ---------------------------------------------------------------------
  // id가 있는 배열은 합집합으로 둔다. 같은 id면 내 것을 쓴다 — 방금 고친 쪽이
  // 더 최신일 가능성이 높다. 순서는 원격을 앞에 둬서 남의 항목이 밀려나지 않게 한다.

  function mergeById(remote, local) {
    var out = [];
    var seen = {};
    var localById = {};
    (local || []).forEach(function (x) {
      if (x && x.id) localById[x.id] = x;
    });
    (remote || []).forEach(function (x) {
      if (!x || !x.id) return;
      seen[x.id] = true;
      out.push(localById[x.id] || x);
    });
    (local || []).forEach(function (x) {
      if (x && x.id && !seen[x.id]) out.push(x);
    });
    return out;
  }

  // 노선 안의 관측치는 날짜가 키다. 같은 날이면 내 값을 쓴다.
  function mergeRoutes(remote, local) {
    var merged = mergeById(remote, local);
    var localById = {};
    (local || []).forEach(function (r) {
      if (r && r.id) localById[r.id] = r;
    });
    var remoteById = {};
    (remote || []).forEach(function (r) {
      if (r && r.id) remoteById[r.id] = r;
    });
    return merged.map(function (r) {
      var a = (remoteById[r.id] && remoteById[r.id].observations) || [];
      var b = (localById[r.id] && localById[r.id].observations) || [];
      var byDate = {};
      a.concat(b).forEach(function (o) {
        if (o && o.date) byDate[o.date] = o; // 뒤에 오는 로컬 값이 이긴다
      });
      var obs = Object.keys(byDate)
        .sort()
        .map(function (d) {
          return byDate[d];
        });
      var copy = {};
      Object.keys(r).forEach(function (k) {
        copy[k] = r[k];
      });
      copy.observations = obs;
      return copy;
    });
  }

  function merge(remote, local) {
    if (!remote) return local;
    if (!local) return remote;
    return {
      v: local.v || remote.v,
      buys: mergeById(remote.buys, local.buys),
      plans: mergeById(remote.plans, local.plans),
      alerts: mergeById(remote.alerts, local.alerts),
      items: mergeById(remote.items, local.items),
      routes: mergeRoutes(remote.routes, local.routes),
      // 설정은 id가 없어 합칠 수가 없다. 방금 만진 쪽(로컬)을 쓴다.
      settings: local.settings || remote.settings,
    };
  }

  // ---------------------------------------------------------------------
  // 통신
  // ---------------------------------------------------------------------

  function req(method, body) {
    var url = endpoint();
    if (!url) return Promise.reject(new Error("공유 저장소 주소가 없습니다."));
    var opts = { method: method, cache: "no-store" };
    if (body) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.json().then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  // 서버 내용을 받아 로컬에 반영한다. 바뀌었으면 true.
  function pull() {
    if (inFlight) return Promise.resolve(false);
    inFlight = true;
    return req("GET")
      .then(function (r) {
        inFlight = false;
        if (r.status === 503) {
          state = "unbound";
          notify();
          return false;
        }
        if (!r.data || r.data.ok !== true) {
          state = "error";
          notify();
          return false;
        }
        state = "ok";
        updatedAt = r.data.updatedAt;

        if (r.data.data == null) {
          // 저장소가 비어 있다. 지금 브라우저 내용을 씨앗으로 올린다.
          rev = r.data.rev || 0;
          notify();
          return push(true).then(function () {
            return false;
          });
        }

        if ((r.data.rev || 0) === rev) {
          notify();
          return false; // 내가 아는 그대로다
        }
        rev = r.data.rev || 0;
        global.Portfolio.adoptShared(merge(r.data.data, global.Portfolio.load()));
        notify();
        return true;
      })
      .catch(function () {
        inFlight = false;
        state = "offline";
        notify();
        return false;
      });
  }

  // 로컬 내용을 올린다. 그 사이 남이 먼저 저장했으면 합쳐서 한 번 더 시도한다.
  function push(immediate) {
    if (!immediate) return schedulePush();
    return req("PUT", { rev: rev, data: global.Portfolio.load() })
      .then(function (r) {
        if (r.status === 503) {
          state = "unbound";
          notify();
          return false;
        }
        if (r.status === 409) {
          // 남이 먼저 올렸다. 그 위에 내 것을 합쳐 다시 올린다.
          rev = r.data.rev || 0;
          global.Portfolio.adoptShared(merge(r.data.data, global.Portfolio.load()));
          return req("PUT", { rev: rev, data: global.Portfolio.load() }).then(function (r2) {
            if (r2.data && r2.data.ok) {
              rev = r2.data.rev;
              updatedAt = r2.data.updatedAt;
              state = "ok";
            }
            notify();
            return true;
          });
        }
        if (r.data && r.data.ok) {
          rev = r.data.rev;
          updatedAt = r.data.updatedAt;
          state = "ok";
        } else {
          state = "error";
        }
        notify();
        return true;
      })
      .catch(function () {
        state = "offline";
        notify();
        return false;
      });
  }

  // 연속된 편집을 한 번으로 묶는다. 글자 하나 칠 때마다 올릴 이유가 없다.
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      push(true);
    }, PUSH_DEBOUNCE_MS);
    return Promise.resolve(true);
  }

  // onChanged: 원격 내용이 들어와 화면을 다시 그려야 할 때 부른다.
  function start(onChanged) {
    if (!endpoint()) return;
    state = "ok";

    global.Portfolio.onChange(function () {
      schedulePush();
    });

    function refresh() {
      pull().then(function (changed) {
        if (changed && onChanged) onChanged();
      });
    }

    refresh();
    setInterval(function () {
      if (!document.hidden) refresh();
    }, POLL_MS);
    // 다른 창에서 고치고 돌아왔을 때 바로 맞춰준다.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
  }

  global.Sync = {
    start: start,
    pull: pull,
    push: push,
    status: status,
    onStatus: onStatus,
    merge: merge, // 테스트용
  };
})(window);
