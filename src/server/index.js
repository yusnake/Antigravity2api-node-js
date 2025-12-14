import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parseToml } from '../utils/tomlParser.js';
import {
  generateAssistantResponse,
  generateAssistantResponseNoStream,
  generateGeminiResponseNoStream,
  getAvailableModels,
  closeRequester,
  refreshApiClientConfig
} from '../api/client.js';
import { generateRequestBody, generateRequestBodyFromGemini } from '../utils/utils.js';
import { generateProjectId } from '../utils/idGenerator.js';
import {
  mapClaudeToOpenAI,
  mapClaudeToolsToOpenAITools,
  countClaudeTokens,
  ClaudeSseEmitter,
  buildClaudeContentBlocks,
  estimateTokensFromText
} from '../utils/claudeAdapter.js';
import logger from '../utils/logger.js';
import {
  loadDataConfig,
  getEffectiveConfig as getEffectiveDataConfig,
  isDockerOnlyKey,
  getDockerOnlyKeys
} from '../config/dataConfig.js';
import config, { updateEnvValues } from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { buildAuthUrl, exchangeCodeForToken } from '../auth/oauth_client.js';
import { resolveProjectIdFromAccessToken, fetchUserEmail } from '../auth/project_id_resolver.js';
import {
  appendLog,
  getLogDetail,
  getRecentLogs,
  getUsageCountsWithinWindow,
  getUsageSummary,
  clearLogs
} from '../utils/log_store.js';
import quotaManager from '../auth/quota_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const ACCOUNTS_FILE = path.join(__dirname, '..', '..', 'data', 'accounts.json');
const OAUTH_STATE = crypto.randomUUID();
const PANEL_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 管理面板登录有效期：2 小时
const SENSITIVE_HEADERS = ['authorization', 'cookie'];

function getPanelUser() {
  return config.panelUser || 'admin';
}

function isPanelPasswordConfigured() {
  return !!config.panelPassword;
}

function sanitizeHeaders(headers = {}) {
  const result = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    result[key] = SENSITIVE_HEADERS.includes(String(key).toLowerCase()) ? '[REDACTED]' : value;
  });
  return result;
}

function createRequestSnapshot(req) {
  return {
    path: req.originalUrl,
    method: req.method,
    headers: sanitizeHeaders(req.headers),
    query: req.query,
    body: req.body
  };
}

function summarizeStreamEvents(events = []) {
  const summary = { text: '', tool_calls: null, thinking: '' };
  events.forEach(event => {
    if (event?.type === 'tool_calls') {
      summary.tool_calls = event.tool_calls;
    } else if (event?.type === 'thinking') {
      summary.thinking += event.content || '';
    } else if (event?.content) {
      summary.text += event.content;
    }
  });
  return summary;
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function maskSecret(value) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (!str) return null;
  if (str.length <= 4) return '****';
  return `${str.slice(0, 2)}${'*'.repeat(Math.max(4, str.length - 4))}${str.slice(-2)}`;
}

function buildSettingsSummary(configSnapshot = config) {
  const dataConfig = getEffectiveDataConfig();
  const configSource = configSnapshot || config;
  const groups = new Map();

  SETTINGS_DEFINITIONS.forEach(def => {
    // 使用统一配置获取逻辑，而不是直接读取process.env
    const envValue = process.env[def.key];
    const dataValue = dataConfig[def.key];
    const envNormalized = normalizeValue(envValue);
    const dataNormalized = normalizeValue(dataValue);
    const defaultNormalized = normalizeValue(def.defaultValue ?? null);

    // 判断配置来源：Docker环境变量 > data文件 > 默认值
    let source = 'default';
    let resolved = defaultNormalized;

    // Docker专用配置只能从环境变量读取
    if (isDockerOnlyKey(def.key)) {
      if (envValue !== undefined && envValue !== null && envValue !== '') {
        source = 'docker';
        resolved = normalizeValue(envValue);
      }
    } else {
      // 其他配置：data文件 > 默认值 (环境变量只是用于展示，不覆盖实际生效值)
      if (dataValue !== undefined && dataValue !== null && dataValue !== '') {
        source = 'file';
        resolved = dataNormalized;
      } else if (envValue !== undefined && envValue !== null && envValue !== '') {
        // 只有当data文件中没有值时才显示环境变量
        source = 'env';
        resolved = normalizeValue(envValue);
      }
    }

    const isDefault = source === 'default';

    const item = {
      key: def.key,
      label: def.label || def.key,
      value: def.sensitive ? maskSecret(resolved) : resolved,
      defaultValue: defaultNormalized,
      source,
      sensitive: !!def.sensitive,
      isDefault,
      isMissing: resolved === null,
      description: def.description || '',
      dockerOnly: isDockerOnlyKey(def.key) // 标记是否为Docker专用配置
    };

    const groupName = def.category || '未分组';
    if (!groups.has(groupName)) {
      groups.set(groupName, { name: groupName, items: [] });
    }
    groups.get(groupName).items.push(item);
  });

  return Array.from(groups.values());
}

