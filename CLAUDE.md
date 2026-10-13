# 글로벌 매크로 팔로업 대시보드 — 작업 인수인계

매주 토요일 "글로벌 매크로 팔로업 스터디"에서 보는 시장 데이터 대시보드.
사용자는 HTML/CSS를 배우는 중이므로 **설명은 한국어로, 변경은 최소한으로, 왜 그렇게 바꾸는지 짧게** 알려줄 것.

---

## 1. 전체 구조

```
[Google Apps Script]  (구글 시트에 붙어 있는 스크립트, 이 저장소 밖에 있음)
  ├─ 코드.gs   : 데이터 수집 함수들 (CNBC, NAVER_*, CNN_FG, getGdpNow_, getFedWatch_ …)
  ├─ 수집.gs   : collectAll() — 전부 모아 '스냅샷' JSON으로 저장. 트리거가 매시간 실행
  ├─ 페이지.gs : doGet() — 웹 앱 진입점
  └─ index.html: (이전) Apps Script가 직접 보여주던 페이지
        │
        │  스냅샷을 JSON으로 내보내는 웹 앱 주소 (…/exec?format=json)
        ▼
[GitHub Pages]  ← 이 저장소
  └─ index.html : JSON을 fetch로 받아 대시보드를 그림
```

- 수집은 Apps Script에 그대로 둔다 (FRED API 키도 Apps Script에만 있음).
- GitHub는 **화면만** 담당한다. 이유: Apps Script 웹 앱은 개인 계정이면 "Google Apps Script 사용자가 만든 앱" 배너가 항상 뜨고 주소가 길어서.
- 비용 0원 유지가 조건 (Apps Script 무료, GitHub Pages 공개 저장소 무료).

---

## 2. 이번에 할 일

### (1) Apps Script `페이지.gs` — JSON 창구 추가
`doGet(e)`에 분기 추가:
- `?format=json` → `getSnapshot()` 결과를 JSON으로 반환
- `?format=json&action=refresh` → `refreshFromPage()` 결과를 JSON으로 반환 (마지막 수집 후 3분 이내면 재수집 안 함 — 이미 함수에 구현됨)
- 파라미터 없으면 기존처럼 HTML 페이지 반환 (기존 동작 유지)

참고 구현:
```javascript
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.format === 'json') {
    const data = (p.action === 'refresh') ? refreshFromPage() : getSnapshot();
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // ↓ 기존 HTML 반환 코드 그대로
}
```

배포 조건 (사용자가 직접 해야 함):
- **배포 관리 → 기존 배포 연필 → 버전: 새 버전**으로 재배포 (새 배포를 만들면 주소가 바뀜)
- **실행 사용자: 나**, **액세스 권한: 모든 사용자(Anyone)** — 로그인 필요 설정이면 GitHub 페이지에서 fetch가 실패함

### (2) 이 저장소 `index.html` — 데이터 받는 부분만 교체
현재 파일은 Apps Script용이라 GitHub에서는 카드가 비어서 나옴. 바꿀 곳:
- `<script type="application/json" id="snap-data"><?!= snapJson ?></script>` 제거 (Apps Script 템플릿 문법)
- `google.script.run...getSnapshot()` / `refreshFromPage()` 호출을 `fetch`로 교체
- 맨 위에 `const API_URL = 'https://script.google.com/macros/s/……/exec';` 상수 하나 두고 사용자가 채우게 할 것
- 로딩 중 / 실패 시 상태 문구 표시 (`#updated`, `#status` 요소 활용)
- **CSS와 render() 안의 카드 구성은 건드리지 말 것** (사용자가 직접 고친 부분이 있음)

fetch 주의점:
- Apps Script 웹 앱은 `script.googleusercontent.com`으로 302 리다이렉트됨 → `fetch`는 기본으로 따라가므로 OK
- **GET만 쓰고 커스텀 헤더를 붙이지 말 것** (Content-Type 등 붙이면 CORS preflight가 생기는데 Apps Script는 OPTIONS를 처리 못 해서 실패)
- 갱신 버튼도 GET: `fetch(API_URL + '?format=json&action=refresh')`

---

## 3. 스냅샷 JSON 구조

```jsonc
{
  "updatedAt": "2026-10-13 02:24",          // 한국시간
  "failed": [],                              // 이번 수집에서 실패한 항목 설명
  "sections": {
    "<키>": {
      "data": { ... },                       // 실패했고 이전 값도 없으면 null
      "at": "2026-10-13 02:24",              // 이 data가 수집된 시각
      "stale": false,                        // true = 이번엔 실패해서 직전 값을 보여주는 중
      "error": "…"                           // stale일 때만
    }
  }
}
```

