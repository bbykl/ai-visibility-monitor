import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { companyNames, matchesCompany, normalizeName } from '../analysis/companies.js';

const decode = value => JSON.parse(value || 'null');
const now = () => new Date().toISOString();
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS keywords (
        id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL, keywords TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, status TEXT NOT NULL, origin TEXT NOT NULL, snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL, finished_at TEXT, total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), keyword TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, error TEXT,
        model TEXT NOT NULL, thinking INTEGER NOT NULL, channel TEXT NOT NULL DEFAULT 'official_api',
        result TEXT, companies TEXT, extraction_status TEXT NOT NULL DEFAULT 'pending', extraction_error TEXT,
        extraction_usage TEXT, raw_file TEXT, duration_ms INTEGER, UNIQUE(job_id, keyword));
      CREATE TABLE IF NOT EXISTS target_results (
        query_id INTEGER NOT NULL REFERENCES queries(id), target_id INTEGER NOT NULL, target_name TEXT NOT NULL,
        status TEXT NOT NULL, company TEXT, PRIMARY KEY(query_id,target_id));
      CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, domain TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS query_sources (
        query_id INTEGER NOT NULL REFERENCES queries(id), source_id INTEGER NOT NULL REFERENCES sources(id),
        title TEXT, snippet TEXT, published_at TEXT, site_name TEXT,
        searched INTEGER NOT NULL, fetched INTEGER NOT NULL, cited INTEGER NOT NULL, search_rank INTEGER,
        PRIMARY KEY(query_id, source_id));
      CREATE TABLE IF NOT EXISTS citations (
        id INTEGER PRIMARY KEY, query_id INTEGER NOT NULL REFERENCES queries(id),
        source_id INTEGER NOT NULL REFERENCES sources(id), block_index INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_query_job ON queries(job_id);
      CREATE INDEX IF NOT EXISTS idx_query_created ON queries(created_at);
      CREATE INDEX IF NOT EXISTS idx_target_result ON target_results(target_id);
    `);
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE name='keyword-first-v2'").get()) this.transaction(() => {
      const keywords = new Set(this.db.prepare('SELECT DISTINCT keyword FROM queries').all().map(q => q.keyword));
      for (const target of this.targets()) for (const keyword of target.keywords) keywords.add(keyword);
      for (const keyword of keywords) this.saveKeyword({ text: keyword, enabled: true });
      for (const row of this.db.prepare('SELECT id,companies FROM queries WHERE companies IS NOT NULL').all()) {
        this.db.prepare('UPDATE queries SET companies=? WHERE id=?').run(JSON.stringify(companyNames(decode(row.companies))), row.id);
      }
      this.db.prepare("INSERT INTO migrations VALUES('keyword-first-v2')").run();
    });
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(1, ?)').run(JSON.stringify({
      thinking: true, readUrls: false, scheduleEnabled: false, scheduleTimes: ['09:00', '14:00', '20:00'], timezone: 'Asia/Shanghai',
    }));
    // A process restart never replays a billable query automatically.
    this.db.prepare("UPDATE jobs SET status='interrupted', finished_at=?, error='服务重启，任务已中断，可手动重试' WHERE status IN ('queued','running')").run(now());
    this.db.prepare("UPDATE queries SET status='interrupted', finished_at=?, extraction_status=CASE WHEN extraction_status='pending' THEN 'failed' ELSE extraction_status END, error='服务重启，查询已中断' WHERE status='running'").run(now());
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  targets() {
    // Legacy configuration is read only by the one-time migration.
    return this.db.prepare('SELECT * FROM targets ORDER BY id').all().map(row => ({ ...row,
      aliases: decode(row.aliases), keywords: decode(row.keywords), enabled: Boolean(row.enabled) }));
  }
  settings() { return decode(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value); }
  keywords() { return this.db.prepare('SELECT * FROM keywords ORDER BY id').all().map(k => ({ ...k, enabled: Boolean(k.enabled) })); }
  keywordOptions() {
    return this.db.prepare('SELECT text FROM keywords UNION SELECT keyword AS text FROM queries ORDER BY text').all().map(k => k.text);
  }
  saveKeyword({ text, enabled = true }, id) {
    if (id) {
      const result = this.db.prepare('UPDATE keywords SET text=?,enabled=? WHERE id=?').run(text, Number(enabled), id);
      if (!result.changes) throw new Error('关键词不存在');
      return id;
    }
    const existing = this.db.prepare('SELECT id FROM keywords WHERE text=?').get(text);
    if (existing) return existing.id;
    return Number(this.db.prepare('INSERT INTO keywords(text,enabled,created_at) VALUES(?,?,?)').run(text, Number(enabled), now()).lastInsertRowid);
  }
  removeKeyword(id) { return this.db.prepare('DELETE FROM keywords WHERE id=?').run(id).changes > 0; }
  saveSettings(settings) { this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(settings)); }
  createJob(snapshot, origin) {
    return Number(this.db.prepare("INSERT INTO jobs(status,origin,snapshot,created_at,total) VALUES('queued',?,?,?,?)")
      .run(origin, JSON.stringify(snapshot), now(), snapshot.keywords.length).lastInsertRowid);
  }
  job(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? { ...row, snapshot: decode(row.snapshot) } : null;
  }
  jobs() { return this.db.prepare('SELECT id,status,origin,created_at,finished_at,total,completed,error FROM jobs ORDER BY id DESC LIMIT 40').all(); }
  startJob(id) { this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id); }
  finishJob(id, status, error = null) { this.db.prepare('UPDATE jobs SET status=?,error=?,finished_at=? WHERE id=?').run(status, error, now(), id); }
  incrementJob(id) { this.db.prepare('UPDATE jobs SET completed=completed+1 WHERE id=?').run(id); }
  updateAnalysis(id, { companies, extractionStatus, extractionError = null, extractionUsage = {} }) {
    this.transaction(() => {
      const previous = decode(this.db.prepare('SELECT extraction_usage FROM queries WHERE id=?').get(id).extraction_usage) || {};
      const usage = { input_tokens: (previous.input_tokens || 0) + (extractionUsage.input_tokens || 0),
        cache_read_input_tokens: (previous.cache_read_input_tokens || 0) + (extractionUsage.cache_read_input_tokens || 0),
        output_tokens: (previous.output_tokens || 0) + (extractionUsage.output_tokens || 0) };
      this.db.prepare('UPDATE queries SET companies=?,extraction_status=?,extraction_error=?,extraction_usage=? WHERE id=?')
        .run(JSON.stringify(companyNames(companies)), extractionStatus, extractionError, JSON.stringify(usage), id);
    });
  }
  createQuery(jobId, keyword, options) {
    return Number(this.db.prepare("INSERT INTO queries(job_id,keyword,status,created_at,model,thinking,raw_file) VALUES(?,?,'running',?,?,?,?)")
      .run(jobId, keyword, now(), options.model, Number(options.thinking), options.rawFile).lastInsertRowid);
  }
  finishQuery(id, { status, result, companies = [], extractionStatus = 'failed', extractionError = null, extractionUsage = {}, error = null, durationMs }) {
    this.transaction(() => {
      this.db.prepare(`UPDATE queries SET status=?,finished_at=?,result=?,companies=?,extraction_status=?,extraction_error=?,extraction_usage=?,error=?,duration_ms=? WHERE id=?`)
        .run(status, now(), JSON.stringify(result || null), JSON.stringify(companyNames(companies)), extractionStatus, extractionError, JSON.stringify(extractionUsage), error, durationMs, id);
      for (const item of result?.sources || []) {
        this.db.prepare('INSERT OR IGNORE INTO sources(url,domain) VALUES(?,?)').run(item.url, item.domain);
        const sourceId = this.db.prepare('SELECT id FROM sources WHERE url=?').get(item.url).id;
        this.db.prepare('INSERT INTO query_sources VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          id, sourceId, item.title, item.snippet, item.publishedAt, item.siteName,
          Number(item.searched), Number(item.fetched), Number(item.cited), item.searchRank,
        );
      }
      for (const cite of result?.citations || []) {
        const sourceId = this.db.prepare('SELECT id FROM sources WHERE url=?').get(cite.url)?.id;
        if (sourceId) this.db.prepare('INSERT INTO citations(query_id,source_id,block_index,text) VALUES(?,?,?,?)').run(id, sourceId, cite.blockIndex, cite.text);
      }
    });
  }
  query(id) {
    const row = this.db.prepare('SELECT * FROM queries WHERE id=?').get(id);
    if (!row) return null;
    return { ...row, thinking: Boolean(row.thinking), result: decode(row.result), companies: companyNames(decode(row.companies) || []),
      extraction_usage: decode(row.extraction_usage),
    };
  }
  listQueries({ limit = 50, offset = 0, keyword = '' } = {}) {
    const condition = "WHERE (?='' OR q.keyword=?)";
    const args = [keyword, keyword];
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM queries q ${condition}`).get(...args).n;
    const items = this.db.prepare(`SELECT q.id,q.job_id,q.keyword,q.status,q.created_at,q.model,q.thinking,q.error,q.extraction_status,q.duration_ms,q.companies,
      json_extract(result,'$.searchTriggered') AS search_triggered,
      (SELECT COUNT(*) FROM query_sources s WHERE s.query_id=q.id AND s.searched=1) AS searched,
      (SELECT COUNT(*) FROM query_sources s WHERE s.query_id=q.id AND s.fetched=1) AS fetched,
      (SELECT COUNT(*) FROM query_sources s WHERE s.query_id=q.id AND s.cited=1) AS cited
      FROM queries q ${condition} ORDER BY q.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    for (const item of items) item.companies = companyNames(decode(item.companies) || []);
    return { total, items };
  }
  overview() {
    const row = this.db.prepare(`SELECT COUNT(*) AS queries, SUM(status='completed') AS completed, SUM(status IN ('failed','interrupted')) AS failed FROM queries`).get();
    const daily = this.db.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS samples
      FROM queries WHERE status='completed' GROUP BY day ORDER BY day DESC LIMIT 14`).all().reverse();
    const usage = this.db.prepare('SELECT result,extraction_usage FROM queries WHERE result IS NOT NULL').all().reduce((sum, query) => {
      for (const use of [decode(query.result)?.usage || {}, decode(query.extraction_usage) || {}]) {
        sum.inputTokens += (use.input_tokens || 0) + (use.cache_read_input_tokens || 0) + (use.cache_creation_input_tokens || 0);
        sum.outputTokens += use.output_tokens || 0;
        sum.searchCalls += use.server_tool_use?.tool_search || 0;
        sum.fetchCalls += use.server_tool_use?.tool_fetch || 0;
      }
      return sum;
    }, { inputTokens: 0, outputTokens: 0, searchCalls: 0, fetchCalls: 0 });
    return { ...row, keywords: this.keywords().filter(k => k.enabled).length,
      analyzed: this.db.prepare("SELECT COUNT(*) AS n FROM queries WHERE status='completed' AND extraction_status='completed'").get().n,
      sources: this.db.prepare('SELECT COUNT(DISTINCT source_id) AS n FROM query_sources s JOIN queries q ON q.id=s.query_id WHERE q.status=\'completed\'').get().n, daily, usage };
  }
  topSources(keyword = '') {
    const rows = this.db.prepare(`SELECT s.url,s.domain, MAX(qs.title) AS title, COUNT(*) AS appearances,
      SUM(qs.searched) AS searched, SUM(qs.fetched) AS fetched,SUM(qs.cited) AS cited,
      json_group_array(DISTINCT q.keyword) AS keywords
      FROM sources s JOIN query_sources qs ON qs.source_id=s.id JOIN queries q ON q.id=qs.query_id
      WHERE q.status='completed' AND (?='' OR q.keyword=?)
      GROUP BY s.id ORDER BY cited DESC, fetched DESC, searched DESC, s.url`).all(keyword, keyword);
    return rows.map(r => ({ ...r, keywords: decode(r.keywords) }));
  }
  companyStats({ keyword = '', company = '', aliases = [] } = {}) {
    const rows = this.db.prepare(`SELECT keyword,status,extraction_status,companies,created_at FROM queries
      WHERE (?='' OR keyword=?)`).all(keyword, keyword);
    const groups = new Map(), frequencies = new Map(), days = new Map();
    let evaluated = 0, found = 0, excluded = 0;
    for (const row of rows) {
      if (!groups.has(row.keyword)) groups.set(row.keyword, { keyword: row.keyword, evaluated: 0, found: 0, excluded: 0 });
      const group = groups.get(row.keyword);
      if (row.status !== 'completed' || row.extraction_status !== 'completed') { group.excluded++; excluded++; continue; }
      const names = companyNames(decode(row.companies) || []);
      const hit = matchesCompany(names, company, aliases);
      evaluated++; group.evaluated++; if (hit) { found++; group.found++; }
      const day = row.created_at.slice(0,10);
      if (!days.has(day)) days.set(day, { day, evaluated: 0, found: 0 });
      days.get(day).evaluated++; if (hit) days.get(day).found++;
      for (const name of names) {
        const key = normalizeName(name);
        if (!frequencies.has(key)) frequencies.set(key, { name, count: 0 });
        frequencies.get(key).count++;
      }
    }
    const rate = item => ({ ...item, rate: item.evaluated ? item.found / item.evaluated : null });
    return { company, aliases, keyword, ...rate({ evaluated, found, excluded }),
      byKeyword: [...groups.values()].map(rate), daily: [...days.values()].sort((a,b) => a.day.localeCompare(b.day)).map(rate),
      companies: [...frequencies.values()].sort((a,b) => b.count-a.count || a.name.localeCompare(b.name,'zh-CN')).map(c => ({ ...c, rate: evaluated ? c.count/evaluated : null })) };
  }
  close() { this.db.close(); }
}