const SETTINGS_DEFINITIONS = [
  {
    key: 'CREDENTIAL_MAX_USAGE_PER_HOUR',
    label: '凭证每小时调用上限',
    category: '限额与重试',
    defaultValue: 20,
    valueResolver: cfg => cfg.credentials.maxUsagePerHour
  },
  {
    key: 'REQUEST_LOG_LEVEL',
    label: '调用日志级别',
    category: '调用日志',
    defaultValue: 'all',
    valueResolver: cfg => cfg.logging.requestLogLevel
  },
  {
    key: 'REQUEST_LOG_MAX_ITEMS',
    label: '调用日志最大保留条数',
    category: '调用日志',
    defaultValue: 200,
    valueResolver: cfg => cfg.logging.requestLogMaxItems
  },
  {
    key: 'REQUEST_LOG_RETENTION_DAYS',
    label: '调用日志保留天数',
    category: '调用日志',
    defaultValue: 7,
    valueResolver: cfg => cfg.logging.requestLogRetentionDays
  },
  {
    key: 'PANEL_USER',
    label: '面板登录用户名',
    category: '面板与安全',
    defaultValue: 'admin',
    valueResolver: () => getPanelUser()
  },
  {
    key: 'PANEL_PASSWORD',
    label: '面板登录密码',
    category: '面板与安全',
    defaultValue: null,
    sensitive: true,
    valueResolver: () => (isPanelPasswordConfigured() ? '已配置' : null),
    description: '用于保护管理界面，未配置将拒绝启动'
  },
  {
    key: 'API_KEY',
    label: 'API 密钥',
    category: '面板与安全',
    defaultValue: null,
    sensitive: true,
    valueResolver: cfg => cfg.security.apiKey || null,
    description: '保护 /v1/* 端点的访问'
  },
  {
    key: 'MAX_REQUEST_SIZE',
    label: '最大请求体',
    category: '面板与安全',
    defaultValue: '50mb',
    valueResolver: cfg => cfg.security.maxRequestSize
  },
  {
    key: 'PORT',
    label: '服务端口',
    category: '服务与网络',
    defaultValue: 8045,
    valueResolver: cfg => cfg.server.port
  },
  {
    key: 'HOST',
    label: '监听地址',
    category: '服务与网络',
    defaultValue: '0.0.0.0',
    valueResolver: cfg => cfg.server.host,
  },
  {
    key: 'API_URL',
    label: '流式接口 URL',
    category: '服务与网络',
    defaultValue:
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    valueResolver: cfg => cfg.api.url
  },
  {
    key: 'API_MODELS_URL',
    label: '模型列表 URL',
    category: '服务与网络',
    defaultValue: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    valueResolver: cfg => cfg.api.modelsUrl
  },
  {
    key: 'API_NO_STREAM_URL',
    label: '非流式接口 URL',
    category: '服务与网络',
    defaultValue:
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
    valueResolver: cfg => cfg.api.noStreamUrl
  },
  {
    key: 'API_HOST',
    label: 'API Host 头',
    category: '服务与网络',
    defaultValue: 'daily-cloudcode-pa.sandbox.googleapis.com',
    valueResolver: cfg => cfg.api.host
  },
  {
    key: 'API_USER_AGENT',
    label: 'User-Agent',
    category: '服务与网络',
    defaultValue: 'antigravity/1.11.3 windows/amd64',
    valueResolver: cfg => cfg.api.userAgent
  },
  {
    key: 'PROXY',
    label: 'HTTP 代理',
    category: '服务与网络',
    defaultValue: null,
    valueResolver: cfg => cfg.proxy
  },
  {
    key: 'TIMEOUT',
    label: '请求超时(ms)',
    category: '服务与网络',
    defaultValue: 180000,
    valueResolver: cfg => cfg.timeout
  },
  {
    key: 'USE_NATIVE_AXIOS',
    label: '使用原生 Axios',
    category: '服务与网络',
    defaultValue: 'false',
    valueResolver: cfg => cfg.useNativeAxios
  },
  {
    key: 'DEFAULT_TEMPERATURE',
    label: '默认温度',
    category: '生成参数',
    defaultValue: 1,
    valueResolver: cfg => cfg.defaults.temperature
  },
  {
    key: 'DEFAULT_TOP_P',
    label: '默认 top_p',
    category: '生成参数',
    defaultValue: 0.85,
    valueResolver: cfg => cfg.defaults.top_p
  },
  {
    key: 'DEFAULT_TOP_K',
    label: '默认 top_k',
    category: '生成参数',
    defaultValue: 50,
    valueResolver: cfg => cfg.defaults.top_k
  },
  {
    key: 'DEFAULT_MAX_TOKENS',
    label: '默认最大 Tokens',
    category: '生成参数',
    defaultValue: 8096,
    valueResolver: cfg => cfg.defaults.max_tokens
  },
  {
    key: 'SYSTEM_INSTRUCTION',
    label: '系统提示词',
    category: '生成参数',
    defaultValue: '',
    valueResolver: cfg => cfg.systemInstruction
  },
  {
    key: 'RETRY_STATUS_CODES',
    label: '重试状态码',
    category: '限额与重试',
    defaultValue: '429,500',
    valueResolver: cfg => cfg.retry.statusCodes
  },
  {
    key: 'RETRY_MAX_ATTEMPTS',
    label: '最大重试次数',
    category: '限额与重试',
    defaultValue: 3,
    valueResolver: cfg => cfg.retry.maxAttempts
  },
  {
    key: 'MAX_IMAGES',
    label: '图片保存上限',
    category: '图床配置',
    defaultValue: 10,
    valueResolver: cfg => cfg.maxImages,
    description: '本地存储最大保留图片数（仅 local 模式有效）'
  },
  {
    key: 'IMAGE_BASE_URL',
    label: '图片访问基础 URL',
    category: '图床配置',
    defaultValue: null,
    valueResolver: cfg => cfg.imageBaseUrl,
    description: '本地图片访问基础 URL（仅 local 模式），留空使用本机 IP'
  },
  {
    key: 'IMAGE_HOST',
    label: '图床类型',
    category: '图床配置',
    defaultValue: 'local',
    valueResolver: cfg => cfg.imageHost,
    description: '图片存储方式：local 本地存储 | base64 直接返回 Data URI | r2 Cloudflare R2'
  },
  {
    key: 'R2_ACCESS_KEY_ID',
    label: 'R2 Access Key ID',
    category: '图床配置',
    defaultValue: null,
    sensitive: true,
    valueResolver: cfg => cfg.r2?.accessKeyId || null,
    description: 'Cloudflare R2 访问密钥 ID'
  },
  {
    key: 'R2_SECRET_ACCESS_KEY',
    label: 'R2 Secret Access Key',
    category: '图床配置',
    defaultValue: null,
    sensitive: true,
    valueResolver: cfg => cfg.r2?.secretAccessKey || null,
    description: 'Cloudflare R2 访问密钥'
  },
  {
    key: 'R2_ENDPOINT',
    label: 'R2 Endpoint',
    category: '图床配置',
    defaultValue: null,
    valueResolver: cfg => cfg.r2?.endpoint || null,
    description: 'Cloudflare R2 端点 URL'
  },
  {
    key: 'R2_BUCKET',
    label: 'R2 Bucket',
    category: '图床配置',
    defaultValue: null,
    valueResolver: cfg => cfg.r2?.bucket || null,
    description: 'Cloudflare R2 存储桶名称'
  },
  {
    key: 'R2_PUBLIC_URL',
    label: 'R2 公开访问 URL',
    category: '图床配置',
    defaultValue: null,
    valueResolver: cfg => cfg.r2?.publicUrl || null,
    description: 'R2 存储桶的公开访问域名'
  }
];

const SETTINGS_MAP = new Map(SETTINGS_DEFINITIONS.map(def => [def.key, def]));

function buildSettingsPayload(configSnapshot = config) {
  return {
    updatedAt: new Date().toISOString(),
    groups: buildSettingsSummary(configSnapshot)
  };
}

// 为了防止误配置导致管理面板完全裸露，这里强制要求配置 PANEL_PASSWORD
if (!config.panelPassword) {
  logger.error(
    'PANEL_PASSWORD 环境变量未配置，出于安全考虑服务将不会启动，请在 Docker 环境变量中设置 PANEL_PASSWORD。'
  );
  process.exit(1);
}

// 启动时校验必须存在的环境变量，防止无认证暴露
if (!config.panelUser) {
  logger.error(
    'PANEL_USER 环境变量未配置，出于安全考虑服务将不会启动，请在 Docker 环境变量中设置 PANEL_USER。'
  );
  process.exit(1);
}

if (!config.security.apiKey) {
  logger.error(
    'API_KEY 环境变量未配置，出于安全考虑服务将不会启动，请在 Docker 环境变量中设置 API_KEY。'
  );
  process.exit(1);
}

const PANEL_AUTH_ENABLED = isPanelPasswordConfigured();
// 使用内存 Map 保存会话：token -> 过期时间戳
const panelSessions = new Map();

// ===== Helper functions for OpenAI-compatible responses =====

const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

const setStreamHeaders = res => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
};

const createStreamChunk = (id, created, model, delta, finish_reason = null, usage = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason }],
  ...(usage ? { usage } : {})
});

const writeStreamData = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const endStream = (res, id, created, model, finish_reason, usage = null) => {
  writeStreamData(res, createStreamChunk(id, created, model, {}, finish_reason, usage));
  res.write('data: [DONE]\n\n');
  res.end();
};

// ===== Global middleware =====

app.use(express.json({ limit: config.security.maxRequestSize }));
app.use(express.urlencoded({ extended: false }));

// Static images for generated image URLs
app.use('/images', express.static(path.join(__dirname, '../../public/images')));

// Request body size error handler
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: `Request entity too large, max ${config.security.maxRequestSize}` });
  }
  return next(err);
});

// Basic request logging (skip images / favicon)
app.use((req, res, next) => {
  if (!req.path.startsWith('/images') && !req.path.startsWith('/favicon.ico')) {
    const start = Date.now();
    res.on('finish', () => {
      const clientIP = req.headers['x-forwarded-for'] ||
        req.headers['x-real-ip'] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        req.ip ||
        'unknown';
      const userAgent = req.headers['user-agent'] || '';
      logger.request(req.method, req.path, res.statusCode, Date.now() - start, clientIP, userAgent);
    });
  }
  next();
});

// 根路径：未登录时跳转登录页，已登录则进入管理面板
app.get('/', (req, res) => {
  if (isPanelAuthed(req)) {
    return res.redirect('/admin/oauth');
  }
  return res.redirect('/admin/login');
});

// API key check for /v1/* 以及 /{credential}/v1/* endpoints（API_KEY 在启动时强制要求配置）
const isProtectedApiPath = pathname => {
  const normalized = pathname || '';
  return /^\/(?:[\w-]+\/)?v1\//.test(normalized);
};

