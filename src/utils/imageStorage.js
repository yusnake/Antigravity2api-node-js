import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/config.js';
import { getDefaultIp } from './utils.js';
import log from './logger.js';
import { uploadToR2, isR2Configured } from './r2Uploader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_DIR = path.join(__dirname, '../../public/images');

// 确保图片目录存在（本地存储模式需要）
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// MIME 类型到文件扩展名映射
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/**
 * 生成唯一文件名
 */
function generateFileName(ext) {
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 9);
  return `${timestamp}_${randomStr}.${ext}`;
}

/**
 * 清理超过限制数量的旧图片（仅本地存储模式使用）
 * @param {number} maxCount - 最大保留图片数量
 */
function cleanOldImages(maxCount = 10) {
  try {
    const files = fs.readdirSync(IMAGE_DIR)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .map(f => ({
        name: f,
        path: path.join(IMAGE_DIR, f),
        mtime: fs.statSync(path.join(IMAGE_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > maxCount) {
      files.slice(maxCount).forEach(f => {
        fs.unlinkSync(f.path);
        log.info(`[ImageStorage] 已清理旧图片: ${f.name}`);
      });
    }
  } catch (e) {
    log.error(`[ImageStorage] 清理旧图片失败: ${e.message}`);
  }
}

/**
 * 保存图片到本地
 */
function saveToLocal(base64Data, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || 'jpg';
  const filename = generateFileName(ext);
  const filepath = path.join(IMAGE_DIR, filename);

  // 解码并保存
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filepath, buffer);

  // 清理旧图片
  cleanOldImages(config.maxImages);

  // 返回访问 URL
  const baseUrl = config.imageBaseUrl || `http://${getDefaultIp()}:${config.server.port}`;
  const url = `${baseUrl}/images/${filename}`;

  log.info(`[ImageStorage] 本地保存: ${filename} (${(buffer.length / 1024).toFixed(2)} KB)`);

  return url;
}

/**
 * 保存图片到 R2
 */
async function saveToR2(base64Data, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || 'jpg';
  const filename = `img/${generateFileName(ext)}`;

  // 解码
  const buffer = Buffer.from(base64Data, 'base64');

  // 上传到 R2
  const url = await uploadToR2(buffer, filename);

  return url;
}

/**
 * 将 base64 转换为 Data URI（base64 模式使用）
 */
function toDataUri(base64Data, mimeType) {
  return `data:${mimeType};base64,${base64Data}`;
}

/**
 * 保存 base64 图片并返回访问 URL
 * 根据 IMAGE_HOST 配置自动选择存储方式
 * @param {string} base64Data - base64 编码的图片数据
 * @param {string} mimeType - 图片 MIME 类型
 * @returns {string|Promise<string>} 图片访问 URL 或 Data URI
 */
export function saveBase64Image(base64Data, mimeType) {
  const imageHost = config.imageHost || 'local';

  log.info(`[ImageStorage] 图床模式: ${imageHost}`);

  // base64 模式：直接返回 Data URI，不保存文件
  if (imageHost === 'base64') {
    const dataUri = toDataUri(base64Data, mimeType);
    log.info(`[ImageStorage] Base64 模式: 返回 Data URI (${(base64Data.length / 1024).toFixed(2)} KB)`);
    return dataUri;
  }

  if (imageHost === 'r2') {
    // 检查 R2 配置是否完整
    if (!isR2Configured()) {
      log.warn('[ImageStorage] R2 配置不完整，回退到本地存储');
      return saveToLocal(base64Data, mimeType);
    }

    // R2 上传是异步的，返回 Promise
    return saveToR2(base64Data, mimeType);
  }

  // 默认本地存储
  return saveToLocal(base64Data, mimeType);
}

/**
 * 同步版本的保存函数（兼容旧代码）
 * 注意：R2 模式下此函数会抛出错误
 */
export function saveBase64ImageSync(base64Data, mimeType) {
  const imageHost = config.imageHost || 'local';

  if (imageHost === 'r2') {
    throw new Error('R2 模式不支持同步保存，请使用 saveBase64Image');
  }

  return saveToLocal(base64Data, mimeType);
}
