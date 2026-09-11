# 실시간 고시환율 Worker 배포하기

## 왜 필요한가

앱은 원래 GitHub Actions가 미리 받아둔 `data/rates.json`만 읽었습니다. 그런데 **GitHub 무료 러너는 예약(cron)을 통째로 건너뜁니다.**

> 2026-09-11 실측: 11:17·11:37 두 예약 모두 실행되지 않아 정오까지 당일 고시가 없었습니다.

당일 고시가 없으면 **「내일 적용환율」을 못 보여줍니다** — 내일 적용분이 곧 오늘 고시분이기 때문입니다. "오늘 살까 내일 살까"를 정하려고 보는 화면인데 그날 못 쓰게 되는 겁니다.

Worker는 **요청이 올 때** 실행됩니다. 앱을 여는 순간 조회하므로 예약과 무관하게 항상 최신입니다.

| 역할 | 담당 |
|---|---|
| 앱 호스팅 | GitHub Pages (그대로) |
| **오늘·최근 고시환율** | **이 Worker — 앱 열 때 실시간** |
| 과거 이력 (7일 표, 매수 기록) | `data/rates.json` — Actions가 계속 쌓음 (그대로) |

Worker가 죽어도 앱은 `rates.json`으로 돌아가므로 지금보다 나빠지지 않습니다.

---

## 1. 배포 (5분, 설치 불필요)

이 PC에는 Node가 없으므로 웹 대시보드를 씁니다.

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Start with Hello World**
2. 이름을 `fx-live`로 두고 **Deploy**
3. **Edit code** → 편집기 내용을 전부 지우고 [`fx-live.js`](fx-live.js) 전체를 붙여넣기 → **Deploy**
4. Worker → **Settings** → **Variables and Secrets** → **Add**
   - Type **Secret**, Name `KOREAEXIM_KEY`, Value는 한국수출입은행 인증키
   - (선택) Type **Variable**, Name `ALLOWED_ORIGIN`, Value `https://jugga1004.github.io`
5. **Deploy**를 한 번 더 눌러 Secret을 반영
6. 배포 주소 복사 → `https://fx-live.<계정이름>.workers.dev`

## 2. 앱에 연결

앱 → **내 보유 → 국내 고시환율 → 실시간 조회** 칸에 위 주소를 넣고 **연결 확인**.

연결되면 그 자리에서 바로 오늘 고시를 받아옵니다.

---

## 동작 확인

```
https://fx-live.<계정이름>.workers.dev/v1/health
```

`{"ok":true,...,"keyConfigured":true}` 면 키까지 정상입니다.

```
https://fx-live.<계정이름>.workers.dev/v1/recent
```

```json
{ "ok": true, "today": "2026-09-11", "latest": "2026-09-11",
  "rates": { "2026-09-11": { "USD": 1338.2, "JPY": 872.1 } }, "missing": [] }
```

## API

| 경로 | 설명 |
|---|---|
| `GET /v1/recent?days=5` | 최근 영업일들의 매매기준율 (기본 5, 최대 10) |
| `GET /v1/health` | 키 설정 여부 확인 (키 값은 노출하지 않음) |

`JPY`는 **100엔 기준**입니다.

## 호출량

수출입은행 API는 **하루 1,000회** 제한입니다. 앱은 이렇게 아낍니다.

- `rates.json`이 이미 오늘 자를 담고 있으면 **Worker를 아예 호출하지 않습니다.**
- 11시 이전, 주말에는 호출하지 않습니다 (고시가 없으므로).
- 실패해도 10분 안에는 다시 조르지 않습니다.
- Worker 안에서도 과거 날짜는 7일, 오늘 자는 15분 캐시합니다.

개인 사용으로는 하루 수십 회를 넘지 않습니다.

## 인증키가 2년마다 만료됩니다

수출입은행은 개인정보 보유기간(2년)이 지나면 키를 파기하고 `result:3`을 반환합니다. 파기 전 등록 이메일로 「개인정보 수집 재동의」 안내가 오며, 재동의하면 2년 연장됩니다. 파기된 키는 재사용할 수 없습니다.

잘 쓰던 앱이 갑자기 인증 오류를 내면 이 경우입니다. 앱의 상태 표시에 사유가 그대로 나옵니다.
