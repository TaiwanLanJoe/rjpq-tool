/**
 * ==========================================================================
 * 楓之谷 羅朱跳台協作工具 (狗男女工具) - Google Apps Script 後端 (獨立分軌版)
 * ==========================================================================
 * 
 * 【特色優化】：
 * 1. 徹底分離 4 位玩家的資料 (P0/101, P1/102, P2/103, P3/104 獨立欄位)，徹底解決多人同時點擊覆蓋、格子消失的問題！
 * 2. 引入 LockService（檔案鎖），避免同時寫入衝突。
 * 3. 引入 CacheService（高速快取），大幅降低 LAG 延遲！
 */

const SHEET_ROOMS = "Rooms";
const SHEET_GRID = "GridData";

/**
 * 處理 GET 請求
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 0. 連線測試
    if (action === "ping") {
      return createJsonResponse({ status: "ok", timestamp: Date.now() });
    }

    // 1. 建立房間
    if (action === "create") {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const pwd = params.pwd ? params.pwd.toString().trim() : Math.floor(1000 + Math.random() * 9000).toString();
      const nowIso = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

      const roomSheet = getOrCreateSheet(ss, SHEET_ROOMS, ["RoomCode", "Password", "CreatedAt", "LastActive"]);
      roomSheet.appendRow([code, pwd, nowIso, nowIso]);

      // 初始化 4 位玩家的獨立 10 層數據（-1 代表未踩）
      const emptyPath = JSON.stringify(Array(10).fill(-1));
      const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"]);
      const timestamp = Date.now();
      gridSheet.appendRow([code, emptyPath, emptyPath, emptyPath, emptyPath, timestamp]);

      // 寫入快取
      const cache = CacheService.getScriptCache();
      cache.put("room_" + code, JSON.stringify({
        p0: Array(10).fill(-1),
        p1: Array(10).fill(-1),
        p2: Array(10).fill(-1),
        p3: Array(10).fill(-1),
        updatedAt: timestamp
      }), 21600); // 6 小時

      return createJsonResponse({ success: true, code: code, password: pwd });
    }

    // 2. 輪詢同步資料 (優先從快取讀取，極速響應)
    if (action === "sync") {
      const code = (params.code || "").toString().trim();
      const pwd = (params.pwd || "").toString().trim();

      if (!code) return createJsonResponse({ error: "缺少房間代碼" });

      const cache = CacheService.getScriptCache();
      const cached = cache.get("room_" + code);
      if (cached) {
        const parsed = JSON.parse(cached);
        return createJsonResponse({
          success: true,
          code: code,
          players: [parsed.p0, parsed.p1, parsed.p2, parsed.p3],
          updatedAt: parsed.updatedAt
        });
      }

      // 快取未命中，從試算表讀取
      const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"]);
      const gridRows = gridSheet.getDataRange().getValues();

      for (let i = 1; i < gridRows.length; i++) {
        if (gridRows[i][0].toString() === code) {
          const p0 = safeJsonParse(gridRows[i][1], Array(10).fill(-1));
          const p1 = safeJsonParse(gridRows[i][2], Array(10).fill(-1));
          const p2 = safeJsonParse(gridRows[i][3], Array(10).fill(-1));
          const p3 = safeJsonParse(gridRows[i][4], Array(10).fill(-1));
          const updatedAt = gridRows[i][5] || Date.now();

          // 寫回快取
          cache.put("room_" + code, JSON.stringify({ p0, p1, p2, p3, updatedAt }), 21600);

          return createJsonResponse({
            success: true,
            code: code,
            players: [p0, p1, p2, p3],
            updatedAt: updatedAt
          });
        }
      }

      return createJsonResponse({ error: "房間不存在" });
    }

    // 3. GET 模式更新 (若前端使用 GET 回退)
    if (action === "updatePlayer") {
      const code = (params.code || "").toString().trim();
      const color = parseInt(params.color);
      const path = safeJsonParse(params.path, []);
      return handlePlayerUpdate(ss, code, color, path);
    }

    if (action === "reset") {
      const code = (params.code || "").toString().trim();
      return handleReset(ss, code);
    }

    return createJsonResponse({ error: "未知的 action" });

  } catch (err) {
    return createJsonResponse({ error: "伺服器錯誤: " + err.toString() });
  }
}

/**
 * 處理 POST 請求 (避免 CORS preflight)
 */
