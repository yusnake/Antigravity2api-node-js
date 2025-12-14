/**
 * Antigravity OAuth 管理面板
 * 使用 Tailwind CSS 样式
 */

// DOM 元素引用
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const statusEl = document.getElementById('status');
const tomlStatusEl = document.getElementById('tomlStatus');
const listEl = document.getElementById('accountsList');
const refreshBtn = document.getElementById('refreshBtn');
const refreshAllBtn = document.getElementById('refreshAllBtn');
const logsRefreshBtn = document.getElementById('logsRefreshBtn');
const logsClearBtn = document.getElementById('logsClearBtn');
const hourlyUsageEl = document.getElementById('hourlyUsage');
const manageStatusEl = document.getElementById('manageStatus');
const callbackUrlInput = document.getElementById('callbackUrlInput');
const customProjectIdInput = document.getElementById('customProjectIdInput');
const allowRandomProjectIdCheckbox = document.getElementById('allowRandomProjectId');
const submitCallbackBtn = document.getElementById('submitCallbackBtn');
const logsEl = document.getElementById('logs');
const usageStatusEl = document.getElementById('usageStatus');
const settingsGrid = document.getElementById('settingsGrid');
const settingsStatusEl = document.getElementById('settingsStatus');
const settingsRefreshBtn = document.getElementById('settingsRefreshBtn');
const importTomlBtn = document.getElementById('importTomlBtn');
const tomlInput = document.getElementById('tomlInput');
const replaceExistingCheckbox = document.getElementById('replaceExisting');
const filterDisabledCheckbox = document.getElementById('filterDisabled');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const deleteDisabledBtn = document.getElementById('deleteDisabledBtn');
const usageRefreshBtn = document.getElementById('usageRefreshBtn');
const paginationInfo = document.getElementById('paginationInfo');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const logPaginationInfo = document.getElementById('logPaginationInfo');
const logPrevPageBtn = document.getElementById('logPrevPageBtn');
const logNextPageBtn = document.getElementById('logNextPageBtn');
const statusFilterSelect = document.getElementById('statusFilter');
const errorFilterCheckbox = document.getElementById('errorFilter');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const pageSizeSelect = document.getElementById('pageSizeSelect');

// 常量
const HOUR_WINDOW_MINUTES = 60;
const HOURLY_LIMIT = 20;
const LOG_PAGE_SIZE = 20;

// 每页显示数量（可配置）
let pageSize = 5;

// 状态变量
let accountsData = [];
let filteredAccounts = [];
let currentPage = 1;
let logsData = [];
let logCurrentPage = 1;
let statusFilter = 'all';
let errorOnly = false;
const logDetailCache = new Map();
let logLevelSelect = null;
let replaceIndex = null;

// 初始化主题
if (window.AgTheme) {
  window.AgTheme.initTheme();
  window.AgTheme.bindThemeToggle(themeToggleBtn);
}

/**
 * 设置状态提示
 */
function setStatus(text, type = 'info', target = statusEl) {
  if (!target) return;
  if (!text) {
    target.classList.add('hidden');
    return;
  }
  target.textContent = text;
  target.className = `badge badge-${type}`;
  target.classList.remove('hidden');
}

/**
 * 激活指定选项卡
 */
function activateTab(target) {
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tabTarget === target);
  });
  tabPanels.forEach(panel => {
    const isActive = panel.dataset.tab === target;
    panel.classList.toggle('active', isActive);
    panel.classList.toggle('hidden', !isActive);
  });
}

/**
 * 封装的 fetch 请求
 */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 格式化 JSON
 */
function formatJson(value) {
  try {
    return escapeHtml(JSON.stringify(value ?? {}, null, 2));
  } catch (e) {
    return escapeHtml(String(value));
  }
}

/**
 * 获取账号显示名称
 */
function getAccountDisplayName(acc) {
  if (!acc) return '未知账号';
  if (acc.email) return acc.email;
  if (acc.user_email) return acc.user_email;
  if (acc.projectId) return acc.projectId;
  if (typeof acc.index === 'number') return `账号 #${acc.index + 1}`;
  return '未知账号';
}

/**
 * 渲染用量卡片
 */
function renderUsageCard(account) {
  const { usage = {} } = account;
  const models = usage.models && usage.models.length > 0 ? usage.models.join(', ') : '暂无数据';
  const lastUsed = usage.lastUsedAt ? new Date(usage.lastUsedAt).toLocaleString() : '未使用';
  return `
    <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 border border-dashed border-gray-200 dark:border-gray-600 text-xs space-y-1">
      <div class="flex justify-between"><span class="text-gray-500 dark:text-gray-400">累计调用</span><span class="font-semibold text-gray-900 dark:text-white">${usage.total || 0}</span></div>
      <div class="flex justify-between"><span class="text-gray-500 dark:text-gray-400">成功 / 失败</span><span class="font-semibold text-gray-900 dark:text-white">${usage.success || 0} / ${usage.failed || 0}</span></div>
      <div class="flex justify-between"><span class="text-gray-500 dark:text-gray-400">最近使用</span><span class="font-semibold text-gray-900 dark:text-white">${lastUsed}</span></div>
      <div class="flex justify-between"><span class="text-gray-500 dark:text-gray-400">使用模型</span><span class="font-semibold text-gray-900 dark:text-white truncate max-w-[150px]" title="${escapeHtml(models)}">${escapeHtml(models)}</span></div>
    </div>
  `;
}

/**
 * 更新筛选后的账号列表
 */
function updateFilteredAccounts() {
  filteredAccounts = accountsData.filter(acc => {
    const matchesStatus =
      statusFilter === 'all' || (statusFilter === 'enabled' && acc.enable) || (statusFilter === 'disabled' && !acc.enable);
    const failedCount = acc?.usage?.failed || 0;
    const matchesError = !errorOnly || failedCount > 0;
    return matchesStatus && matchesError;
  });
  currentPage = 1;
  renderAccountsList();
}

