import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export function validateApiKey(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error('API Key 格式错误');
  const key = value.trim();
  if (allowEmpty && key === '') return '';
  if (!/^sk-[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('请输入有效的 DeepSeek API Key（以 sk- 开头）');
  return key;
}

export class Credentials {
  constructor(path, environmentKey = '') {
    this.path = path; this.environmentKey = environmentKey; this.localKey = undefined;
    if (existsSync(path)) {
      try { this.localKey = validateApiKey(JSON.parse(readFileSync(path,'utf8')).apiKey, { allowEmpty:true }); }
      catch { throw new Error('本机密钥配置文件格式错误，请检查 data/credentials.json'); }
    }
  }
  get key() { return this.localKey ?? this.environmentKey; }
  status() {
    return { configured:Boolean(this.key), source:this.key ? this.localKey !== undefined ? 'settings' : 'environment' : 'none' };
  }
  save(value) {
    const key = validateApiKey(value, { allowEmpty:true });
    mkdirSync(dirname(this.path), { recursive:true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ apiKey:key })+'\n', { encoding:'utf8', mode:0o600, flag:'wx' });
      renameSync(temporary,this.path);
      this.localKey = key;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return this.status();
  }
}

// Explicit dashboard configuration takes precedence over an optional .env key.
// An explicitly removed key remains empty, rather than silently reusing .env.
export const credentials = new Credentials(resolve(config.dataDir,'credentials.json'), process.env.DEEPSEEK_API_KEY || '');