function extractApiKeyFromHeaders(req) {
  const headers = req.headers || {};
  const authHeader = headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  if (authHeader) return authHeader;
  // 兼容各种大小写/横线/下划线写法
  const candidates = [
    headers['x-api-key'],
    headers['api-key'],
    headers['x-api_key'],
    headers['api_key']
  ];
  return candidates.find(v => v) || null;
}

function validateApiKey(req) {
  const apiKey = config.security?.apiKey;
  const providedKey = extractApiKeyFromHeaders(req);

  if (!apiKey) {
    return { ok: false, status: 503, message: 'API Key 未配置' };
  }

  if (!providedKey || providedKey !== apiKey) {
    return { ok: false, status: 401, message: 'Invalid API Key' };
  }

  return { ok: true };
}

function requireApiKey(req, res, next) {
  const result = validateApiKey(req);
  if (!result.ok) {
    logger.warn(`API Key 鉴权失败: ${req.method} ${req.originalUrl || req.url}`);
    return res.status(result.status).json({ error: result.message });
  }
  return next();
}

app.use((req, res, next) => {
  if (isProtectedApiPath(req.path)) {
    const result = validateApiKey(req);
    if (!result.ok) {
      logger.warn(`API Key 鉴权失败: ${req.method} ${req.path}`);
      return res.status(result.status).json({ error: result.message });
    }
  }
  next();
});

// 简单健康检查接口，用于 Docker / 监控探活
app.get('/healthz', (req, res) => {
  const now = new Date();
  const serverTime = now.toISOString();
  const deltaMinutes = 8 * 60 + now.getTimezoneOffset();
  const chinaDate = new Date(now.getTime() + deltaMinutes * 60000);
  const chinaTime = chinaDate.toISOString();

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    serverTime,
    chinaTime
  });
});

// ===== OAuth + simple admin panel =====

function getSessionTokenFromReq(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const item = cookie
    .split(';')
    .map(s => s.trim())
    .find(c => c.startsWith('panel_session='));
  if (!item) return null;
  return decodeURIComponent(item.slice('panel_session='.length));
}

function isPanelAuthed(req) {
  if (!PANEL_AUTH_ENABLED) return true;
  const token = getSessionTokenFromReq(req);
  if (!token) return false;

  const expiresAt = panelSessions.get(token);
  if (!expiresAt) return false;

  // 超过有效期自动失效并清理
  if (Date.now() > expiresAt) {
    panelSessions.delete(token);
    return false;
  }

  return true;
}

function requirePanelAuthPage(req, res, next) {
  if (!isPanelPasswordConfigured()) return next();
  if (isPanelAuthed(req)) return next();
  return res.redirect('/admin/login');
}

