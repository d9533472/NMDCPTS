// ============================================================
// OPTS — Offshore Personnel Transfer System · Google Apps Script backend
// 綁定試算表「Person transfer」；前端 https://d9533472.github.io/NMDCPTS/
// 原始碼：E:\NMDCPTS\opts-gas\程式碼.js（clasp push + deploy -i <prod id>）
//
// 協定：POST text/plain JSON {action, token, payload} → {ok:true, data} / {ok:false, error}
//       GET ?action=ping 僅供健康檢查（GET 不做任何寫入）
// 角色：admin（全部功能、全部公司）、mc（MC 作業：轉運／日誌／會議／證照核准；人員只能編自家公司）、
//       contractor（只管自家公司人員）。人員與船舶需 Admin 核准；Admin 自己新增的直接核准。
// 通知信：Settings.notify_emails（共用收件者）＋ notify_events（啟用的事件）；每日到期提醒由 setup() 建立的觸發器執行。
// ============================================================

const VERSION = '2.8';
const CAT_SAFETY = 'Offshore Safety Training';   // 原 'Sea Survival'（2.1 改名，ensureSchema_ 會遷移舊資料）

const SCHEMAS = {
  Users: ['id','username','name','email','role','company','password_hash','password_salt','active','must_change','last_login','created_at','updated_at'],
  Sessions: ['token','user_id','expires_at','created_at'],
  Companies: ['id','name','active','created_at'],
  Vessels: ['id','name','mmsi','imo','type','flag','gross_tonnage','max_persons','operator','company','contact_person','phone','whatsapp','email','remark','approval','approval_note','approved_by','approved_at','created_by','created_at','updated_at'],
  Personnel: ['id','name','company','nationality','position','email','phone','passport','blood_type','emergency','emergency_phone','photo','passport_file_id','passport_file_name','remark','current_location','approval','approval_note','approved_by','approved_at','created_by','created_at','updated_at'],
  Meetings: ['id','title','time','location','items','attendees','externals','remark','attachments','created_by','created_at','updated_at'],
  Announcements: ['id','text_zh','text_en','level','link_url','link_text','attachments','active','created_by','created_at','updated_at'],
  AuditLog: ['id','time','username','name','role','company','action','target_id','target_name','detail','result','error'],
  LoginLog: ['id','time','username','name','role','company','ip','user_agent','result','error'],
  Locations: ['id','name','type','linked_vessel','remark','created_at','updated_at'],
  Transfers: ['id','personnel_id','personnel_name','company','from_location','to_location','time','type','transport','approved_by','reason','remark','logged_by','created_at'],
  SiteLog: ['id','time','activity','source','detail','asset','transport','personnel','logged_by','created_at'],
  VesselCertTypes: ['id','code','name','mandatory','active','sort','rule'],
  VesselCerts: ['id','vessel_id','type_id','issue_date','expiry_date','description','file_id','file_name','updated_by','updated_at'],
  PersonCertTypes: ['id','name','category','has_expiry','active','sort'],
  PersonCerts: ['id','personnel_id','type_id','other_name','cert_no','issue_date','expiry_date','file_id','file_name','status','review_note','reviewed_by','reviewed_at','submitted_by','created_at','updated_at'],
  Settings: ['key','value']
};

const DEFAULT_SETTINGS = {
  ptw_url: 'https://script.google.com/macros/s/AKfycbyhOITKpUPZDcvL-jZx52H-ZNX-tGTvCjFXYY3-J_XrBfj7PRwzZE7fDYnu9vG8_z8/exec',
  required_categories: 'Medical,' + CAT_SAFETY,
  app_url: 'https://d9533472.github.io/NMDCPTS/',
  notify_emails: '',
  notify_events: 'personnel_pending,vessel_pending,cert_pending,review_result,transfer,expiry,meeting',
  meeting_title: '每日協調會議',
  mc_permissions: '',   // Admin 開放給 MC 的系統管理項目（逗號分隔，見 MC_PERMS）
  // 船型清單（每行一個，系統設定可改）
  vessel_types: ['Pipelay Vessel (PLV)', 'CTV (Crew Transfer Vessel)', 'SOV (Service Operation Vessel)', 'Supply Vessel', 'Tug', 'Barge', 'Crane Vessel', 'Jack-up', 'Dive Support Vessel', 'Survey Vessel', 'Anchor Handling Tug', 'Guard Vessel', 'Other'].join('\n'),
  project_name: '通霄電廠二期更新改建計畫海底輸氣管線統包工程',   // 顯示在通知信頁首
  // 儀表板天氣／海象（Open-Meteo 預報＋Windy 地圖）；座標空白＝不顯示天氣欄
  weather_name: '沿線海象 · 台中－通霄 36" 海管',
  // 每行「名稱, 緯度, 經度」，依管線順序（預設：台中接收站→通霄電廠沿線約每 5 km 一點，依路線圖估計）
  weather_points: [
    'KP 5, 24.2483, 120.4217',
    'KP 10, 24.2863, 120.4075',
    'KP 14, 24.3277, 120.4199',
    'KP 19, 24.3691, 120.4322',
    'KP 24, 24.4106, 120.4443',
    'KP 29, 24.4509, 120.4596',
    'KP 34, 24.4789, 120.4946',
    'KP 38, 24.5030, 120.5341',
    'KP 43, 24.5214, 120.5767',
    'KP 48, 24.5199, 120.6225'
  ].join('\n'),
  weather_lat: '',
  weather_lon: '',
  weather_wave_limit: '1.5',
  weather_wind_limit: '25'
};
const NOTIFY_EVENTS = ['personnel_pending','vessel_pending','cert_pending','review_result','transfer','expiry','meeting'];
const EXPIRY_ALERT_DAYS = [30, 14, 7, 1, 0];

// SeaPlanner Vessel Certs Matrix（44 項）
const VESSEL_CERT_SEED = [
  [20,'船籍證明 Certificate of Registry'],[21,'國籍證明 Certificate of Nationality'],[22,'中國驗船中心 CR Classification Society'],
  [23,'船級證書 Certificate of Class'],[24,'國際噸位證書 Int. Tonnage'],[25,'國際載重線證書 International Load Line'],
  [26,'載重線豁免證書 Exemption Load Line'],[27,'最低安全配員證書 Minimum Safe Manning'],[28,'貨船無線電安全證書 Cargo Ship Radio Certificate'],
  [29,'貨船安全結構證書 Cargo Ship Safety Construction'],[30,'貨船安全設備證書 Cargo Ship Safety Equipment'],[31,'符合證書 Document of Compliance'],
  [32,'安全管理證書 Safety Management Certificate'],[33,'交通部航港局小船執照 MPB Small Boat Certificate'],[34,'保險證書 (P&I) Insurance (P&I)'],
  [35,'保險證書 (船體&機械) Insurance (Hull & Machinery)'],[36,'保險證書 (船員) Insurance (Crew)'],[37,'國際防污系統證書 International Anti-Fouling System Certificate'],
  [38,'國際防止油污染證書 International Oil Pollution Prevention Certificate (IOPP)'],[39,'國際防止污水污染證書 International Sewage Pollution Prevention Certificate (ISPP)'],
  [40,'國際防止空氣污染證書 International Air Pollution Prevention Certificate (IAPP)'],[41,'柴油機國際防止空氣污染證書 Engine International Air Pollution Prevention Certificate (EIAPP)'],
  [42,'國際船舶保全證書 International Ship Security Certificate'],[43,'貨船搭客證書 Certificate of Fitness for Cargo Ship Carrying Passengers'],
  [44,'IMCA 一般船舶檢驗文件 IMCA Common Marine Inspection Document (CMID)'],[45,'防止垃圾污染證明 Garbage Pollution Prevention Attestation'],
  [46,'船舶試航證書 Certificate of Seaworthiness'],[47,'機械級別 Class Machinery'],[48,'船體級別 Class Hull'],[49,'船舶無線電台執照 Ship Station License'],
  [50,'海上基地維修 GMDSS Shore Based Maintenance GMDSS'],[51,'除鼠證書 De-ratting Certificate'],[52,'船舶焚化爐之型式認可證書 Shipboard Incinerator Type Approval'],
  [53,'救難艇 Rescue Boat'],[54,'救生筏 Life Raft(s)'],[55,'救生艇 Lifeboat(s)'],[56,'安裝證書 CO2 (Halon) Installation'],[57,'滅火器 Fire Extinguishers'],
  [58,'空氣呼吸器證書 Breathing Apparatus Certificate'],[59,'緊急逃生呼吸裝置 Emergency Escape Breathing Device (EEBD)'],[60,'藥品 Medicine'],
  [61,'吊車裝備證書 Hoisting Equipment'],[62,'貨船設備證書 Cargo Equipment'],[63,'起重機測試證書 Crane Test Certificate']
];

/**
 * 船舶證書的適用條件（rule，JSON）：
 *   mode: 'always' 每艘都要 | 'never' 依實際配備（不自動要求）| 'auto' 依條件
 *   flag: 'any' | 'tw' 本國籍 | 'foreign' 外國籍
 *   gt_min / pob_min：總噸位 ≥ gt_min「或」限制員額 ≥ pob_min 時需要（兩個都沒填＝只看船籍）
 *   gt_max：總噸位 < gt_max 才需要（例：小船執照）
 * 門檻取自 SOLAS／MARPOL／ISM／ISPS 與我國小船規定的常見數值，僅供參考；實際以船旗國與驗船機構為準。
 */
const VESSEL_RULE_SEED = {
  20: { mode: 'always' }, 21: { mode: 'auto', flag: 'tw', gt_min: 20 }, 22: { mode: 'auto', flag: 'tw', gt_min: 100 },
  23: { mode: 'auto', gt_min: 100 }, 24: { mode: 'auto', gt_min: 100 }, 25: { mode: 'auto', gt_min: 150 }, 26: { mode: 'never' },
  27: { mode: 'auto', gt_min: 20 }, 28: { mode: 'auto', gt_min: 300 }, 29: { mode: 'auto', gt_min: 500 }, 30: { mode: 'auto', gt_min: 500 },
  31: { mode: 'auto', gt_min: 500 }, 32: { mode: 'auto', gt_min: 500 }, 33: { mode: 'auto', flag: 'tw', gt_max: 20 },
  34: { mode: 'always' }, 35: { mode: 'always' }, 36: { mode: 'always' }, 37: { mode: 'auto', gt_min: 400 }, 38: { mode: 'auto', gt_min: 400 },
  39: { mode: 'auto', gt_min: 400, pob_min: 16 }, 40: { mode: 'auto', gt_min: 400 }, 41: { mode: 'auto', gt_min: 400 }, 42: { mode: 'auto', gt_min: 500 },
  43: { mode: 'auto', pob_min: 13 }, 44: { mode: 'always' }, 45: { mode: 'auto', gt_min: 100, pob_min: 15 }, 46: { mode: 'always' },
  47: { mode: 'auto', gt_min: 100 }, 48: { mode: 'auto', gt_min: 100 }, 49: { mode: 'always' }, 50: { mode: 'auto', gt_min: 300 },
  51: { mode: 'auto', flag: 'foreign' }, 52: { mode: 'never' }, 53: { mode: 'auto', gt_min: 500 }, 54: { mode: 'always' }, 55: { mode: 'auto', gt_min: 500 },
  56: { mode: 'never' }, 57: { mode: 'always' }, 58: { mode: 'auto', gt_min: 500 }, 59: { mode: 'auto', gt_min: 500 }, 60: { mode: 'always' },
  61: { mode: 'never' }, 62: { mode: 'never' }, 63: { mode: 'never' }
};
function normRule_(raw) {
  let r = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r || '{}'); } catch (e) { r = {}; } }
  r = r || {};
  const out = { mode: ['always', 'never', 'auto'].indexOf(r.mode) >= 0 ? r.mode : 'always' };
  if (out.mode === 'auto') {
    out.flag = ['tw', 'foreign'].indexOf(r.flag) >= 0 ? r.flag : 'any';
    ['gt_min', 'gt_max', 'pob_min'].forEach(k => { const n = Number(r[k]); if (r[k] !== '' && r[k] !== null && r[k] !== undefined && isFinite(n) && n > 0) out[k] = n; });
  }
  return JSON.stringify(out);
}
const PERSON_CERT_SEED = [
  ['OEUK Medical','Medical'],['ADNOC Medical','Medical'],['Other Medical','Medical'],
  ['BOSIET',CAT_SAFETY],['FOET',CAT_SAFETY],['STCW95 Basic Safety Training',CAT_SAFETY],
  ['GWO Basic Safety Training (Sea Survival)',CAT_SAFETY],['Other Offshore Safety Training',CAT_SAFETY],
  ['HUET / CA-EBS','Training'],['GWO Working at Heights','Training'],['H2S Awareness','Training'],['Other Certificate','Other']
];

