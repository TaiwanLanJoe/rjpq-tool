/**
 * 楓之谷 羅朱跳台協作工具 - Google Sheet API 溝通模組 (獨立分軌版)
 */

const Api = {
  isConfigured() {
    return Boolean(CONFIG.GAS_API_URL && CONFIG.GAS_API_URL.trim().startsWith("http"));
  },

  /**
   * 建立房間
   */
  async createRoom(customPwd = "") {
    if (!this.isConfigured()) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const pwd = customPwd || Math.floor(1000 + Math.random() * 9000).toString();
      const initData = {
        pwd,
        players: [Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1)],
        updatedAt: Date.now()
      };
      localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(initData));
      return { success: true, code, password: pwd, isDemo: true };
    }

    try {
      let url = `${CONFIG.GAS_API_URL}?action=create`;
      if (customPwd) url += `&pwd=${encodeURIComponent(customPwd)}`;
      const res = await fetch(url, { method: "GET" });
      return await res.json();
    } catch (err) {
      console.error("API createRoom Error:", err);
      throw new Error("建立房間失敗，請確認 Google Sheet Web App 網址！");
    }
  },

  /**
   * 同步房間狀態 (取得 4 位玩家的獨立數據)
   */
  async syncRoom(code, pwd) {
    if (!this.isConfigured()) {
      const saved = localStorage.getItem(`rjpq_demo_${code}`);
      if (!saved) {
        const init = {
          pwd: pwd || "1234",
          players: [Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1)],
          updatedAt: Date.now()
        };
        localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(init));
        return { success: true, code, players: init.players, updatedAt: init.updatedAt, isDemo: true };
      }
      const parsed = JSON.parse(saved);
      if (pwd && parsed.pwd !== pwd) return { error: "密碼錯誤" };
      return { success: true, code, players: parsed.players, updatedAt: parsed.updatedAt, isDemo: true };
    }

    try {
      const url = `${CONFIG.GAS_API_URL}?action=sync&code=${encodeURIComponent(code)}&pwd=${encodeURIComponent(pwd || "")}`;
      const res = await fetch(url, { method: "GET" });
      return await res.json();
    } catch (err) {
      console.warn("API syncRoom Warning:", err);
      return { error: "連線異常" };
    }
  },

  /**
   * 僅更新單一角色的 10 層踩踏路徑 (徹底避免覆蓋其他隊友)
   */
  async updatePlayer(code, pwd, color, path) {
    if (!this.isConfigured()) {
      const saved = localStorage.getItem(`rjpq_demo_${code}`);
      const parsed = saved ? JSON.parse(saved) : { pwd: pwd || "", players: [Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1)] };
      parsed.players[color] = path;
      parsed.updatedAt = Date.now();
      localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(parsed));
      return { success: true, color, updatedAt: parsed.updatedAt, isDemo: true };
    }

    const payload = {
      action: "updatePlayer",
      code: code,
      pwd: pwd,
      color: color,
      path: path
    };

    try {
      // 優先使用 POST (text/plain 免去 OPTIONS preflight)
      const res = await fetch(CONFIG.GAS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      return await res.json();
    } catch (err) {
      // GET 回退模式
      try {
        const url = `${CONFIG.GAS_API_URL}?action=updatePlayer&code=${encodeURIComponent(code)}&color=${color}&path=${encodeURIComponent(JSON.stringify(path))}`;
        const res = await fetch(url, { method: "GET" });
        return await res.json();
      } catch (fallbackErr) {
        console.error("更新玩家踏板失敗:", fallbackErr);
        throw fallbackErr;
      }
    }
  },

  /**
   * 重置全部踏板
   */
  async resetGrid(code, pwd) {
    if (!this.isConfigured()) {
      const saved = localStorage.getItem(`rjpq_demo_${code}`);
      const parsed = saved ? JSON.parse(saved) : { pwd: pwd || "" };
      parsed.players = [Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1), Array(10).fill(-1)];
      parsed.updatedAt = Date.now();
      localStorage.setItem(`rjpq_demo_${code}`, JSON.stringify(parsed));
      return { success: true, updatedAt: parsed.updatedAt, isDemo: true };
    }

    try {
      const res = await fetch(CONFIG.GAS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "reset", code: code, pwd: pwd })
      });
      return await res.json();
    } catch (err) {
      const url = `${CONFIG.GAS_API_URL}?action=reset&code=${encodeURIComponent(code)}`;
      const res = await fetch(url, { method: "GET" });
      return await res.json();
    }
  }
};