function requirePanelAuthApi(req, res, next) {
  if (!isPanelPasswordConfigured()) return next();
  if (isPanelAuthed(req)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function readAccountsSafe() {
  const usageMap = getUsageSummary();
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map((acc, index) => ({
      index,
      projectId: acc.projectId || null,
      email: acc.email || acc.user_email || acc.userEmail || null,
      enable: acc.enable !== false,
      hasRefreshToken: !!acc.refresh_token,
      createdAt: acc.timestamp || null,
      expiresIn: acc.expires_in || null,
      usage: usageMap[acc.projectId] || {
        total: 0,
        success: 0,
        failed: 0,
        lastUsedAt: null,
        models: []
      }
    }));
  } catch (e) {
    logger.error(`读取 accounts.json 失败: ${e.message}`);
    return [];
  }
}

function parseTimestamp(raw) {
  if (raw && Number.isFinite(Number(raw.timestamp))) {
    return Number(raw.timestamp);
  }

  const dateString = raw?.created_at || raw?.createdAt;
  if (dateString) {
    const parsed = Date.parse(dateString);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return Date.now();
}

function normalizeTomlAccount(raw, { filterDisabled = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const accessToken = raw.access_token ?? raw.accessToken;
  const refreshToken = raw.refresh_token ?? raw.refreshToken;

  const isDisabled = raw.disabled === true || raw.enable === false;
  if (filterDisabled && isDisabled) return null;

  if (!accessToken || !refreshToken) return null;

  const normalized = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Number.isFinite(Number(raw.expires_in ?? raw.expiresIn))
      ? Number(raw.expires_in ?? raw.expiresIn)
      : 3600,
    timestamp: parseTimestamp(raw),
    enable: !isDisabled
  };

  const projectId = raw.projectId ?? raw.project_id;
  if (projectId) normalized.projectId = projectId;

  const copyPairs = [
    ['email', 'email'],
    ['user_id', 'user_id'],
    ['userId', 'user_id'],
    ['user_email', 'user_email'],
    ['userEmail', 'user_email'],
    ['last_used', 'last_used'],
    ['lastUsed', 'last_used'],
    ['created_at', 'created_at'],
    ['createdAt', 'created_at'],
    ['next_reset_time', 'next_reset_time'],
    ['nextResetTime', 'next_reset_time'],
    ['daily_limit_claude', 'daily_limit_claude'],
    ['dailyLimitClaude', 'daily_limit_claude'],
    ['daily_limit_gemini', 'daily_limit_gemini'],
    ['dailyLimitGemini', 'daily_limit_gemini'],
    ['daily_limit_total', 'daily_limit_total'],
    ['dailyLimitTotal', 'daily_limit_total'],
    ['claude_sonnet_4_5_calls', 'claude_sonnet_4_5_calls'],
    ['gemini_3_pro_calls', 'gemini_3_pro_calls'],
    ['total_calls', 'total_calls'],
    ['last_success', 'last_success'],
    ['error_codes', 'error_codes'],
    ['gemini_3_series_banned_until', 'gemini_3_series_banned_until']
  ];

  for (const [source, target] of copyPairs) {
    if (raw[source] !== undefined) {
      normalized[target] = raw[source];
    }
  }

  return normalized;
}

function mergeAccounts(existing, incoming, replaceExisting = false) {
  if (replaceExisting) return incoming;

  const map = new Map();

  existing.forEach((acc, idx) => {
    const key = acc.refresh_token || acc.access_token || `existing-${idx}`;
    map.set(key, acc);
  });

  incoming.forEach((acc, idx) => {
    const key = acc.refresh_token || acc.access_token || `incoming-${idx}`;
    const current = map.get(key) || {};
    map.set(key, { ...current, ...acc });
  });

  return Array.from(map.values());
}

// Simple login page for admin panel
app.get('/admin/login', (req, res) => {
  if (!PANEL_AUTH_ENABLED) {
    return res.send(
      '<h1>管理面板未启用登录</h1><p>未配置 PANEL_PASSWORD 环境变量，当前不启用面板密码保护。</p><p><a href="/admin/oauth">进入 OAuth 管理面板</a></p>'
    );
  }

  if (isPanelAuthed(req)) {
    return res.redirect('/admin/oauth');
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN" class="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Antigravity 管理登录</title>
  <script>
    (function() {
      const saved = localStorage.getItem('ag-panel-theme');
      if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      }
    })();
  </script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: { 50:'#eef2ff',100:'#e0e7ff',200:'#c7d2fe',300:'#a5b4fc',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',800:'#3730a3',900:'#312e81' }
          }
        }
      }
    }
  </script>
</head>
<body class="min-h-screen bg-gradient-to-br from-primary-50 via-white to-primary-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <!-- Logo/Icon -->
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-primary-600 dark:bg-primary-500 rounded-2xl shadow-lg mb-4">
        <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
        </svg>
      </div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Antigravity</h1>
      <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">登录管理控制台</p>
    </div>

    <!-- Login Card -->
    <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 p-8">
      <form method="POST" action="/admin/login" class="space-y-5">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">用户名</label>
          <input name="username" autocomplete="username" value="${config.panelUser || 'admin'}"
            class="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">密码</label>
          <input type="password" name="password" autocomplete="current-password"
            class="w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all" />
        </div>
        <button type="submit"
          class="w-full py-3 px-4 bg-primary-600 hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/30 hover:shadow-primary-500/40 transition-all duration-200 flex items-center justify-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"></path>
          </svg>
          登录控制台
        </button>
      </form>

      <div class="mt-6 pt-6 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <p class="text-xs text-gray-500 dark:text-gray-400">环境变量配置账号密码</p>
        <button type="button" id="loginThemeToggle"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-all">
          <svg class="w-4 h-4 hidden dark:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
          <svg class="w-4 h-4 block dark:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>
          <span class="dark:hidden">暗色</span>
          <span class="hidden dark:inline">亮色</span>
        </button>
      </div>
    </div>
  </div>
  <script src="/admin/theme.js"></script>
  <script>
    window.AgTheme?.bindThemeToggle?.(document.getElementById('loginThemeToggle'));
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.post('/admin/login', (req, res) => {
  if (!PANEL_AUTH_ENABLED) {
    return res.redirect('/admin/oauth');
  }

  const { username, password } = req.body || {};
  if (username === getPanelUser() && password === config.panelPassword) {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + PANEL_SESSION_TTL_MS;
    panelSessions.set(token, expiresAt);
    res.setHeader(
      'Set-Cookie',
      `panel_session=${encodeURIComponent(
        token
      )}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
        PANEL_SESSION_TTL_MS / 1000
      )}`
    );
    return res.redirect('/admin/oauth');
  }

  return res
    .status(401)
    .send(`<!DOCTYPE html>
<html lang="zh-CN" class="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>登录失败 - Antigravity</title>
  <script>
    (function() {
      const saved = localStorage.getItem('ag-panel-theme');
      if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      }
    })();
  </script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: { 50:'#eef2ff',100:'#e0e7ff',200:'#c7d2fe',300:'#a5b4fc',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',800:'#3730a3',900:'#312e81' }
          }
        }
      }
    }
  </script>
</head>
<body class="min-h-screen bg-gradient-to-br from-red-50 via-white to-red-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-red-500 rounded-2xl shadow-lg mb-4">
        <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
        </svg>
      </div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">登录失败</h1>
      <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">用户名或密码错误</p>
    </div>
    <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700 p-8">
      <div class="text-center space-y-4">
        <div class="p-4 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800">
          <p class="text-sm text-red-600 dark:text-red-400">请检查您的用户名和密码是否正确，然后重新尝试登录。</p>
        </div>
        <a href="/admin/login" class="inline-flex items-center justify-center gap-2 w-full py-3 px-4 bg-primary-600 hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/30 hover:shadow-primary-500/40 transition-all duration-200">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12"></path>
          </svg>
          返回登录页面
        </a>
      </div>
    </div>
  </div>
</body>
</html>`);
});

// Logout endpoint for admin panel
app.post('/admin/logout', (req, res) => {
  const token = getSessionTokenFromReq(req);
  if (token) {
    panelSessions.delete(token);
  }

  res.setHeader(
    'Set-Cookie',
    'panel_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'
  );

  if (req.accepts('json')) {
    return res.json({ success: true });
  }

  return res.redirect('/admin/login');
});

// Return Google OAuth URL as JSON for front-end
// 前端现在采用“手动粘贴回调 URL”模式，这里仍然返回带 redirect_uri 的完整授权链接
app.get('/auth/oauth/url', requirePanelAuthApi, (req, res) => {
  const redirectUri = `http://localhost:${config.server.port}/oauth-callback`;

  const url = buildAuthUrl(redirectUri, OAUTH_STATE);
  res.json({ url });
});

// 仅作为提示页面使用：不再在这里直接交换 token
// 用户在完成授权后，需要复制浏览器地址栏中的完整 URL，回到管理面板粘贴，由新的解析接口处理
app.get(['/oauth-callback', '/auth/oauth/callback'], (req, res) => {
  return res.send(
    '<!DOCTYPE html>' +
    '<html lang="zh-CN"><head><meta charset="utf-8" />' +
    '<title>授权回调 - 请复制地址栏 URL</title>' +
    '<style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f9fafb;margin:0;padding:24px;color:#111827;}h1{font-size:20px;margin:0 0 12px;}p{margin:6px 0;}code{padding:2px 4px;background:#e5e7eb;border-radius:4px;}</style>' +
    '</head><body>' +
    '<h1>授权流程已返回回调地址</h1>' +
    '<p>请复制当前页面浏览器地址栏中的完整 URL，回到 <code>Antigravity</code> 管理面板，在“粘贴回调 URL”输入框中粘贴并提交。</p>' +
    '<p>提交后，服务端会解析 URL 中的 <code>code</code> 参数并完成账户添加。</p>' +
    '</body></html>'
  );
});

// 解析用户粘贴的回调 URL，交换 code 为 token，写入 accounts.json 并刷新 TokenManager
app.post('/auth/oauth/parse-url', requirePanelAuthApi, async (req, res) => {
  const { url, replaceIndex, customProjectId, allowRandomProjectId } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url 字段必填且必须为字符串' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: '无效的 URL，无法解析' });
  }

  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');

  if (!code) {
    return res.status(400).json({ error: 'URL 中缺少 code 参数' });
  }

  if (state && state !== OAUTH_STATE) {
    logger.warn('OAuth state mismatch in pasted URL, possible CSRF or wrong URL.');
    return res.status(400).json({ error: 'state 校验失败，请确认粘贴的是最新的授权回调地址' });
  }

  // 直接使用构造OAuth链接时相同的 redirectUri，避免不匹配问题
  const redirectUri = `http://localhost:${config.server.port}/oauth-callback`;

  try {
    const tokenData = await exchangeCodeForToken(code, redirectUri);

    let projectId = null;
    let userEmail = null;
    let projectResolveError = null;

    // 优先使用用户自定义的项目ID
    if (customProjectId && typeof customProjectId === 'string' && customProjectId.trim()) {
      projectId = customProjectId.trim();
      logger.info(`使用用户自定义项目ID: ${projectId}`);
    } else if (tokenData?.access_token) {
      // 自动获取项目ID的逻辑
      try {
        // 获取用户邮箱
        userEmail = await fetchUserEmail(tokenData.access_token);
        logger.info(`成功获取用户邮箱: ${userEmail}`);

        // 使用更可靠的Resource Manager方法获取项目ID
        const result = await resolveProjectIdFromAccessToken(tokenData.access_token);
        if (result.projectId) {
          projectId = result.projectId;
          logger.info(`通过Resource Manager获取到项目ID: ${projectId}`);
        } else {
          // 备用方案：使用原有的loadCodeAssist方法
          const loadedProjectId = await tokenManager.fetchProjectId({
            access_token: tokenData.access_token
          });
          if (loadedProjectId !== undefined && loadedProjectId !== null) {
            projectId = loadedProjectId;
            logger.info(`备用方案获取到项目ID: ${projectId}`);
          }
        }
      } catch (err) {
        projectResolveError = err;
      }
    }

    // 如果无法获取项目ID，尝试使用备用方案
    if (!projectId && !allowRandomProjectId) {
      const message =
        projectResolveError?.message ||
        '无法自动获取 Google 项目 ID，对应接口的访问可能出现 403 错误，请检查权限和 API 组件，或选择使用随机 projectId 再申请！';
      return res.status(400).json({ error: message, code: 'PROJECT_ID_MISSING' });
    }

    if (!projectId && allowRandomProjectId) {
      projectId = generateProjectId();
      logger.info(`使用随机生成的项目ID: ${projectId}`);
    }

    const account = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      timestamp: Date.now()
    };

    if (projectId) {
      account.projectId = projectId;
    }

    if (userEmail) {
      account.email = userEmail;
    }

    let accounts = [];
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
      }
    } catch {
      logger.warn('Failed to read accounts.json, will create new file');
    }

    if (!Array.isArray(accounts)) accounts = [];
    if (Number.isInteger(replaceIndex) && replaceIndex >= 0 && replaceIndex < accounts.length) {
      accounts[replaceIndex] = account;
    } else {
      accounts.push(account);
    }

    const dir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');

    // Reload TokenManager so new account becomes usable without restart
    if (typeof tokenManager.initialize === 'function') {
      tokenManager.initialize();
    }

    logger.info(`Token 已保存到 ${ACCOUNTS_FILE}`);

    return res.json({ success: true });
  } catch (e) {
    logger.error('OAuth 交换 token 失败:', e.message);
    return res.status(500).json({ error: `交换 token 失败: ${e.message}` });
  }
});