const ROLES = ['admin','mc','contractor'];
const SESSION_DAYS = 7;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_CHARS = 45000;

// ============ HTTP ============
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'ping') return json_({ ok: true, data: { service: 'OPTS API', version: VERSION, time: new Date().toISOString() } });
  // POST 偶爾在部署切換時被轉成 GET → 回 RETRY，前端會重送一次（此時沒有任何寫入發生）
  return json_({ ok: false, error: 'Use POST', code: 'RETRY' });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad JSON' }); }
  return json_(handle_(req));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const action = String(req.action || '');
  const fn = ROUTES[action];
  if (!fn) return { ok: false, error: 'Unknown action: ' + action };
  let user = null;
  const payload = req.payload || {};
  try {
    ensureSchema_();
    if (EXT_ACTIONS[action]) user = verifyLinkKey_(payload.key);
    else if (!PUBLIC[action]) user = verifySession_(req.token);
    const before = deletedName_(action, payload);
    const data = fn(user, payload);
    if (!NO_REV[action]) bumpRev_();
    audit_(action, user, payload, before ? { name: before } : data, true, '');
    if (LOGIN_ACTIONS[action]) loginLog_(payload, data, true, '');
    return { ok: true, data: data === undefined ? null : data };
  } catch (err) {
    // 登入逾時（AUTH）不記，其餘失敗的操作也記下來（含登入失敗、權限不足）
    if (!(err && err.code === 'AUTH')) audit_(action, user, payload, null, false, err && err.message);
    if (LOGIN_ACTIONS[action]) loginLog_(payload, null, false, err && err.message);
    if (err && err.code) return { ok: false, error: err.message, code: err.code };
    console.error(action + ': ' + err.message + '\n' + err.stack);
    return { ok: false, error: 'Server error: ' + err.message };
  }
}

// ============ Audit log（操作紀錄：誰在何時做了什麼；只增不改，清空資料也保留） ============
const AUDIT_SKIP = { 'data.rev': 1, 'ping': 1, 'auth.status': 1, 'data.load': 1, 'audit.list': 1, 'login.list': 1, 'visit.hit': 1, 'ext.vessels': 1 };
const AUDIT_SECRET = { password: 1, oldPassword: 1, newPassword: 1, code: 1, photo: 1, key: 1 };
function auditDetail_(payload) {
  const o = {};
  Object.keys(payload || {}).forEach(k => {
    const v = payload[k];
    if (AUDIT_SECRET[k]) { if (v) o[k] = k === 'photo' ? '(photo)' : '***'; return; }
    if (k === 'ua') return;   // 瀏覽器資訊記在登入紀錄，操作紀錄不重複存
    if (k === 'file' || k === 'passport_file') { if (v && v.name) o[k] = v.name; return; }
    if (k === 'newFiles') { if (Array.isArray(v) && v.length) o.newFiles = v.map(x => x && x.name).join(', '); return; }
    if (v === '' || v === null || v === undefined) return;
    o[k] = (typeof v === 'object') ? v : String(v);
  });
  let s = JSON.stringify(o);
  if (s.length > 1500) s = s.slice(0, 1500) + '…';
  return s === '{}' ? '' : s;
}
function auditTarget_(action, payload, data) {
  const r = (data && typeof data === 'object') ? data : {};
  const rec = r.user || r;
  const name = rec.name || rec.title || rec.username || (r.siteLog && r.siteLog.detail) || payload.name || payload.title || payload.username || '';
  let id = rec.id || payload.id || payload.personnel_id || payload.vessel_id || '';
  if (action === 'transfer.execute' && r.transfers) id = r.transfers.map(t => t.personnel_id).join(',');
  return { id: String(id || ''), name: String(name || '') };
}
/** 刪除類動作：刪之前先記下對象名稱，紀錄才看得出刪了什麼 */
const DELETE_SHEETS = { 'personnel.delete': 'Personnel', 'vessel.delete': 'Vessels', 'location.delete': 'Locations', 'transfer.delete': 'Transfers',
  'sitelog.delete': 'SiteLog', 'meeting.delete': 'Meetings', 'announce.delete': 'Announcements', 'user.delete': 'Users', 'company.delete': 'Companies', 'pcert.delete': 'PersonCerts', 'vcert.delete': 'VesselCerts' };
