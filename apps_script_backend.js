// ============================================================
// Offshore Personnel Transfer System - Google Apps Script Backend
// ============================================================
// 部署步驟：
// 1. 建立一個新的 Google Spreadsheet
// 2. 在該 Spreadsheet 中，點選 Extensions > Apps Script
// 3. 貼上此程式碼（取代原本的 Code.gs 內容）
// 4. 執行一次 initSheets() 函式（初始化表頭）
// 5. 部署：Deploy > New deployment > Web App
//    - Execute as: Me
//    - Who has access: Anyone
// 6. 複製部署後的 URL，貼到前端 Settings 頁面
// ============================================================

// Sheet 名稱
const SHEET_NAMES = {
  vessels: 'Vessels',
  personnel: 'Personnel',
  locations: 'Locations',
  transfers: 'Transfers'
};

// 各 Sheet 的欄位定義
const SCHEMAS = {
  vessels: ['id','name','mmsi','imo','type','flag','remark','created_at','updated_at'],
  personnel: ['id','name','employee_id','company','nationality','position','medical','medical_expiry','bosiet','bosiet_expiry','passport','emergency','remark','current_location','created_at','updated_at'],
  locations: ['id','name','type','linked_vessel','remark','created_at','updated_at'],
  transfers: ['id','personnel_id','from_location','to_location','time','type','approved_by','reason','remark','created_at']
};

// ============ 初始化 ============
function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEET_NAMES).forEach(key => {
    let sheet = ss.getSheetByName(SHEET_NAMES[key]);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAMES[key]);
    }
    // 寫入表頭
    const headers = SCHEMAS[key];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    // 粗體表頭
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    // 凍結第一列
    sheet.setFrozenRows(1);
  });
  SpreadsheetApp.getUi().alert('All sheets initialized successfully!');
}

// ============ HTTP Handlers ============
function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || '';
    const entity = params.entity || '';
    
    // CORS headers
    let result;
    
    switch(action) {
      case 'getAll':
        result = getAllRecords(entity);
        break;
      case 'create':
        result = createRecord(entity, JSON.parse(e.postData.contents));
        break;
      case 'update':
        result = updateRecord(entity, JSON.parse(e.postData.contents));
        break;
      case 'delete':
        result = deleteRecord(entity, params.id);
        break;
      case 'sync':
        // 一次取回所有資料
        result = {
          vessels: getAllRecords('vessels').data,
          personnel: getAllRecords('personnel').data,
          locations: getAllRecords('locations').data,
          transfers: getAllRecords('transfers').data
        };
        break;
      case 'bulkSync':
        // 前端推送所有資料到後端（覆蓋式同步）
        result = bulkSync(JSON.parse(e.postData.contents));
        break;
      case 'ping':
        result = { status: 'ok', timestamp: new Date().toISOString() };
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
    
    return ContentService.createTextOutput(JSON.stringify({ success: true, ...result }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ 
      success: false, 
      error: err.message,
      stack: err.stack 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============ CRUD Operations ============

function getAllRecords(entity) {
  const sheetName = SHEET_NAMES[entity];
  if (!sheetName) return { data: [], error: 'Invalid entity' };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { data: [] };
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { data: [] };
  
  const headers = data[0];
  const records = [];
  for (let i = 1; i < data.length; i++) {
    const row = {};
    headers.forEach((h, idx) => {
      let val = data[i][idx];
      // Date 轉字串
      if (val instanceof Date) {
        val = val.toISOString();
      }
      row[h] = val !== undefined && val !== null ? String(val) : '';
    });
    if (row.id) records.push(row);
  }
  return { data: records };
}

function createRecord(entity, record) {
  const sheetName = SHEET_NAMES[entity];
  if (!sheetName) return { error: 'Invalid entity' };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  const headers = SCHEMAS[entity];
  
  // 加上時間戳
  if (!record.id) record.id = generateId();
  record.created_at = record.created_at || new Date().toISOString();
  if (headers.includes('updated_at')) record.updated_at = new Date().toISOString();
  
  const row = headers.map(h => record[h] || '');
  sheet.appendRow(row);
  
  return { data: record, message: 'Created' };
}

function updateRecord(entity, record) {
  const sheetName = SHEET_NAMES[entity];
  if (!sheetName) return { error: 'Invalid entity' };
  if (!record.id) return { error: 'Missing id' };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  const headers = SCHEMAS[entity];
  const data = sheet.getDataRange().getValues();
  
  // 找到 id 所在列
  const idCol = headers.indexOf('id');
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(record.id)) {
      rowIdx = i + 1; // Sheets row 從 1 開始
      break;
    }
  }
  
  if (rowIdx === -1) return { error: 'Record not found' };
  
  if (headers.includes('updated_at')) record.updated_at = new Date().toISOString();
  
  const row = headers.map(h => record[h] !== undefined ? record[h] : '');
  sheet.getRange(rowIdx, 1, 1, row.length).setValues([row]);
  
  return { data: record, message: 'Updated' };
}

function deleteRecord(entity, id) {
  const sheetName = SHEET_NAMES[entity];
  if (!sheetName) return { error: 'Invalid entity' };
  if (!id) return { error: 'Missing id' };
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = SCHEMAS[entity];
  const idCol = headers.indexOf('id');
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { message: 'Deleted', id: id };
    }
  }
  
  return { error: 'Record not found' };
}

// ============ Bulk Sync（前端 → 後端 全量覆蓋）============
function bulkSync(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = {};
  
  ['vessels','personnel','locations','transfers'].forEach(entity => {
    if (!payload[entity]) return;
    const sheetName = SHEET_NAMES[entity];
    const sheet = ss.getSheetByName(sheetName);
    const headers = SCHEMAS[entity];
    
    // 清除舊資料（保留表頭）
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    }
    
    // 寫入新資料
    const records = payload[entity];
    if (records.length > 0) {
      const rows = records.map(rec => headers.map(h => rec[h] || ''));
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    
    results[entity] = records.length + ' records synced';
  });
  
  return { data: results, message: 'Bulk sync complete' };
}

// ============ Utility ============
function generateId() {
  return new Date().getTime().toString(36) + Math.random().toString(36).substr(2, 6);
}
