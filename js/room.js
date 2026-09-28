/**
 * 楓之谷 羅朱跳台協作工具 - 房間頁面邏輯 (獨立分軌防覆蓋版)
 */

// ===== 狀態變數 =====
const urlParams = new URLSearchParams(window.location.search);
const roomCode = urlParams.get("code");
const roomPwd = urlParams.get("pwd");

// 檢查房間代碼與密碼，若不合法則返回首頁
if (!roomCode || !/^\d{6}$/.test(roomCode) || !roomPwd) {
  const back = roomCode ? `./?prefill=${encodeURIComponent(roomCode)}` : "./";
  window.location.href = back;
}

// 客戶端唯一 ID (用於統計在線人數與心跳)
let myClientId = sessionStorage.getItem("rjpq_client_id");
if (!myClientId) {
  myClientId = "c_" + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  sessionStorage.setItem("rjpq_client_id", myClientId);
}

// 4 位玩家的獨立 10 層踩踏資料 (0: 101紅, 1: 102綠, 2: 103藍, 3: 104紫)
// 陣列值為 0~3 (代表踏板 1~4) 或 -1 (未踩)
let players = [
  Array(10).fill(-1),
  Array(10).fill(-1),
  Array(10).fill(-1),
  Array(10).fill(-1)
];

let roomData = Array(40).fill(CONFIG.EMPTY_COLOR);
let prevData = Array(40).fill(-1);
let selectedColor = -1; // 當前選取的角色編號 (0~3)
let lastCharCounts = [0, 0, 0, 0];
let isSaving = false;
let pollTimer = null;
const cells = [];

// ===== 初始化 =====
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("roomCodeDisplay").textContent = roomCode;
  document.getElementById("roomPwdDisplay").textContent = roomPwd || "---";

  if (!Api.isConfigured()) {
    const banner = document.getElementById("demoNotice");
    if (banner) banner.style.display = "block";
  }

  initGrid();

  // 還原上次選擇的角色
  const savedChar = localStorage.getItem("rjpq_last_char");
  if (savedChar !== null && [0, 1, 2, 3].includes(parseInt(savedChar))) {
    selectCharacter(parseInt(savedChar));
  }

  fetchSync();
  startPolling();
});

// ===== 產生 10x4 平台網格 =====
function initGrid() {
  const container = document.getElementById("platforms");
  container.innerHTML = "";

  for (let row = 0; row < 10; row++) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "platform-row";

    // 層數 (10 ~ 1)
    const rowNum = document.createElement("div");
    rowNum.className = "row-num";
    rowNum.textContent = 10 - row;
    rowDiv.appendChild(rowNum);

    // 4 個踩踏踏板 (1, 2, 3, 4)
    for (let col = 0; col < 4; col++) {
      const index = row * 4 + col;
      const cell = document.createElement("div");
      cell.className = "platform-cell";
      cell.textContent = col + 1;
      cell.dataset.index = index;

      cell.addEventListener("click", () => onCellClick(row, col, index));
      rowDiv.appendChild(cell);
      cells[index] = cell;
    }

    container.appendChild(rowDiv);
  }
}

// ===== 選擇角色 =====
function selectCharacter(colorIndex) {
  selectedColor = colorIndex;
  localStorage.setItem("rjpq_last_char", colorIndex);

  document.querySelectorAll(".char-btn").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.color) === colorIndex);
  });

  renderPath();
  updateCellsDimmedState();
  if (lastCharCounts) updateBadges(lastCharCounts);
  fetchSync(); // 切換角色時立即送出心跳通知
}

// ===== 更新角色按鈕上方在線標籤 (me 或 人數) =====
function updateBadges(counts) {
  for (let i = 0; i < 4; i++) {
    const badge = document.getElementById("badge" + i);
    if (!badge) continue;
    const count = counts[i] || 0;
    if (count === 0) {
      badge.style.visibility = "hidden";
    } else if (count === 1 && selectedColor === i) {
      badge.textContent = "me";
      badge.style.visibility = "visible";
    } else {
      badge.textContent = count;
      badge.style.visibility = "visible";
    }
  }
}