// Import accounts from TOML and merge into accounts.json
app.post('/auth/accounts/import-toml', requirePanelAuthApi, (req, res) => {
  const {
    toml: tomlContent,
    replaceExisting = false,
    filterDisabled = true
  } = req.body || {};

  if (!tomlContent || typeof tomlContent !== 'string') {
    return res.status(400).json({ error: 'toml 字段必填且必须为字符串' });
  }

  let parsed;
  try {
    parsed = parseToml(tomlContent);
  } catch (e) {
    return res.status(400).json({ error: `TOML 解析失败: ${e.message}` });
  }

  const accountsFromToml = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  if (accountsFromToml.length === 0) {
    return res.status(400).json({ error: '未在 TOML 中找到 accounts 列表' });
  }

  const normalized = [];
  let skipped = 0;

  for (const raw of accountsFromToml) {
    const acc = normalizeTomlAccount(raw, { filterDisabled });
    if (acc) {
      normalized.push(acc);
    } else {
      skipped += 1;
    }
  }

  if (normalized.length === 0) {
    return res.status(400).json({ error: 'TOML 中没有有效的账号信息' });
  }

  let existing = [];
  if (!replaceExisting && fs.existsSync(ACCOUNTS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
      if (!Array.isArray(existing)) existing = [];
    } catch (e) {
      logger.warn(`读取 accounts.json 失败，将忽略已有账号: ${e.message}`);
      existing = [];
    }
  }

  const merged = mergeAccounts(existing, normalized, replaceExisting);

  const dir = path.dirname(ACCOUNTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(merged, null, 2), 'utf-8');

  if (typeof tokenManager.initialize === 'function') {
    tokenManager.initialize();
  }

  return res.json({
    success: true,
    imported: normalized.length,
    skipped,
    total: merged.length
  });
});

// Simple JSON list of accounts for front-end
app.get('/auth/accounts', requirePanelAuthApi, (req, res) => {
  res.json({ accounts: readAccountsSafe() });
});

// Refresh all accounts
app.post('/auth/accounts/refresh-all', requirePanelAuthApi, async (req, res) => {
  try {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.json({ success: true, refreshed: 0, failed: 0, total: 0, results: [] });
    }

    const results = [];
    let refreshed = 0;
    let failed = 0;

    for (let i = 0; i < accounts.length; i += 1) {
      const account = accounts[i];
      if (!account) continue;

      try {
        await tokenManager.refreshToken(account);
        accounts[i] = account;
        refreshed += 1;
        results.push({ index: i, status: 'ok' });
      } catch (e) {
        const statusCode = e?.statusCode;
        if (statusCode === 403 || statusCode === 400) {
          account.enable = false;
        }

        failed += 1;
        results.push({ index: i, status: 'failed', error: e?.message || '刷新失败' });
        logger.warn(`账号 ${i + 1} 刷新失败: ${e?.message || e}`);
      }
    }

    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
    tokenManager.initialize();

    res.json({ success: true, refreshed, failed, total: accounts.length, results });
  } catch (e) {
    logger.error('批量刷新凭证失败', e.message);
    res.status(500).json({ error: e.message || '批量刷新失败' });
  }
});

// Manually refresh a single account by index
app.post('/auth/accounts/:index/refresh', requirePanelAuthApi, async (req, res) => {
  const index = Number.parseInt(req.params.index, 10);
  if (Number.isNaN(index)) return res.status(400).json({ error: '无效的账号序号' });

  try {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    const target = accounts[index];
    if (!target) return res.status(404).json({ error: '账号不存在' });
    await tokenManager.refreshToken(target);
    accounts[index] = target;
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
    tokenManager.initialize();
    res.json({ success: true });
  } catch (e) {
    logger.error('刷新账号失败', e.message);
    res.status(500).json({ error: e.message || '刷新失败' });
  }
});

app.post('/auth/accounts/:index/refresh-project-id', requirePanelAuthApi, async (req, res) => {
  const index = Number.parseInt(req.params.index, 10);
  if (Number.isNaN(index)) return res.status(400).json({ error: 'invalid account index' });

  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      return res.status(404).json({ error: 'accounts.json not found' });
    }

    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    const target = accounts[index];
    if (!target) return res.status(404).json({ error: 'account not found' });

    let accessToken = target.access_token;

    if (!accessToken && target.refresh_token) {
      try {
        await tokenManager.refreshToken(target);
        accessToken = target.access_token;
      } catch (err) {
        logger.error('failed to refresh token before resolving project id', err.message);
        return res
          .status(500)
          .json({ error: err?.message || 'failed to refresh token for this account' });
      }
    }

    if (!accessToken) {
      return res
        .status(400)
        .json({ error: 'no usable access token for this account' });
    }

    const result = await resolveProjectIdFromAccessToken(accessToken);
    if (!result.projectId) {
      const errorMessage =
        result.error?.message ||
        'failed to resolve project id from Resource Manager';
      logger.warn(
        'refresh project id failed: unable to resolve project id from Resource Manager',
        errorMessage
      );
      return res.status(500).json({ error: errorMessage });
    }

    target.projectId = result.projectId;
    accounts[index] = target;

    const dir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');

    if (typeof tokenManager.initialize === 'function') {
      tokenManager.initialize();
    }

    return res.json({ success: true, projectId: result.projectId });
  } catch (e) {
    logger.error('refresh project id failed', e.message);
    return res.status(500).json({ error: e.message || 'refresh project id failed' });
  }
});

// Delete an account
app.delete('/auth/accounts/:index', requirePanelAuthApi, (req, res) => {
  const index = Number.parseInt(req.params.index, 10);
  if (Number.isNaN(index)) return res.status(400).json({ error: '无效的账号序号' });

  try {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!accounts[index]) return res.status(404).json({ error: '账号不存在' });
    accounts.splice(index, 1);
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
    tokenManager.initialize();
    res.json({ success: true });
  } catch (e) {
    logger.error('删除账号失败', e.message);
    res.status(500).json({ error: e.message || '删除失败' });
  }
});

// Toggle enable/disable for an account
app.post('/auth/accounts/:index/enable', requirePanelAuthApi, (req, res) => {
  const index = Number.parseInt(req.params.index, 10);
  const { enable = true } = req.body || {};
  if (Number.isNaN(index)) return res.status(400).json({ error: '无效的账号序号' });

  try {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!accounts[index]) return res.status(404).json({ error: '账号不存在' });
    accounts[index].enable = !!enable;
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
    tokenManager.initialize();
    res.json({ success: true });
  } catch (e) {
    logger.error('更新账号状态失败', e.message);
    res.status(500).json({ error: e.message || '更新失败' });
  }
});

app.get('/admin/settings', requirePanelAuthApi, (req, res) => {
  res.json(buildSettingsPayload());
});

app.post('/admin/settings', requirePanelAuthApi, (req, res) => {
  const { key, value } = req.body || {};

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: '缺少 key，无法更新配置' });
  }

  if (!SETTINGS_MAP.has(key)) {
    return res.status(400).json({ error: `不支持修改的配置项: ${key}` });
  }

  // 检查是否为Docker专用配置
  if (isDockerOnlyKey(key)) {
    return res.status(400).json({
      error: `此配置项 ${key} 为 Docker 专用，请在 docker-compose.yml 的 environment 部分修改`,
      dockerOnly: true
    });
  }

  try {
    const newConfig = updateEnvValues({ [key]: value ?? '' });

    // 特殊配置项的即时处理
    if (
      key === 'CREDENTIAL_MAX_USAGE_PER_HOUR' &&
      typeof tokenManager.setHourlyLimit === 'function'
    ) {
      tokenManager.setHourlyLimit(newConfig.credentials.maxUsagePerHour);
    }

    if (key === 'USE_NATIVE_AXIOS' && typeof refreshApiClientConfig === 'function') {
      refreshApiClientConfig();
    }

    return res.json({ success: true, ...buildSettingsPayload(newConfig) });
  } catch (e) {
    logger.error('更新环境变量失败', e.message || e);
    return res.status(500).json({ error: e.message || '更新配置失败' });
  }
});

