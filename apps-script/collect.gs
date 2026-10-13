/* =========================================================
 * 수집.gs — doGet 페이지용 데이터 수집 (스냅샷)
 *
 * collectAll()  : 모든 데이터를 모아 '스냅샷'으로 저장 (트리거가 매시간 실행)
 * getSnapshot() : 저장된 스냅샷 읽기 (doGet 페이지가 사용)
 *
 * 기존 코드.gs의 NAVER_*, CNN_FG, getGdpNow_, getFedWatch_, CNBC 함수를 그대로 재사용함.
 * 항목이 실패하면 → 수동입력 탭 값(CNN·FedWatch만) → 직전 스냅샷 값 순서로 대체.
 * ========================================================= */

const SNAP_KEY = 'snapshot_v1';
const TZ_KR = 'Asia/Seoul';
const TZ_US = 'America/New_York';

// GOOGLEFINANCE로 받을 종목 (숨김 탭 '_gf'에서 계산)
const GF_TICKERS = [
  ['us', '다우', 'INDEXDJX:.DJI'],
  ['us', 'S&P500', 'INDEXSP:.INX'],
  ['us', '나스닥', 'INDEXNASDAQ:.IXIC'],
  ['us', '러셀2000', 'INDEXRUSSELL:RUT'],
  ['vix', 'VIX', 'INDEXCBOE:VIX'],
  ['sector', '기술', 'NYSEARCA:XLK'],
  ['sector', '금융', 'NYSEARCA:XLF'],
  ['sector', '헬스케어', 'NYSEARCA:XLV'],
  ['sector', '경기소비재', 'NYSEARCA:XLY'],
  ['sector', '커뮤니케이션', 'NYSEARCA:XLC'],
  ['sector', '산업재', 'NYSEARCA:XLI'],
  ['sector', '필수소비재', 'NYSEARCA:XLP'],
  ['sector', '에너지', 'NYSEARCA:XLE'],
  ['sector', '부동산', 'NYSEARCA:XLRE'],
  ['sector', '유틸리티', 'NYSEARCA:XLU'],
  ['sector', '소재', 'NYSEARCA:XLB']
];

// 수동입력 탭 항목 (자동 수집이 실패했을 때만 사용)
const MANUAL_ROWS = [
  ['cnn.score', 'CNN 공포·탐욕 지수'],
  ['cnn.prev', 'CNN 전일'],
  ['cnn.week', 'CNN 1주 전'],
  ['cnn.month', 'CNN 1개월 전'],
  ['fed.now.cut', 'FedWatch 인하 - 이번 주 (%)'],
  ['fed.now.hold', 'FedWatch 동결 - 이번 주 (%)'],
  ['fed.now.hike', 'FedWatch 인상 - 이번 주 (%)'],
  ['fed.week.cut', 'FedWatch 인하 - 지난주 (%)'],
  ['fed.week.hold', 'FedWatch 동결 - 지난주 (%)'],
  ['fed.week.hike', 'FedWatch 인상 - 지난주 (%)']
];

/* ---------------------------------------------------------
 * 메인: 전체 수집 → 스냅샷 저장
 * --------------------------------------------------------- */
function collectAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return loadSnapshot_();          // 다른 수집이 진행 중이면 기존 값 반환
  try {
    // 기존 함수들의 캐시를 비워서 항상 새로 받아오게 함
    CacheService.getScriptCache().removeAll(['gdpnow_v1', 'gdpnow_v2', 'fedwatch_v1', 'fedwatch_v2',
      'cnn_fg_v1', 'cnn_fg_v2', 'naver_sectors_v3']);

    const prev = loadSnapshot_() || { sections: {} };
    const ss = getSS_();
    const manual = readManual_(ss);

    let gf = null, gfErr = '';
    try { gf = readGoogleFinance_(ss); } catch (e) { gfErr = e.message; }
    const needGf = group => {
      if (!gf) throw new Error('GOOGLEFINANCE ' + gfErr);
      return gf.filter(r => r.group === group);
    };

    let cnbcData = null;
    const cnbc = sym => {
      if (!cnbcData) { try { cnbcData = cnbcBatch_(['US10Y', 'US2Y', '.DXY', '@CL.1', '@LCO.1']); } catch (e) { cnbcData = {}; } }
      if (cnbcData[sym] && cnbcData[sym].last != null) return cnbcData[sym];
      // 묶음 조회에 없으면 기존 CNBC() 함수로 한 번 더 시도
      return { last: num_(safe_(() => CNBC(sym, 'last'))), change: num_(safe_(() => CNBC(sym, 'change'))),
               pct: num_(safe_(() => CNBC(sym, 'change_pct'))) };
    };

    const collectors = {
      // 1. 미국 4대 지수
      usIndices: () => {
        const rows = needGf('us');
        rows.forEach(r => must_(r.price, r.name));
        const order = rows.slice().sort((a, b) => a.pct - b.pct)
          .map(r => r.name).join(' < ');
        return { rows: rows, order: order };
      },

      // 2. 미국 국채 금리
      rates: () => {
        const t10 = cnbc('US10Y'), t2 = cnbc('US2Y');
        must_(t10.last, 'US10Y'); must_(t2.last, 'US2Y');
        const spreadBp = Math.round((t10.last - t2.last) * 1000) / 10;
        return { us10y: t10, us2y: t2, spreadBp: spreadBp,
                 curve: spreadBp > 0 ? '정상' : spreadBp < 0 ? '역전' : '보합' };
      },

      // 3. 달러인덱스·유가
      dollarOil: () => {
        const dxy = cnbc('.DXY'), wti = cnbc('@CL.1');
        must_(dxy.last, '달러인덱스'); must_(wti.last, 'WTI');
        const brent = cnbc('@LCO.1');
        return { dxy: dxy, wti: wti, brent: brent.last != null ? brent : null };
      },

      // 4. VIX
      vix: () => {
        const v = needGf('vix')[0];
        must_(v.price, 'VIX');
        return { last: v.price, change: v.change, pct: v.pct, date: v.date,
                 state: v.price >= 20 ? '변동성 큼' : '변동성 안정적' };
      },

      // 5. 미국 섹터
      usSectors: () => {
        const list = needGf('sector').filter(r => r.pct != null)
          .map(r => ({ name: r.name, ticker: r.ticker, pct: r.pct }))
          .sort((a, b) => b.pct - a.pct);
        if (list.length < 8) throw new Error('섹터 데이터 부족');
        return { list: list, top: list.slice(0, 2), bottom: list.slice(-2).reverse() };
      },

      // 6. 국내 지수 + 비교 분석·스타일 힌트
      krIndices: () => {
        const rows = [['코스피', 'KOSPI'], ['코스닥', 'KOSDAQ'], ['코스피200', 'KPI200']].map(([name, code]) => ({
          name: name, code: code,
          close: num_(safe_(() => NAVER_INDEX(code, 'close'))),
          change: num_(safe_(() => NAVER_INDEX(code, 'change'))),
          pct: num_(safe_(() => NAVER_INDEX(code, 'change_pct'))),
          date: dateStr_(safe_(() => NAVER_INDEX(code, 'date')))
        }));
        rows.forEach(r => must_(r.close, r.name));
        const p = rows[0].pct, q = rows[1].pct, k200 = rows[2].pct;
        let compare = '';
        if (p > 0 && q > 0) compare = '코스피, 코스닥 동시 상승 (' + (p > q ? '코스피' : '코스닥') + '가 더 큰 폭)';
        else if (p < 0 && q < 0) compare = '코스피, 코스닥 동시 하락 (' + (p < q ? '코스피' : '코스닥') + '가 더 큰 폭)';
        else compare = '코스피 ' + (p >= 0 ? '상승' : '하락') + ', 코스닥 ' + (q >= 0 ? '상승' : '하락') + ' (다른 방향)';
        const style = (k200 - q >= 0.5) ? '대형주 우위' : (q - k200 >= 0.5) ? '중소형·성장주 우위' : '대형·중소형 비슷 (혼조)';
        return { rows: rows, compare: compare, style: style };
      },

      // 7. 투자자별 매매동향 (억원)
      flows: () => {
        const one = code => ({
          personal: num_(safe_(() => NAVER_TREND(code, 'personal'))),
          foreign: num_(safe_(() => NAVER_TREND(code, 'foreign'))),
          institution: num_(safe_(() => NAVER_TREND(code, 'institution'))),
          date: dateStr_(safe_(() => NAVER_TREND(code, 'date')))
        });
        const kospi = one('KOSPI'), kosdaq = one('KOSDAQ');
        must_(kospi.foreign, '코스피 수급'); must_(kosdaq.foreign, '코스닥 수급');
        return { kospi: kospi, kosdaq: kosdaq };
      },

      // 8. 원/달러 환율
      usdkrw: () => {
        const r = {
          close: num_(safe_(() => NAVER_FX('FX_USDKRW', 'close'))),
          change: num_(safe_(() => NAVER_FX('FX_USDKRW', 'change'))),
          pct: num_(safe_(() => NAVER_FX('FX_USDKRW', 'change_pct'))),
          date: dateStr_(safe_(() => NAVER_FX('FX_USDKRW', 'date')))
        };
        must_(r.close, '환율');
        return r;
      },

      // 9. 국내 업종 상승·하락 1·2위
      krSectors: () => {
        const get = (dir, rank) => {
          const v = safe_(() => NAVER_SECTOR(dir, rank));
          if (isBad_(v)) throw new Error('국내 업종 ' + v);
          return v;
        };
        return { top: [get('up', 1), get('up', 2)], bottom: [get('down', 1), get('down', 2)] };
      },

      // 10. CNN 공포·탐욕 지수 (자동 → 수동입력)
      sentiment: () => {
        const score = safe_(() => CNN_FG('score'));
        if (!isBad_(score)) {
          return { score: num_(score), rating: fgRating_(num_(score)),
                   prev: num_(safe_(() => CNN_FG('prev'))), week: num_(safe_(() => CNN_FG('week'))),
                   month: num_(safe_(() => CNN_FG('month'))), date: dateStr_(safe_(() => CNN_FG('date'))),
                   source: 'CNN' };
        }
        if (manual['cnn.score'] != null) {
          return { score: manual['cnn.score'], rating: fgRating_(manual['cnn.score']),
                   prev: manual['cnn.prev'], week: manual['cnn.week'], month: manual['cnn.month'],
                   date: '', source: '수동 입력' };
        }
        throw new Error('CNN ' + score);
      },

      // 11. GDPNow
      gdpnow: () => {
        const d = safe_(() => getGdpNow_());
        if (!d || typeof d !== 'object' || d.error) throw new Error('GDPNow ' + (d && d.error ? d.error : d));
        return { quarter: d.quarter, now: d.now, status: d.status, change: d.change, prev: d.prev,
                 date: d.date, prevDate: d.prev_date, source: d.source || 'FRED' };
      },

      // 12. FedWatch (자동 계산 → 수동입력)
      fedwatch: () => {
        const d = safe_(() => getFedWatch_());
        let now, week, meeting = '', source;
        if (d && typeof d === 'object' && !d.error && d.now) {
          now = d.now; week = d.week; meeting = d.meeting; source = '선물 가격 계산';
        } else if (manual['fed.now.cut'] != null || manual['fed.now.hold'] != null) {
          now = { cut: manual['fed.now.cut'] || 0, hold: manual['fed.now.hold'] || 0, hike: manual['fed.now.hike'] || 0 };
          week = (manual['fed.week.hold'] != null || manual['fed.week.cut'] != null)
            ? { cut: manual['fed.week.cut'] || 0, hold: manual['fed.week.hold'] || 0, hike: manual['fed.week.hike'] || 0 }
            : null;
          source = '수동 입력';
        } else {
          throw new Error('FedWatch ' + (d && d.error ? d.error : d));
        }
        const kinds = [['cut', '인하'], ['hold', '동결'], ['hike', '인상']];
        const rows = kinds.map(([k, label]) => ({
          key: k, label: label, now: now[k], week: week ? week[k] : null,
          change: week ? Math.round((now[k] - week[k]) * 10) / 10 : null
        }));
        const likely = rows.slice().sort((a, b) => b.now - a.now)[0].label;
        return { meeting: meeting, rows: rows, likely: likely, source: source };
      }
    };

    const nowStr = Utilities.formatDate(new Date(), TZ_KR, 'yyyy-MM-dd HH:mm');
    const sections = {}, failed = [];
    Object.keys(collectors).forEach(key => {
      try {
        sections[key] = { data: collectors[key](), at: nowStr, stale: false };
      } catch (e) {
        failed.push(key + ': ' + e.message);
        const old = prev.sections && prev.sections[key];
        sections[key] = (old && old.data)
          ? { data: old.data, at: old.at, stale: true, error: e.message }   // 직전 값 유지
          : { data: null, at: null, stale: true, error: e.message };
      }
    });

    const snap = { updatedAt: nowStr, sections: sections, failed: failed };
    saveSnapshot_(snap);
    return snap;
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------
 * 페이지에서 쓰는 함수
 * --------------------------------------------------------- */
function getSnapshot() {
  return loadSnapshot_() || collectAll();
}

// 페이지의 '지금 갱신' 버튼용
function refreshNow() {
  return collectAll();
}

/* ---------------------------------------------------------
 * 한 번만 실행: 매시간 자동 수집 예약 (예전 refreshAll 예약은 삭제)
 * --------------------------------------------------------- */
function installCollectTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['collectAll', 'refreshAll'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('collectAll').timeBased().everyHours(1).create();
  collectAll();   // 바로 한 번 수집
}

// 확인용: 실행 후 '실행 로그'에서 결과 확인
function testCollect() {
  const snap = collectAll();
  Logger.log('수집 시각: ' + snap.updatedAt);
  Logger.log('실패 항목: ' + (snap.failed.length ? snap.failed.join(' / ') : '없음'));
  Object.keys(snap.sections).forEach(k => {
    const s = snap.sections[k];
    Logger.log(k + (s.stale ? ' [이전 값]' : '') + ' → ' + JSON.stringify(s.data).slice(0, 300));
  });
}

/* ---------------------------------------------------------
 * 내부 도우미
 * --------------------------------------------------------- */

// 시트 열기 (트리거·웹앱 어디서 실행돼도 같은 시트를 찾도록 ID 기억)
function getSS_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (ss) { props.setProperty('SS_ID', ss.getId()); return ss; }
  const id = props.getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  throw new Error('시트를 찾을 수 없음 (Apps Script에서 testCollect를 한 번 실행해 주세요)');
}