// ===== 點擊踏板格子 =====
function onCellClick(row, col, index) {
  if (selectedColor === -1) {
    showToast("⚠️ 請先在上方選取您的角色 (101 ～ 104)！");
    return;
  }

  const currentMarkedCol = players[selectedColor][row];

  // 1. 若點擊的是自己已踩的踏板 -> 取消標記
  if (currentMarkedCol === col) {
    players[selectedColor][row] = -1;
  } else {
    // 2. 檢查此踏板是否被「其他隊友」佔用
    for (let c = 0; c < 4; c++) {
      if (c !== selectedColor && players[c][row] === col) {
        showToast("⚠️ 此踏板已被其他隊友標記！");
        return;
      }
    }
    // 3. 標記為自己的踏板 (同層自動互斥換位)
    players[selectedColor][row] = col;
  }

  // 本機立即 0 延遲更新畫面（點再快都即時變色）
  syncGridFromPlayers();
  updateCells();

  // 觸發防抖佇列上傳（多次快速連點會合併為 1 次最新狀態上傳，防止網路亂序與重複請求）
  scheduleSaveMyPath();
}

// ===== 防抖與佇列上傳機制 (解決快速點擊覆蓋/消失的核心) =====
let saveDebounceTimer = null;
let isUploading = false;
let hasPendingSave = false;

function scheduleSaveMyPath() {
  hasPendingSave = true;
  updateStatus("syncing", "同步中");

  // 清除前一次防抖計時器
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }

  // 400ms 防抖：連續快速點擊時等待停頓，一口氣打包最新結果上傳至 Google Sheet
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    executeSaveMyPath();
  }, 400);
}

async function executeSaveMyPath() {
  if (isUploading) {
    // 若當前有請求正在傳輸中，標記 pending 等它完成後立即發送最新版
    hasPendingSave = true;
    return;
  }

  if (!hasPendingSave || selectedColor === -1) return;

  isUploading = true;
  hasPendingSave = false;
  isSaving = true; // 告知背景輪詢切勿覆蓋本地狀態

  try {
    const myPathSnapshot = [...players[selectedColor]];
    await Api.updatePlayer(roomCode, roomPwd, selectedColor, myPathSnapshot);
    updateStatus("connected", "已同步");
  } catch (err) {
    console.error("儲存失敗:", err);
    updateStatus("disconnected", "同步失敗");
    hasPendingSave = true;
  } finally {
    isUploading = false;
    isSaving = false;
    // 如果剛才上傳期間又有新的點擊，立刻觸發下一輪最新上傳
    if (hasPendingSave) {
      scheduleSaveMyPath();
    }
  }
}

// ===== 將 4 位玩家的獨立路徑合成 40 格矩陣 =====
function syncGridFromPlayers() {
  roomData = Array(40).fill(CONFIG.EMPTY_COLOR);
  for (let c = 0; c < 4; c++) {
    const path = players[c];
    if (Array.isArray(path)) {
      for (let row = 0; row < 10; row++) {
        const col = path[row];
        if (col >= 0 && col < 4) {
          roomData[row * 4 + col] = c;
        }
      }
    }
  }
}

// ===== 差量更新格子 UI =====
function updateCells() {
  for (let i = 0; i < 40; i++) {
    const cell = cells[i];
    if (!cell) continue;

    const val = roomData[i];
    const changed = roomData[i] !== prevData[i];

    if (changed) {
      if (val !== CONFIG.EMPTY_COLOR && CONFIG.CHARACTERS[val]) {
        const charInfo = CONFIG.CHARACTERS[val];
        cell.style.backgroundColor = charInfo.color;
        cell.style.boxShadow = `0 0 12px ${charInfo.glow}, inset 0 0 8px ${charInfo.glow}`;
        cell.classList.add("marked");
      } else {
        cell.style.backgroundColor = "";
        cell.style.boxShadow = "";
        cell.classList.remove("marked");
      }
    }
  }

  updateCellsDimmedState();
  prevData = [...roomData];
  renderPath();
}

// ===== 更新半透明狀態 =====
function updateCellsDimmedState() {
  for (let i = 0; i < 40; i++) {
    const cell = cells[i];
    if (!cell) continue;
    const val = roomData[i];

    if (val !== CONFIG.EMPTY_COLOR && selectedColor !== -1 && val !== selectedColor) {
      cell.classList.add("dimmed");
    } else {
      cell.classList.remove("dimmed");
    }
  }
}