function deletedName_(action, p) {
  const sheet = DELETE_SHEETS[action];
  if (!sheet || !p.id) return '';
  try {
    const r = Repo.get(sheet, p.id);
    if (!r) return '';
    if (sheet === 'PersonCerts') { const x = Repo.get('Personnel', r.personnel_id) || {}, t = Repo.get('PersonCertTypes', r.type_id) || {}; return (x.name || '') + ' — ' + (t.name || ''); }
    if (sheet === 'VesselCerts') { const x = Repo.get('Vessels', r.vessel_id) || {}, t = Repo.get('VesselCertTypes', r.type_id) || {}; return (x.name || '') + ' — ' + (t.name || ''); }
    if (sheet === 'Transfers') return r.personnel_name + ' (' + String(r.time).replace('T', ' ') + ')';
    if (sheet === 'SiteLog') return String(r.detail).slice(0, 120);
    return r.name || r.title || r.username || '';
  } catch (e) { return ''; }
}
function audit_(action, user, payload, data, ok, err) {
  if (AUDIT_SKIP[action]) return;
  try {
    const t = auditTarget_(action, payload, data);
    let who = user;
    if (!who && data && data.user) who = data.user;   // 登入成功：帶出姓名／公司／角色
    if (!who && action === 'auth.login') who = { username: str_(payload.username).toLowerCase(), name: '', role: '', company: '' };
    Repo.append('AuditLog', { id: genId_(), time: nowIso_(), username: who ? who.username : '', name: who ? (who.name || '') : '', role: who ? (who.role || '') : '',
      company: who ? (who.company || '') : '', action: action, target_id: t.id, target_name: t.name.slice(0, 200), detail: auditDetail_(payload),
      result: ok ? 'OK' : 'FAILED', error: ok ? '' : String(err || '').slice(0, 300) });
  } catch (e) { console.warn('audit failed: ' + e.message); }
}
function auditList_(u, p) {
  requireRole_(u, ['admin']);   // 操作紀錄只有 Admin 能看
  const from = str_(p.from), to = str_(p.to), who = str_(p.username).toLowerCase(), act = str_(p.action), q = str_(p.q).toLowerCase();
  const limit = Math.min(Number(p.limit) || 500, 3000);
  const rows = Repo.all('AuditLog').filter(r => {
    const d = r.time.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (who && r.username !== who) return false;
    if (act && r.action.indexOf(act) !== 0) return false;
    if (p.failedOnly && r.result !== 'FAILED') return false;
    if (q && [r.username, r.name, r.company, r.target_name, r.detail, r.error].join(' ').toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort((a, b) => b.time.localeCompare(a.time));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

// ============ 登入紀錄（含 IP；只有 Admin 可看） ============
// Apps Script 拿不到連線端 IP，IP 由前端查詢後隨登入送上來（僅供參考，可被竄改）
const LOGIN_ACTIONS = { 'auth.login': 1, 'auth.setup': 1 };
function loginLog_(payload, data, ok, err) {
  try {
    const who = (data && data.user) || { username: str_(payload.username).toLowerCase() };
    Repo.append('LoginLog', { id: genId_(), time: nowIso_(), username: who.username || '', name: who.name || '', role: who.role || '', company: who.company || '',
      ip: str_(payload.ip).slice(0, 64), user_agent: str_(payload.ua).slice(0, 300), result: ok ? 'OK' : 'FAILED', error: ok ? '' : String(err || '').slice(0, 300) });
  } catch (e) { console.warn('login log failed: ' + e.message); }
}
function loginList_(u, p) {
  requireRole_(u, ['admin']);
  const from = str_(p.from), to = str_(p.to), q = str_(p.q).toLowerCase();
  const limit = Math.min(Number(p.limit) || 1000, 3000);
  const rows = Repo.all('LoginLog').filter(r => {
    const d = r.time.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (p.failedOnly && r.result !== 'FAILED') return false;
    if (q && [r.username, r.name, r.company, r.ip, r.user_agent].join(' ').toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort((a, b) => b.time.localeCompare(a.time));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

// ============ 瀏覽人數（每個瀏覽器分頁工作階段算一次；從 VISIT_BASE 起算） ============
const VISIT_BASE = 87;
function visitCount_() { return Number(PropertiesService.getScriptProperties().getProperty('visit_count')) || VISIT_BASE; }
function visitHit_(p) {
  if (!p.count) return { visits: visitCount_() };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { visits: visitCount_() };   // 忙碌時不卡住頁面，這次就不算
  try {
    const n = visitCount_() + 1;
    PropertiesService.getScriptProperties().setProperty('visit_count', String(n));
    return { visits: n };
  } finally { lock.releaseLock(); }
}

// ============ 資料版本號（前端每 3 秒問一次，有變才重新抓整包資料） ============
// 任何成功的寫入動作都會換一個新版本號；放在 Cache（快）並備份在 Script Properties（Cache 過期時用）
const NO_REV = { 'ping': 1, 'auth.status': 1, 'auth.login': 1, 'auth.logout': 1, 'auth.changePassword': 1, 'data.load': 1, 'data.rev': 1,
  'audit.list': 1, 'login.list': 1, 'visit.hit': 1, 'file.get': 1, 'ext.vessels': 1 };
function dataRev_() {
  const cache = CacheService.getScriptCache();
  let r = cache.get('data_rev');
  if (!r) {
    r = PropertiesService.getScriptProperties().getProperty('data_rev') || '0';
    cache.put('data_rev', r, 21600);
  }
  return r;
}
function bumpRev_() {
  try {
    const r = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    CacheService.getScriptCache().put('data_rev', r, 21600);
    PropertiesService.getScriptProperties().setProperty('data_rev', r);
  } catch (e) { console.warn('rev bump failed: ' + e.message); }
}

function fail_(msg, code) { const e = new Error(msg); e.code = code || 'ERROR'; throw e; }

const PUBLIC = { 'data.rev': true, 'ping': true, 'auth.status': true, 'auth.setup': true, 'auth.login': true, 'visit.hit': true };

const ROUTES = {
  'ping': () => ({ version: VERSION, time: new Date().toISOString() }),
  'auth.status': () => ({ needsSetup: Repo.all('Users').length === 0 }),
  'auth.setup': (u, p) => authSetup_(p),
  'auth.login': (u, p) => authLogin_(p),
  'auth.logout': (u, p) => authLogout_(u),
  'auth.changePassword': (u, p) => changePassword_(u, p),
  'data.load': (u) => loadData_(u),
  'data.rev': () => ({ rev: dataRev_() }),

  'vessel.save': (u, p) => saveVessel_(u, p),
  'vessel.review': (u, p) => reviewRecord_(u, 'Vessels', p),
  'personnel.review': (u, p) => reviewRecord_(u, 'Personnel', p),
  'meeting.save': (u, p) => { requireRole_(u, ['admin','mc']); return saveMeeting_(u, p); },
  'meeting.delete': (u, p) => { requireRole_(u, ['admin','mc']); return deleteWithFiles_('Meetings', p.id); },
  'announce.save': (u, p) => { requirePerm_(u, 'ann'); return saveAnnouncement_(u, p); },
  'announce.delete': (u, p) => { requirePerm_(u, 'ann'); return deleteWithFiles_('Announcements', p.id); },
  'notify.test': (u, p) => { requireRole_(u, ['admin']); return notifyTest_(u); },
  'audit.list': (u, p) => auditList_(u, p),
  'login.list': (u, p) => loginList_(u, p),
  'visit.hit': (u, p) => visitHit_(p),
  'reset.request': (u, p) => { requireRole_(u, ['admin']); return resetRequest_(u, p); },
  'reset.confirm': (u, p) => { requireRole_(u, ['admin']); return resetConfirm_(u, p); },
  'vessel.delete': (u, p) => { vesselFor_(u, p.id, true); return deleteVessel_(p.id); },
  'location.save': (u, p) => { requireRole_(u, ['admin','mc']); return saveSimple_('Locations', p, ['name','type','linked_vessel','remark'], ['name','type']); },
  'location.delete': (u, p) => { requireRole_(u, ['admin','mc']); return deleteLocation_(p.id); },

  'personnel.save': (u, p) => savePersonnel_(u, p),
  'personnel.delete': (u, p) => deletePersonnel_(u, p.id),
  'pcert.save': (u, p) => savePersonCert_(u, p),
  'pcert.delete': (u, p) => deletePersonCert_(u, p.id),
  'pcert.review': (u, p) => reviewPersonCert_(u, p),
  'vcert.save': (u, p) => { vesselFor_(u, p.vessel_id); return saveVesselCert_(u, p); },
  'vcert.delete': (u, p) => { const c = Repo.get('VesselCerts', p.id); if (c) vesselFor_(u, c.vessel_id); return deleteVesselCert_(p.id); },
  'file.get': (u, p) => getFile_(u, p.id),

  'transfer.execute': (u, p) => { requireRole_(u, ['admin','mc']); return executeTransfer_(u, p); },
  'sitelog.save': (u, p) => { requireRole_(u, ['admin','mc']); return saveSiteLog_(u, p); },
  'sitelog.delete': (u, p) => { requireRole_(u, ['admin','mc']); withLock_(() => Repo.remove('SiteLog', p.id)); return { id: p.id }; },

  'vcerttype.save': (u, p) => { requirePerm_(u, 'vct'); if (p.rule !== undefined) p.rule = normRule_(p.rule); return saveCertType_('VesselCertTypes', p, ['code','name','mandatory','active','sort','rule']); },
  'pcerttype.save': (u, p) => { requirePerm_(u, 'pct'); return saveCertType_('PersonCertTypes', p, ['name','category','has_expiry','active','sort']); },
  'company.save': (u, p) => { requirePerm_(u, 'companies'); return saveSimple_('Companies', p, ['name','active'], ['name']); },
  'company.delete': (u, p) => { requirePerm_(u, 'companies'); return deleteCompany_(p.id); },
  'transfer.delete': (u, p) => { requireRole_(u, ['admin']); withLock_(() => Repo.remove('Transfers', p.id)); return { id: p.id }; },
  'user.save': (u, p) => saveUser_(u, p),
  'user.resetPassword': (u, p) => resetPassword_(u, p),
  'user.delete': (u, p) => deleteUser_(u, p.id),
  'settings.save': (u, p) => saveSettings_(u, p),
  'admin.ptwKey': (u, p) => ptwLinkKeyAdmin_(u, p),

  // Offshore PTW 系統（伺服器對伺服器，以連結金鑰驗證）
  'ext.vessels': () => ({ vessels: Repo.all('Vessels').map(extVessel_) }),
  'ext.vesselApply': (u, p) => extVesselApply_(u, p)
};

// ============ Repo（依表頭名稱讀寫，欄位順序不拘） ============
const Repo = (function () {
  const cache = {};
  function sheet_(name) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    return ss.getSheetByName(name) || ss.insertSheet(name);
  }
  function load_(name) {
    if (cache[name]) return cache[name];
    const sh = sheet_(name);
    const values = sh.getDataRange().getValues();
    const headers = (values[0] || []).map(String);
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const o = {};
      headers.forEach((h, j) => { if (h) o[h] = cell_(values[i][j]); });
      o.__row = i + 1;
      rows.push(o);
    }
    cache[name] = { sh: sh, headers: headers, rows: rows };
    return cache[name];
  }
  function cell_(v) {
    if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    if (v === null || v === undefined) return '';
    return String(v);
  }
  function key_(name) { return name === 'Sessions' ? 'token' : (name === 'Settings' ? 'key' : 'id'); }
  function clean_(o) { const c = {}; Object.keys(o).forEach(k => { if (k !== '__row') c[k] = o[k]; }); return c; }
  function rowOf_(t, obj) { return t.headers.map(h => (h && obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : ''); }

  return {
    all: function (name) { return load_(name).rows.filter(r => r[key_(name)]).map(clean_); },
    get: function (name, id) {
      const k = key_(name);
      const r = load_(name).rows.find(x => String(x[k]) === String(id));
      return r ? clean_(r) : null;
    },
    insert: function (name, obj) {
      const t = load_(name);
      const row = rowOf_(t, obj);
      t.sh.getRange(t.sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
      delete cache[name];
      return obj;
    },
    /** appendRow 是原子操作，不需鎖（操作紀錄用，避免多人同時寫入互相覆蓋） */
    append: function (name, obj) {
      // 只讀表頭，不載入整張表（操作／登入紀錄只增不減，整張讀會越來越慢）
      let t = cache[name];
      if (!t) {
        const sh = sheet_(name);
        t = { sh: sh, headers: sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String) };
      }
      t.sh.appendRow(rowOf_(t, obj).map(v => (v !== '' && /^[=+\-@]/.test(v)) ? "'" + v : v));
      delete cache[name];
    },
    insertMany: function (name, objs) {
      if (!objs.length) return;
      const t = load_(name);
      const rows = objs.map(o => rowOf_(t, o));
      t.sh.getRange(t.sh.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
      delete cache[name];
    },
    update: function (name, id, patch) {
      const t = load_(name);
      const k = key_(name);
      const r = t.rows.find(x => String(x[k]) === String(id));
      if (!r) fail_('Record not found', 'NOT_FOUND');
      const merged = Object.assign({}, clean_(r), patch);
      const row = rowOf_(t, merged);
      t.sh.getRange(r.__row, 1, 1, row.length).setNumberFormat('@').setValues([row]);
      delete cache[name];
      return merged;
    },
    remove: function (name, id) {
      const t = load_(name);
      const k = key_(name);
      const r = t.rows.find(x => String(x[k]) === String(id));
      if (!r) return false;
      t.sh.deleteRow(r.__row);
      delete cache[name];
      return true;
    },
    removeWhere: function (name, pred) {
      const t = load_(name);
      const rows = t.rows.filter(r => r[key_(name)] && pred(clean_(r))).map(r => r.__row).sort((a, b) => b - a);
      rows.forEach(n => t.sh.deleteRow(n));
      delete cache[name];
      return rows.length;
    },
    /** 清空整張表（保留表頭）；用 clearContent 避免「不能刪除所有未凍結列」的限制，空白列 all() 會略過 */
    clear: function (name) {
      const t = load_(name);
      const n = t.rows.filter(r => r[key_(name)]).length;
      const last = t.sh.getLastRow();
      if (last > 1) t.sh.getRange(2, 1, last - 1, Math.max(1, t.sh.getLastColumn())).clearContent();
      delete cache[name];
      return n;
    },
    flush: function () { Object.keys(cache).forEach(k => delete cache[k]); }
  };
})();

// 確保每張表都有需要的欄位（只「補」缺的欄位，不刪任何既有資料）
function ensureSchema_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('schema_version') === VERSION) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (props.getProperty('schema_version') === VERSION) return;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    Object.keys(SCHEMAS).forEach(name => {
      let sh = ss.getSheetByName(name);
      if (!sh) sh = ss.insertSheet(name);
      const lastCol = sh.getLastColumn();
      const existing = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
      const missing = SCHEMAS[name].filter(h => existing.indexOf(h) < 0);
      if (missing.length) {
        sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
      }
      sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
      sh.setFrozenRows(1);
    });
    Repo.flush();
    if (!Repo.all('VesselCertTypes').length) {
      Repo.insertMany('VesselCertTypes', VESSEL_CERT_SEED.map((c, i) => ({
        id: genId_(), code: String(c[0]), name: c[1], mandatory: 'TRUE', active: 'TRUE', sort: String(i + 1), rule: normRule_(VESSEL_RULE_SEED[c[0]]) })));
    }
    Repo.all('VesselCertTypes').forEach(t => { if (!t.rule) Repo.update('VesselCertTypes', t.id, { rule: normRule_(VESSEL_RULE_SEED[t.code] || { mode: 'always' }) }); });
    if (!Repo.all('PersonCertTypes').length) {
      Repo.insertMany('PersonCertTypes', PERSON_CERT_SEED.map((c, i) => ({
        id: genId_(), name: c[0], category: c[1], has_expiry: 'TRUE', active: 'TRUE', sort: String(i + 1) })));
    }
    const st = Repo.all('Settings');
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (!st.find(s => s.key === k)) Repo.insert('Settings', { key: k, value: DEFAULT_SETTINGS[k] });
    });
    migrate21_();
    props.setProperty('schema_version', VERSION);
  } finally { lock.releaseLock(); }
}

// 2.1：「Sea Survival」類別改名為海上安全訓練證書；既有人員／船舶視為已核准；公司清單補上 NMDC 與使用者既有公司
function migrate21_() {
  Repo.all('PersonCertTypes').forEach(t => {
    const patch = {};
    if (t.category === 'Sea Survival') patch.category = CAT_SAFETY;
    if (t.name === 'Other Sea Survival') patch.name = 'Other Offshore Safety Training';
    if (Object.keys(patch).length) Repo.update('PersonCertTypes', t.id, patch);
  });
  const rc = Repo.get('Settings', 'required_categories');
  if (rc && rc.value.indexOf('Sea Survival') >= 0) Repo.update('Settings', 'required_categories', { value: rc.value.split('Sea Survival').join(CAT_SAFETY) });
  ['Personnel', 'Vessels'].forEach(sheet => Repo.all(sheet).forEach(r => {
    if (!r.approval) Repo.update(sheet, r.id, { approval: 'Approved', approved_by: 'migration', approved_at: nowIso_() });
  }));
  const names = Repo.all('Companies').map(c => c.name.toLowerCase());
  ['NMDC'].concat(Repo.all('Users').map(u => u.company)).forEach(n => {
    n = str_(n);
    if (n && names.indexOf(n.toLowerCase()) < 0) {
      Repo.insert('Companies', { id: genId_(), name: n, active: 'TRUE', created_at: nowIso_() });
      names.push(n.toLowerCase());
    }
  });
}

/** 在 GAS 編輯器手動執行一次：授權 Drive／Gmail 寄信／觸發器權限，建立附件資料夾與每日到期提醒 */
function setup() {
  PropertiesService.getScriptProperties().deleteProperty('schema_version');
  ensureSchema_();
  const f = filesFolder_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyExpiryCheck').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyExpiryCheck').timeBased().everyDays(1).atHour(8).create();
  Logger.log('OK — files folder: ' + f.getUrl() + ' · daily expiry check at 08:00 · mail quota left today: ' + MailApp.getRemainingDailyQuota());
}

// ============ Utility ============
function genId_() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso_() { return new Date().toISOString(); }
function bool_(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1'; }
function str_(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function settings_() {
  const o = Object.assign({}, DEFAULT_SETTINGS);
  Repo.all('Settings').forEach(s => { o[s.key] = s.value; });
  return o;
}
// ---- MC 可用的系統管理項目（Admin 在系統設定勾選）----
const MC_PERMS = ['users', 'companies', 'vct', 'pct', 'ann', 'basic'];   // 操作紀錄、登入紀錄不開放給 MC
// 「基本設定」包含的設定欄位；其餘設定（PTW、通知信、清空資料、MC 權限）一律只有 Admin 能改
const BASIC_SETTINGS = ['meeting_title', 'project_name', 'vessel_types', 'weather_name', 'weather_points', 'weather_lat', 'weather_lon', 'weather_wave_limit', 'weather_wind_limit'];
function hasPerm_(u, perm) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.role !== 'mc') return false;
  return String(settings_().mc_permissions || '').split(',').indexOf(perm) >= 0;
}
function requirePerm_(u, perm) { if (!hasPerm_(u, perm)) fail_('Permission denied', 'FORBIDDEN'); }
function requireRole_(u, roles) {
  if (!u || roles.indexOf(u.role) < 0) fail_('Permission denied', 'FORBIDDEN');
}
function isStaff_(u) { return u && (u.role === 'admin' || u.role === 'mc'); }
function sameCompany_(a, b) { return str_(a).toLowerCase() === str_(b).toLowerCase(); }

// ============ Auth ============
function hash_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < 500; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}
function publicUser_(u) {
  return { id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, company: u.company,
    active: bool_(u.active), must_change: bool_(u.must_change), last_login: u.last_login };
}
function checkPassword_(pw) {
  if (str_(pw).length < 6) fail_('Password must be at least 6 characters', 'WEAK_PASSWORD');
}
function newSession_(user) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  Repo.insert('Sessions', { token: token, user_id: user.id, expires_at: exp, created_at: nowIso_() });
  CacheService.getScriptCache().put('s_' + token, user.id + '|' + exp, 21600);
  return token;
}
function verifySession_(token) {
  token = str_(token);
  if (!token) fail_('Please log in', 'AUTH');
  const cache = CacheService.getScriptCache();
  let userId = '', exp = '';
  const c = cache.get('s_' + token);
  if (c) { const parts = c.split('|'); userId = parts[0]; exp = parts[1]; }
  else {
    const s = Repo.get('Sessions', token);
    if (!s) fail_('Session expired, please log in again', 'AUTH');
    userId = s.user_id; exp = s.expires_at;
    cache.put('s_' + token, userId + '|' + exp, 21600);
  }
  if (exp < nowIso_()) fail_('Session expired, please log in again', 'AUTH');
  const u = Repo.get('Users', userId);
  if (!u || !bool_(u.active)) fail_('Account disabled', 'AUTH');
  u.token = token;
  return u;
}
function killSessions_(userId) {
  const tokens = Repo.all('Sessions').filter(x => x.user_id === userId).map(x => 's_' + x.token);
  if (tokens.length) CacheService.getScriptCache().removeAll(tokens);
  Repo.removeWhere('Sessions', x => x.user_id === userId);
}
function authSetup_(p) {
  return withLock_(() => {
    if (Repo.all('Users').length) fail_('System already set up', 'FORBIDDEN');
    const username = str_(p.username).toLowerCase();
    if (!username) fail_('Username required');
    checkPassword_(p.password);
    const salt = Utilities.getUuid();
    const u = { id: genId_(), username: username, name: str_(p.name) || username, email: str_(p.email), role: 'admin',
      company: str_(p.company) || 'NMDC', password_salt: salt, password_hash: hash_(p.password, salt), active: 'TRUE',
      must_change: 'FALSE', last_login: nowIso_(), created_at: nowIso_(), updated_at: nowIso_() };
    Repo.insert('Users', u);
    return { token: newSession_(u), user: publicUser_(u) };
  });
}
function authLogin_(p) {
  const username = str_(p.username).toLowerCase();
  const u = Repo.all('Users').find(x => str_(x.username).toLowerCase() === username || (x.email && str_(x.email).toLowerCase() === username));
  if (!u || !bool_(u.active) || hash_(str_(p.password), u.password_salt) !== u.password_hash) fail_('Wrong username or password', 'LOGIN');
  Repo.update('Users', u.id, { last_login: nowIso_() });
  const token = newSession_(u);
  // 登入同時回傳資料，前端不用再多打一次 data.load（過期 session 改由每日排程清理）
  return { token: token, user: publicUser_(u), data: bool_(u.must_change) ? null : loadData_(u) };
}
function authLogout_(u) {
  CacheService.getScriptCache().remove('s_' + u.token);
  Repo.remove('Sessions', u.token);
  return true;
}
function changePassword_(u, p) {
  if (hash_(str_(p.oldPassword), u.password_salt) !== u.password_hash) fail_('Current password is wrong', 'LOGIN');
  checkPassword_(p.newPassword);
  const salt = Utilities.getUuid();
  Repo.update('Users', u.id, { password_salt: salt, password_hash: hash_(p.newPassword, salt), must_change: 'FALSE', updated_at: nowIso_() });
  return true;
}
function guardAdminTarget_(u, id) {
  if (u.role === 'admin' || !id) return;
  const t = Repo.get('Users', id);
  if (t && t.role === 'admin') fail_('Only an Admin can change an Admin account', 'FORBIDDEN');
}
function saveUser_(u, p) {
  requirePerm_(u, 'users');
  guardAdminTarget_(u, p.id);
  const saved = withLock_(() => {
    const username = str_(p.username).toLowerCase();
    if (!username) fail_('Username required');
    const role = ROLES.indexOf(p.role) >= 0 ? p.role : 'contractor';
    if (role === 'admin' && u.role !== 'admin') fail_('Only an Admin can create or promote Admin accounts', 'FORBIDDEN');
    const company = str_(p.company);
    if (!company) fail_('Please select a company');
    if (!Repo.all('Companies').some(c => sameCompany_(c.name, company))) fail_('Company is not in the company list — add it under Companies first');
    const dup = Repo.all('Users').find(x => str_(x.username).toLowerCase() === username && x.id !== p.id);
    if (dup) fail_('Username already exists');
    const patch = { username: username, name: str_(p.name), email: str_(p.email), role: role, company: company,
      active: bool_(p.active) ? 'TRUE' : 'FALSE', updated_at: nowIso_() };
    if (patch.email && !EMAIL_RE.test(patch.email)) fail_('Invalid email address');
    if (!p.id && !patch.email) fail_('Email is required — the sign-in details are emailed to the user');
    if (p.id) {
      if (p.id === u.id && (role !== 'admin' || patch.active !== 'TRUE')) fail_('You cannot demote or disable your own account');
      const saved = Repo.update('Users', p.id, patch);
      if (patch.active !== 'TRUE') killSessions_(p.id);
      return publicUser_(saved);
    }
    checkPassword_(p.password);
    const salt = Utilities.getUuid();
    const rec = Object.assign({ id: genId_(), password_salt: salt, password_hash: hash_(p.password, salt), must_change: 'TRUE',
      last_login: '', created_at: nowIso_() }, patch);
    Repo.insert('Users', rec);
    return rec;
  });
  if (p.id) return saved;
  // 新帳號：把帳號與臨時密碼寄給本人（寄信失敗不影響帳號建立，前端會提示改用手動告知）
  return Object.assign(publicUser_(saved), { mail: sendWelcome_(saved, p.password) });
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLE_NAME_ = { admin: ['Administrator', '系統管理員'], mc: ['Marine Coordinator (MC)', '海事協調員（MC）'], contractor: ['Contractor', '承包商'] };
function sendWelcome_(user, password) {
  try {
    const st = settings_();
    const role = ROLE_NAME_[user.role] || [user.role, user.role];
    const rows = [
      ['Name｜姓名', user.name || user.username],
      ['Company｜公司', user.company],
      ['Role｜角色', role[1] + '　' + role[0]],
      ['Website｜系統網址', st.app_url]
    ];
    MailApp.sendEmail({ to: user.email, subject: '[OPTS] 您的帳號已建立｜Your OPTS account is ready', name: 'OPTS — NMDC',
      htmlBody: mailHtml_('Your account is ready｜帳號已建立', [
        ['Username｜帳號', user.username, { mono: true }],
        ['Temporary password｜臨時密碼', password, { mono: true, badge: '首次登入需變更密碼' }]
      ].concat(rows), st.app_url, {
        icon: '👤',
        intro: [(user.name || user.username) + ' 您好，系統管理員已為您建立 OPTS 帳號，請使用下列帳號與臨時密碼登入。',
          'An OPTS account has been created for you — sign in with the details below.'],
        section: { title: '📌 注意事項', items: ['首次登入時，系統會要求您設定自己的新密碼。 You will be asked to set a new password at first sign-in.',
          '請妥善保管此信，勿轉寄他人。 Please keep this email private.'] },
        button: '🔑 登入 OPTS'
      }) });
    return { sent: true, to: user.email };
  } catch (e) {
    console.warn('welcome mail failed: ' + e.message);
    return { sent: false, to: user.email, error: e.message };
  }
}
function resetPassword_(u, p) {
  requirePerm_(u, 'users');
  guardAdminTarget_(u, p.id);
  checkPassword_(p.password);
  const salt = Utilities.getUuid();
  return withLock_(() => {
    Repo.update('Users', p.id, { password_salt: salt, password_hash: hash_(p.password, salt), must_change: 'TRUE', updated_at: nowIso_() });
    killSessions_(p.id);
    return true;
  });
}
function deleteUser_(u, id) {
  requirePerm_(u, 'users');
  guardAdminTarget_(u, id);
  if (id === u.id) fail_('You cannot delete your own account');
  return withLock_(() => {
    killSessions_(id);
    Repo.remove('Users', id);
    return { id: id };
  });
}
function saveSettings_(u, p) {
  if (u.role !== 'admin') {
    requirePerm_(u, 'basic');
    const q = {};
    BASIC_SETTINGS.forEach(k => { if (p[k] !== undefined) q[k] = p[k]; });
    p = q;
  }
  if (p.mc_permissions !== undefined) p.mc_permissions = String(p.mc_permissions || '').split(',').map(x => x.trim()).filter(x => MC_PERMS.indexOf(x) >= 0).join(',');
  return withLock_(() => {
    if (p.notify_emails !== undefined) {
      const list = str_(p.notify_emails).split(/[\s,;]+/).filter(Boolean);
      const bad = list.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad.length) fail_('Invalid email address: ' + bad.join(', '));
      p.notify_emails = list.join(', ');
    }
    if (p.meeting_title !== undefined && !str_(p.meeting_title)) p.meeting_title = DEFAULT_SETTINGS.meeting_title;
    if (p.vessel_types !== undefined) {
      const seen = {};
      p.vessel_types = String(p.vessel_types || '').split(/\r?\n/).map(x => x.trim()).filter(x => x && !seen[x.toLowerCase()] && (seen[x.toLowerCase()] = true)).join('\n');
      if (!p.vessel_types) p.vessel_types = DEFAULT_SETTINGS.vessel_types;
    }
    [['weather_lat', 90], ['weather_lon', 180]].forEach(([k, max]) => {
      if (p[k] === undefined || str_(p[k]) === '') return;
      const n = Number(str_(p[k]));
      if (!isFinite(n) || Math.abs(n) > max) fail_((k === 'weather_lat' ? 'Latitude' : 'Longitude') + ' must be a number between -' + max + ' and ' + max);
      p[k] = String(n);
    });
    if (p.weather_points !== undefined) {
      const lines = String(p.weather_points || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length > 30) fail_('Up to 30 weather points');
      p.weather_points = lines.map((l, i) => {
        const a = l.split(/[,\t;]/).map(x => x.trim());
        const lat = Number(a[1]), lon = Number(a[2]);
        if (a.length < 3 || !a[0] || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
          fail_('Weather point line ' + (i + 1) + ' must be: name, latitude, longitude — got "' + l + '"');
        return a[0] + ', ' + lat + ', ' + lon;
      }).join('\n');
    }
    ['weather_wave_limit', 'weather_wind_limit'].forEach(k => {
      if (p[k] !== undefined && !(Number(str_(p[k])) > 0)) p[k] = DEFAULT_SETTINGS[k];
    });
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (p[k] === undefined) return;
      if (Repo.get('Settings', k)) Repo.update('Settings', k, { value: str_(p[k]) });
      else Repo.insert('Settings', { key: k, value: str_(p[k]) });
    });
    return settings_();
  });
}