// 숨김 탭 '_gf'에 GOOGLEFINANCE 수식을 두고 값을 읽음
function readGoogleFinance_(ss) {
  let sh = ss.getSheetByName('_gf');
  if (!sh) { sh = ss.insertSheet('_gf'); sh.hideSheet(); }
  const n = GF_TICKERS.length;
  const formulas = GF_TICKERS.map((t, i) => {
    const r = i + 1;
    return ['=GOOGLEFINANCE(A' + r + ',"price")', '=GOOGLEFINANCE(A' + r + ',"change")',
            '=GOOGLEFINANCE(A' + r + ',"changepct")', '=GOOGLEFINANCE(A' + r + ',"tradetime")'];
  });
  const tickers = sh.getRange(1, 1, n, 1).getValues();
  const current = sh.getRange(1, 2, n, 4).getFormulas();
  const same = GF_TICKERS.every((t, i) => tickers[i][0] === t[2] && current[i][0] === formulas[i][0]);
  if (!same) {
    sh.clear();
    sh.getRange(1, 1, n, 1).setValues(GF_TICKERS.map(t => [t[2]]));
    sh.getRange(1, 2, n, 4).setFormulas(formulas);
  }
  SpreadsheetApp.flush();

  let vals = [];
  for (let k = 0; k < 6; k++) {                                // 계산이 끝날 때까지 최대 약 10초 대기
    vals = sh.getRange(1, 1, n, 5).getValues();
    if (vals.every(v => typeof v[1] === 'number')) break;
    Utilities.sleep(2000);
    SpreadsheetApp.flush();
  }
  return GF_TICKERS.map((t, i) => ({
    group: t[0], name: t[1], ticker: t[2],
    price: num_(vals[i][1]), change: num_(vals[i][2]), pct: num_(vals[i][3]),
    date: (vals[i][4] instanceof Date) ? Utilities.formatDate(vals[i][4], TZ_US, 'yyyy-MM-dd') : ''
  }));
}