// ===== 計算並呈現目前角色的踏板路徑 =====
function renderPath() {
  const pathDisplay = document.getElementById("pathDisplay");
  if (selectedColor === -1) {
    pathDisplay.textContent = "請選角色";
    return;
  }

  const myPath = players[selectedColor]; // 10 層 (row 0 是 10 層，row 9 是 1 層)
  const displayArr = new Array(10).fill("?");

  for (let row = 0; row < 10; row++) {
    if (myPath[row] >= 0) {
      displayArr[row] = (myPath[row] + 1); // 踏板 1~4
    }
  }

  // 反轉：使第 1 層在左，第 10 層在右
  const reversed = displayArr.slice().reverse();
  const formatted = reversed.slice(0, 5).join("") + " " + reversed.slice(5).join("");
  pathDisplay.textContent = formatted;
}

// ===== 輪詢同步資料 =====
async function fetchSync() {
  try {
    const res = await Api.syncRoom(roomCode, roomPwd, myClientId, selectedColor);

    if (res.error) {
      if (res.error === "密碼錯誤" || res.error === "房間不存在") {
        alert(res.error);
        window.location.href = "./";
        return;
      }
      updateStatus("disconnected", "連線異常");
      return;
    }

    // 更新在線人數
    if (typeof res.count === "number") {
      const countEl = document.getElementById("countNum");
      if (countEl) countEl.textContent = res.count;
    }

    // 更新角色頭像上的徽章 (me / 人數)
    if (Array.isArray(res.charCounts)) {
      lastCharCounts = res.charCounts;
      updateBadges(res.charCounts);
    }

    if (res.success && Array.isArray(res.players)) {
      // 合併 4 位玩家資料
      for (let c = 0; c < 4; c++) {
        // 【核心防消失關鍵】：如果自己正在點擊、等待防抖、或正在上傳中，絕對不讓舊的伺服器資料覆寫自己！
        if (c === selectedColor && (isSaving || isUploading || hasPendingSave || saveDebounceTimer)) {
          continue;
        }
        if (Array.isArray(res.players[c])) {
          players[c] = res.players[c];
        }
      }

      syncGridFromPlayers();
      updateCells();
      updateStatus("connected", "已同步");
    }
  } catch (err) {
    console.warn("同步失敗:", err);
    updateStatus("disconnected", "離線");
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchSync, CONFIG.POLL_INTERVAL || 1500);
}

// ===== 重置所有踏板 =====
async function resetAllPlatforms() {
  if (!confirm("確定要清空全隊所有的跳台標記嗎？")) return;

  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  hasPendingSave = false;

  players = [
    Array(10).fill(-1),
    Array(10).fill(-1),
    Array(10).fill(-1),
    Array(10).fill(-1)
  ];
  syncGridFromPlayers();
  updateCells();
  updateStatus("syncing", "重置中");

  try {
    await Api.resetGrid(roomCode, roomPwd);
    updateStatus("connected", "已重置");
    showToast("✨ 踏板已全部重置！");
  } catch (err) {
    showToast("重置失敗，請檢查網路連線");
  }
}

// ===== 複製房間資訊 =====
function copyRoomInfo() {
  const fullUrl = window.location.href;
  const copyText = `【楓之谷 羅朱跳台協作】\n房間代碼：${roomCode}\n密碼：${roomPwd}\n直接加入連結：${fullUrl}`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(copyText).then(() => {
      showCopySuccess();
    }).catch(() => fallbackCopy(copyText));
  } else {
    fallbackCopy(copyText);
  }
}

function showCopySuccess() {
  const btn = document.querySelector(".copy-btn");
  btn.textContent = "✅";
  showToast("📋 房間資訊與連結已複製到剪貼簿！");
  setTimeout(() => { btn.textContent = "📋"; }, 1500);
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
    showCopySuccess();
  } catch (err) {
    prompt("請手動複製以下資訊：", text);
  }
  document.body.removeChild(textarea);
}

// ===== 更新狀態指示燈 =====
function updateStatus(state, text) {
  const el = document.getElementById("statusIndicator");
  const txt = document.getElementById("statusText");
  if (!el) return;

  el.className = `status-indicator ${state}`;
  if (txt && text) txt.textContent = text;
}

// ===== 顯示 Toast 訊息 =====
function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}
