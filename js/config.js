/**
 * 楓之谷 羅朱跳台協作工具 - 設定檔
 */

const CONFIG = {
  // 【重要】請將部署完成的 Google Apps Script「網頁應用程式網址」填在此處：
  // 例如: "https://script.google.com/macros/s/AKfycbx.../exec"
  GAS_API_URL: "https://script.google.com/macros/s/AKfycbwaC0WTwHW5hCbgc_6yE-Dct1_ItHxiOBNywKta78RKhue3PHzTGo8MBjbCul86jybyUQ/exec",

  // 輪詢間隔時間 (毫秒)，預設 1500ms (1.5秒)
  POLL_INTERVAL: 1500,

  // 角色定義 (0: 101紅, 1: 102綠, 2: 103藍, 3: 104紫)
  CHARACTERS: [
    { id: 0, label: "101", name: "紅 (101)", color: "#ff6b6b", glow: "rgba(255, 107, 107, 0.5)" },
    { id: 1, label: "102", name: "綠 (102)", color: "#51cf66", glow: "rgba(81, 207, 102, 0.5)" },
    { id: 2, label: "103", name: "藍 (103)", color: "#339af0", glow: "rgba(51, 154, 240, 0.5)" },
    { id: 3, label: "104", name: "紫 (104)", color: "#cc5de8", glow: "rgba(204, 93, 232, 0.5)" }
  ],

  // 空白格子的代表值
  EMPTY_COLOR: 4
};