/**
 * 批量刷新所有账号
 */
async function refreshAllAccountsBatch() {
  if (!accountsData.length) {
    setStatus('暂无凭证可刷新。', 'info', manageStatusEl);
    return;
  }

  if (refreshAllBtn) refreshAllBtn.disabled = true;
  setStatus('正在批量刷新凭证...', 'info', manageStatusEl);

  try {
    const { refreshed = 0, failed = 0 } = await fetchJson('/auth/accounts/refresh-all', { method: 'POST' });
    const message = `批量刷新完成：成功 ${refreshed} 个，失败 ${failed} 个。`;
    setStatus(message, failed > 0 ? 'warning' : 'success', manageStatusEl);
    await refreshAccounts();
  } catch (e) {
    setStatus('批量刷新失败: ' + e.message, 'error', manageStatusEl);
  } finally {
    if (refreshAllBtn) refreshAllBtn.disabled = false;
  }
}

/**
 * 绑定账号操作事件
 */
function bindAccountActions() {
  // 刷新凭证
  document.querySelectorAll('[data-action="refresh"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      btn.disabled = true;
      setStatus('正在刷新凭证...', 'info', manageStatusEl);
      try {
        await fetchJson(`/auth/accounts/${idx}/refresh`, { method: 'POST' });
        setStatus('刷新成功', 'success', manageStatusEl);
        refreshAccounts();
      } catch (e) {
        setStatus('刷新失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // 启用/停用
  document.querySelectorAll('[data-action="toggle"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      const enable = btn.dataset.enable === 'false';
      btn.disabled = true;
      setStatus(enable ? '正在启用账号...' : '正在停用账号...', 'info', manageStatusEl);
      try {
        await fetchJson(`/auth/accounts/${idx}/enable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable })
        });
        setStatus(enable ? '已启用账号' : '已停用账号', 'success', manageStatusEl);
        refreshAccounts();
      } catch (e) {
        setStatus('更新状态失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // 删除
  document.querySelectorAll('[data-action="delete"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      if (!confirm('确认删除这个账号吗？删除后无法恢复')) return;
      btn.disabled = true;
      setStatus('正在删除账号...', 'info', manageStatusEl);
      try {
        await fetchJson(`/auth/accounts/${idx}`, { method: 'DELETE' });
        setStatus('账号已删除', 'success', manageStatusEl);
        refreshAccounts();
      } catch (e) {
        setStatus('删除失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // 重新授权
  document.querySelectorAll('[data-action="reauthorize"]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      replaceIndex = Number(btn.dataset.index);
      setStatus(`请重新授权账号 #${replaceIndex + 1}，完成后粘贴新的回调 URL 提交。`, 'info', manageStatusEl);
      loginBtn?.click();
    });
  });

  // 刷新项目ID
  document.querySelectorAll('[data-action="refreshProjectId"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      if (idx === undefined) return;
      btn.disabled = true;
      setStatus(`正在刷新账号 #${Number(idx) + 1} 的项目ID...`, 'info', manageStatusEl);
      try {
        const res = await fetch('/auth/accounts/' + idx + '/refresh-project-id', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setStatus(`项目ID 已刷新为：${data.projectId || '未知'}`, 'success', manageStatusEl);
        await refreshAccounts();
      } catch (e) {
        setStatus('刷新项目ID失败: ' + e.message, 'error', manageStatusEl);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // 查看额度
  document.querySelectorAll('[data-action="toggleQuota"]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = btn.dataset.index;
      if (idx === undefined) return;
      const quotaSection = document.getElementById(`quota-${idx}`);
      if (!quotaSection) return;
      quotaSection.classList.remove('hidden');
      btn.textContent = '刷新额度';
      await loadQuota(idx, true);
    });
  });
}

/**
 * 加载账号额度
 */
async function loadQuota(accountIndex, showLoading = false) {
  const quotaSection = document.getElementById(`quota-${accountIndex}`);
  if (!quotaSection) return;

  try {
    if (showLoading) {
      quotaSection.innerHTML = '<div class="text-center py-4 text-sm text-gray-500 dark:text-gray-400">加载中...</div>';
    }
    const data = await fetchJson(`/admin/tokens/${accountIndex}/quotas`, { cache: 'no-store' });
    renderQuota(quotaSection, data.data);
  } catch (e) {
    quotaSection.innerHTML = `<div class="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm text-center">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

/**
 * 渲染额度信息
 */
function renderQuota(container, quotaData) {
  if (!quotaData || !quotaData.models) {
    container.innerHTML = '<div class="p-3 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-lg text-sm text-center">暂无额度数据</div>';
    return;
  }

  const lastUpdated = quotaData.lastUpdated ? new Date(quotaData.lastUpdated).toLocaleString() : '未知时间';

  // 模型分组配置
  const modelGroups = {
    'Claude/GPT': {
      models: ['claude-sonnet-4-5-thinking', 'claude-opus-4-5-thinking', 'claude-sonnet-4-5', 'gpt-oss-120b-medium'],
      icon: '🧠',
      description: 'Claude和GPT模型共享额度'
    },
    'Tab补全': {
      models: ['chat_23310', 'chat_20706'],
      icon: '📝',
      description: 'Tab补全模型'
    },
    '香蕉绘图': {
      models: ['gemini-2.5-flash-image'],
      icon: '🍌',
      description: 'Gemini图像生成模型'
    },
    '香蕉Pro': {
      models: ['gemini-3-pro-image'],
      icon: '🌟',
      description: 'Gemini Pro图像生成模型'
    },
    'Gemini其他': {
      models: ['gemini-3-pro-high', 'rev19-uic3-1p', 'gemini-2.5-flash', 'gemini-3-pro-low', 'gemini-2.5-flash-thinking', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
      icon: '💎',
      description: '其他Gemini模型共享额度'
    }
  };

  // 对模型进行分组
  const groupedModels = {};
  const otherModels = [];

  Object.keys(modelGroups).forEach(groupName => {
    groupedModels[groupName] = { ...modelGroups[groupName], modelIds: [], remaining: [], resetTime: null };
  });

  for (const [modelName, modelInfo] of Object.entries(quotaData.models)) {
    let assigned = false;
    for (const [groupName, groupConfig] of Object.entries(modelGroups)) {
      if (groupConfig.models.includes(modelName)) {
        groupedModels[groupName].modelIds.push(modelName);
        groupedModels[groupName].remaining.push(modelInfo.remaining);
        if (!groupedModels[groupName].resetTime) {
          groupedModels[groupName].resetTime = modelInfo.resetTime;
        }
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      otherModels.push({ name: modelName, remaining: modelInfo.remaining, resetTime: modelInfo.resetTime });
    }
  }

  let html = `
    <div class="flex justify-between items-center mb-3 pb-2 border-b border-gray-200 dark:border-gray-600">
      <span class="font-semibold text-sm text-gray-900 dark:text-white">模型额度信息</span>
      <span class="text-xs text-gray-500 dark:text-gray-400">更新: ${lastUpdated}</span>
    </div>
    <div class="space-y-2">
  `;

  // 渲染分组模型
  for (const [groupName, groupData] of Object.entries(groupedModels)) {
    if (groupData.modelIds.length === 0) continue;
    const avgRemaining = groupData.remaining.length > 0 ? groupData.remaining.reduce((a, b) => a + b, 0) / groupData.remaining.length : 0;
    const remainingPercentage = Math.round(avgRemaining * 100);
    const colorClass = remainingPercentage > 50 ? 'bg-emerald-500' : remainingPercentage > 20 ? 'bg-amber-500' : 'bg-red-500';

    html += `
      <div class="bg-white dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-600">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-lg">${groupData.icon}</span>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-gray-900 dark:text-white">${escapeHtml(groupName)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400 truncate">${escapeHtml(groupData.description)}</div>
          </div>
        </div>
        <div class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
          <div class="h-full ${colorClass} rounded-full transition-all" style="width: ${remainingPercentage}%"></div>
        </div>
        <div class="flex justify-between text-xs">
          <span class="font-semibold text-gray-900 dark:text-white">${remainingPercentage}%</span>
          <span class="text-gray-500 dark:text-gray-400">重置: ${groupData.resetTime || '未知'}</span>
        </div>
      </div>
    `;
  }

  // 渲染其他模型
  if (otherModels.length > 0) {
    html += `<div class="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-lg">📋</span>
        <div class="font-medium text-sm text-gray-900 dark:text-white">其他模型</div>
      </div>
      <div class="space-y-2">`;

    otherModels.forEach(model => {
      const remainingPercentage = Math.round(model.remaining * 100);
      const colorClass = remainingPercentage > 50 ? 'bg-emerald-500' : remainingPercentage > 20 ? 'bg-amber-500' : 'bg-red-500';
      html += `
        <div class="bg-white dark:bg-gray-800 rounded p-2">
          <div class="text-xs font-medium text-gray-900 dark:text-white mb-1 truncate">${escapeHtml(model.name)}</div>
          <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-1">
            <div class="h-full ${colorClass} rounded-full" style="width: ${remainingPercentage}%"></div>
          </div>
          <div class="flex justify-between text-xs">
            <span class="font-semibold text-gray-700 dark:text-gray-300">${remainingPercentage}%</span>
            <span class="text-gray-500 dark:text-gray-400">重置: ${model.resetTime}</span>
          </div>
        </div>
      `;
    });

    html += '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

/**
 * 刷新账号列表
 */
async function refreshAccounts() {
  try {
    const data = await fetchJson('/auth/accounts');
    accountsData = data.accounts || [];
    updateFilteredAccounts();
    loadHourlyUsage();
  } catch (e) {
    listEl.innerHTML = `<div class="text-center py-8 text-red-500 dark:text-red-400">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

/**
 * 渲染账号列表
 */
function renderAccountsList() {
  if (!filteredAccounts.length) {
    listEl.innerHTML = `<div class="text-center py-8 text-gray-500 dark:text-gray-400">${accountsData.length ? '没有符合筛选条件的凭证。' : '暂无账号，请先添加一个。'}</div>`;
    if (paginationInfo) paginationInfo.textContent = '第 0 / 0 页';
    if (prevPageBtn) prevPageBtn.disabled = true;
    if (nextPageBtn) nextPageBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / pageSize));
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = filteredAccounts.slice(start, start + pageSize);

  listEl.innerHTML = pageItems
    .map(acc => {
      const created = acc.createdAt ? new Date(acc.createdAt).toLocaleString() : '时间未知';
      const statusBg = acc.enable
        ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
        : 'bg-gradient-to-r from-red-500 to-rose-500';
      const statusText = acc.enable ? '启用' : '停用';
      const displayName = escapeHtml(getAccountDisplayName(acc));
      const projectId = acc.projectId ? escapeHtml(acc.projectId) : null;
      const { usage = {} } = acc;
      const lastUsed = usage.lastUsedAt ? new Date(usage.lastUsedAt).toLocaleString() : '从未使用';

      return `
        <div class="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden">
          <!-- 头部 -->
          <div class="relative px-4 py-3 flex items-center gap-3">
            <div class="absolute top-0 right-0 ${statusBg} text-white text-[10px] font-bold px-3 py-1 rounded-bl-lg">
              ${statusText}
            </div>
            <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center text-white font-bold text-sm shadow">
              ${displayName.charAt(0).toUpperCase()}
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="font-semibold text-gray-900 dark:text-white truncate text-sm">${displayName}</h3>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 ${projectId ? 'font-mono' : ''} truncate">${projectId || '创建于 ' + created}</p>
            </div>
          </div>

          <!-- 统计 + 按钮 -->
          <div class="px-4 pb-3 flex items-center gap-3">
            <div class="flex items-center gap-4 text-center text-xs">
              <div><span class="font-bold text-gray-900 dark:text-white">${usage.total || 0}</span><span class="text-gray-400 ml-1">调用</span></div>
              <div><span class="font-bold text-emerald-600 dark:text-emerald-400">${usage.success || 0}</span><span class="text-gray-400 ml-1">成功</span></div>
              <div><span class="font-bold text-red-500">${usage.failed || 0}</span><span class="text-gray-400 ml-1">失败</span></div>
            </div>
            <div class="flex-1"></div>
            <div class="flex items-center gap-1.5">
              <button class="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-primary-50 text-primary-700 hover:bg-primary-100 dark:bg-primary-900/30 dark:text-primary-400 transition-colors" data-action="refresh" data-index="${acc.index}">刷新</button>
              <button class="px-2.5 py-1.5 text-[11px] font-medium rounded-md ${acc.enable ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400'} transition-colors" data-action="toggle" data-enable="${acc.enable}" data-index="${acc.index}">${acc.enable ? '停用' : '启用'}</button>
              <button class="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 transition-colors" data-action="reauthorize" data-index="${acc.index}">重授权</button>
              <button class="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 transition-colors" data-action="refreshProjectId" data-index="${acc.index}">刷新ID</button>
              <button class="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 transition-colors" data-action="toggleQuota" data-index="${acc.index}">额度</button>
              <button class="px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 transition-colors" data-action="delete" data-index="${acc.index}">删除</button>
            </div>
          </div>

          <!-- 额度区域 -->
          <div class="hidden border-t border-gray-100 dark:border-gray-700" id="quota-${acc.index}">
            <div class="p-4">
              <div class="text-center py-2 text-sm text-gray-500 dark:text-gray-400">加载中...</div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  if (paginationInfo) {
    paginationInfo.textContent = `第 ${currentPage} / ${totalPages} 页，共 ${filteredAccounts.length} 个凭证`;
  }
  if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages;
  bindAccountActions();
}

/**
 * 删除停用的账号
 */
async function deleteDisabledAccounts() {
  const disabledAccounts = accountsData.filter(acc => !acc.enable).sort((a, b) => b.index - a.index);
  if (disabledAccounts.length === 0) {
    setStatus('没有停用的凭证需要删除。', 'info', manageStatusEl);
    return;
  }

  if (!confirm(`确认删除 ${disabledAccounts.length} 个停用凭证吗？删除后无法恢复。`)) return;

  deleteDisabledBtn.disabled = true;
  setStatus('正在删除停用凭证...', 'info', manageStatusEl);

  try {
    for (const acc of disabledAccounts) {
      await fetchJson(`/auth/accounts/${acc.index}`, { method: 'DELETE' });
    }
    setStatus(`已删除 ${disabledAccounts.length} 个停用凭证。`, 'success', manageStatusEl);
    await refreshAccounts();
  } catch (e) {
    setStatus('删除停用凭证失败: ' + e.message, 'error', manageStatusEl);
  } finally {
    deleteDisabledBtn.disabled = false;
  }
}

/**
 * 渲染系统设置
 */
function renderSettings(groups) {
  if (!settingsGrid) return;
  if (!groups || groups.length === 0) {
    settingsGrid.innerHTML = '<div class="text-center py-8 text-gray-500 dark:text-gray-400">暂无配置数据</div>';
    return;
  }

  const html = groups
    .map(group => {
      const items = (group.items || [])
        .map(item => {
          const currentValue = item?.value ?? '未设置';
          const editableValue = item.sensitive ? '' : currentValue;
          const defaultValue = item?.defaultValue ?? '无默认值';
          const displayValue = item.isDefault
            ? (item.defaultValue !== null && item.defaultValue !== undefined ? defaultValue : currentValue)
            : `${currentValue} ${defaultValue !== '无默认值' ? `(默认: ${defaultValue})` : ''}`;

          const sourceClass = item.isDefault ? 'badge-info' :
            item.source === 'docker' ? 'badge-warning' :
            item.source === 'env' ? 'badge-info' : 'badge-success';
          const sourceText = item.isDefault ? '默认值' :
            item.source === 'docker' ? 'Docker' :
            item.source === 'env' ? '环境变量' : '配置文件';

          return `
            <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div class="flex items-center gap-2 flex-wrap mb-2">
                <span class="font-semibold text-sm text-gray-900 dark:text-white">${escapeHtml(item.label || item.key)}</span>
                <span class="badge ${sourceClass}">${sourceText}</span>
                ${item.sensitive ? '<span class="badge badge-warning">敏感</span>' : ''}
              </div>
              <div class="text-sm text-gray-700 dark:text-gray-300 font-mono break-all mb-2">${escapeHtml(displayValue)}</div>
              <div class="text-xs text-gray-500 dark:text-gray-400 mb-2">${escapeHtml(item.description || '')}</div>
              <button class="btn btn-secondary btn-sm setting-edit-btn" data-key="${escapeHtml(item.key)}" data-label="${escapeHtml(item.label || item.key)}" data-sensitive="${item.sensitive ? 'true' : 'false'}" data-current="${escapeHtml(String(editableValue ?? ''))}">
                修改
              </button>
            </div>
          `;
        })
        .join('');

      return `
        <div class="bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div class="px-4 py-3 bg-primary-50 dark:bg-primary-900/20 border-b border-gray-200 dark:border-gray-700">
            <span class="font-semibold text-sm text-primary-700 dark:text-primary-300">${escapeHtml(group.name || '配置')}</span>
          </div>
          <div class="p-3 space-y-2">${items || '<div class="text-center py-4 text-gray-500 dark:text-gray-400">暂无配置</div>'}</div>
        </div>
      `;
    })
    .join('');

  settingsGrid.innerHTML = html;
}

/**
 * 加载系统设置
 */
async function loadSettings() {
  if (!settingsGrid) return;
  settingsGrid.innerHTML = '<div class="text-center py-8 text-gray-500 dark:text-gray-400">加载中...</div>';
  try {
    const data = await fetchJson('/admin/settings');
    renderSettings(data.groups || []);
    if (data.updatedAt) {
      setStatus(`已更新：${new Date(data.updatedAt).toLocaleString()}`, 'success', settingsStatusEl);
    }
  } catch (e) {
    settingsGrid.innerHTML = `<div class="text-center py-8 text-red-500 dark:text-red-400">加载设置失败: ${escapeHtml(e.message)}</div>`;
    setStatus('刷新失败: ' + e.message, 'error', settingsStatusEl);
  }
}

/**
 * 更新配置值
 */
async function updateSettingValue({ key, label, isSensitive, currentValue }) {
  if (!key) return;

  const promptMessage = [
    `${label || key} (${key})`,
    '留空可回退到默认值，更新后会立即保存到 data/config.json。',
    isSensitive ? '敏感信息不会显示当前值，请直接输入新值。' : null
  ].filter(Boolean).join('\n');

  const newValue = window.prompt(promptMessage, isSensitive ? '' : currentValue || '');
  if (newValue === null) return;

  try {
    setStatus('保存配置中...', 'info', settingsStatusEl);
    const response = await fetchJson('/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: newValue })
    });

    if (response.dockerOnly) {
      setStatus(`此配置为 Docker 专用，请在 docker-compose.yml 的 environment 部分修改。`, 'warning', settingsStatusEl);
      alert(`此配置为 Docker 专用\n\n请在 docker-compose.yml 的 environment 部分修改：\n${key}=你的值`);
    } else {
      await loadSettings();
      setStatus('已保存到 data/config.json。', 'success', settingsStatusEl);
    }
  } catch (e) {
    setStatus('更新失败: ' + e.message, 'error', settingsStatusEl);
  }
}

/**
 * 加载调用日志
 */
async function loadLogs() {
  if (!logsEl) return;
  logsEl.innerHTML = '<div class="text-center py-8 text-gray-500 dark:text-gray-400">加载中...</div>';
  if (logPaginationInfo) logPaginationInfo.textContent = '加载中...';
  if (logPrevPageBtn) logPrevPageBtn.disabled = true;
  if (logNextPageBtn) logNextPageBtn.disabled = true;
  try {
    const data = await fetchJson('/admin/logs?limit=200');
    logsData = data.logs || [];
    logCurrentPage = 1;
    renderLogs();
  } catch (e) {
    logsEl.innerHTML = `<div class="text-center py-8 text-red-500 dark:text-red-400">加载日志失败: ${escapeHtml(e.message)}</div>`;
    if (logPaginationInfo) logPaginationInfo.textContent = '';
  }
}

/**
 * 获取日志详情
 */
async function fetchLogDetail(logId) {
  if (!logId) throw new Error('缺少日志 ID');
  if (logDetailCache.has(logId)) return logDetailCache.get(logId);
  const data = await fetchJson(`/admin/logs/${logId}`);
  const detail = data.log;
  logDetailCache.set(logId, detail);
  return detail;
}

/**
 * 渲染日志详情内容
 */
function renderLogDetailContent(detail, container) {
  if (!container) return;
  if (!detail) {
    container.textContent = '未找到日志详情';
    return;
  }

  const requestSnapshot = detail.detail?.request;
  const responseSnapshot = detail.detail?.response;
  const modelAnswer = responseSnapshot?.modelOutput || responseSnapshot?.body?.modelOutput || responseSnapshot?.body?.text || responseSnapshot?.body || responseSnapshot;

  container.innerHTML = `
    <details class="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden mb-2" open>
      <summary class="px-3 py-2 font-medium text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">模型回答</summary>
      <div class="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
        <pre class="text-xs font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto text-gray-800 dark:text-gray-200">${formatJson(modelAnswer || '暂无模型回答')}</pre>
      </div>
    </details>
    <details class="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden mb-2">
      <summary class="px-3 py-2 font-medium text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">用户请求体</summary>
      <div class="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
        <pre class="text-xs font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto text-gray-800 dark:text-gray-200">${formatJson(requestSnapshot?.body || requestSnapshot || '暂无请求')}</pre>
      </div>
    </details>
    <details class="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
      <summary class="px-3 py-2 font-medium text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">完整请求/响应</summary>
      <div class="px-3 py-2 border-t border-gray-200 dark:border-gray-600 space-y-2">
        <div>
          <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">请求</h4>
          <pre class="text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto text-gray-800 dark:text-gray-200">${formatJson(requestSnapshot)}</pre>
        </div>
        <div>
          <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">响应</h4>
          <pre class="text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto text-gray-800 dark:text-gray-200">${formatJson(responseSnapshot)}</pre>
        </div>
      </div>
    </details>
  `;
}

/**
 * 渲染错误详情内容
 */
function renderErrorDetailContent(detail, container) {
  if (!container) return;
  if (!detail) {
    container.textContent = '未找到错误详情';
    return;
  }

  const requestSnapshot = detail.detail?.request;
  const responseSnapshot = detail.detail?.response;
  const errorSummary = { status: detail.status || null, message: detail.message || '未知错误' };

  container.innerHTML = `
    <div class="mb-2">
      <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">错误摘要</h4>
      <pre class="text-xs font-mono whitespace-pre-wrap break-words text-red-600 dark:text-red-400">${formatJson(errorSummary)}</pre>
    </div>
    <details class="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden mb-2" open>
      <summary class="px-3 py-2 font-medium text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">响应内容</summary>
      <div class="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
        <pre class="text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto text-gray-800 dark:text-gray-200">${formatJson(responseSnapshot?.body || responseSnapshot || '暂无响应')}</pre>
      </div>
    </details>
    <details class="bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
      <summary class="px-3 py-2 font-medium text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">请求快照</summary>
      <div class="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
        <pre class="text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto text-gray-800 dark:text-gray-200">${formatJson(requestSnapshot || '暂无请求')}</pre>
      </div>
    </details>
  `;
}

/**
 * 绑定日志详情切换
 */
function bindLogDetailToggles() {
  document.querySelectorAll('.log-detail-toggle')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.detailTarget;
      const detailEl = document.getElementById(targetId);
      if (!detailEl) return;
      const isOpen = !detailEl.classList.contains('hidden');
      if (isOpen) {
        detailEl.classList.add('hidden');
        btn.textContent = '查看详情';
        return;
      }
      detailEl.classList.remove('hidden');
      detailEl.innerHTML = '<div class="text-center py-2 text-sm text-gray-500 dark:text-gray-400">加载中...</div>';
      btn.disabled = true;
      try {
        const detail = await fetchLogDetail(btn.dataset.logId);
        renderLogDetailContent(detail, detailEl);
        btn.textContent = '收起详情';
      } catch (e) {
        detailEl.innerHTML = `<div class="text-sm text-red-500 dark:text-red-400">加载详情失败: ${escapeHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.log-error-toggle')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.errorTarget;
      const errorEl = document.getElementById(targetId);
      if (!errorEl) return;
      const isOpen = !errorEl.classList.contains('hidden');
      if (isOpen) {
        errorEl.classList.add('hidden');
        btn.textContent = '查看错误';
        return;
      }
      errorEl.classList.remove('hidden');
      errorEl.innerHTML = '<div class="text-center py-2 text-sm text-gray-500 dark:text-gray-400">加载中...</div>';
      btn.disabled = true;
      try {
        const detail = await fetchLogDetail(btn.dataset.logId);
        renderErrorDetailContent(detail, errorEl);
        btn.textContent = '收起错误';
      } catch (e) {
        errorEl.innerHTML = `<div class="text-sm text-red-500 dark:text-red-400">加载错误详情失败: ${escapeHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/**
 * 渲染日志列表
 */
function renderLogs() {
  if (!logsEl) return;

  if (!logsData.length) {
    logsEl.innerHTML = '<div class="text-center py-8 text-gray-500 dark:text-gray-400">暂无调用日志</div>';
    if (logPaginationInfo) logPaginationInfo.textContent = '第 0 / 0 页';
    if (logPrevPageBtn) logPrevPageBtn.disabled = true;
    if (logNextPageBtn) logNextPageBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(logsData.length / LOG_PAGE_SIZE));
  logCurrentPage = Math.min(Math.max(logCurrentPage, 1), totalPages);
  const start = (logCurrentPage - 1) * LOG_PAGE_SIZE;
  const pageItems = logsData.slice(start, start + LOG_PAGE_SIZE);

  logsEl.innerHTML = pageItems
    .map((log, idx) => {
      const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : '未知时间';
      const bgClass = log.success
        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800'
        : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      const hasError = !log.success;
      const detailId = `log-detail-${start + idx}`;
      const errorDetailId = `log-error-${start + idx}`;
      const statusText = log.status ? `HTTP ${log.status}` : log.success ? '成功' : '失败';
      const durationText = log.durationMs ? `${log.durationMs} ms` : '';
      const pathText = `${log.method || '未知'} ${log.path || log.route || ''}`;

      const detailButton = log.hasDetail && log.id
        ? `<button class="btn btn-secondary btn-sm log-detail-toggle" data-log-id="${log.id}" data-detail-target="${detailId}">查看详情</button>
           <div class="hidden mt-2" id="${detailId}"></div>`
        : '';

      const errorButton = hasError && log.id
        ? `<button class="btn btn-danger btn-sm log-error-toggle" data-log-id="${log.id}" data-error-target="${errorDetailId}">查看错误</button>
           <div class="hidden mt-2" id="${errorDetailId}"></div>`
        : '';

      return `
        <div class="rounded-lg border p-3 ${bgClass}">
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm text-gray-900 dark:text-white">${time}</div>
              <div class="text-xs text-gray-600 dark:text-gray-400 mt-1">模型: ${escapeHtml(log.model || '未知')} | 项目: ${escapeHtml(log.projectId || '未知')}</div>
              <div class="text-xs text-gray-500 dark:text-gray-500">${escapeHtml(pathText)} ${statusText} ${durationText}</div>
              ${hasError && log.message ? `<div class="text-xs text-red-600 dark:text-red-400 mt-1">失败原因：${escapeHtml(log.message)}</div>` : ''}
              <div class="flex flex-wrap gap-2 mt-2">
                ${errorButton}
                ${detailButton}
              </div>
            </div>
            <span class="font-bold text-sm ${log.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}">${log.success ? '成功' : '失败'}</span>
          </div>
        </div>
      `;
    })
    .join('');

  if (logPaginationInfo) {
    logPaginationInfo.textContent = `第 ${logCurrentPage} / ${totalPages} 页，共 ${logsData.length} 条`;
  }
  if (logPrevPageBtn) logPrevPageBtn.disabled = logCurrentPage === 1;
  if (logNextPageBtn) logNextPageBtn.disabled = logCurrentPage === totalPages;
  bindLogDetailToggles();
}

/**
 * 加载小时用量
 */
async function loadHourlyUsage() {
  if (!hourlyUsageEl) return;
  hourlyUsageEl.innerHTML = '<div class="text-center py-4 text-gray-500 dark:text-gray-400">加载中...</div>';
  try {
    const data = await fetchJson('/admin/logs/usage');
    const usageMap = new Map();
    (data.usage || []).forEach(item => {
      if (!item) return;
      usageMap.set(item.projectId || '未知项目', item);
    });

    const merged = (accountsData.length ? accountsData : Array.from(usageMap.values()))
      .map(acc => {
        const projectId = acc.projectId || acc.project || acc.id || '未知项目';
        const stats = usageMap.get(projectId) || acc || {};
        const usage = acc.usage || {};
        const totalCalls = usage.total ?? stats.count ?? 0;
        const successCalls = usage.success ?? stats.success ?? 0;
        const failedCalls = usage.failed ?? stats.failed ?? 0;
        const lastUsedAt = usage.lastUsedAt || stats.lastUsedAt || null;
        const hasActivity = (stats.count || 0) > 0 || (totalCalls || 0) > 0 || (successCalls || 0) > 0 || (failedCalls || 0) > 0 || !!lastUsedAt;
        return { projectId, label: getAccountDisplayName(acc), count: stats.count || 0, success: successCalls, failed: failedCalls, total: totalCalls, lastUsedAt, hasActivity };
      })
      .filter(item => item.hasActivity);

    const windowMinutes = data.windowMinutes || HOUR_WINDOW_MINUTES;
    const limit = data.limitPerCredential || HOURLY_LIMIT;

    if (!merged.length) {
      hourlyUsageEl.innerHTML = '<div class="text-center py-4 text-gray-500 dark:text-gray-400">暂无最近 1 小时内的调用记录</div>';
      return;
    }

    const sorted = merged.sort((a, b) => {
      const aTime = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bTime = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      if (aTime !== bTime) return bTime - aTime;
      return (b.count || 0) - (a.count || 0);
    });

    const html = sorted
      .map(item => {
        const percent = Math.min(100, Math.round(((item.count || 0) / limit) * 100));
        const lastUsedText = item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : '暂无';
        const barColor = percent > 80 ? 'bg-red-500' : percent > 50 ? 'bg-amber-500' : 'bg-primary-500';

        return `
          <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="font-semibold text-sm text-gray-900 dark:text-white truncate">${escapeHtml(item.label)}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">${item.count || 0} / ${limit} 次</span>
            </div>
            <div class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
              <div class="h-full ${barColor} rounded-full transition-all" style="width: ${percent}%"></div>
            </div>
            <div class="grid grid-cols-3 gap-2 text-xs">
              <div class="bg-gray-50 dark:bg-gray-700/50 rounded p-2 text-center">
                <div class="text-gray-500 dark:text-gray-400">总调用</div>
                <div class="font-semibold text-gray-900 dark:text-white">${item.total || 0}</div>
              </div>
              <div class="bg-gray-50 dark:bg-gray-700/50 rounded p-2 text-center">
                <div class="text-gray-500 dark:text-gray-400">成功/失败</div>
                <div class="font-semibold text-gray-900 dark:text-white">${item.success || 0}/${item.failed || 0}</div>
              </div>
              <div class="bg-gray-50 dark:bg-gray-700/50 rounded p-2 text-center">
                <div class="text-gray-500 dark:text-gray-400">最近使用</div>
                <div class="font-semibold text-gray-900 dark:text-white text-xs truncate" title="${escapeHtml(lastUsedText)}">${escapeHtml(lastUsedText)}</div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    hourlyUsageEl.innerHTML = html;
  } catch (e) {
    hourlyUsageEl.innerHTML = `<div class="text-center py-4 text-red-500 dark:text-red-400">加载用量失败: ${escapeHtml(e.message)}</div>`;
  }
}

// ==================== 事件绑定 ====================

// 获取授权链接
if (loginBtn) {
  loginBtn.addEventListener('click', async () => {
    try {
      loginBtn.disabled = true;
      setStatus('获取授权链接中...', 'info');
      const data = await fetchJson('/auth/oauth/url');
      if (!data.url) throw new Error('未返回 url');
      setStatus('已打开授权页面，请完成 Google 授权后复制回调 URL。', 'info');
      window.open(data.url, '_blank', 'noopener');
    } catch (e) {
      setStatus('获取授权链接失败: ' + e.message, 'error');
    } finally {
      loginBtn.disabled = false;
    }
  });
}

// 提交回调 URL
if (submitCallbackBtn && callbackUrlInput) {
  submitCallbackBtn.addEventListener('click', async () => {
    const url = callbackUrlInput.value.trim();
    if (!url) {
      setStatus('请先粘贴包含 code 参数的完整回调 URL。', 'error');
      return;
    }
    const customProjectId = customProjectIdInput ? customProjectIdInput.value.trim() : '';
    try {
      submitCallbackBtn.disabled = true;
      setStatus('正在解析回调 URL...', 'info');
      await fetchJson('/auth/oauth/parse-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, replaceIndex, customProjectId, allowRandomProjectId: !!allowRandomProjectIdCheckbox?.checked })
      });
      setStatus('授权成功，账号已添加。', 'success');
      callbackUrlInput.value = '';
      if (customProjectIdInput) customProjectIdInput.value = '';
      replaceIndex = null;
      refreshAccounts();
    } catch (e) {
      setStatus('解析回调 URL 失败: ' + e.message, 'error');
    } finally {
      submitCallbackBtn.disabled = false;
    }
  });
}

// 导入 TOML
if (importTomlBtn && tomlInput) {
  importTomlBtn.addEventListener('click', async () => {
    const content = tomlInput.value.trim();
    if (!content) {
      setStatus('请粘贴 TOML 凭证内容后再导入。', 'error', tomlStatusEl);
      return;
    }
    const replaceExisting = !!replaceExistingCheckbox?.checked;
    const filterDisabled = filterDisabledCheckbox ? !!filterDisabledCheckbox.checked : true;
    try {
      importTomlBtn.disabled = true;
      setStatus('正在导入 TOML 凭证...', 'info', tomlStatusEl);
      const result = await fetchJson('/auth/accounts/import-toml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toml: content, replaceExisting, filterDisabled })
      });
      const summary = `导入成功：有效 ${result.imported ?? 0} 条，跳过 ${result.skipped ?? 0} 条，总计 ${result.total ?? 0} 个账号。`;
      setStatus(summary, 'success', tomlStatusEl);
      tomlInput.value = '';
      refreshAccounts();
      loadLogs();
    } catch (e) {
      setStatus('导入失败: ' + e.message, 'error', tomlStatusEl);
    } finally {
      importTomlBtn.disabled = false;
    }
  });
}

// 选项卡切换
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tabTarget));
});

// 删除停用凭证
if (deleteDisabledBtn) {
  deleteDisabledBtn.addEventListener('click', deleteDisabledAccounts);
}

// 分页
if (prevPageBtn) {
  prevPageBtn.addEventListener('click', () => {
    currentPage = Math.max(1, currentPage - 1);
    renderAccountsList();
  });
}
if (nextPageBtn) {
  nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / pageSize));
    currentPage = Math.min(totalPages, currentPage + 1);
    renderAccountsList();
  });
}