app.get('/admin/panel-config', requirePanelAuthApi, (req, res) => {
  res.json({ apiKey: config.security.apiKey || null });
});

app.get('/admin/logs/usage', requirePanelAuthApi, (req, res) => {
  const windowMinutes = 60;
  const limitPerCredential = Number.isFinite(Number(tokenManager.hourlyLimit))
    ? Number(tokenManager.hourlyLimit)
    : null;
  const usage = getUsageCountsWithinWindow(windowMinutes * 60 * 1000);

  res.json({ windowMinutes, limitPerCredential, usage, updatedAt: new Date().toISOString() });
});

// 调用日志配置：仅影响管理面板里的调用日志存储，不影响终端控制台输出
app.get('/admin/logs/settings', requirePanelAuthApi, (req, res) => {
  const raw = (config.logging.requestLogLevel || '').toLowerCase();
  const level = ['off', 'error', 'all'].includes(raw) ? raw : 'all';

  const maxItems = config.logging.requestLogMaxItems;
  const retentionDays = config.logging.requestLogRetentionDays;

  res.json({
    level,
    maxItems,
    retentionDays
  });
});

app.post('/admin/logs/settings', requirePanelAuthApi, (req, res) => {
  const { level } = req.body || {};
  const normalized = String(level || 'all').toLowerCase();

  if (!['off', 'error', 'all'].includes(normalized)) {
    return res.status(400).json({ error: 'REQUEST_LOG_LEVEL 只支持 off / error / all' });
  }

  try {
    updateEnvValues({ REQUEST_LOG_LEVEL: normalized });
    return res.json({ success: true, level: normalized });
  } catch (e) {
    logger.error('更新 REQUEST_LOG_LEVEL 失败', e.message || e);
    return res.status(500).json({ error: e.message || '更新调用日志配置失败' });
  }
});

// Recent request logs
app.get('/admin/logs', requirePanelAuthApi, (req, res) => {
  const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 200;
  res.json({ logs: getRecentLogs(limit) });
});

app.post('/admin/logs/clear', requirePanelAuthApi, (req, res) => {
  try {
    const ok = clearLogs();
    if (!ok) {
      return res.status(500).json({ error: '清空日志失败' });
    }
    return res.json({ success: true });
  } catch (e) {
    logger.error('清空调用日志失败:', e.message || e);
    return res.status(500).json({ error: e.message || '清空日志失败' });
  }
});

app.get('/admin/logs/:id', requirePanelAuthApi, (req, res) => {
  const detail = getLogDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: '日志不存在或已过期' });
  res.json({ log: detail });
});

function parseQuotaIndexes(rawIndexes, total) {
  if (rawIndexes === undefined || rawIndexes === null) return null;

  const normalized = Array.isArray(rawIndexes) ? rawIndexes.join(',') : String(rawIndexes);
  const candidates = normalized
    .split(/[,\s]+/)
    .map(part => parseInt(part, 10))
    .filter(num => Number.isFinite(num));

  const unique = [];
  candidates.forEach(num => {
    const zeroBased = num > 0 ? num - 1 : num;
    if (zeroBased >= 0 && zeroBased < total && !unique.includes(zeroBased)) {
      unique.push(zeroBased);
    }
  });

  return unique;
}

function formatQuotaForResponse(quotaResult) {
  const quota = {};
  const models = quotaResult?.models || {};

  Object.entries(models).forEach(([modelId, info]) => {
    const remainingFraction = Number.isFinite(Number(info?.remaining))
      ? Number(info.remaining)
      : Number(info?.remainingFraction ?? 0);
    const modelQuota = { remainingFraction: remainingFraction || 0 };
    if (info?.resetTime) modelQuota.resetTime = info.resetTime;
    if (info?.resetTimeRaw) modelQuota.resetTimeRaw = info.resetTimeRaw;
    quota[modelId] = modelQuota;
  });

  return {
    code: '成功为200',
    msg: '成功就写获取成功',
    quota
  };
}

function mergeQuota(aggregate, quotaMap) {
  Object.entries(quotaMap || {}).forEach(([modelId, info]) => {
    if (!aggregate[modelId]) {
      aggregate[modelId] = { remainingFraction: 0 };
      if (info.resetTime) aggregate[modelId].resetTime = info.resetTime;
      if (info.resetTimeRaw) aggregate[modelId].resetTimeRaw = info.resetTimeRaw;
    }
    const value = Number.isFinite(Number(info?.remainingFraction))
      ? Number(info.remainingFraction)
      : 0;
    aggregate[modelId].remainingFraction += value;
  });
  return aggregate;
}

// API Key 鉴权的额度查询接口
app.get('/admin/quota/list', requireApiKey, (req, res) => {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      return res.json({ code: '成功为200', msg: '成功就写获取成功', enabled: 0 });
    }

    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    const enabled = Array.isArray(accounts)
      ? accounts.filter(acc => acc && acc.enable !== false).length
      : 0;

    return res.json({ code: '成功为200', msg: '成功就写获取成功', enabled });
  } catch (e) {
    logger.error('/admin/quota/list 获取启用凭证数量失败:', e.message);
    return res
      .status(500)
      .json({ error: e.message || '获取启用凭证数量失败' });
  }
});

app.get('/admin/quota/all', requireApiKey, async (req, res) => {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      return res.status(404).json({ error: 'accounts.json 不存在' });
    }

    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(404).json({ error: '暂无可用凭证' });
    }

    const indexes = parseQuotaIndexes(
      req.query.ids ?? req.query.index ?? req.query.credentials,
      accounts.length
    );
    const targetIndexes =
      indexes && indexes.length > 0
        ? indexes
        : accounts
          .map((_, idx) => idx)
          .filter(idx => accounts[idx]?.enable !== false);

    if (targetIndexes.length === 0) {
      return res.status(404).json({ error: '没有匹配的启用凭证' });
    }

    const payload = {};
    const aggregateQuota = {};

    for (const idx of targetIndexes) {
      const account = accounts[idx];
      const label = `凭证${idx + 1}`;

      if (!account || account.enable === false) {
        payload[label] = { code: '403', msg: '凭证未启用', quota: {} };
        continue;
      }

      if (!account.refresh_token) {
        payload[label] = { code: '400', msg: '凭证缺少 refresh_token', quota: {} };
        continue;
      }

      try {
        const quotaResult = await quotaManager.getQuotas(account.refresh_token, account);
        const formatted = formatQuotaForResponse(quotaResult);
        payload[label] = formatted;
        mergeQuota(aggregateQuota, formatted.quota);
      } catch (e) {
        payload[label] = {
          code: '500',
          msg: e.message || '获取额度失败',
          quota: {}
        };
      }
    }

    payload.all = {
      code: '成功为200',
      msg: '成功就写获取成功',
      quota: aggregateQuota
    };

    return res.json(payload);
  } catch (e) {
    logger.error('/admin/quota/all 获取额度失败:', e.message);
    return res.status(500).json({ error: e.message || '获取额度失败' });
  }
});

// 额度查询接口
app.get('/admin/tokens/:index/quotas', requirePanelAuthApi, async (req, res) => {
  try {
    const index = Number.parseInt(req.params.index, 10);
    if (Number.isNaN(index)) {
      return res.status(400).json({ error: '无效的凭证序号' });
    }

    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    const target = accounts[index];
    if (!target) {
      return res.status(404).json({ error: '凭证不存在' });
    }

    if (!target.refresh_token) {
      return res.status(400).json({ error: '凭证缺少refresh_token' });
    }

    // 使用refreshToken作为缓存键
    const quotas = await quotaManager.getQuotas(target.refresh_token, target);

    // 禁止浏览器缓存额度结果，确保每次查询直连谷歌
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.json({ success: true, data: quotas });
  } catch (e) {
    logger.error('获取额度失败:', e.message);
    res.status(500).json({ error: e.message || '获取额度失败' });
  }
});

