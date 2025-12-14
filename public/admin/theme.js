/**
 * Antigravity Panel 主题管理
 * 基于 Tailwind CSS class-based dark mode
 */
(function () {
  const THEME_KEY = 'ag-panel-theme';
  let currentTheme = 'light';
  let initialized = false;
  let autoThemeTimer = null;
  const toggleButtons = new Set();

  /**
   * 检查当前是否为夜间时段（18:00 - 06:00）
   */
  function isNightTime() {
    const hour = new Date().getHours();
    return hour >= 18 || hour < 6;
  }

  /**
   * 应用主题到页面
   */
  function applyTheme(theme, { persist = true } = {}) {
    currentTheme = theme;

    // 使用 Tailwind 的 class-based dark mode
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    }

    // 更新所有绑定的切换按钮
    toggleButtons.forEach(updateToggleLabel);

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (e) {
        // 忽略存储错误
      }
    }

    return currentTheme;
  }

  /**
   * 根据时间自动应用主题
   */
  function applyAutoTheme() {
    return applyTheme(isNightTime() ? 'dark' : 'light', { persist: false });
  }

  /**
   * 初始化主题
   */
  function initTheme() {
    if (initialized) return currentTheme;
    initialized = true;

    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved) {
        return applyTheme(saved, { persist: false });
      }
    } catch (e) {
      // 忽略存储错误
    }

    // 优先检测系统主题偏好
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return applyTheme('dark', { persist: false });
    }

    // 启动自动主题切换定时器
    autoThemeTimer = setInterval(applyAutoTheme, 10 * 60 * 1000);
    return applyAutoTheme();
  }

  /**
   * 更新切换按钮的标签（此函数保留用于兼容性）
   */
  function updateToggleLabel(button) {
    if (!button) return;
    // 新的 UI 使用 SVG 图标和 Tailwind dark: 类来切换显示
    // 不需要更新文本内容
  }

  /**
   * 切换主题
   */
  function toggleTheme(button) {
    const next = currentTheme === 'dark' ? 'light' : 'dark';

    // 停止自动主题切换
    if (autoThemeTimer) {
      clearInterval(autoThemeTimer);
      autoThemeTimer = null;
    }

    applyTheme(next);
    updateToggleLabel(button);
    return next;
  }

  /**
   * 绑定主题切换按钮
   */
  function bindThemeToggle(button) {
    if (!button) return;
    initTheme();
    toggleButtons.add(button);
    updateToggleLabel(button);

    button.addEventListener('click', () => {
      toggleTheme(button);
    });
  }

  // 导出全局 API
  window.AgTheme = {
    initTheme,
    applyTheme,
    toggleTheme,
    bindThemeToggle,
    getTheme: () => currentTheme,
    THEME_KEY
  };

  // DOM 加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme, { once: true });
  } else {
    initTheme();
  }
})();