// ============ Load ============
function loadData_(u) {
  const rev = dataRev_();   // 先取版本號再讀資料：讀取中若有人寫入，前端下一輪會再抓一次
  const personnelAll = Repo.all('Personnel');
  const personnel = isStaff_(u) ? personnelAll : personnelAll.filter(p => sameCompany_(p.company, u.company));
  const ids = {};
  personnel.forEach(p => { ids[p.id] = true; });
  return {
    user: publicUser_(u),
    settings: settings_(),
    companies: Repo.all('Companies'),
    vessels: Repo.all('Vessels'),
    locations: Repo.all('Locations'),
    personnel: personnel,
    transfers: Repo.all('Transfers').filter(t => isStaff_(u) || ids[t.personnel_id]),
    siteLog: Repo.all('SiteLog'),
    announcements: Repo.all('Announcements').filter(a => hasPerm_(u, 'ann') || a.active !== 'FALSE'),
    vesselCertTypes: Repo.all('VesselCertTypes'),
    vesselCerts: Repo.all('VesselCerts'),
    personCertTypes: Repo.all('PersonCertTypes'),
    personCerts: Repo.all('PersonCerts').filter(c => ids[c.personnel_id]),
    meetings: Repo.all('Meetings').filter(m => meetingVisible_(u, m, personnelAll)).map(m => {
      // 參與者顯示用（承包商看不到其他公司的人員資料，所以把姓名／公司附在會議上）
      m.attendee_info = JSON.stringify(parseList_(m.attendees).map(id => { const x = personnelAll.find(q => q.id === id); return x ? { id: id, name: x.name, company: x.company, position: x.position } : null; }).filter(Boolean));
      return m;
    }),
    // 會議勾選參與者用：Admin／MC 拿全部人員的精簡清單
    people: isStaff_(u) ? personnelAll.map(p => ({ id: p.id, name: p.name, company: p.company, position: p.position })) : [],
    // 只有 Admin 看得到 Admin 帳號
    users: hasPerm_(u, 'users') ? Repo.all('Users').filter(x => u.role === 'admin' || x.role !== 'admin').map(publicUser_) : [],
    visits: visitCount_(),
    rev: rev
  };
}
function meetingVisible_(u, m, personnelAll) {
  if (isStaff_(u)) return true;
  let att = [], ext = [];
  try { att = JSON.parse(m.attendees || '[]'); } catch (e) {}
  try { ext = JSON.parse(m.externals || '[]'); } catch (e) {}
  return att.some(id => { const p = personnelAll.find(x => x.id === id); return p && sameCompany_(p.company, u.company); }) ||
    ext.some(x => sameCompany_(x.company, u.company));
}