function doPost(e) {
  try {
    let body = {};
    if (e && e.postData && e.postData.contents) {
      try {
        body = JSON.parse(e.postData.contents);
      } catch (e) {
        body = e.parameter || {};
      }
    } else if (e && e.parameter) {
      body = e.parameter;
    }

    const action = body.action;
    const code = (body.code || "").toString().trim();
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === "updatePlayer") {
      const color = parseInt(body.color);
      const path = Array.isArray(body.path) ? body.path : safeJsonParse(body.path, []);
      return handlePlayerUpdate(ss, code, color, path);
    }

    if (action === "reset") {
      return handleReset(ss, code);
    }

    return createJsonResponse({ error: "未知的 POST action" });

  } catch (err) {
    return createJsonResponse({ error: "POST 失敗: " + err.toString() });
  }
}

/**
 * 核心：僅更新特定玩家的 10 層路徑 (獨立分軌，互不覆蓋！)
 */
function handlePlayerUpdate(ss, code, color, path) {
  if (!code || color < 0 || color > 3 || !Array.isArray(path) || path.length !== 10) {
    return createJsonResponse({ error: "資料格式錯誤" });
  }

  // 取得腳本鎖，避免同微秒並發寫入試算表衝突
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    // 逾時直接繼續
  }

  try {
    const timestamp = Date.now();
    const cache = CacheService.getScriptCache();
    let currentData = { p0: Array(10).fill(-1), p1: Array(10).fill(-1), p2: Array(10).fill(-1), p3: Array(10).fill(-1) };

    const cached = cache.get("room_" + code);
    if (cached) {
      currentData = JSON.parse(cached);
    }

    // 只修改該角色對應的數據！
    currentData["p" + color] = path;
    currentData.updatedAt = timestamp;
    cache.put("room_" + code, JSON.stringify(currentData), 21600);

    // 同步寫入 Google Sheet
    const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"]);
    const gridRows = gridSheet.getDataRange().getValues();
    const colIndex = color + 2; // P0 是第 2 欄 (B), P1 是第 3 欄 (C)...

    for (let i = 1; i < gridRows.length; i++) {
      if (gridRows[i][0].toString() === code) {
        gridSheet.getRange(i + 1, colIndex).setValue(JSON.stringify(path));
        gridSheet.getRange(i + 1, 6).setValue(timestamp); // UpdatedAt
        return createJsonResponse({ success: true, color: color, updatedAt: timestamp });
      }
    }

    // 若原表沒有，新增一列
    gridSheet.appendRow([code,
      color === 0 ? JSON.stringify(path) : JSON.stringify(Array(10).fill(-1)),
      color === 1 ? JSON.stringify(path) : JSON.stringify(Array(10).fill(-1)),
      color === 2 ? JSON.stringify(path) : JSON.stringify(Array(10).fill(-1)),
      color === 3 ? JSON.stringify(path) : JSON.stringify(Array(10).fill(-1)),
      timestamp
    ]);

    return createJsonResponse({ success: true, color: color, updatedAt: timestamp });

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * 重置指定房間的所有玩家數據
 */
function handleReset(ss, code) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) {}

  try {
    const timestamp = Date.now();
    const empty = Array(10).fill(-1);
    const emptyJson = JSON.stringify(empty);

    const cache = CacheService.getScriptCache();
    cache.put("room_" + code, JSON.stringify({ p0: empty, p1: empty, p2: empty, p3: empty, updatedAt: timestamp }), 21600);

    const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"]);
    const gridRows = gridSheet.getDataRange().getValues();

    for (let i = 1; i < gridRows.length; i++) {
      if (gridRows[i][0].toString() === code) {
        gridSheet.getRange(i + 1, 2, 1, 4).setValues([[emptyJson, emptyJson, emptyJson, emptyJson]]);
        gridSheet.getRange(i + 1, 6).setValue(timestamp);
        return createJsonResponse({ success: true, updatedAt: timestamp });
      }
    }

    return createJsonResponse({ success: true, updatedAt: timestamp });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function safeJsonParse(str, defaultVal) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return defaultVal;
  }
}

function getOrCreateSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }
  return sheet;
}

function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
