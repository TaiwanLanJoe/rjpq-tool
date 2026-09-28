/**
 * ==========================================================================
 * 楓之谷 羅朱跳台協作工具 (狗男女工具) - Google Apps Script 後端
 * ==========================================================================
 * 
 * 【使用步驟】：
 * 1. 在 Google 雲端硬碟建立一個新的「Google 試算表」。
 * 2. 點選試算表頂部選單「擴充功能」 -> 「Apps Script」。
 * 3. 刪除原有所有程式碼，將本檔案內容全部複製貼上進去。
 * 4. 點選右上角藍色「部署」按鈕 -> 選擇「新增部署作業」。
 * 5. 點選齒輪圖示 ⚙️，選擇類型為「網頁應用程式 (Web App)」：
 *    - 說明：跳台工具API
 *    - 執行身分：我 (您的 Google 帳號)
 *    - 誰可以存取：任何人 (Anyone)  <--- 【非常重要！否則前端無法免登入讀寫】
 * 6. 點選「部署」，並授予必要的權限（若跳出未經驗證警告，點選進階 -> 前往專案）。
 * 7. 複製產生的「網頁應用程式網址 (Web App URL)」，貼到前端的 `js/config.js` 中的 `GAS_API_URL`。
 */

const SHEET_ROOMS = "Rooms";
const SHEET_GRID = "GridData";

// 初始化試算表標題與結構
function initSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet(ss, SHEET_ROOMS, ["RoomCode", "Password", "CreatedAt", "LastActive"]);
  getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "GridState", "UpdatedAt"]);
}

/**
 * 處理 GET 請求
 * 支援操作：
 * - action=create&pwd=XXXX            建立房間
 * - action=sync&code=XXXXXX&pwd=XXXX  取得最新跳台資料
 * - action=ping                       測試連線
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 0. 連線測試
    if (action === "ping") {
      return createJsonResponse({ status: "ok", message: "Google Sheet API 連線正常！", timestamp: Date.now() });
    }

    // 1. 建立房間
    if (action === "create") {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const pwd = params.pwd ? params.pwd.toString().trim() : Math.floor(1000 + Math.random() * 9000).toString();
      const now = new Date();
      const nowIso = Utilities.formatDate(now, "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");

      const roomSheet = getOrCreateSheet(ss, SHEET_ROOMS, ["RoomCode", "Password", "CreatedAt", "LastActive"]);
      roomSheet.appendRow([code, pwd, nowIso, nowIso]);

      // 初始化 40 格，4 代表空白 (0: 101紅, 1: 102綠, 2: 103藍, 3: 104紫, 4: 空白)
      const initialGrid = Array(40).fill(4);
      const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "GridState", "UpdatedAt"]);
      gridSheet.appendRow([code, JSON.stringify(initialGrid), Date.now()]);

      return createJsonResponse({
        success: true,
        code: code,
        password: pwd
      });
    }

    // 2. 輪詢同步資料
    if (action === "sync") {
      const code = (params.code || "").toString().trim();
      const pwd = (params.pwd || "").toString().trim();

      if (!code) {
        return createJsonResponse({ error: "缺少房間代碼" });
      }

      // 驗證房間與密碼
      const roomSheet = getOrCreateSheet(ss, SHEET_ROOMS, ["RoomCode", "Password", "CreatedAt", "LastActive"]);
      const roomData = roomSheet.getDataRange().getValues();
      let roomFound = false;

      for (let i = 1; i < roomData.length; i++) {
        if (roomData[i][0].toString() === code) {
          if (pwd && roomData[i][1].toString() !== pwd) {
            return createJsonResponse({ error: "密碼錯誤" });
          }
          roomFound = true;
          break;
        }
      }

      if (!roomFound) {
        return createJsonResponse({ error: "房間不存在" });
      }

      // 讀取格子資料
      const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "GridState", "UpdatedAt"]);
      const gridRows = gridSheet.getDataRange().getValues();

      for (let i = 1; i < gridRows.length; i++) {
        if (gridRows[i][0].toString() === code) {
          let gridArray;
          try {
            gridArray = JSON.parse(gridRows[i][1]);
          } catch (parseErr) {
            gridArray = Array(40).fill(4);
          }
          return createJsonResponse({
            success: true,
            code: code,
            data: gridArray,
            updatedAt: gridRows[i][2] || 0
          });
        }
      }

      return createJsonResponse({ error: "尚未找到跳台數據" });
    }

    // 3. 也支援透過 GET 提交更新（避免部分瀏覽器或環境的 POST CORS 限制）
    if (action === "update" || action === "reset") {
      const code = (params.code || "").toString().trim();
      const newGrid = action === "reset" ? Array(40).fill(4) : JSON.parse(params.data || "[]");
      return handleGridUpdate(ss, code, newGrid);
    }

    return createJsonResponse({ error: "未知的 action 請求" });

  } catch (err) {
    return createJsonResponse({ error: "伺服器內部錯誤: " + err.toString() });
  }
}

/**
 * 處理 POST 請求 (更新跳台或重置)
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

    if (action === "reset") {
      const emptyGrid = Array(40).fill(4);
      return handleGridUpdate(ss, code, emptyGrid);
    }

    if (action === "updateGrid") {
      const gridData = Array.isArray(body.data) ? body.data : JSON.parse(body.data || "[]");
      return handleGridUpdate(ss, code, gridData);
    }

    return createJsonResponse({ error: "未知的 POST action" });

  } catch (err) {
    return createJsonResponse({ error: "POST 處理失敗: " + err.toString() });
  }
}

/**
 * 更新指定房間的 40 格狀態
 */
function handleGridUpdate(ss, code, gridArray) {
  if (!code || !Array.isArray(gridArray) || gridArray.length !== 40) {
    return createJsonResponse({ error: "傳入的格子資料格式不正確" });
  }

  const gridSheet = getOrCreateSheet(ss, SHEET_GRID, ["RoomCode", "GridState", "UpdatedAt"]);
  const gridRows = gridSheet.getDataRange().getValues();
  const timestamp = Date.now();

  for (let i = 1; i < gridRows.length; i++) {
    if (gridRows[i][0].toString() === code) {
      // 找到房間列，更新 GridState (欄 2) 與 UpdatedAt (欄 3)
      gridSheet.getRange(i + 1, 2).setValue(JSON.stringify(gridArray));
      gridSheet.getRange(i + 1, 3).setValue(timestamp);

      // 同時更新 Rooms 工作表的最後活動時間
      updateRoomLastActive(ss, code);

      return createJsonResponse({
        success: true,
        code: code,
        updatedAt: timestamp
      });
    }
  }

  // 若沒找到，追加新的一列
  gridSheet.appendRow([code, JSON.stringify(gridArray), timestamp]);
  return createJsonResponse({ success: true, code: code, updatedAt: timestamp });
}

/**
 * 更新房間最後活躍時間
 */
function updateRoomLastActive(ss, code) {
  try {
    const roomSheet = ss.getSheetByName(SHEET_ROOMS);
    if (!roomSheet) return;
    const roomRows = roomSheet.getDataRange().getValues();
    const nowIso = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    for (let i = 1; i < roomRows.length; i++) {
      if (roomRows[i][0].toString() === code) {
        roomSheet.getRange(i + 1, 4).setValue(nowIso);
        break;
      }
    }
  } catch (e) {
    // 忽略時間更新的非關鍵錯誤
  }
}

/**
 * 取得或自動建立工作表
 */
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

/**
 * 回傳 JSON 給前端
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