// 每页显示数量变化
if (pageSizeSelect) {
  pageSizeSelect.addEventListener('change', () => {
    pageSize = parseInt(pageSizeSelect.value, 10) || 5;
    currentPage = 1;
    renderAccountsList();
  });
}
if (logPrevPageBtn) {
  logPrevPageBtn.addEventListener('click', () => {
    logCurrentPage = Math.max(1, logCurrentPage - 1);
    renderLogs();
  });
}
if (logNextPageBtn) {
  logNextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(logsData.length / LOG_PAGE_SIZE));
    logCurrentPage = Math.min(totalPages, logCurrentPage + 1);
    renderLogs();
  });
}

// 筛选器
if (statusFilterSelect) {
  statusFilterSelect.addEventListener('change', () => {
    statusFilter = statusFilterSelect.value || 'all';
    updateFilteredAccounts();
  });
}
if (errorFilterCheckbox) {
  errorFilterCheckbox.addEventListener('change', () => {
    errorOnly = !!errorFilterCheckbox.checked;
    updateFilteredAccounts();
  });
}

// 退出登录
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      logoutBtn.disabled = true;
      setStatus('正在退出登录...', 'info');
      await fetch('/admin/logout', { method: 'POST', headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      window.location.href = '/admin/login';
    } catch (e) {
      setStatus('退出录失败: ' + e.message, 'error');
      logoutBtn.disabled = false;
    }
  });
}