// Minimal HTML admin panel for OAuth (served as static file)
app.get('/admin/oauth', requirePanelAuthPage, (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public', 'admin', 'index.html');
  res.sendFile(filePath);
});

// Static assets for admin panel
const adminStatic = express.static(path.join(__dirname, '..', '..', 'public', 'admin'));

// 登录页仍需访问的公共静态资源（如样式、主题脚本），不应被登录保护拦截
const publicAdminAssets = new Set(['/auth.css', '/panel.css', '/theme.js']);

app.use('/admin', (req, res, next) => {
  if (req.method === 'GET' && publicAdminAssets.has(req.path)) {
    return adminStatic(req, res, next);
  }

  // 复用页面级的鉴权逻辑，未登录则重定向到 /admin/login
  requirePanelAuthPage(req, res, err => {
    if (err) return next(err);
    return adminStatic(req, res, next);
  });
});

// ===== API routes =====

const createChatCompletionHandler = (resolveToken, options = {}) => async (req, res) => {
  const { messages, model, stream = true, tools, ...params } = req.body || {};
  const startedAt = Date.now();
  const requestSnapshot = createRequestSnapshot(req);
  const streamEventsForLog = [];
  let responseBodyForLog = null;
  let responseSummaryForLog = null;

  let token = null;
  const writeLog = ({ success, status, message }) => {
    appendLog({
      timestamp: new Date().toISOString(),
      model: model || req.body?.model || 'unknown',
      projectId: token?.projectId || null,
      success,
      status,
      message,
      durationMs: Date.now() - startedAt,
      path: req.originalUrl,
      method: req.method,
      detail: {
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog,
          modelOutput: responseSummaryForLog
        }
      }
    });
    // 同时输出到控制台详细日志
    if (logger.detail) {
      logger.detail({
        method: req.method,
        path: req.originalUrl,
        status,
        durationMs: Date.now() - startedAt,
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog,
          modelOutput: responseSummaryForLog
        },
        error: success ? undefined : message
      });
    }
  };
  try {
    if (!messages) {
      res.status(400).json({ error: 'messages is required' });
      writeLog({ success: false, status: 400, message: 'messages is required' });
      return;
    }

    token = await resolveToken(req);
    if (!token) {
      const message =
        options.tokenMissingError || '没有可用的 token，请先通过 OAuth 面板或 npm run login 获取。';
      const status = options.tokenMissingStatus || 503;
      res.status(status).json({ error: message });
      writeLog({ success: false, status, message });
      return;
    }

    const isImageModel = typeof model === 'string' && model.includes('-image');
    const requestBody = generateRequestBody(messages, model, params, tools, token);

    if (isImageModel) {
      // 为图像模型配置思维链和响应模态，使 gemini-3-pro-image 能返回思维内容
      requestBody.request.generationConfig = {
        candidateCount: 1,
        responseModalities: ["TEXT", "IMAGE"],
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 1024
        }
      };
      requestBody.requestType = 'image_gen';
      requestBody.request.systemInstruction.parts[0].text +=
        '（当前作为图像生成模型使用，请根据描述生成图片）';
      delete requestBody.request.tools;
      delete requestBody.request.toolConfig;
    }

    const { id, created } = createResponseMeta();

    if (stream) {
      setStreamHeaders(res);

      if (isImageModel) {
        // 图像模型使用流式API，实现思维链实时传输
        const imageUrls = [];
        const { usage } = await generateAssistantResponse(requestBody, token, data => {
          streamEventsForLog.push(data);

          if (data.type === 'thinking') {
            // 思维链内容实时发送
            writeStreamData(res, createStreamChunk(id, created, model, { reasoning_content: data.content }));
          } else if (data.type === 'image') {
            // 收集图片URL，最后统一发送
            imageUrls.push(data.url);
          } else if (data.type === 'text') {
            // 文本内容
            writeStreamData(res, createStreamChunk(id, created, model, { content: data.content }));
          }
        });

        // 发送所有图片
        if (imageUrls.length > 0) {
          const markdown = imageUrls.map(url => `![image](${url})`).join('\n\n');
          writeStreamData(res, createStreamChunk(id, created, model, { content: markdown }));
        }

        endStream(res, id, created, model, 'stop', usage);
        responseBodyForLog = { stream: true, image: true, usage, events: streamEventsForLog };
        responseSummaryForLog = summarizeStreamEvents(streamEventsForLog);
      } else {
        let hasToolCall = false;
        const { usage } = await generateAssistantResponse(requestBody, token, data => {
          streamEventsForLog.push(data);

          let delta = {};
          if (data.type === 'tool_calls') {
            // 为兼容 OpenAI 流式规范，这里补充 index 字段
            delta = {
              tool_calls: (data.tool_calls || []).map((toolCall, index) => ({
                index,
                id: toolCall.id,
                type: toolCall.type,
                function: toolCall.function
              }))
            };
          } else if (data.type === 'thinking') {
            // 思维链内容直接放入 reasoning_content（不包含标签）
            const cleanContent = data.content.replace(/^<思考>\n?|\n?<\/思考>$/g, '');
            delta = { reasoning_content: cleanContent };
          } else if (data.type === 'text') {
            // 普通文本内容放入 content（需要过滤掉思考标签）
            const cleanContent = data.content.replace(/<思考>[\s\S]*?<\/思考>/g, '');
            if (cleanContent) {
              delta = { content: cleanContent };
            }
          }

          // 只有当 delta 有内容时才发送
          if (Object.keys(delta).length > 0) {
            if (data.type === 'tool_calls') hasToolCall = true;
            writeStreamData(res, createStreamChunk(id, created, model, delta));
          }
        });
        endStream(res, id, created, model, hasToolCall ? 'tool_calls' : 'stop', usage);
        responseBodyForLog = { stream: true, events: streamEventsForLog, usage };
        responseSummaryForLog = summarizeStreamEvents(streamEventsForLog);
      }
    } else {
      const { content, toolCalls, usage } = await generateAssistantResponseNoStream(
        requestBody,
        token
      );
      const message = { role: 'assistant', content };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;

      const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finishReason
          }
        ],
        usage: usage || null
      });
      responseBodyForLog = { stream: false, choices: [{ message, finish_reason: finishReason }], usage };
      responseSummaryForLog = { text: content, tool_calls: toolCalls, usage };
    }

    writeLog({ success: true, status: res.statusCode || 200 });
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    responseBodyForLog = responseBodyForLog || { error: error.message };
    const errorStatus = error.statusCode || (res.statusCode >= 400 ? res.statusCode : 500);
    writeLog({ success: false, status: errorStatus, message: error.message });
    if (!res.headersSent) {
      const { id, created } = createResponseMeta();
      const errorContent = `错误: ${error.message}`;

      if (stream) {
        setStreamHeaders(res);
        writeStreamData(
          res,
          createStreamChunk(id, created, model || 'unknown', { content: errorContent })
        );
        endStream(res, id, created, model || 'unknown', 'stop');
      } else {
        const status = error.statusCode || 500;
        res.status(status).json({
          id,
          object: 'chat.completion',
          created,
          model: model || 'unknown',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: errorContent },
              finish_reason: 'stop'
            }
          ]
        });
      }
    }
  }
};

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    const clientIP = req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.ip ||
      'unknown';
    const userAgent = req.headers['user-agent'] || '';
    logger.error(`/v1/models 错误详情 [${clientIP}] ${userAgent}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/lits', (req, res) => {
  const limitPerCredential = Number.isFinite(Number(tokenManager.hourlyLimit))
    ? Number(tokenManager.hourlyLimit)
    : null;
  const usageMap = new Map(
    getUsageCountsWithinWindow(60 * 60 * 1000).map(item => [item.projectId, item.count])
  );

  const credentials = (tokenManager.tokens || [])
    .filter(token => token.enable !== false)
    .map(token => {
      const used = usageMap.get(token.projectId) || 0;
      const remaining = limitPerCredential === null ? null : Math.max(limitPerCredential - used, 0);
      return {
        name: token.projectId,
        used_per_hour: used,
        remaining_per_hour: remaining
      };
    });

  res.json({
    credentials,
    windowMinutes: 60,
    limitPerCredential,
    updatedAt: new Date().toISOString()
  });
});

// Gemini 兼容接口：非流式 GenerateContent，直接接收 Gemini Request 并通过 AntigravityRequester 调用后端
app.post('/v1beta/models/:model\\:generateContent', async (req, res) => {
  const startedAt = Date.now();
  const requestSnapshot = createRequestSnapshot(req);
  const model = req.params.model || req.body?.model || 'unknown';

  let token = null;
  let responseBodyForLog = null;

  const writeLog = ({ success, status, message }) => {
    appendLog({
      timestamp: new Date().toISOString(),
      model,
      projectId: token?.projectId || null,
      success,
      status,
      message,
      durationMs: Date.now() - startedAt,
      path: req.originalUrl,
      method: req.method,
      detail: {
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog
        }
      }
    });
    // 同时输出到控制台详细日志
    if (logger.detail) {
      logger.detail({
        method: req.method,
        path: req.originalUrl,
        status,
        durationMs: Date.now() - startedAt,
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog
        },
        error: success ? undefined : message
      });
    }
  };

  try {
    const body = req.body || {};
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      const status = 400;
      const message = 'contents is required for Gemini generateContent';
      res.status(status).json({ error: message });
      writeLog({ success: false, status, message });
      return;
    }

    token = await tokenManager.getToken();
    if (!token) {
      const status = 503;
      const message = '没有可用的 token，请先通过 OAuth 面板或 npm run login 获取。';
      res.status(status).json({ error: message });
      writeLog({ success: false, status, message });
      return;
    }

    // 将 Gemini 原生请求包装成 Antigravity 请求体
    const requestBody = generateRequestBodyFromGemini(body, model, token);

    // 当前只支持非流式：即官方 Gemini 的 :generateContent 语义
    const geminiResponse = await generateGeminiResponseNoStream(requestBody, token);
    responseBodyForLog = geminiResponse;

    res.json(geminiResponse);
    writeLog({ success: true, status: res.statusCode || 200 });
  } catch (error) {
    const status = 500;
    const message = error?.message || 'Gemini generateContent 调用失败';
    res.status(status).json({ error: message });
    writeLog({ success: false, status, message });
  }
});

app.post('/v1/chat/completions', createChatCompletionHandler(() => tokenManager.getToken()));
app.post(
  '/:credential/v1/chat/completions',
  createChatCompletionHandler(
    req => tokenManager.getTokenByProjectId(req.params.credential),
    { tokenMissingError: '指定的凭证不存在或已停用，请检查凭证名。', tokenMissingStatus: 404 }
  )
);

app.post('/v1/messages/count_tokens', (req, res) => {
  const startedAt = Date.now();
  const requestSnapshot = createRequestSnapshot(req);
  let responseBodyForLog = null;

  const writeLog = ({ success, status, message }) => {
    appendLog({
      timestamp: new Date().toISOString(),
      model: req.body?.model || 'unknown',
      projectId: null,
      success,
      status,
      message,
      durationMs: Date.now() - startedAt,
      path: req.originalUrl,
      method: req.method,
      detail: {
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog
        }
      }
    });
    // 同时输出到控制台详细日志
    if (logger.detail) {
      logger.detail({
        method: req.method,
        path: req.originalUrl,
        status,
        durationMs: Date.now() - startedAt,
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog
        },
        error: success ? undefined : message
      });
    }
  };

  try {
    const result = countClaudeTokens(req.body || {});
    responseBodyForLog = result;
    res.json(result);
    writeLog({ success: true, status: res.statusCode || 200 });
  } catch (error) {
    const status = 400;
    const message = error?.message || '璁＄畻澶辫触';
    res.status(status).json({ error: message });
    writeLog({ success: false, status, message });
  }
});

app.post('/v1/messages', async (req, res) => {
  const startedAt = Date.now();
  const requestSnapshot = createRequestSnapshot(req);
  let responseBodyForLog = null;
  let token = null;
  let openaiReq = null;
  let requestBody = null;

  const writeLog = ({ success, status, message }) => {
    appendLog({
      timestamp: new Date().toISOString(),
      model: openaiReq?.model || req.body?.model || 'unknown',
      projectId: token?.projectId || null,
      success,
      status,
      message,
      durationMs: Date.now() - startedAt,
      path: req.originalUrl,
      method: req.method,
      detail: {
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog
        }
      }
    });
    // 同时输出到控制台详细日志
    if (logger.detail) {
      logger.detail({
        method: req.method,
        path: req.originalUrl,
        status,
        durationMs: Date.now() - startedAt,
        request: requestSnapshot,
        response: {
          status,
          headers: res.getHeaders ? res.getHeaders() : undefined,
          body: responseBodyForLog
        },
        error: success ? undefined : message
      });
    }
  };

  try {
    openaiReq = mapClaudeToOpenAI(req.body || {});
    const tokenStats = (() => {
      try {
        return countClaudeTokens(req.body || {});
      } catch {
        return { input_tokens: 0 };
      }
    })();

    token = await tokenManager.getToken();
    if (!token) {
      const message = '娌℃湁鍙敤鐨?token锛岃鍏堥€氳繃 OAuth 闈㈡澘鎴?npm run login 鑾峰彇銆?';
      res.status(503).json({ error: message });
      writeLog({ success: false, status: 503, message });
      return;
    }

    const openaiTools = mapClaudeToolsToOpenAITools(req.body?.tools || []);
    requestBody = generateRequestBody(
      openaiReq.messages,
      openaiReq.model,
      openaiReq,
      openaiTools,
      token
    );

    const requestId = requestBody.requestId;

    if (openaiReq.stream) {
      setStreamHeaders(res);
      const emitter = new ClaudeSseEmitter(res, requestId, {
        model: openaiReq.model,
        inputTokens: tokenStats?.input_tokens || 0
      });
      emitter.start();

      const { usage } = await generateAssistantResponse(requestBody, token, async data => {
        if (data.type === 'thinking') {
          emitter.sendThinking(data.content);
        } else if (data.type === 'text') {
          emitter.sendText(data.content);
        } else if (data.type === 'tool_calls') {
          await emitter.sendToolCalls(data.tool_calls);
        }
      });

      responseBodyForLog = { stream: true, usage };
      emitter.finish(usage);
      writeLog({ success: true, status: res.statusCode || 200 });
    } else {
      const result = await generateAssistantResponseNoStream(requestBody, token);
      const contentBlocks = buildClaudeContentBlocks(result.content, result.toolCalls);
      const outputTokens =
        result.usage?.completion_tokens ??
        result.usage?.output_tokens ??
        (result.content ? estimateTokensFromText(result.content) : 0);

      const payload = {
        id: `msg_${requestId}`,
        type: 'message',
        role: 'assistant',
        model: openaiReq.model,
        content: contentBlocks,
        stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: tokenStats?.input_tokens || 0,
          output_tokens: outputTokens || 0
        }
      };

      responseBodyForLog = payload;
      res.json(payload);
      writeLog({ success: true, status: res.statusCode || 200 });
    }
  } catch (error) {
    logger.error('/v1/messages 璇锋眰澶辫触:', error?.message || error);
    const status = error?.statusCode || 500;
    if (!res.headersSent) {
      res.status(status).json({ error: error?.message || '鏈嶅姟鍣ㄥけ璐?' });
    }
    writeLog({ success: false, status, message: error?.message });
  }
});

// ===== Server bootstrap =====

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务...');
  closeRequester();
  server.close(() => {
    logger.info('服务已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
