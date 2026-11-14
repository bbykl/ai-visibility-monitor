import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(rootDir, '.env'))) process.loadEnvFile(resolve(rootDir, '.env'));
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 配置无效`);
  return value;
}
export const config = Object.freeze({
  apiOrigin: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  host: process.env.HOST || '0.0.0.0',
  port: integer('PORT', 5180, 1024, 65535),
  timeoutMs: integer('QUERY_TIMEOUT_MS', 300000, 1000, 1800000),
  dataDir: resolve(rootDir, process.env.DATA_DIR || 'data'),
});
export function safeError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]').slice(0, 1200);
}
