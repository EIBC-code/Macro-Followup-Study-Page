/* =========================================================
 * 페이지.gs — doGet 웹페이지
 * '수집.gs'가 저장한 스냅샷을 읽어 index.html로 보여줌
 * ========================================================= */
function doGet(e) {
  // GitHub Pages용 JSON 창구: ?format=json (조회) / ?format=json&action=refresh (갱신)
  const p = (e && e.parameter) || {};

  // 비밀번호: 프로젝트 설정 → 스크립트 속성의 SITE_PASSWORD (저장소에는 절대 올리지 않음)
  // 비워 두면 비밀번호 없이 열림
  const pw = PropertiesService.getScriptProperties().getProperty('SITE_PASSWORD');
  const locked = !!pw && p.key !== pw;

  if (p.format === 'json') {
    let data;
    try {
      if (locked) data = { auth: false, error: '비밀번호가 필요해요' };
      else data = (p.action === 'refresh') ? refreshFromPage() : getSnapshot();
    } catch (err) {
      data = { error: String(err && err.message ? err.message : err) };
    }
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ↓ 파라미터 없으면 기존처럼 HTML 페이지 (비밀번호가 설정돼 있으면 막음)
  if (locked) return HtmlService.createHtmlOutput('GitHub 페이지에서 비밀번호를 입력해 주세요.');
  const t = HtmlService.createTemplateFromFile('index');
  // 스냅샷을 페이지에 바로 심어서 열자마자 표시 ('<' 이스케이프로 스크립트 깨짐 방지)
  t.snapJson = JSON.stringify(getSnapshot()).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('글로벌 매크로 팔로업')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 페이지의 '지금 갱신' 버튼: 마지막 수집 후 3분이 안 지났으면 새로 수집하지 않음
function refreshFromPage() {
  const snap = loadSnapshot_();
  if (snap && snap.updatedAt) {
    const last = new Date(snap.updatedAt.replace(' ', 'T') + ':00+09:00').getTime();
    if (Date.now() - last < 3 * 60 * 1000) return snap;
  }
  return collectAll();
}
