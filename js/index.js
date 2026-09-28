/**
 * 首頁邏輯
 */

document.addEventListener("DOMContentLoaded", () => {
  // 檢查是否設定了 Google Sheet
  if (!Api.isConfigured()) {
    const banner = document.getElementById("demoNotice");
    if (banner) banner.style.display = "block";
  }

  // 檢查是否有預填房號 (從 room.html 返回時)
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get("prefill");
  if (prefill) {
    const codeInput = document.getElementById("roomCodeInput");
    if (codeInput) {
      codeInput.value = prefill;
      document.getElementById("joinPwdInput").focus();
    }
  }

  // 綁定鍵盤 Enter 鍵
  document.getElementById("createPwdInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleCreateRoom();
  });
  document.getElementById("roomCodeInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") document.getElementById("joinPwdInput").focus();
  });
  document.getElementById("joinPwdInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleJoinRoom();
  });
});

/**
 * 建立房間
 */
async function handleCreateRoom() {
  const btn = document.getElementById("btnCreateRoom");
  const pwdInput = document.getElementById("createPwdInput");
  const customPwd = pwdInput.value.trim();

  btn.disabled = true;
  btn.innerHTML = `<span>⏳</span> <span>建立中...</span>`;

  try {
    const res = await Api.createRoom(customPwd);
    if (res.error) {
      showToast(res.error);
      resetBtn();
      return;
    }
    // 成功建立，跳轉到房間頁
    window.location.href = `room.html?code=${res.code}&pwd=${res.password}`;
  } catch (err) {
    showToast(err.message || "建立房間時發生錯誤");
    resetBtn();
  }

  function resetBtn() {
    btn.disabled = false;
    btn.innerHTML = `<span>✨</span> <span>建立新房間</span>`;
  }
}

/**
 * 加入房間
 */
function handleJoinRoom() {
  const code = document.getElementById("roomCodeInput").value.trim();
  const pwd = document.getElementById("joinPwdInput").value.trim();

  if (!code || !/^\d{6}$/.test(code)) {
    showToast("請輸入完整的 6 位數字房間代碼！");
    document.getElementById("roomCodeInput").focus();
    return;
  }

  if (!pwd) {
    showToast("請輸入 4 位房間密碼！");
    document.getElementById("joinPwdInput").focus();
    return;
  }

  window.location.href = `room.html?code=${encodeURIComponent(code)}&pwd=${encodeURIComponent(pwd)}`;
}

/**
 * 顯示快顯訊息
 */
function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) {
    alert(msg);
    return;
  }
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}
