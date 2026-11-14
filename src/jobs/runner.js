import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, safeError } from '../config.js';
import { credentials } from '../credentials.js';
import { queryDeepSeek, extractWithModel } from '../providers/deepseek.js';
import { validateCompanies } from '../analysis/companies.js';

export class Runner {
  constructor(store, providers = {}) {
    this.store = store; this.queue = []; this.active = null; this.closing = false;
    this.queryProvider = providers.query || queryDeepSeek;
    this.extractProvider = providers.extract || extractWithModel;
    this.configuredOverride = providers.configured;
    this.dataDir = providers.dataDir || config.dataDir;
  }
  get configured() { return this.configuredOverride ?? Boolean(credentials.key); }
  submit(keywordIds, origin = 'manual', options = {}) {
    if (this.closing) throw new Error('服务正在关闭');
    if (!this.configured) throw new Error('尚未配置 DeepSeek API Key');
    if (this.queue.length >= 10) throw new Error('等待任务已达到上限');
    const selected = this.store.keywords().filter(k => k.enabled && (!keywordIds?.length || keywordIds.includes(k.id)));
    if (!selected.length) throw new Error('请先添加并启用查询关键词');
    if (keywordIds?.length && keywordIds.some(id => !selected.some(k => k.id === id))) throw new Error('选择的关键词不存在或未启用');
    const keywords = [...new Set(selected.map(k => k.text))];
    if (keywords.length > 200) throw new Error('单个任务最多 200 个不同关键词');
    const settings = this.store.settings();
    const snapshot = { keywords, model: config.model, promptVersion: 'keyword-first-v2',
      thinking: options.thinking ?? settings.thinking, readUrls: settings.readUrls };
    const id = this.store.createJob(snapshot, origin);
    this.queue.push(id);
    setImmediate(() => this.pump());
    return id;
  }
  cancel(id) {
    if (this.active?.id === id) { this.active.controller.abort(new Error('用户取消任务')); return true; }
    const index = this.queue.indexOf(id);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.store.finishJob(id, 'cancelled');
    return true;
  }
  reanalyze(queryId) {
    if (!this.configured) throw new Error('尚未配置 DeepSeek API Key');
    if (this.closing || this.queue.length >= 10) throw new Error('服务繁忙，请稍后重试');
    const query = this.store.query(queryId);
    if (!query || query.status !== 'completed') throw new Error('只能重新分析已完整生成的回答');
    const original = this.store.job(query.job_id).snapshot;
    const snapshot = { ...original, kind: 'analysis', queryId, keywords: [query.keyword] };
    const id = this.store.createJob(snapshot, 'analysis');
    this.queue.push(id); setImmediate(() => this.pump());
    return id;
  }
  async analyze(query, signal) {
    const raw = await this.extractProvider(query.result.responseText, { signal });
    mkdirSync(resolve(this.dataDir, 'raw'), { recursive: true });
    writeFileSync(resolve(this.dataDir, 'raw', query.raw_file.replace(/\.sse$/, '') + `.analysis-${Date.now()}.json`), JSON.stringify(raw, null, 2));
    const companies = validateCompanies(raw.companies, query.result.responseText);
    if (raw.companies.length && !companies.length) {
      const error = new Error('提取结果未通过原文证据校验'); error.usage = raw.usage; throw error;
    }
    return { companies, extractionUsage: raw.usage, extractionStatus: 'completed' };
  }
  async pump() {
    if (this.active || this.closing) return;
    const id = this.queue.shift();
    if (!id) return;
    const controller = new AbortController();
    this.active = { id, controller, stage: '准备查询', keyword: '' };
    this.store.startJob(id);
    let failures = 0;
    try {
      const snapshot = this.store.job(id).snapshot;
      for (const keyword of snapshot.keywords) {
        if (controller.signal.aborted) break;
        this.active.keyword = keyword;
        let ok;
        if (snapshot.kind === 'analysis') {
          this.active.stage = '重新分析已有回答';
          const query = this.store.query(snapshot.queryId);
          try {
            const analysis = await this.analyze(query, controller.signal);
            this.store.updateAnalysis(query.id, analysis); ok = true;
          } catch (error) {
            this.store.updateAnalysis(query.id, {companies:[],extractionStatus:'failed',extractionError:safeError(error),extractionUsage:error.usage}); ok = false;
          }
        } else ok = await this.runQuery(id, keyword, snapshot, controller.signal);
        if (!ok) failures++;
        this.store.incrementJob(id);
      }
      this.store.finishJob(id, controller.signal.aborted ? 'cancelled' : failures ? 'partial_failed' : 'completed',
        failures ? `${failures} 条查询或公司分析未完成，详情见查询记录` : null);
    } catch (error) { this.store.finishJob(id, 'failed', safeError(error)); }
    finally { this.active = null; if (!this.closing) setImmediate(() => this.pump()); }
  }
  async runQuery(jobId, keyword, snapshot, signal) {
    const started = Date.now();
    mkdirSync(resolve(this.dataDir, 'raw'), { recursive: true });
    const filename = `job-${jobId}-${Date.now()}.sse`;
    const rawPath = resolve(this.dataDir, 'raw', filename);
    const id = this.store.createQuery(jobId, keyword, { ...snapshot, rawFile: filename });
    let result, companies = [], extractionUsage = {}, extractionStatus = 'pending', extractionError = null;
    try {
      this.active.stage = '联网生成回答';
      result = await this.queryProvider(keyword, {
        ...snapshot, signal,
        onEvent: frame => appendFileSync(rawPath, `event: ${frame.event}\ndata: ${frame.data}\n\n`, 'utf8'),
      });
      this.active.stage = '提取出现的公司名称';
      try {
        const extraction = await this.analyze({ result, raw_file: filename }, signal);
        extractionUsage = extraction.extractionUsage;
        companies = extraction.companies;
        extractionStatus = 'completed';
      } catch (error) { extractionStatus = 'failed'; extractionError = safeError(error); extractionUsage = error.usage || {}; }
      this.store.finishQuery(id, { status: signal.aborted ? 'failed' : 'completed', result, companies, extractionStatus, extractionError,
        extractionUsage, durationMs: Date.now() - started,
        error: signal.aborted ? '任务已取消，回答已保留' : null,
      });
      return extractionStatus === 'completed' && !signal.aborted;
    } catch (error) {
      this.store.finishQuery(id, { status: 'failed', result: error.partialResult || result, extractionStatus: 'failed',
        error: safeError(error), durationMs: Date.now() - started,
      });
      return false;
    }
  }
  status() {
    return { active: this.active ? { id: this.active.id, keyword: this.active.keyword, stage: this.active.stage } : null, queued: this.queue.length };
  }
  async shutdown() {
    this.closing = true;
    for (const id of this.queue) this.store.finishJob(id, 'interrupted', '服务关闭，未执行查询');
    this.queue = [];
    this.active?.controller.abort(new Error('服务关闭'));
    while (this.active) await new Promise(resolve => setTimeout(resolve, 50));
  }
}
