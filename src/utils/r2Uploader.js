/**
 * Cloudflare R2 上传工具
 * 使用 AWS S3 V4 签名实现
 */
import crypto from 'crypto';
import config from '../config/config.js';
import log from './logger.js';

// MIME 类型映射
const MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
};

/**
 * HMAC-SHA256 签名
 */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * SHA256 哈希
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 获取签名密钥
 */
function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

/**
 * 上传图片到 R2
 * @param {Buffer} imageBuffer - 图片数据
 * @param {string} fileName - 文件名
 * @returns {Promise<string>} 公开访问 URL
 */
export async function uploadToR2(imageBuffer, fileName) {
  const { accessKeyId, secretAccessKey, endpoint, bucket, publicUrl } = config.r2;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error('R2 配置不完整，请检查 R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET');
  }

  const region = 'auto';
  const service = 's3';
  const host = new URL(endpoint).host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  // 根据文件扩展名确定 Content-Type
  const ext = fileName.split('.').pop()?.toLowerCase() || 'jpg';
  const contentType = MIME_TYPES[ext] || 'image/jpeg';

  const payloadHash = sha256(imageBuffer);
  const canonicalUri = `/${bucket}/${fileName}`;
  const canonicalQuerystring = '';

  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`
  ].join('\n') + '\n';

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = sha256(canonicalRequest);

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const uploadUrl = `${endpoint}${canonicalUri}`;

  log.info(`[R2] 上传文件: ${fileName} (${(imageBuffer.length / 1024).toFixed(2)} KB)`);

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Authorization': authorizationHeader
    },
    body: imageBuffer
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error(`[R2] 上传失败: ${response.status} - ${errorText}`);
    throw new Error(`R2 上传失败: ${response.status} - ${errorText}`);
  }

  // 返回公开访问 URL
  const resultUrl = publicUrl ? `${publicUrl}/${fileName}` : `${endpoint}/${bucket}/${fileName}`;
  log.info(`[R2] 上传成功: ${resultUrl}`);

  return resultUrl;
}

/**
 * 检查 R2 配置是否完整
 */
export function isR2Configured() {
  const { accessKeyId, secretAccessKey, endpoint, bucket } = config.r2 || {};
  return !!(accessKeyId && secretAccessKey && endpoint && bucket);
}
