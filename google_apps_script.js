/**
 * ==========================================================================
 * 楓之谷 羅朱跳台協作工具 (狗男女工具) - Google Apps Script 後端 (完全兼容新舊版)
 * ==========================================================================
 * 
 * 【特色優化】：
 * 1. 支援「舊房間無縫相容」：即使使用以前建立的舊房間，系統會自動將舊版 40 格格式平滑遷移為新版 4 軌獨立格式！
 * 2. 徹底分離 4 位玩家的資料 (P0/101, P1/102, P2/103, P3/104 獨立欄位)，徹底解決多人點擊格子互相覆蓋消失問題！
 * 3. 引入 LockService（檔案鎖）與 CacheService（高速快取），大幅降低延遲！
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
      }), 21600);

      return createJsonResponse({ success: true, code: code, password: pwd });
    }

    // 2. 輪詢同步資料 (優先從快取讀取，並計算在線心跳人數)
    if (action === "sync") {
      const code = (params.code || "").toString().trim();
      const pwd = (params.pwd || "").toString().trim();
      const clientId = (params.clientId || "").toString().trim();
      const color = params.color !== undefined ? parseInt(params.color) : -1;

      if (!code) return createJsonResponse({ error: "缺少房間代碼" });

      const cache = CacheService.getScriptCache();
      const presenceInfo = computePresence(cache, code, clientId, color);

      const cached = cache.get("room_" + code);
      if (cached) {
        const parsed = JSON.parse(cached);
        return createJsonResponse({
          success: true,
          code: code,
          players: [parsed.p0, parsed.p1, parsed.p2, parsed.p3],
          updatedAt: parsed.updatedAt,
          count: presenceInfo.count,
          charCounts: presenceInfo.charCounts
        });
      }

      // 快取未命中，從試算表讀取並自動相容舊版結構
      const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"]);
      ensureGridSheetHeaders(gridSheet);
      const gridRows = gridSheet.getDataRange().getValues();

      for (let i = 1; i < gridRows.length; i++) {
        if (gridRows[i][0].toString() === code) {
          const rowData = parseAndMigrateRow(gridSheet, i + 1, gridRows[i]);
          cache.put("room_" + code, JSON.stringify(rowData), 21600);

          return createJsonResponse({
            success: true,
            code: code,
            players: [rowData.p0, rowData.p1, rowData.p2, rowData.p3],
            updatedAt: rowData.updatedAt,
            count: presenceInfo.count,
            charCounts: presenceInfo.charCounts
          });
        }
      }

      return createJsonResponse({ error: "房間不存在" });
    }

    // 3. GET 模式更新
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
 * 處理 POST 請求
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
 * 核心：僅更新特定玩家的 10 層路徑
 */