// 刷新按钮
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    refreshAccounts();
    loadLogs();
    loadHourlyUsage();
  });
}
if (refreshAllBtn) {
  refreshAllBtn.addEventListener('click', refreshAllAccountsBatch);
}
if (logsRefreshBtn) {
  logsRefreshBtn.addEventListener('click', async () => {
    try {
      logsRefreshBtn.disabled = true;
      await loadLogs();
    } finally {
      logsRefreshBtn.disabled = false;
    }
  });
}
if (logsClearBtn) {
  logsClearBtn.addEventListener('click', async () => {
    if (!confirm('确认清空所有调用日志吗？该操作不可恢复。')) return;
    try {
      logsClearBtn.disabled = true;
      await fetchJson('/admin/logs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      setStatus('调用日志已清空', 'success', statusEl);
      logsData = [];
      logCurrentPage = 1;
      renderLogs();
      await loadHourlyUsage();
    } catch (e) {
      setStatus('清空日志失败: ' + e.message, 'error', statusEl);
    } finally {
      logsClearBtn.disabled = false;
    }
  });
}
if (usageRefreshBtn) {
  usageRefreshBtn.addEventListener('click', async () => {
    try {
      usageRefreshBtn.disabled = true;
      await loadHourlyUsage();
      setStatus('用量已刷新', 'success', usageStatusEl);
    } catch (e) {
      setStatus('刷新用量失败: ' + e.message, 'error', usageStatusEl);
    } finally {
      usageRefreshBtn.disabled = false;
    }
  });
}
if (settingsRefreshBtn) {
  settingsRefreshBtn.addEventListener('click', async () => {
    try {
      settingsRefreshBtn.disabled = true;
      await loadSettings();
    } finally {
      settingsRefreshBtn.disabled = false;
    }
  });
}

// 设置编辑
if (settingsGrid) {
  settingsGrid.addEventListener('click', async event => {
    const target = event.target.closest('.setting-edit-btn');
    if (!target) return;
    await updateSettingValue({
      key: target.dataset.key,
      label: target.dataset.label,
      isSensitive: target.dataset.sensitive === 'true',
      currentValue: target.dataset.current
    });
  });
}

// ==================== 初始化 ====================
refreshAccounts();
loadLogs();
loadHourlyUsage();
loadSettings();