// ============ Generic save ============
function saveSimple_(sheet, p, fields, required) {
  return withLock_(() => {
    const d = {};
    fields.forEach(f => { if (p[f] !== undefined) d[f] = str_(p[f]); });
    if (sheet === 'Companies' && p.active !== undefined) d.active = bool_(p.active) ? 'TRUE' : 'FALSE';
    required.forEach(f => { if (!d[f] && !(p.id && d[f] === undefined)) fail_(f + ' is required'); });
    const hasUpdated = SCHEMAS[sheet].indexOf('updated_at') >= 0;
    if (p.id) {
      if (hasUpdated) d.updated_at = nowIso_();
      return Repo.update(sheet, p.id, d);
    }
    d.id = genId_();
    d.created_at = nowIso_();
    if (hasUpdated) d.updated_at = d.created_at;
    if (sheet === 'Companies' && d.active === undefined) d.active = 'TRUE';
    return Repo.insert(sheet, d);
  });
}
function saveCertType_(sheet, p, fields) {
  const d = {};
  fields.forEach(f => {
    if (p[f] === undefined) return;
    d[f] = (f === 'mandatory' || f === 'active' || f === 'has_expiry') ? (bool_(p[f]) ? 'TRUE' : 'FALSE') : str_(p[f]);
  });
  return withLock_(() => {
    if (p.id && d.name === '') fail_('Name is required');
    if (p.id) return Repo.update(sheet, p.id, d);
    if (!d.name) fail_('Name is required');
    d.id = genId_();
    if (d.active === undefined) d.active = 'TRUE';
    if (d.sort === undefined) d.sort = String(Repo.all(sheet).length + 1);
    if (sheet === 'PersonCertTypes' && d.has_expiry === undefined) d.has_expiry = 'TRUE';
    if (sheet === 'VesselCertTypes' && d.mandatory === undefined) d.mandatory = 'FALSE';
    return Repo.insert(sheet, d);
  });
}
function deleteCompany_(id) {
  const c = Repo.get('Companies', id);
  if (!c) return { id: id };
  if (Repo.all('Personnel').some(p => sameCompany_(p.company, c.name)) || Repo.all('Users').some(x => sameCompany_(x.company, c.name))) {
    fail_('Company still has personnel or user accounts — deactivate it instead');
  }
  withLock_(() => Repo.remove('Companies', id));
  return { id: id };
}
function locationInUse_(cid) {
  return Repo.all('Personnel').some(p => p.current_location === cid);
}
/** 承包商只能動自家公司登錄的船；forDelete＝已核准的船只有 Admin／MC 能刪 */
function vesselFor_(u, id, forDelete) {
  const v = Repo.get('Vessels', id);
  if (!v) fail_('Vessel not found', 'NOT_FOUND');
  if (isStaff_(u)) return v;
  if (!v.company || !sameCompany_(v.company, u.company)) fail_('You can only change vessels registered by your company', 'FORBIDDEN');
  if (forDelete && v.approval === 'Approved') fail_('Approved vessels can only be deleted by MC / Admin', 'FORBIDDEN');
  return v;
}
function deleteVessel_(id) {
  if (locationInUse_('vessel_' + id)) fail_('Cannot delete: personnel are on board this vessel');
  return withLock_(() => {
    Repo.all('VesselCerts').filter(c => c.vessel_id === id).forEach(c => trashFile_(c.file_id));
    Repo.removeWhere('VesselCerts', c => c.vessel_id === id);
    Repo.remove('Vessels', id);
    return { id: id };
  });
}
function deleteLocation_(id) {
  if (locationInUse_('loc_' + id)) fail_('Cannot delete: personnel are at this location');
  withLock_(() => Repo.remove('Locations', id));
  return { id: id };
}

// ============ Personnel ============
const PERSON_FIELDS = ['name','company','nationality','position','email','phone','passport','blood_type','emergency','emergency_phone','photo','remark','current_location'];
/** 人員必填欄位（照片、備註、位置除外） */
const PERSON_REQUIRED = ['name','company','nationality','position','email','phone','passport','blood_type','emergency','emergency_phone'];
const BLOOD_TYPES = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];
function savePersonnel_(u, p) {
  let event = '';
  const rec = withLock_(() => {
    const d = {};
    PERSON_FIELDS.forEach(f => { if (p[f] !== undefined) d[f] = str_(p[f]); });
    if (d.photo && d.photo.length > MAX_PHOTO_CHARS) fail_('Photo is too large');
    if (d.photo && d.photo.indexOf('data:image/') !== 0) d.photo = '';
    if (!isStaff_(u)) d.company = u.company;      // 承包商只能建／編自家公司的人；Admin／MC 可改人員所屬公司
    // 承包商只能在新增人員時選初始位置；之後位置只由 Admin／MC（轉運）變更
    if (!isStaff_(u) && p.id) delete d.current_location;
    if (d.current_location && !locationExists_(d.current_location)) fail_('Location not found');
    let existing = null;
    if (p.id) {
      existing = Repo.get('Personnel', p.id);
      if (!existing) fail_('Record not found', 'NOT_FOUND');
      if (!isStaff_(u) && !sameCompany_(existing.company, u.company)) fail_('Permission denied', 'FORBIDDEN');
    }
    const merged = Object.assign({}, existing || {}, d);
    if (PERSON_REQUIRED.some(f => !str_(merged[f]))) fail_('All personnel fields are required');
    if (BLOOD_TYPES.indexOf(merged.blood_type) < 0) fail_('Invalid blood type');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(merged.email)) fail_('Email address looks invalid');
    if (!Repo.all('Companies').some(c => sameCompany_(c.name, merged.company))) fail_('Company is not in the company list — add it under Companies first');
    const dup = Repo.all('Personnel').find(x => x.id !== p.id && str_(x.passport).toLowerCase() === merged.passport.toLowerCase());
    if (dup) fail_('Passport No ' + merged.passport + ' already exists (' + dup.name + ', ' + dup.company + ')');
    // 護照影本必附：新增時一定要上傳；舊資料沒有護照檔的，下次儲存時也要補上
    const hasFile = p.passport_file && p.passport_file.data;
    if (!hasFile && !(existing && existing.passport_file_id)) fail_('Please upload a copy of the passport');
    if (hasFile) {
      const saved = saveFile_(p.passport_file, merged.name + ' - Passport');
      if (existing) trashFile_(existing.passport_file_id);
      d.passport_file_id = saved.id; d.passport_file_name = saved.name;
    }
    if (existing) {
      d.updated_at = nowIso_();
      // 被退件後由送件方修改 → 重新送 Admin 核准
      if (existing.approval === 'Rejected' && !isStaff_(u)) { d.approval = 'Pending'; d.approval_note = ''; event = 'resubmitted'; }
      return Repo.update('Personnel', p.id, d);
    }
    d.id = genId_();
    d.created_by = u.username;
    d.created_at = d.updated_at = nowIso_();
    if (isStaff_(u)) { d.approval = 'Approved'; d.approved_by = u.username; d.approved_at = d.created_at; }
    else { d.approval = 'Pending'; event = 'new'; }
    return Repo.insert('Personnel', d);
  });
  if (event) notify_('personnel_pending', 'Personnel pending approval｜人員待核准',
    [['Name｜姓名', rec.name], ['Company｜公司', rec.company], ['Nationality｜國籍', rec.nationality], ['Position｜職稱', rec.position],
     ['Submitted by｜送件人', u.name || u.username], ['Type｜類型', event === 'new' ? 'New personnel｜新增人員' : 'Resubmitted after rejection｜退件後重新送審']]);
  return rec;
}
function locationExists_(cid) {
  const m = /^(vessel|loc)_(.+)$/.exec(str_(cid));
  return !!m && !!Repo.get(m[1] === 'vessel' ? 'Vessels' : 'Locations', m[2]);
}
/** 檢視與編輯同一規則：Admin／MC 全部，承包商只能自家公司（forEdit 參數保留給呼叫端標示用途） */
function personFor_(u, personnelId, forEdit) {
  const p = Repo.get('Personnel', personnelId);
  if (!p) fail_('Personnel not found', 'NOT_FOUND');
  const ok = isStaff_(u) || sameCompany_(p.company, u.company);
  if (!ok) fail_('Permission denied', 'FORBIDDEN');
  return p;
}
function deletePersonnel_(u, id) {
  const p = personFor_(u, id, true);
  // 刪除人員維持原規則：Admin 全部，MC／承包商只能刪自家公司
  if (u.role !== 'admin' && !sameCompany_(p.company, u.company)) fail_('Permission denied', 'FORBIDDEN');
  if (!isStaff_(u) && p.current_location) fail_('This person is currently assigned to a location — ask MC to transfer them out first');
  return withLock_(() => {
    Repo.all('PersonCerts').filter(c => c.personnel_id === id).forEach(c => trashFile_(c.file_id));
    Repo.removeWhere('PersonCerts', c => c.personnel_id === id);
    trashFile_(p.passport_file_id);
    Repo.remove('Personnel', id);
    return { id: id };
  });
}

