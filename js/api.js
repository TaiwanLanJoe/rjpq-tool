/**
 * 楓之谷 羅朱跳台協作工具 - Google Sheet API 溝通模組
 */

const Api = {
  /**
   * 檢查是否有設定 GAS 網址
   */
  isConfigured() {
    return Boolean(CONFIG.GAS_API_URL && CONFIG.GAS_API_URL.trim().startsWith("http"));
  },

  /**
   * 建立房間
   */
  async createRoom(customPwd = "") {
    if (!this.isConfigured()) {
      // 離線 / 演示模式
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const pwd = customPwd || Math.floor(1000 + Math.random() * 9000).toString();
      localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify({
        pwd,
        data: Array(40).fill(CONFIG.EMPTY_COLOR),
        updatedAt: Date.now()
      }));
      return { success: true, code, password: pwd, isDemo: true };
    }

    try {
      let url = `${CONFIG.GAS_API_URL}?action=create`;
      if (customPwd) url += `&pwd=${encodeURIComponent(customPwd)}`;
      const res = await fetch(url, { method: "GET" });
      const data = await res.json();
      return data;
    } catch (err) {
      console.error("API createRoom Error:", err);
      throw new Error("建立房間失敗，請確認 Google Sheet Web App 網址與網路連線！");
    }
  },

  /**
   * 輪詢同步房間狀態
   */
  async syncRoom(code, pwd) {
    if (!this.isConfigured()) {
      // 離線 / 演示模式
      const saved = localStorage.getItem(`rjpq_demo_${code}`);
      if (!saved) {
        // 自動建立一個本機測試房間
        const init = { pwd: pwd || "1234", data: Array(40).fill(CONFIG.EMPTY_COLOR), updatedAt: Date.now() };
        localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(init));
        return { success: true, code, data: init.data, updatedAt: init.updatedAt, isDemo: true };
      }
      const parsed = JSON.parse(saved);
      if (pwd && parsed.pwd !== pwd) {
        return { error: "密碼錯誤" };
      }
      return { success: true, code, data: parsed.data, updatedAt: parsed.updatedAt, isDemo: true };
    }

    try {
      const url = `${CONFIG.GAS_API_URL}?action=sync&code=${encodeURIComponent(code)}&pwd=${encodeURIComponent(pwd || "")}`;
      const res = await fetch(url, { method: "GET" });
      const data = await res.json();
      return data;
    } catch (err) {
      console.warn("API syncRoom Warning:", err);
      return { error: "無法連線至 Google Sheet API" };
    }
  },

  /**
   * 更新 40 格跳台數據
   */
  async updateGrid(code, pwd, gridData) {
    if (!this.isConfigured()) {
      const saved = localStorage.getItem(`rjpq_demo_${code}`);
      const parsed = saved ? JSON.parse(saved) : { pwd: pwd || "" };
      parsed.data = gridData;
      parsed.updatedAt = Date.now();
      localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(parsed));
      return { success: true, updatedAt: parsed.updatedAt, isDemo: true };
    }

    try {
      // 優先使用 POST（Content-Type 設為 text/plain 避免觸發 OPTIONS CORS preflight）
      const payload = {
        action: "updateGrid",
        code: code,
        pwd: pwd,
        data: gridData
      };

      const res = await fetch(CONFIG.GAS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      return await res.json();
    } catch (err) {
      console.warn("POST 失敗，嘗試 GET 回退模式:", err);
      // 回退使用 GET (將數據轉為 JSON 字串傳輸)
      try {
        const url = `${CONFIG.GAS_API_URL}?action=update&code=${encodeURIComponent(code)}&data=${encodeURIComponent(JSON.stringify(gridData))}`;
        const res = await fetch(url, { method: "GET" });
        return await res.json();
      } catch (fallbackErr) {
        console.error("更新失敗:", fallbackErr);
        throw fallbackErr;
      }
    }
  },

  /**
   * 重置 40 格跳台
   */
  async resetGrid(code, pwd) {
    if (!this.isConfigured()) {
      const saved = localStorage.getItem(`rjpq_demo_${code}`);
      const parsed = saved ? JSON.parse(saved) : { pwd: pwd || "" };
      parsed.data = Array(40).fill(CONFIG.EMPTY_COLOR);
      parsed.updatedAt = Date.now();
      localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(parsed));
      return { success: true, updatedAt: parsed.updatedAt, isDemo: true };
    }

    try {
      const payload = { action: "reset", code: code, pwd: pwd };
      const res = await fetch(CONFIG.GAS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      return await res.json();
    } catch (err) {
      const url = `${CONFIG.GAS_API_URL}?action=reset&code=${encodeURIComponent(code)}`;
      const res = await fetch(url, { method: "GET" });
      return await res.json();
    }
  }
};