// CNBC 여러 종목을 한 번에 조회
function cnbcBatch_(symbols) {
  const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols='
    + encodeURIComponent(symbols.join('|'))
    + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (res.getResponseCode() !== 200) throw new Error('CNBC ' + res.getResponseCode());
  let list = JSON.parse(res.getContentText()).FormattedQuoteResult.FormattedQuote;
  if (!Array.isArray(list)) list = [list];
  const n = v => {
    if (v === undefined || v === null || v === '') return null;
    if (v === 'UNCH') return 0;
    const x = parseFloat(String(v).replace(/[,%+]/g, ''));
    return isNaN(x) ? null : x;
  };
  const out = {};
  list.forEach(q => { out[q.symbol] = { last: n(q.last), change: n(q.change), pct: n(q.change_pct), time: q.last_time || '' }; });
  return out;
}

// 수동입력 탭 읽기 (없으면 만들어 둠)
function readManual_(ss) {
  let sh = ss.getSheetByName('수동입력');
  if (!sh) {
    sh = ss.insertSheet('수동입력');
    sh.getRange(1, 1, 1, 3).setValues([['키 (수정 금지)', '항목', '값 — 자동 수집이 실패했을 때만 사용']]);
    sh.getRange(2, 1, MANUAL_ROWS.length, 2).setValues(MANUAL_ROWS);
    sh.setColumnWidth(2, 220); sh.setColumnWidth(3, 260);
  }
  const vals = sh.getRange(2, 1, MANUAL_ROWS.length, 3).getValues();
  const m = {};
  vals.forEach(r => { m[r[0]] = (typeof r[2] === 'number') ? r[2] : null; });
  return m;
}