// ============ Files（Drive，私有；只能透過 file.get 依權限取回） ============
function filesFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('files_folder_id');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('OPTS Files (Person transfer)');
  props.setProperty('files_folder_id', f.getId());
  return f;
}
function saveFile_(file, prefix) {
  if (!file || !file.data) return null;
  const bytes = Utilities.base64Decode(String(file.data));
  if (bytes.length > MAX_FILE_BYTES) fail_('File is larger than 10 MB');
  const name = (prefix ? prefix + ' - ' : '') + str_(file.name || 'file');
  const blob = Utilities.newBlob(bytes, str_(file.mime) || 'application/octet-stream', name);
  const f = filesFolder_().createFile(blob);
  return { id: f.getId(), name: str_(file.name || 'file') };
}
function trashFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
}
function getFile_(u, id) {
  id = str_(id);
  if (!id) fail_('Missing file id');
  let allowed = Repo.all('VesselCerts').some(c => c.file_id === id);
  if (!allowed) {
    const pc = Repo.all('PersonCerts').find(c => c.file_id === id);
    if (pc) { personFor_(u, pc.personnel_id, false); allowed = true; }
  }
  if (!allowed) {
    const pp = Repo.all('Personnel').find(x => x.passport_file_id === id);   // 護照影本：Admin／MC 或同公司才看得到
    if (pp) { personFor_(u, pp.id, false); allowed = true; }
  }
  if (!allowed) allowed = Repo.all('Announcements').some(a => (hasPerm_(u, 'ann') || a.active !== 'FALSE') && parseList_(a.attachments).some(x => x.id === id));
  if (!allowed) {
    const all = Repo.all('Personnel');
    allowed = Repo.all('Meetings').some(m => meetingVisible_(u, m, all) && parseList_(m.attachments).some(x => x.id === id));
  }
  if (!allowed) fail_('File not found', 'NOT_FOUND');
  const f = DriveApp.getFileById(id);
  const blob = f.getBlob();
  return { name: f.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ============ Personnel certificates ============
function savePersonCert_(u, p) {
  const person = personFor_(u, p.personnel_id, true);
  const type = Repo.get('PersonCertTypes', p.type_id);
  if (!type) fail_('Certificate type is required');
  const d = { personnel_id: person.id, type_id: type.id, other_name: str_(p.other_name), cert_no: str_(p.cert_no),
    issue_date: str_(p.issue_date), expiry_date: str_(p.expiry_date) };
  if (bool_(type.has_expiry) && !d.expiry_date) fail_('Expiry date is required for ' + type.name);
  let existing = null;
  if (p.id) {
    existing = Repo.get('PersonCerts', p.id);
    if (!existing || existing.personnel_id !== person.id) fail_('Record not found', 'NOT_FOUND');
  }
  if (existing && existing.status === 'Approved' && !isStaff_(u)) {
    if (!(p.file && p.file.data)) fail_('Please attach the new certificate file');
    existing = null;   // 換證：保留已核准的舊證照，新的另外送審
  }
  if (existing && existing.status === 'Rejected' && !isStaff_(u) && !(p.file && p.file.data)) fail_('Please attach the new certificate file');
  if (!existing && !(p.file && p.file.data)) fail_('Please attach the certificate file');
  const saved = saveFile_(p.file, person.name + ' - ' + type.name);
  const rec = withLock_(() => {
    if (saved) {
      if (existing) trashFile_(existing.file_id);
      d.file_id = saved.id; d.file_name = saved.name;
    }
    // 承包商上傳或修改 → 送 Admin／MC 核准；Admin／MC 自己建的直接核准
    if (isStaff_(u)) {
      d.status = 'Approved'; d.reviewed_by = u.username; d.reviewed_at = nowIso_(); d.review_note = '';
    } else {
      d.status = 'Pending'; d.reviewed_by = ''; d.reviewed_at = ''; d.review_note = '';
    }
    d.submitted_by = u.username;
    d.updated_at = nowIso_();
    if (existing) return Repo.update('PersonCerts', existing.id, d);
    d.id = genId_();
    d.created_at = d.updated_at;
    return Repo.insert('PersonCerts', d);
  });
  if (rec.status === 'Pending') notify_('cert_pending', 'Certificate pending approval｜證照待核准',
    [['Personnel｜人員', person.name], ['Company｜公司', person.company], ['Certificate｜證照', type.name + (rec.other_name ? ' — ' + rec.other_name : '')],
     ['Cert No｜證號', rec.cert_no], ['Expiry｜到期日', rec.expiry_date], ['Submitted by｜送件人', u.name || u.username]]);
  return rec;
}
function deletePersonCert_(u, id) {
  const c = Repo.get('PersonCerts', id);
  if (!c) return { id: id };
  personFor_(u, c.personnel_id, true);
  withLock_(() => { trashFile_(c.file_id); Repo.remove('PersonCerts', id); });
  return { id: id };
}
function reviewPersonCert_(u, p) {
  requireRole_(u, ['admin','mc']);
  const status = p.status === 'Approved' ? 'Approved' : 'Rejected';
  if (status === 'Rejected' && !str_(p.note)) fail_('Please give a reason for rejection');
  const rec = withLock_(() => Repo.update('PersonCerts', p.id, { status: status, review_note: str_(p.note), reviewed_by: u.username, reviewed_at: nowIso_() }));
  const person = Repo.get('Personnel', rec.personnel_id) || {};
  const type = Repo.get('PersonCertTypes', rec.type_id) || {};
  notify_('review_result', 'Certificate ' + status.toLowerCase() + '｜證照' + (status === 'Approved' ? '已核准' : '已退件'),
    [['Personnel｜人員', person.name], ['Company｜公司', person.company], ['Certificate｜證照', type.name], ['Result｜結果', status],
     ['Reason｜原因', rec.review_note], ['Reviewed by｜審核人', u.name || u.username]]);
  return rec;
}

// ============ Approval（人員／船舶由 Admin 核准） ============
/**
 * 人員／船舶審核：
 * - 人員：核准＝基本資料與證照一起合格 → 一次核准該人員所有待審證照；退件時待審證照一起退。
 *   有證照被退件、或必要類別（體檢、海上安全訓練…）沒有有效證照時，不能核准。
 * - 船舶：本船需要的證書（依噸位／員額／船籍判斷）都已上傳檔案且未過期，才能核准。
 */
function reviewRecord_(u, sheet, p) {
  requireRole_(u, ['admin','mc']);
  const status = p.status === 'Approved' ? 'Approved' : 'Rejected';
  if (status === 'Rejected' && !str_(p.note)) fail_('Please give a reason for rejection');
  const target = Repo.get(sheet, p.id);
  if (!target) fail_('Record not found', 'NOT_FOUND');
  const now = nowIso_(), today = now.slice(0, 10);
  let certs = [];
  if (sheet === 'Personnel') {
    certs = Repo.all('PersonCerts').filter(c => c.personnel_id === p.id);
    if (status === 'Approved') {
      if (!target.passport_file_id) fail_('No passport copy uploaded — cannot approve yet');
      const rej = certs.filter(c => c.status === 'Rejected');
      if (rej.length) fail_('A certificate of this person was rejected — fix or delete it before approving the person');
      const types = Repo.all('PersonCertTypes');
      const cat = c => (types.find(t => t.id === c.type_id) || {}).category;
      const live = certs.filter(c => (c.status === 'Pending' || c.status === 'Approved') && !(c.expiry_date && c.expiry_date < today));
      const missing = String(settings_().required_categories || '').split(',').map(s => s.trim()).filter(Boolean).filter(k => !live.some(c => cat(c) === k));
      if (missing.length) fail_('Missing valid certificate: ' + missing.join(', ') + ' — cannot approve yet');
    }
  }
  if (sheet === 'Vessels' && status === 'Approved') {
    const miss = vesselMissingCerts_(target, today);
    if (miss === null) fail_('Fill in gross tonnage, max persons on board and flag before approving');
    if (miss.length) fail_('Missing / expired / no file: ' + miss.slice(0, 6).join(', ') + (miss.length > 6 ? ' … (+' + (miss.length - 6) + ')' : '') + ' — cannot approve yet');
  }
  const updated = [];
  const rec = withLock_(() => {
    certs.filter(c => c.status === 'Pending').forEach(c => {
      updated.push(Repo.update('PersonCerts', c.id, status === 'Approved'
        ? { status: 'Approved', review_note: '', reviewed_by: u.username, reviewed_at: now }
        : { status: 'Rejected', review_note: '隨人員退件 Rejected with personnel: ' + str_(p.note), reviewed_by: u.username, reviewed_at: now }));
    });
    return Repo.update(sheet, p.id, { approval: status, approval_note: str_(p.note), approved_by: u.username, approved_at: now });
  });
  const what = sheet === 'Vessels' ? ['Vessel', '船舶'] : ['Personnel', '人員'];
  notify_('review_result', what[0] + ' ' + status.toLowerCase() + '｜' + what[1] + (status === 'Approved' ? '已核准' : '已退件'),
    [[what[0] + '｜' + what[1], rec.name], ['Company｜公司', rec.company || rec.operator], ['Result｜結果', status],
     ['Reason｜原因', rec.approval_note], ['Reviewed by｜審核人', u.name || u.username]]
     .concat(updated.length ? [['Certificates｜證照', updated.length + (status === 'Approved' ? ' 張證照一併核准 approved together' : ' 張證照一併退件 rejected together')]] : []));
  return Object.assign({}, rec, { _certs: updated });
}
/** 船舶需要但缺少（未上傳檔案／已過期）的證書名稱；船的噸位／員額／船籍沒填齊時回傳 null */
function vesselMissingCerts_(v, today) {
  const gt = Number(v.gross_tonnage), pob = Number(v.max_persons), flag = str_(v.flag);
  if (!(gt > 0) || !(pob > 0) || !flag) return null;
  const tw = /taiwan|\bR\.?\s?O\.?\s?C\b|republic of china|中華民國|台灣|臺灣|^tw$/i.test(flag);
  const certs = Repo.all('VesselCerts').filter(c => c.vessel_id === v.id);
  return Repo.all('VesselCertTypes').filter(t => t.active !== 'FALSE' && t.mandatory === 'TRUE').filter(t => {
    let r = {}; try { r = JSON.parse(t.rule || '{}') || {}; } catch (e) {}
    if (r.mode === 'never') return false;
    if (r.mode === 'auto') {
      if (r.flag === 'tw' && !tw) return false;
      if (r.flag === 'foreign' && tw) return false;
      if (r.gt_max && gt >= r.gt_max) return false;
      const conds = [];
      if (r.gt_min) conds.push(gt >= r.gt_min);
      if (r.pob_min) conds.push(pob >= r.pob_min);
      if (conds.length && !conds.some(Boolean)) return false;
    }
    return true;
  }).filter(t => {
    const c = certs.find(x => x.type_id === t.id);
    return !c || !c.file_id || (c.expiry_date && c.expiry_date < today);
  }).map(t => t.name);
}
/** 總噸位、限制員額、船籍：判斷需要哪些證書的依據，三項都必填 */
function checkVesselSpecs_(m, out) {
  out = out || m;
  const gt = Number(str_(m.gross_tonnage)), pob = Number(str_(m.max_persons));
  if (!str_(m.gross_tonnage) || !isFinite(gt) || gt <= 0) fail_('Gross tonnage is required (a number greater than 0)');
  if (!str_(m.max_persons) || !isFinite(pob) || pob <= 0 || Math.floor(pob) !== pob) fail_('Maximum persons on board is required (a whole number)');
  if (!str_(m.flag)) fail_('Flag (nationality) is required');
  if (out.gross_tonnage !== undefined) out.gross_tonnage = String(gt);
  if (out.max_persons !== undefined) out.max_persons = String(pob);
}
const VESSEL_FIELDS = ['name','mmsi','imo','type','flag','gross_tonnage','max_persons','operator','contact_person','phone','whatsapp','email','remark'];
function saveVessel_(u, p) {
  let event = '';
  const rec = withLock_(() => {
    const d = {};
    VESSEL_FIELDS.forEach(f => { if (p[f] !== undefined) d[f] = str_(p[f]); });
    if (p.id) {
      const existing = Repo.get('Vessels', p.id);
      if (!existing) fail_('Record not found', 'NOT_FOUND');
      if (d.name === '') fail_('name is required');
      if (!isStaff_(u) && !sameCompany_(existing.company, u.company)) fail_('You can only edit vessels registered by your company', 'FORBIDDEN');
      delete d.company;
      checkVesselSpecs_(Object.assign({}, existing, d), d);
      d.updated_at = nowIso_();
      if (existing.approval === 'Rejected' && !isStaff_(u)) { d.approval = 'Pending'; d.approval_note = ''; event = 'resubmitted'; }
      return Repo.update('Vessels', p.id, d);
    }
    if (!d.name) fail_('name is required');
    checkVesselSpecs_(d);
    d.id = genId_(); d.created_by = u.username; d.created_at = d.updated_at = nowIso_();
    d.company = isStaff_(u) ? '' : u.company;
    if (isStaff_(u)) { d.approval = 'Approved'; d.approved_by = u.username; d.approved_at = d.created_at; }
    else { d.approval = 'Pending'; event = 'new'; }
    return Repo.insert('Vessels', d);
  });
  if (event) notify_('vessel_pending', 'Vessel pending approval｜船舶待核准',
    [['Vessel｜船舶', rec.name], ['Type｜船型', rec.type], ['MMSI / IMO', [rec.mmsi, rec.imo].filter(Boolean).join(' / ')], ['Operator｜營運公司', rec.operator],
     ['Submitted by｜送件人', u.name || u.username]]);
  return rec;
}

// ============ Offshore PTW 系統連結 ============
// OPTS 是船舶的主資料：PTW 系統只拿「已核准」的船當下拉選單，並可把暫存船舶送來這裡申請。
// 金鑰存在 Script Properties（不進試算表，承包商讀得到的 settings 也不會帶出）。
const EXT_ACTIONS = { 'ext.vessels': 1, 'ext.vesselApply': 1 };
function ptwLinkKey_(regenerate) {
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty('PTW_LINK_KEY');
  if (!k || regenerate) {
    k = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('PTW_LINK_KEY', k);
  }
  return k;
}
function verifyLinkKey_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('PTW_LINK_KEY');
  if (!k || str_(key) !== k) fail_('Invalid PTW link key', 'FORBIDDEN');
  return { id: 'ptw-system', username: 'ptw-system', name: 'Offshore PTW System', role: 'system', company: '' };
}
function ptwLinkKeyAdmin_(u, p) {
  requireRole_(u, ['admin']);
  return { key: ptwLinkKey_(!!p.regenerate) };
}
function extVessel_(v) {
  return { id: v.id, name: v.name, imo: v.imo, mmsi: v.mmsi, type: v.type, flag: v.flag, gross_tonnage: v.gross_tonnage, max_persons: v.max_persons, operator: v.operator, approval: v.approval };
}
/** PTW 送來的船舶申請：同 IMO／MMSI／船名已存在就回傳既有那筆，不重複建立 */
function extVesselApply_(u, p) {
  const name = str_(p.name);
  if (!name) fail_('name is required');
  const imo = str_(p.imo).toLowerCase(), mmsi = str_(p.mmsi).toLowerCase();
  let created = false;
  const rec = withLock_(() => {
    const dup = Repo.all('Vessels').find(v => (imo && str_(v.imo).toLowerCase() === imo) ||
      (mmsi && str_(v.mmsi).toLowerCase() === mmsi) || str_(v.name).toLowerCase() === name.toLowerCase());
    if (dup) return dup;
    const d = {};
    VESSEL_FIELDS.forEach(f => { if (p[f] !== undefined) d[f] = str_(p[f]); });
    d.remark = [d.remark, 'Requested from Offshore PTW System by ' + (str_(p.requested_by) || 'PTW')].filter(Boolean).join(' · ');
    d.id = genId_(); d.created_by = 'ptw:' + (str_(p.requested_by) || 'system'); d.created_at = d.updated_at = nowIso_();
    d.approval = 'Pending';
    created = true;
    return Repo.insert('Vessels', d);
  });
  if (created) notify_('vessel_pending', 'Vessel pending approval｜船舶待核准',
    [['Vessel｜船舶', rec.name], ['Type｜船型', rec.type], ['MMSI / IMO', [rec.mmsi, rec.imo].filter(Boolean).join(' / ')], ['Operator｜營運公司', rec.operator],
     ['Submitted by｜送件人', 'Offshore PTW System — ' + (str_(p.requested_by) || '')]]);
  return { vessel: extVessel_(rec), created: created };
}

// ============ Meetings ============
function parseList_(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function saveMeeting_(u, p) {
  const items = parseList_(p.items).map(i => ({ topic: str_(i.topic), discussion: str_(i.discussion), action: str_(i.action), owner: str_(i.owner), due: str_(i.due) }))
    .filter(i => i.topic || i.discussion || i.action);
  const attendees = parseList_(p.attendees).map(str_).filter(Boolean);
  const externals = parseList_(p.externals).map(x => ({ name: str_(x.name), company: str_(x.company) })).filter(x => x.name);
  const d = { title: str_(p.title), time: str_(p.time), location: str_(p.location), remark: str_(p.remark),
    items: JSON.stringify(items), attendees: JSON.stringify(attendees), externals: JSON.stringify(externals), updated_at: nowIso_() };
  if (!d.title || !d.time) fail_('Meeting title and time are required');
  if (!items.length) fail_('Add at least one discussion item');
  const isNew = !p.id;
  const rec = withLock_(() => {
    const old = p.id ? Repo.get('Meetings', p.id) : null;
    if (p.id && !old) fail_('Record not found', 'NOT_FOUND');
    d.attachments = JSON.stringify(applyAttachments_(old ? old.attachments : '', p, 'Meeting ' + d.time.slice(0, 10)));
    if (p.id) return Repo.update('Meetings', p.id, d);
    d.id = genId_(); d.created_by = u.username; d.created_at = d.updated_at;
    return Repo.insert('Meetings', d);
  });
  if (isNew) {
    const ppl = Repo.all('Personnel');
    const names = attendees.map(id => { const x = ppl.find(q => q.id === id); return x ? x.name + ' (' + x.company + ')' : ''; }).filter(Boolean)
      .concat(externals.map(x => x.name + (x.company ? ' (' + x.company + ')' : '')));
    notify_('meeting', 'Meeting minutes｜會議紀錄：' + d.title,
      [['Meeting｜會議', d.title], ['Time｜時間', d.time.replace('T', ' ')], ['Location｜地點', d.location], ['Attendees｜參與人員', names.join(', ')]]
        .concat(items.map((i, n) => ['Item ' + (n + 1) + '｜議題 ' + (n + 1), [i.topic, i.discussion, i.action ? '→ ' + i.action + (i.owner ? ' (' + i.owner + ')' : '') + (i.due ? ' ' + i.due : '') : ''].filter(Boolean).join(' — ')])));
  }
  return rec;
}

// ============ Attachments ============
const MAX_ATTACH_TOTAL = 25 * 1024 * 1024;   // 單次儲存最多 25 MB（GAS 請求大小有限）
/** 附件清單：保留舊的（扣掉 removeFiles）＋存入 newFiles，回傳 [{id,name}] */
function applyAttachments_(oldJson, p, prefix) {
  const remove = parseList_(p.removeFiles).map(str_);
  const add = parseList_(p.newFiles);
  const total = add.reduce((n, x) => n + Math.floor(String((x && x.data) || '').length * 3 / 4), 0);
  if (total > MAX_ATTACH_TOTAL) fail_('Attachments are larger than 25 MB in total — upload them in several saves');
  const keep = parseList_(oldJson).filter(a => {
    if (remove.indexOf(a.id) >= 0) { trashFile_(a.id); return false; }
    return true;
  });
  add.forEach(x => { const saved = saveFile_(x, prefix); if (saved) keep.push(saved); });
  return keep;
}
function deleteWithFiles_(sheet, id) {
  return withLock_(() => {
    const rec = Repo.get(sheet, id);
    if (rec) { parseList_(rec.attachments).forEach(a => trashFile_(a.id)); Repo.remove(sheet, id); }
    return { id: id };
  });
}

// ============ Announcements ============
const ANNOUNCE_LEVELS = ['info', 'warning', 'danger'];
function saveAnnouncement_(u, p) {
  const d = { text_zh: str_(p.text_zh), text_en: str_(p.text_en), level: ANNOUNCE_LEVELS.indexOf(str_(p.level)) >= 0 ? str_(p.level) : 'info',
    link_url: str_(p.link_url), link_text: str_(p.link_text).slice(0, 120), updated_at: nowIso_() };
  if (p.active !== undefined) d.active = bool_(p.active) ? 'TRUE' : 'FALSE';
  if (!d.text_zh) fail_('Chinese text is required');
  if (!d.text_en) fail_('English text is required');
  if (d.link_url && !/^https?:\/\//i.test(d.link_url)) fail_('Link must start with http:// or https://');
  return withLock_(() => {
    const old = p.id ? Repo.get('Announcements', p.id) : null;
    if (p.id && !old) fail_('Record not found', 'NOT_FOUND');
    d.attachments = JSON.stringify(applyAttachments_(old ? old.attachments : '', p, 'Announcement'));
    if (old) return Repo.update('Announcements', p.id, d);
    d.id = genId_(); d.created_by = u.username; d.created_at = d.updated_at;
    if (d.active === undefined) d.active = 'TRUE';
    return Repo.insert('Announcements', d);
  });
}

// ============ Notifications ============
function htmlEsc_(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
/**
 * 通知信版型（表格排版：Outlook／Gmail／手機都正常；每格都寫字型，Outlook 不會繼承）
 * 頁首：系統名稱、圖示＋標題、專案名稱；內文：說明、資料表（灰底標籤）、📌 區塊、置中按鈕。
 * rows：[['English｜中文', 值, { mono, badge }], …]
 * opt：{ icon, intro: [..], section: { title, items: [..] }, button }
 */
const MAIL_FONT_ = "'Microsoft JhengHei','PingFang TC','Noto Sans TC','Segoe UI',Arial,sans-serif";
const MAIL_ICON_ = { personnel_pending: '👷', vessel_pending: '🚢', cert_pending: '📄', review_result: '✅', transfer: '🔄', expiry: '⏰', meeting: '📝' };
const MAIL_INTRO_ = {
  personnel_pending: '有新的人員資料等待核准，請登入系統審核。',
  vessel_pending: '有新的船舶資料等待核准，請登入系統審核。',
  cert_pending: '有新上傳的證照等待核准，請登入系統審核。',
  review_result: '下列資料的審核結果如下。',
  transfer: '已完成下列人員轉運，詳細資料如下。',
  expiry: '下列證照即將到期或已到期，請相關人員儘速更新並上傳證照。',
  meeting: '新增了一份會議紀錄，摘要如下。'
};
function mailHtml_(title, rows, appUrl, opt) {
  opt = opt || {};
  const st = settings_();
  const f = 'font-family:' + MAIL_FONT_ + ';';
  const t = String(title).split('｜');
  const zhTitle = t[1] || t[0], enTitle = t[1] ? t[0] : '';
  const keep = (rows || []).filter(x => x[1] !== undefined && x[1] !== null && String(x[1]) !== '');
  const label = l => { const p = String(l).split('｜'); return htmlEsc_(p[1] || p[0]) + (p[1] ? '<br><span style="font-size:11px;color:#9aa5b1">' + htmlEsc_(p[0]) + '</span>' : ''); };
  const value = x => {
    const v = String(x[1]), o = x[2] || {};
    let h = /^https?:\/\//.test(v) ? '<a href="' + htmlEsc_(v) + '" style="color:#0f5f8f;text-decoration:underline">' + htmlEsc_(v) + '</a>' : htmlEsc_(v).replace(/\n/g, '<br>');
    if (o.mono) h = '<span style="font-family:Consolas,\'Courier New\',monospace;font-size:16px;font-weight:700;color:#0f3d5c;letter-spacing:1px">' + h + '</span>';
    if (o.badge) h += '<br><span style="display:inline-block;margin-top:6px;padding:2px 10px;border-radius:10px;background:#fdecec;color:#c62828;font-size:12px;font-weight:700">' + htmlEsc_(o.badge) + '</span>';
    return h;
  };
  const cell = 'border-bottom:1px solid #e3e8ee;padding:11px 14px;vertical-align:top;';
  const table = keep.length ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e3e8ee">' +
    keep.map((x, i) => '<tr><td width="130" bgcolor="#f6f8fa" style="' + f + cell + (i === keep.length - 1 ? 'border-bottom:0;' : '') + 'background:#f6f8fa;font-size:13px;color:#5b6876;border-right:1px solid #e3e8ee">' + label(x[0]) + '</td>' +
      '<td style="' + f + cell + (i === keep.length - 1 ? 'border-bottom:0;' : '') + 'font-size:14px;color:#1d2b3a;font-weight:600;line-height:1.55">' + value(x) + '</td></tr>').join('') +
    '</table>' : '';
  const section = opt.section ? '<div style="' + f + 'font-size:14px;font-weight:700;color:#1d2b3a;margin:20px 0 8px">' + htmlEsc_(opt.section.title) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #e3e8ee">' +
    opt.section.items.map((it, i) => '<tr><td bgcolor="#f6f8fa" style="' + f + 'background:#f6f8fa;padding:10px 14px;font-size:13px;color:#1d2b3a;line-height:1.6;' + (i ? 'border-top:1px solid #e3e8ee;' : '') + '">' + htmlEsc_(it) + '</td></tr>').join('') +
    '</table>' : '';
  const btn = appUrl ? '<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 6px"><tr>' +
    '<td bgcolor="#0f3d5c" style="background:#0f3d5c;border-radius:4px">' +
    '<a href="' + htmlEsc_(appUrl) + '" style="' + f + 'display:inline-block;padding:12px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">' +
    htmlEsc_(opt.button || '🔗 開啟 OPTS 系統') + '</a></td></tr></table>' : '';
  const intro = opt.intro || (opt.event && MAIL_INTRO_[opt.event] ? [MAIL_INTRO_[opt.event]] : []);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:0;background:#f1f3f6">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f3f6" style="background:#f1f3f6"><tr><td align="center" style="padding:24px 10px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #dfe4ea">' +
    // 頁首
    '<tr><td bgcolor="#0f3d5c" style="background:#0f3d5c;padding:22px 26px 20px">' +
    '<div style="' + f + 'font-size:12px;color:#a9c7dc;letter-spacing:.5px">NMDC OPTS　｜　離岸人員轉運系統</div>' +
    '<div style="' + f + 'font-size:22px;font-weight:700;color:#ffffff;margin-top:8px;line-height:1.35">' + (opt.icon ? opt.icon + ' ' : '') + htmlEsc_(zhTitle) + '</div>' +
    (enTitle ? '<div style="' + f + 'font-size:13px;color:#cfe0ec;margin-top:2px">' + htmlEsc_(enTitle) + '</div>' : '') +
    (st.project_name ? '<div style="' + f + 'font-size:12px;color:#a9c7dc;margin-top:8px">' + htmlEsc_(st.project_name) + '</div>' : '') +
    '</td></tr>' +
    // 內文
    '<tr><td style="padding:22px 26px 10px">' +
    (intro.length ? '<div style="' + f + 'font-size:14px;color:#1d2b3a;line-height:1.75;margin-bottom:14px">' + intro.map(htmlEsc_).join('<br>') + '</div>' : '') +
    table + section + btn +
    '</td></tr>' +
    // 頁尾
    '<tr><td style="' + f + 'padding:14px 26px 20px;font-size:11px;color:#9aa5b1;line-height:1.6;text-align:center">' +
    '此信由 OPTS 系統自動發送，請勿直接回覆。　Automatic message — please do not reply.</td></tr>' +
    '</table></td></tr></table></body></html>';
}
function notify_(event, subject, rows) {
  try {
    const st = settings_();
    if (String(st.notify_events || '').split(',').indexOf(event) < 0) return false;
    const to = String(st.notify_emails || '').split(/[\s,;]+/).filter(Boolean).join(',');
    if (!to) return false;
    MailApp.sendEmail({ to: to, subject: '[OPTS] ' + subject, htmlBody: mailHtml_(subject, rows, st.app_url, { icon: MAIL_ICON_[event], event: event }), name: 'OPTS — NMDC' });
    return true;
  } catch (e) { console.warn('notify ' + event + ' failed: ' + e.message); return false; }
}
function notifyTest_(u) {
  const st = settings_();
  const to = String(st.notify_emails || '').split(/[\s,;]+/).filter(Boolean).join(',');
  if (!to) fail_('Add at least one recipient email first');
  try {
    MailApp.sendEmail({ to: to, subject: '[OPTS] Test notification｜測試通知', name: 'OPTS — NMDC',
      htmlBody: mailHtml_('Test notification｜測試通知', [['Sent by｜寄件人', u.name || u.username], ['Time｜時間', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')]], st.app_url, { icon: '✉️', intro: ['這是一封測試信。收到代表通知信設定正常。'] }) });
  } catch (e) { fail_('Could not send email: ' + e.message + ' — run setup() once in the Apps Script editor to authorise sending mail'); }
  return { to: to, quota: MailApp.getRemainingDailyQuota() };
}
// ============ Reset（清空資料；驗證碼寄到固定信箱，帳號／公司／設定一律保留） ============
const RESET_EMAIL = 'paul.tong@nmdc-group.com';
const RESET_GROUPS = {
  personnel: ['Personnel', 'PersonCerts'],
  vessels: ['Vessels', 'VesselCerts'],
  locations: ['Locations'],
  transfers: ['Transfers'],
  sitelog: ['SiteLog'],
  meetings: ['Meetings']
};
// 清空資料時一併丟掉附件的表
const RESET_ATTACH = { meetings: 'Meetings' };
function resetRequest_(u, p) {
  const groups = (Array.isArray(p.groups) ? p.groups : []).filter(g => RESET_GROUPS[g]);
  if (!groups.length) fail_('Tick at least one item to clear');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const state = { hash: hash_(code, 'reset'), groups: groups, by: u.id, tries: 0, exp: Date.now() + 10 * 60000 };
  PropertiesService.getScriptProperties().setProperty('reset_pending', JSON.stringify(state));
  try {
    MailApp.sendEmail({ to: RESET_EMAIL, name: 'OPTS — NMDC', subject: '[OPTS] Data reset verification code｜清空資料驗證碼：' + code,
      htmlBody: mailHtml_('Data reset verification code｜清空資料驗證碼', [
        ['Code｜驗證碼', code, { mono: true }], ['Requested by｜申請人', (u.name || u.username) + ' (' + u.username + ')'],
        ['Data to delete｜將刪除', groups.join(', ')], ['Valid for｜有效時間', '10 分鐘 (10 minutes)']], '', {
        icon: '🔐', intro: ['有人申請清空 OPTS 系統資料，請把下列驗證碼輸入系統以確認。'],
        section: { title: '📌 注意事項', items: ['若非本人申請，請忽略此信，資料不會被刪除。 If you did not request this, ignore this email.'] } }) });
  } catch (e) { fail_('Could not send email: ' + e.message); }
  return { to: RESET_EMAIL.replace(/^(.).*(@.*)$/, '$1***$2') };
}
function resetConfirm_(u, p) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('reset_pending');
  if (!raw) fail_('No reset request — send a new verification code');
  const st = JSON.parse(raw);
  if (st.by !== u.id) fail_('This code was requested by another administrator');
  if (Date.now() > st.exp) { props.deleteProperty('reset_pending'); fail_('Verification code expired — send a new one'); }
  if (hash_(str_(p.code), 'reset') !== st.hash) {
    st.tries++;
    if (st.tries >= 5) { props.deleteProperty('reset_pending'); fail_('Too many wrong codes — send a new one'); }
    props.setProperty('reset_pending', JSON.stringify(st));
    fail_('Wrong verification code (' + (5 - st.tries) + ' tries left)');
  }
  props.deleteProperty('reset_pending');
  return withLock_(() => {
    let rows = 0, files = 0;
    const g = st.groups;
    if (g.indexOf('personnel') >= 0) Repo.all('PersonCerts').forEach(c => { if (c.file_id) { trashFile_(c.file_id); files++; } });
    if (g.indexOf('vessels') >= 0) Repo.all('VesselCerts').forEach(c => { if (c.file_id) { trashFile_(c.file_id); files++; } });
    g.forEach(k => { if (RESET_ATTACH[k]) Repo.all(RESET_ATTACH[k]).forEach(x => parseList_(x.attachments).forEach(a => { trashFile_(a.id); files++; })); });
    g.forEach(k => RESET_GROUPS[k].forEach(sheet => { rows += Repo.clear(sheet); }));
    // 刪了船舶／位置但人員還在 → 把指向已刪位置的派駐清掉
    if (g.indexOf('personnel') < 0 && (g.indexOf('vessels') >= 0 || g.indexOf('locations') >= 0)) {
      Repo.all('Personnel').forEach(x => {
        const c = x.current_location || '';
        if ((c.indexOf('vessel_') === 0 && g.indexOf('vessels') >= 0) || (c.indexOf('loc_') === 0 && g.indexOf('locations') >= 0)) Repo.update('Personnel', x.id, { current_location: '' });
      });
    }
    console.log('RESET by ' + u.username + ': ' + g.join(',') + ' rows=' + rows + ' files=' + files);
    return { rows: rows, files: files, groups: g };
  });
}

/** 每日觸發器（setup() 建立）：證照在 30／14／7／1 天前與到期當天提醒 */
function dailyExpiryCheck() {
  ensureSchema_();
  try { withLock_(() => Repo.removeWhere('Sessions', s => s.expires_at < nowIso_())); } catch (e) { console.warn('session cleanup failed: ' + e.message); }
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const days = d => Math.round((new Date(d + 'T00:00:00') - new Date(today + 'T00:00:00')) / 864e5);
  const rows = [];
  const ppl = Repo.all('Personnel'), ptypes = Repo.all('PersonCertTypes');
  Repo.all('PersonCerts').forEach(c => {
    if (c.status !== 'Approved' || !c.expiry_date) return;
    const n = days(String(c.expiry_date).slice(0, 10));
    if (EXPIRY_ALERT_DAYS.indexOf(n) < 0) return;
    const p = ppl.find(x => x.id === c.personnel_id) || {}, t = ptypes.find(x => x.id === c.type_id) || {};
    rows.push([n === 0 ? 'EXPIRES TODAY｜今日到期' : n + ' days left｜剩 ' + n + ' 天', '👷 ' + p.name + ' (' + p.company + ') — ' + t.name + ' · ' + c.expiry_date]);
  });
  const ves = Repo.all('Vessels'), vtypes = Repo.all('VesselCertTypes');
  Repo.all('VesselCerts').forEach(c => {
    if (!c.expiry_date) return;
    const n = days(String(c.expiry_date).slice(0, 10));
    if (EXPIRY_ALERT_DAYS.indexOf(n) < 0) return;
    const v = ves.find(x => x.id === c.vessel_id) || {}, t = vtypes.find(x => x.id === c.type_id) || {};
    rows.push([n === 0 ? 'EXPIRES TODAY｜今日到期' : n + ' days left｜剩 ' + n + ' 天', '🚢 ' + v.name + ' — ' + t.name + ' · ' + c.expiry_date]);
  });
  if (rows.length) notify_('expiry', 'Certificates expiring soon｜證照即將到期（' + rows.length + '）', rows);
}

// ============ Vessel certificates ============
function saveVesselCert_(u, p) {
  const vessel = Repo.get('Vessels', p.vessel_id);
  if (!vessel) fail_('Vessel not found', 'NOT_FOUND');
  const type = Repo.get('VesselCertTypes', p.type_id);
  if (!type) fail_('Certificate type not found');
  const saved = saveFile_(p.file, vessel.name + ' - ' + type.name);
  // 船舶被退件後承包商重傳證書 → 船舶自動改回待核准（重新送審）
  const resubmit = vessel.approval === 'Rejected' && !isStaff_(u);
  const rec = withLock_(() => {
    const existing = Repo.all('VesselCerts').find(c => c.vessel_id === vessel.id && c.type_id === type.id);
    const d = { vessel_id: vessel.id, type_id: type.id, issue_date: str_(p.issue_date), expiry_date: str_(p.expiry_date),
      description: str_(p.description), updated_by: u.username, updated_at: nowIso_() };
    if (saved) {
      if (existing) trashFile_(existing.file_id);
      d.file_id = saved.id; d.file_name = saved.name;
    } else if (p.removeFile && existing) {
      trashFile_(existing.file_id);
      d.file_id = ''; d.file_name = '';
    }
    if (existing) return Repo.update('VesselCerts', existing.id, d);
    d.id = genId_();
    return Repo.insert('VesselCerts', d);
  });
  if (!resubmit) return rec;
  const v = withLock_(() => Repo.update('Vessels', vessel.id, { approval: 'Pending', approval_note: '', updated_at: nowIso_() }));
  notify_('vessel_pending', 'Vessel pending approval｜船舶待核准',
    [['Vessel｜船舶', v.name], ['Type｜船型', v.type], ['MMSI / IMO', [v.mmsi, v.imo].filter(Boolean).join(' / ')], ['Operator｜營運公司', v.operator],
     ['Certificate｜證書', type.name], ['Submitted by｜送件人', u.name || u.username]]);
  return Object.assign({}, rec, { vessel: v });
}
function deleteVesselCert_(id) {
  const c = Repo.get('VesselCerts', id);
  if (c) withLock_(() => { trashFile_(c.file_id); Repo.remove('VesselCerts', id); });
  return { id: id };
}

// ============ Transfer & Site Log ============
function locName_(cid, vessels, locations) {
  if (!cid) return 'Not assigned';
  if (cid.indexOf('vessel_') === 0) { const v = vessels.find(x => x.id === cid.slice(7)); return v ? v.name : 'Unknown vessel'; }
  if (cid.indexOf('loc_') === 0) { const l = locations.find(x => x.id === cid.slice(4)); return l ? l.name : 'Unknown location'; }
  return cid;
}
function executeTransfer_(u, p) {
  const ids = Array.isArray(p.personnel_ids) ? p.personnel_ids : [];
  const to = str_(p.to_location), from = str_(p.from_location);
  if (!ids.length) fail_('Select at least one person');
  if (!to || !str_(p.time) || !str_(p.type) || !str_(p.approved_by)) fail_('To, Time, Type and Approved By are required');
  const res = withLock_(() => {
    const vessels = Repo.all('Vessels'), locations = Repo.all('Locations');
    const now = nowIso_();
    const transfers = [], updated = [], skipped = [];
    ids.forEach(id => {
      const person = Repo.get('Personnel', id);
      if (!person) { skipped.push(id + ': not found'); return; }
      const cur = person.current_location || '';
      if (from && from !== cur) { skipped.push(person.name + ': not at the selected From location'); return; }
      if (cur === to) { skipped.push(person.name + ': already at destination'); return; }
      if (person.approval !== 'Approved') { skipped.push(person.name + ': not approved yet'); return; }
      transfers.push({ id: genId_(), personnel_id: person.id, personnel_name: person.name, company: person.company,
        from_location: cur, to_location: to, time: str_(p.time), type: str_(p.type), transport: str_(p.transport),
        approved_by: str_(p.approved_by), reason: str_(p.reason), remark: str_(p.remark), logged_by: u.username, created_at: now });
      updated.push(Repo.update('Personnel', person.id, { current_location: to, updated_at: now }));
    });
    Repo.insertMany('Transfers', transfers);
    let log = null;
    if (transfers.length) {
      const transportName = p.transport ? locName_('vessel_' + p.transport, vessels, locations) : '';
      const fromNames = transfers.map(t => locName_(t.from_location, vessels, locations)).filter((v, i, a) => a.indexOf(v) === i);
      const detail = (transportName ? transportName + ' ' : '') + transfers.length + 'pax ' + fromNames.join('/') + ' → ' +
        locName_(to, vessels, locations) + ' (' + str_(p.type) + ')' + (str_(p.remark) ? ' // ' + str_(p.remark) : '');
      log = { id: genId_(), time: str_(p.time), activity: 'TRANSFER', source: 'System', detail: detail, asset: to,
        transport: str_(p.transport), personnel: transfers.map(t => t.personnel_name).join(', '), logged_by: u.username, created_at: now };
      Repo.insert('SiteLog', log);
    }
    return { transfers: transfers, personnel: updated, siteLog: log, skipped: skipped };
  });
  if (res.transfers.length) notify_('transfer', 'Personnel transferred｜人員轉運：' + res.siteLog.detail,
    [['Time｜時間', str_(p.time).replace('T', ' ')], ['Detail｜內容', res.siteLog.detail],
     ['Personnel｜人員', res.transfers.map(t => t.personnel_name + ' (' + t.company + ')').join(', ')],
     ['Approved by｜核准人', str_(p.approved_by)], ['Logged by｜記錄人', u.name || u.username]]);
  return res;
}
function saveSiteLog_(u, p) {
  const d = { time: str_(p.time), activity: str_(p.activity) || 'INFO', detail: str_(p.detail), asset: str_(p.asset),
    transport: str_(p.transport), personnel: str_(p.personnel) };
  if (!d.time || !d.detail) fail_('Time and Detail are required');
  return withLock_(() => {
    if (p.id) return Repo.update('SiteLog', p.id, d);
    d.id = genId_(); d.source = 'Manual'; d.logged_by = u.username; d.created_at = nowIso_();
    return Repo.insert('SiteLog', d);
  });
}