| 키 | data 내용 |
|---|---|
| `usIndices` | `rows[{name,ticker,price,change,pct,date}]` (다우·S&P500·나스닥·러셀2000), `order`(등락률 순 문자열) |
| `rates` | `us10y{last,change,pct,time}`, `us2y{…}`, `spreadBp`, `curve`(정상/역전/보합) |
| `dollarOil` | `dxy`, `wti`, `brent`(없으면 null) — 각 `{last,change,pct,time}` |
| `vix` | `last, change, pct, date, state` — date가 이상하게 오므로 화면에선 usIndices의 date 사용 |
| `usSectors` | `list[{name,ticker,pct}]` 등락률 내림차순 11개, `top[2]`, `bottom[2]` |
| `krIndices` | `rows[{name,code,close,change,pct,date}]` (코스피·코스닥·코스피200), `compare`, `style` |
| `flows` | `kospi{personal,foreign,institution,date}`, `kosdaq{…}` — 순매수 억원 |
| `usdkrw` | `close, change, pct, date` |
| `krSectors` | `top["해운사 (+5.28%)", …]`, `bottom[…]` — 문자열 |
| `sentiment` | `score, rating, prev, week, month, date, source`("CNN" 또는 "수동 입력") |
| `gdpnow` | `quarter, now, status`(상향/유지/하향/신규 분기)`, change, prev, date, prevDate, source` |
| `fedwatch` | `meeting, rows[{key,label,now,week,change}]`(인하/동결/인상), `likely, source` |

숫자는 숫자 타입, 값 없으면 `null`. 날짜는 `yyyy-MM-dd`.

---

## 4. 디자인 규칙 (유지할 것)

- **색: 한국식** — 상승 빨강(`--up`, `--up-text`), 하락 파랑(`--down`, `--down-text`), ▲▼ 기호 함께 표시
- **라이트 모드만** — 다크 모드 블록은 사용자가 일부러 삭제함. 다시 넣지 말 것
- **폰트**: KoPubWorld 돋움(본문) / 바탕(제목 일부)
  `https://cdn.jsdelivr.net/npm/font-kopubworld@1.0.3/css/all.css`
  family 이름: `'KoPubWorld Dotum'`, `'KoPubWorld Batang'` (굵기 300/400/700만 있음)
- **팔레트** (2026-10 적용): 초록 `#104429`(제목·강조) · 노랑 `#FFD966`(배지·안내) · 진한회색 `#595959` · 중간회색 `#A5A5A5` · 연한회색 `#D9D9D9` · 제목 박스 회색 `#ECECE9` · 섹션 제목 밑줄 `#404040` · 배경 미색 `#F8F8F6` + 흰색·검은색. 하락 파랑은 유지
- 색은 전부 `:root`의 CSS 변수로 관리. HEX 값 바꿀 때 `#`과 `;` 누락 주의 (전에 이걸로 막대가 사라진 적 있음)

---

## 5. 절대 하지 말 것

- **FRED API 키를 이 저장소에 올리지 말 것** — 공개 저장소임. 키는 Apps Script `코드.gs`에만 있음.
  Apps Script 코드를 참고용으로 저장소에 넣을 경우 키 줄은 `'여기에_API_키'`로 가릴 것.
- **사이트 비밀번호도 저장소에 올리지 말 것** — Apps Script 프로젝트 설정 → 스크립트 속성 `SITE_PASSWORD`에만 있음. 페이지는 `&key=`로 보내고 `페이지.gs`가 확인함 (비워 두면 비밀번호 없이 열림).
- 수집 로직(수집.gs, 코드.gs)은 이번 작업 범위가 아님. 고칠 필요가 생기면 사용자에게 먼저 말할 것.
- 데이터 출처 사이트(CME, CNN 등)를 브라우저에서 직접 fetch하지 말 것 — CORS·약관 문제로 Apps Script를 거치는 구조임.

---

## 6. 알려진 미해결 이슈 (급하지 않음)

- GDPNow 출처가 FRED로 나옴 → 애틀랜타 연은 홈페이지 직접 읽기 버전(7번 코드 교체본)을 적용했는지 미확인. FRED는 며칠 늦게 반영될 때가 있음.
- VIX 날짜를 GOOGLEFINANCE가 이상하게 줌 → 화면에서 미국 지수 날짜로 대체해서 표시 중.
- FOMC 일정은 연준 홈페이지에서 자동으로 읽음(실패 시 2028년 1월까지 기본 일정).

---

## 7. 작업 흐름 (사용자 기준)

- 이 저장소 수정 → 커밋 → 1~2분 뒤 `https://eibc-code.github.io/Macro-Terminal/` 에 반영
- Apps Script 수정 → 저장 → **배포 관리 → 새 버전**으로 재배포해야 `/exec`에 반영 (테스트는 `/dev` 주소)
- 데이터는 Apps Script 트리거가 매시간 자동 수집 → 코드 변경 없으면 재배포 불필요
