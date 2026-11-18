import express from 'express';
import { createServer } from 'node:http';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { config, rootDir, safeError } from './config.js';
import { Store } from './storage/store.js';
import { Runner } from './jobs/runner.js';
import { Scheduler } from './jobs/scheduler.js';
import { verifyKey } from './providers/deepseek.js';
import { credentials, validateApiKey } from './credentials.js';
import { withToolActivity } from './analysis/activity.js';

const app = express();
// Reserve the port before opening SQLite: a duplicate launch must not mark the
// running instance's jobs interrupted.
const server = createServer(app);
try {
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, accept);
  });
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被使用。请打开 http://${config.host}:${config.port}，或修改 .env 中的 PORT。` : safeError(error));
  process.exit(1);
}
const store = new Store(resolve(config.dataDir, 'monitor.sqlite'));
const runner = new Runner(store);
const scheduler = new Scheduler(store, runner);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.get('/vendor/marked.js', (req, res) => res.sendFile(resolve(rootDir, 'node_modules/marked/lib/marked.esm.js')));
app.get('/vendor/purify.js', (req, res) => res.type('application/javascript').sendFile(resolve(rootDir, 'node_modules/dompurify/dist/purify.es.mjs')));
app.use(express.static(resolve(rootDir, 'public')));
const positiveId = value => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new Error('ID 无效'); return id; };
const list = (value, max, length) => {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('列表格式错误');
  const result = [...new Set(value.map(v => v.trim()).filter(Boolean))];
  if (result.length > max || result.some(v => v.length > length)) throw new Error('列表长度超出限制');
  return result;
};
function keywordBody(body) {
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) throw new Error('请输入关键词（1000 字以内）');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('启用状态格式错误');
  return { text: body.text.trim(), enabled: body.enabled !== false };
}
app.get('/api/health', (req, res) => res.json({ ok: true, apiConfigured: Boolean(credentials.key), model: config.model, channel: 'official_api', ...runner.status(), scheduler:scheduler.status(), schedulerError: scheduler.lastError }));
app.get('/api/credentials', (req, res) => res.json(credentials.status()));
function ensureKeyChangeAllowed(res) {
  if (runner.active || runner.queue.length) { res.status(409).json({ error:'请在查询任务结束后修改密钥' }); return false; }
  return true;
}
app.put('/api/credentials', (req, res) => {
  if (!ensureKeyChangeAllowed(res)) return;
  const result = credentials.save(validateApiKey(req.body.apiKey));
  scheduler.reload(); res.json(result);
});
app.delete('/api/credentials', (req, res) => {
  if (!ensureKeyChangeAllowed(res)) return;
  const result = credentials.save('');
  scheduler.reload(); res.json(result);
});
app.post('/api/check-key', async (req, res, next) => {
  try { res.json(await verifyKey(req.body?.apiKey === undefined ? credentials.key : validateApiKey(req.body.apiKey))); }
  catch (error) { next(error); }
});
app.get('/api/keywords', (req, res) => res.json(store.keywords()));
app.get('/api/keyword-options', (req, res) => res.json(store.keywordOptions()));
app.post('/api/keywords', (req, res) => res.status(201).json({ id: store.saveKeyword(keywordBody(req.body)) }));
app.put('/api/keywords/:id', (req, res) => res.json({ id: store.saveKeyword(keywordBody(req.body), positiveId(req.params.id)) }));
app.delete('/api/keywords/:id', (req, res) => res.json({ removed: store.removeKeyword(positiveId(req.params.id)) }));
app.get('/api/settings', (req, res) => res.json(store.settings()));
app.put('/api/settings', (req, res) => {
  const { thinking, readUrls, scheduleEnabled, timezone } = req.body;
  if ([thinking, readUrls, scheduleEnabled].some(v => typeof v !== 'boolean')) throw new Error('开关配置格式错误');
  const times = list(req.body.scheduleTimes, 24, 5);
  if (times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || (scheduleEnabled && !times.length)) throw new Error('定时时间格式为 HH:mm');
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(); } catch { throw new Error('时区无效'); }
  if (typeof timezone !== 'string' || !timezone) throw new Error('请填写时区');
  const settings = { thinking, readUrls, scheduleEnabled, timezone, scheduleTimes: times };
  store.saveSettings(settings); scheduler.reload(); res.json(settings);
});
app.post('/api/jobs', (req, res) => {
  const keywordIds = req.body.keywordIds || [];
  if (!Array.isArray(keywordIds) || keywordIds.length > 200) throw new Error('关键词列表无效');
  if (req.body.thinking !== undefined && typeof req.body.thinking !== 'boolean') throw new Error('思考模式无效');
  const id = runner.submit(keywordIds.map(positiveId), 'manual', { thinking: req.body.thinking });
  res.status(202).json({ id });
});
app.get('/api/jobs', (req, res) => res.json(store.jobs()));
app.get('/api/jobs/:id', (req, res) => {
  const job = store.job(positiveId(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});
app.post('/api/jobs/:id/cancel', (req, res) => res.json({ cancelled: runner.cancel(positiveId(req.params.id)) }));
app.get('/api/queries', (req, res) => res.json(store.listQueries({
  keyword: String(req.query.keyword || '').slice(0, 1000),
  limit: Math.trunc(Math.max(1, Math.min(100, Number(req.query.limit) || 30))),
  offset: Math.trunc(Math.max(0, Math.min(1000000, Number(req.query.offset) || 0))),
})));
app.get('/api/queries/:id', async (req, res) => {
  const query = store.query(positiveId(req.params.id));
  if (!query) return res.status(404).json({ error: '查询不存在' });
  res.json(await withToolActivity(query, config.dataDir));
});
app.post('/api/queries/:id/reanalyze', (req, res) => res.status(202).json({ id: runner.reanalyze(positiveId(req.params.id)) }));
app.get('/api/queries/:id/raw', (req, res) => {
  const query = store.query(positiveId(req.params.id));
  if (!query?.raw_file) return res.status(404).json({ error: '暂无原始响应' });
  const path = resolve(config.dataDir, 'raw', basename(query.raw_file));
  if (!existsSync(path)) return res.status(404).json({ error: '请求未产生响应事件' });
  res.download(path);
});
app.get('/api/overview', (req, res) => res.json(store.overview()));
app.get('/api/sources', (req, res) => res.json(store.topSources(String(req.query.keyword || '').slice(0,1000), {
  sort: req.query.sort, direction: req.query.direction,
})));
app.get('/api/company-stats', (req, res) => res.json(store.companyStats({
  keyword: String(req.query.keyword || '').slice(0,1000), company: String(req.query.company || '').slice(0,100),
  aliases: list(req.query.aliases ? String(req.query.aliases).split(/[,，\n]/) : [], 30, 100),
})));
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((error, req, res, next) => {
  const status = error.httpStatus ? 502 : error.type === 'entity.too.large' ? 413 : 400;
  res.status(status).json({ error: safeError(error) });
});

console.log(`AI 可见度监测：http://${config.host}:${config.port}（定时 ${store.settings().scheduleEnabled ? '开启' : '关闭'}）`);
server.on('error', error => { console.error(safeError(error)); process.exitCode = 1; scheduler.stop(); store.close(); });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true; scheduler.stop(); server.close();
  await runner.shutdown(); store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