// 스냅샷 저장·읽기 (저장 공간 한도 때문에 조각내서 저장)
function saveSnapshot_(snap) {
  const props = PropertiesService.getScriptProperties();
  const s = JSON.stringify(snap), size = 2500;
  const parts = {};
  const n = Math.ceil(s.length / size);
  for (let i = 0; i < n; i++) parts[SNAP_KEY + '_' + i] = s.slice(i * size, (i + 1) * size);
  parts[SNAP_KEY + '_n'] = String(n);
  props.setProperties(parts);
}

function loadSnapshot_() {
  try {
    const p = PropertiesService.getScriptProperties();
    const n = +p.getProperty(SNAP_KEY + '_n');
    if (!n) return null;
    let s = '';
    for (let i = 0; i < n; i++) s += p.getProperty(SNAP_KEY + '_' + i) || '';
    return JSON.parse(s);
  } catch (e) { return null; }
}

// 실패 문자열 판별 (기존 함수들은 실패 시 '수집 실패' 같은 글자를 돌려줌)
function isBad_(v) {
  return v === null || v === undefined || v === '' ||
    (typeof v === 'string' && /^(수집 실패|항목 없음|데이터 없음|API 키 없음|오류)/.test(v));
}

// 함수가 없거나 오류가 나도 멈추지 않게 감싸기
function safe_(fn) {
  try { return fn(); } catch (e) { return '오류: ' + e.message; }
}

function must_(v, label) {
  if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) throw new Error(label + ' 값 없음');
}

function num_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (isBad_(v)) return null;
  const x = parseFloat(String(v).replace(/[,%+]/g, ''));
  return isNaN(x) ? null : x;
}

function fix_(v, d) {
  return (typeof v === 'number') ? v.toFixed(d) : '-';
}

// 날짜를 'yyyy-MM-dd'로 통일 ("20260923", "2026-09-23T15:30:00+09:00" 등)
function dateStr_(v) {
  if (isBad_(v)) return '';
  if (v instanceof Date) return Utilities.formatDate(v, TZ_KR, 'yyyy-MM-dd');
  const s = String(v);
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : s;
}

function fgRating_(score) {
  if (typeof score !== 'number') return '';
  return score < 25 ? '극단적 공포' : score < 45 ? '공포' : score < 56 ? '중립' : score < 76 ? '탐욕' : '극단적 탐욕';
}
