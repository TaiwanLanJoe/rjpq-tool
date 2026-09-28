/**
 * 楓之谷 羅朱跳台協作工具 - 房間頁面邏輯
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

let roomData = Array(40).fill(CONFIG.EMPTY_COLOR);
let prevData = Array(40).fill(-1);
let selectedColor = -1; // 預設未選擇
let lastUpdatedAt = 0;
let isSaving = false;
let pollTimer = null;
const cells = [];

// ===== 初始化 =====
document.addEventListener("DOMContentLoaded", () => {
  // 顯示房號與密碼
  document.getElementById("roomCodeDisplay").textContent = roomCode;
  document.getElementById("roomPwdDisplay").textContent = roomPwd || "---";

  // 若未設定 Google Sheet 網址，顯示警告橫幅
  if (!Api.isConfigured()) {
    const banner = document.getElementById("demoNotice");
    if (banner) banner.style.display = "block";
  }

  // 初始化 10x4 格子
  initGrid();

  // 還原上次選擇的角色 (記憶功能)
  const savedChar = localStorage.getItem("rjpq_last_char");
  if (savedChar !== null && [0, 1, 2, 3].includes(parseInt(savedChar))) {
    selectCharacter(parseInt(savedChar));
  }

  // 初次同步資料並啟動輪詢
  fetchSync();
  startPolling();
});

// ===== 產生 10x4 平台網格 =====
function initGrid() {
  const container = document.getElementById("platforms");
  container.innerHTML = "";

  // 10 層，介面上第 10 層在最上面，第 1 層在最下面
  for (let row = 0; row < 10; row++) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "platform-row";

    // 層數標記 (10 ~ 1)
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

      cell.addEventListener("click", () => onCellClick(index));
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

  // 切換按鈕 active 樣式
  document.querySelectorAll(".char-btn").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.color) === colorIndex);
  });

  // 重新計算路徑與格子透明度
  renderPath();
  updateCellsDimmedState();
}

// ===== 點擊踏板格子 =====
let lastClickTime = 0;
const CLICK_COOLDOWN = 200;

async function onCellClick(index) {
  if (selectedColor === -1) {
    showToast("⚠️ 請先在上方選取您的角色 (101 ～ 104)！");
    return;
  }

  const now = Date.now();
  if (now - lastClickTime < CLICK_COOLDOWN) return;
  lastClickTime = now;

  // 1. 若點擊的是自己已標記的踏板 -> 取消標記
  if (roomData[index] === selectedColor) {
    roomData[index] = CONFIG.EMPTY_COLOR;
    updateCells();
    saveData();
    return;
  }

  // 2. 若該踏板已被其他隊友佔用 -> 不可覆蓋
  if (roomData[index] !== CONFIG.EMPTY_COLOR) {
    showToast("⚠️ 此踏板已被其他隊友標記！");
    return;
  }

  // 3. 樂觀更新：同層內同顏色互斥（一個人在一層只有一個正確踩點）
  const rowStart = Math.floor(index / 4) * 4;
  for (let i = rowStart; i < rowStart + 4; i++) {
    if (i !== index && roomData[i] === selectedColor) {
      roomData[i] = CONFIG.EMPTY_COLOR;
    }
  }

  roomData[index] = selectedColor;
  updateCells();
  saveData();
}

// ===== 儲存資料至後端 (Google Sheet) =====
async function saveData() {
  isSaving = true;
  updateStatus("syncing", "同步中");
  try {
    const res = await Api.updateGrid(roomCode, roomPwd, roomData);
    if (res && res.updatedAt) {
      lastUpdatedAt = res.updatedAt;
    }
    updateStatus("connected", "已同步");
  } catch (err) {
    console.error("儲存失敗:", err);
    updateStatus("disconnected", "同步失敗");
  } finally {
    isSaving = false;
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

// ===== 更新其他角色的半透明狀態 =====
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

  // 10 層預設為 '?'
  const path = new Array(10).fill("?");
  for (let i = 0; i < 40; i++) {
    if (roomData[i] === selectedColor) {
      const rowIndex = Math.floor(i / 4); // 0 (10層) 到 9 (1層)
      const colNum = (i % 4) + 1; // 踏板 1 ~ 4
      path[rowIndex] = colNum;
    }
  }

  // 反轉陣列，使第 1 層在最前面、第 10 層在最後面
  const fromLevel1To10 = path.slice().reverse();
  // 格式化為 5-5 分組，例如：14231 23412
  const formatted = fromLevel1To10.slice(0, 5).join("") + " " + fromLevel1To10.slice(5).join("");
  pathDisplay.textContent = formatted;
}

// ===== 輪詢同步資料 =====
async function fetchSync() {
  if (isSaving) return; // 若正在送出更新，先不覆寫

  try {
    const res = await Api.syncRoom(roomCode, roomPwd);

    if (res.error) {
      if (res.error === "密碼錯誤" || res.error === "房間不存在") {
        alert(res.error);
        window.location.href = "./";
        return;
      }
      updateStatus("disconnected", "連線異常");
      return;
    }

    if (res.success && Array.isArray(res.data)) {
      // 若遠端資料的時間戳較新，則更新本地
      if (!res.updatedAt || res.updatedAt > lastUpdatedAt) {
        roomData = res.data;
        if (res.updatedAt) lastUpdatedAt = res.updatedAt;
        updateCells();
      }
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

// ===== 重置所有跳台 =====
async function resetAllPlatforms() {
  if (!confirm("確定要清空全隊所有的跳台標記嗎？")) return;

  roomData = Array(40).fill(CONFIG.EMPTY_COLOR);
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
  }, 2200);
}