function handlePlayerUpdate(ss, code, color, path) {
  if (!code || color < 0 || color > 3 || !Array.isArray(path) || path.length !== 10) {
    return createJsonResponse({ error: "資料格式錯誤" });
  }

  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) {}

  try {
    const timestamp = Date.now();
    const cache = CacheService.getScriptCache();
    let currentData = { p0: Array(10).fill(-1), p1: Array(10).fill(-1), p2: Array(10).fill(-1), p3: Array(10).fill(-1) };

    const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"]);
    ensureGridSheetHeaders(gridSheet);
    const gridRows = gridSheet.getDataRange().getValues();

    for (let i = 1; i < gridRows.length; i++) {
      if (gridRows[i][0].toString() === code) {
        // 先確保舊資料若為 40 格，無痛遷移為 4 軌
        currentData = parseAndMigrateRow(gridSheet, i + 1, gridRows[i]);

        // 只更新該位玩家的踏板資料
        currentData["p" + color] = path;
        currentData.updatedAt = timestamp;
        cache.put("room_" + code, JSON.stringify(currentData), 21600);

        // 寫入試算表
        const colIndex = color + 2; // P0 是第 2 欄 (B), P1 是第 3 欄 (C)...
        gridSheet.getRange(i + 1, colIndex).setValue(JSON.stringify(path));
        gridSheet.getRange(i + 1, 6).setValue(timestamp);

        return createJsonResponse({ success: true, color: color, updatedAt: timestamp });
      }
    }

    // 若原表未找到該房間列，新建該列
    const p0 = color === 0 ? path : Array(10).fill(-1);
    const p1 = color === 1 ? path : Array(10).fill(-1);
    const p2 = color === 2 ? path : Array(10).fill(-1);
    const p3 = color === 3 ? path : Array(10).fill(-1);

    gridSheet.appendRow([code, JSON.stringify(p0), JSON.stringify(p1), JSON.stringify(p2), JSON.stringify(p3), timestamp]);
    cache.put("room_" + code, JSON.stringify({ p0, p1, p2, p3, updatedAt: timestamp }), 21600);

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
    ensureGridSheetHeaders(gridSheet);
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

/**
 * 自動相容舊版結構：若讀取到舊版 40 格數據，自動拆解成 4 軌並更新到試算表
 */
function parseAndMigrateRow(gridSheet, rowIndex, rowData) {
  const rawCol1 = safeJsonParse(rowData[1], null);

  // 判斷是否為舊版 40 格格式
  if (Array.isArray(rawCol1) && rawCol1.length === 40) {
    const p0 = Array(10).fill(-1);
    const p1 = Array(10).fill(-1);
    const p2 = Array(10).fill(-1);
    const p3 = Array(10).fill(-1);

    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 4; col++) {
        const val = rawCol1[row * 4 + col];
        if (val === 0) p0[row] = col;
        else if (val === 1) p1[row] = col;
        else if (val === 2) p2[row] = col;
        else if (val === 3) p3[row] = col;
      }
    }

    const timestamp = Date.now();
    // 自動將舊資料轉換成新欄位格式寫回
    gridSheet.getRange(rowIndex, 2, 1, 4).setValues([[
      JSON.stringify(p0),
      JSON.stringify(p1),
      JSON.stringify(p2),
      JSON.stringify(p3)
    ]]);
    gridSheet.getRange(rowIndex, 6).setValue(timestamp);

    return { p0, p1, p2, p3, updatedAt: timestamp };
  }

  // 已經是新版獨立欄位格式
  const p0 = safeJsonParse(rowData[1], Array(10).fill(-1));
  const p1 = safeJsonParse(rowData[2], Array(10).fill(-1));
  const p2 = safeJsonParse(rowData[3], Array(10).fill(-1));
  const p3 = safeJsonParse(rowData[4], Array(10).fill(-1));
  const updatedAt = rowData[5] || Date.now();

  return { p0, p1, p2, p3, updatedAt };
}

/**
 * 確保 GridData 標題包含 6 個標準欄位
 */
function ensureGridSheetHeaders(sheet) {
  const headers = ["RoomCode", "P0", "P1", "P2", "P3", "UpdatedAt"];
  const currentHeaders = sheet.getRange(1, 1, 1, 6).getValues()[0];
  if (currentHeaders[1] !== "P0" || currentHeaders[2] !== "P1") {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
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

/**
 * 計算房間在線人數與各角色被選次數 (基於 6 秒心跳快取)
 */
function computePresence(cache, code, clientId, color) {
  const presenceKey = "pres_" + code;
  let presence = {};
  const cached = cache.get(presenceKey);
  if (cached) {
    try { presence = JSON.parse(cached); } catch (e) {}
  }

  const now = Date.now();
  if (clientId) {
    presence[clientId] = { t: now, c: parseInt(color) };
  }

  let count = 0;
  const charCounts = [0, 0, 0, 0];
  const active = {};

  for (const id in presence) {
    const item = presence[id];
    // 6 秒內有心跳則判定在線
    if (now - item.t <= 6000) {
      active[id] = item;
      count++;
      if (item.c >= 0 && item.c <= 3) {
        charCounts[item.c]++;
      }
    }
  }

  // 存回快取，存活 60 秒
  cache.put(presenceKey, JSON.stringify(active), 60);
  return { count: Math.max(count, 1), charCounts: charCounts };
}
