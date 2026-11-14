import { renderMarkdown } from './markdown.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const num = value => Number(value || 0).toLocaleString('zh-CN');
const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' }) : '—';
const names = { completed:'已完成',running:'进行中',queued:'等待中',failed:'失败',partial_failed:'部分失败',interrupted:'已中断',cancelled:'已取消',pending:'等待提取' };
const badge = (status, text = names[status] || status) => `<span class="badge ${['completed','running','failed','partial_failed','interrupted'].includes(status) ? status : ''}">${esc(text)}</span>`;
const empty = text => `<div class="empty"><span>◌</span><p>${esc(text)}</p></div>`;
const metric = (label, value, note, accent = '') => `<div class="metric ${accent}"><div class="metric-label">${esc(label)}</div><strong>${esc(value)}</strong><p>${esc(note)}</p></div>`;
function link(url, title) {
  try { if (!['http:','https:'].includes(new URL(url).protocol)) throw new Error(); }
  catch { return esc(title || url); }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title || url)} <span class="external">↗</span></a>`;
}
async function api(path, options = {}) {
  const res = await fetch('/api' + path, { ...options, headers:{ 'Content-Type':'application/json','X-Requested-With':'visibility-monitor',...options.headers } });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data;
}
const send = (path, body, method = 'POST') => api(path, { method, body:JSON.stringify(body) });
let toastTimer;
function toast(text) { $('#toast').textContent = text; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4500); }
async function action(fn) { try { await fn(); } catch (error) { toast(error.message); } }
let currentView = 'overview', keywords = [], options = [], health, settings, queryOffset = 0, queryTotal = 0, detail, activeDetailTab = 'answer';
const descriptions = {
  overview:['总览','把关键词查询积累为样本，把品牌出现变成可以回看的数据。'],
  queries:['查询记录','每份回答，都是一份独立、可追溯的样本。'],
  companies:['公司洞察','一次收集，多次比较。换个公司，直接计算已有回答。'],
  sources:['来源洞察','按关键词，观察 AI 搜到了什么、读了什么、引用了什么。'],
  keywords:['关键词管理','从你关心的问题出发，独立管理每一次查询。'],
  settings:['设置','简单配置，先把查询稳定跑起来。'],
};
function queryTable(items) {
  if (!items.length) return empty('还没有查询样本，添加关键词后开始第一次查询。');
  return `<div class="table-scroll"><table><thead><tr><th>关键词 / 查询时间</th><th>回答中的公司</th><th>来源记录</th><th>状态</th><th></th></tr></thead><tbody>${items.map(q => `<tr><td><button class="query-title" data-detail="${q.id}">${esc(q.keyword)}</button><div class="subline">${esc(date(q.created_at))} · ${esc(q.model)}</div></td><td><div class="company-preview">${q.companies.slice(0,3).map(c => `<span class="chip">${esc(c)}</span>`).join('')}${q.companies.length > 3 ? `<span class="muted">+${q.companies.length-3}</span>` : ''}${!q.companies.length ? `<span class="muted">${q.extraction_status === 'completed' ? '未提取到公司' : '暂无提取结果'}</span>` : ''}</div><div class="subline">${q.extraction_status === 'failed' ? '提取失败，未计入出现率' : `共 ${q.companies.length} 家公司`}</div></td><td><div class="source-counts"><span>${q.searched} 检索</span><span>${q.fetched} 读取</span><span>${q.cited} 引用</span></div></td><td>${badge(q.status)}${q.status === 'completed' && q.extraction_status === 'failed' ? '<div class="subline warning">公司待提取</div>' : ''}</td><td><button class="text-button" data-detail="${q.id}">查看 ↗</button></td></tr>`).join('')}</tbody></table></div>`;
}
async function loadHealth() {
  health = await api('/health');
  $('#connection').classList.toggle('busy', Boolean(health.active));
  $('#connection').textContent = health.active ? `正在查询 · ${health.active.keyword} / ${health.active.stage}` : health.apiConfigured ? '● 服务已连接 · 官方 API 已配置' : '● 服务已启动 · 请在设置中填写自己的 API Key';
  if (health.schedulerError) $('#connection').textContent += ` · 定时错误：${health.schedulerError}`;
}
async function loadKeywords() {
  [keywords, options] = await Promise.all([api('/keywords'),api('/keyword-options')]);
  for (const el of document.querySelectorAll('.keyword-select')) {
    const selected = el.value;
    el.innerHTML = '<option value="">全部关键词</option>' + options.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
    el.value = options.includes(selected) ? selected : '';
  }
  $('#keywords-table').innerHTML = keywords.length ? `<div class="table-scroll"><table><thead><tr><th>查询关键词</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${keywords.map(k => `<tr><td class="strong">${esc(k.text)}</td><td>${badge(k.enabled ? 'completed' : 'pending', k.enabled ? '已启用' : '已停用')}</td><td class="muted">${esc(date(k.created_at))}</td><td class="row-actions"><button class="text-button" data-edit-keyword="${k.id}">编辑</button><button class="text-button" data-toggle-keyword="${k.id}">${k.enabled ? '停用' : '启用'}</button><button class="text-button danger" data-delete-keyword="${k.id}">删除</button></td></tr>`).join('')}</tbody></table></div>` : empty('添加第一个查询关键词。');
}
async function overview() {
  const [o, jobs, recent] = await Promise.all([api('/overview'),api('/jobs'),api('/queries?limit=5')]);
  $('#overview-metrics').innerHTML = metric('有效回答',num(o.analyzed),`共 ${num(o.queries)} 次查询`, 'accent') + metric('出现的公司',num((await api('/company-stats')).companies.length),'从回答正文提取、去重') + metric('来源链接',num(o.sources),'检索、读取与引用分开记录') + metric('启用关键词',num(o.keywords),'公司切换无需重复查询');
  $('#recent-queries').innerHTML = queryTable(recent.items);
  $('#runner-status').textContent = health?.active ? `${health.active.keyword} · ${health.active.stage}` : '暂无正在执行的任务';
  $('#jobs').innerHTML = jobs.length ? `<div class="job-list">${jobs.slice(0,5).map(j => `<div class="job-row"><span class="job-icon">${j.origin === 'analysis' ? '◎' : '↗'}</span><div><strong>${j.origin === 'analysis' ? '重新提取公司' : '关键词查询'} <span class="muted">#${j.id}</span></strong><div class="subline">${esc(date(j.created_at))} · ${j.completed} / ${j.total} 已处理${j.error ? ` · ${esc(j.error)}` : ''}</div></div>${badge(j.status)}${['running','queued'].includes(j.status) ? `<button class="text-button danger" data-cancel="${j.id}">取消</button>` : ''}</div>`).join('')}</div>` : empty('开始查询后，这里将显示任务进度。');
}
async function loadQueries() {
  const data = await api('/queries?' + new URLSearchParams({keyword:$('#query-keyword').value,limit:20,offset:queryOffset})); queryTotal = data.total;
  $('#queries-table').innerHTML = queryTable(data.items); $('#query-count').textContent = `${data.total} 份样本`;
  $('#query-page').textContent = `${queryTotal ? queryOffset+1 : 0}–${Math.min(queryOffset+20,queryTotal)} / ${queryTotal}`;
  $('#query-prev').disabled = !queryOffset; $('#query-next').disabled = queryOffset+20 >= queryTotal;
}
let statsRequest = 0;
async function companyStats() {
  const request = ++statsRequest, company = $('#analysis-company').value.trim();
  const args = { keyword:$('#analysis-keyword').value,company,aliases:$('#analysis-aliases').value };
  const data = await api('/company-stats?' + new URLSearchParams(args)); if (request !== statsRequest) return;
  localStorage.setItem('visibility-analysis-v2', JSON.stringify(args));
  $('#company-metrics').innerHTML = metric(company ? `${company} · 出现率` : '选择一家公司',company ? percent(data.rate) : '—',company ? `${data.found} / ${data.evaluated} 份有效回答` : '输入名称，或点击下方公司', 'accent') + metric('有效样本',num(data.evaluated),'回答完成且公司提取成功') + metric(company ? '包含公司的回答' : '出现的公司',num(company ? data.found : data.companies.length),company ? '每份回答最多计一次' : '按公司名称去重') + metric('排除的样本',num(data.excluded),'失败、中断或尚未完成');
  $('#company-breakdown-title').textContent = company ? `${company} · 按关键词比较` : '各关键词的样本情况';
  $('#company-breakdown').innerHTML = data.byKeyword.length ? `<div class="table-scroll"><table><thead><tr><th>查询关键词</th><th>有效回答</th><th>包含公司</th><th>出现率</th><th>排除样本</th></tr></thead><tbody>${data.byKeyword.map(k => `<tr><td class="strong">${esc(k.keyword)}</td><td>${k.evaluated}</td><td>${company ? k.found : '—'}</td><td><span class="rate-value">${company ? percent(k.rate) : '—'}</span></td><td class="muted">${k.excluded}</td></tr>`).join('')}</tbody></table></div>` : empty('该关键词还没有查询样本。');
  $('#company-options').innerHTML = data.companies.map(c => `<option value="${esc(c.name)}"></option>`).join('');
  $('#company-frequency-note').textContent = `当前范围 ${data.companies.length} 家公司 · 点击名称计算 · 提及不代表正面推荐`;
  $('#company-frequencies').innerHTML = data.companies.length ? `<div class="frequency-grid">${data.companies.map(c => `<button class="company-card ${c.name === company ? 'selected' : ''}" data-company="${esc(c.name)}"><span class="company-avatar">${esc(c.name.slice(0,1))}</span><span class="company-card-name">${esc(c.name)}<small>${c.count} 份回答中出现</small></span><strong>${percent(c.rate)}<span>↗</span></strong></button>`).join('')}</div>` : empty('暂无可统计的公司名称。');
}
async function sources() {
  const all = await api('/sources?' + new URLSearchParams({keyword:$('#source-keyword').value}));
  const stage = $('#source-stage').value, rows = all.filter(s => stage === 'all' || s[stage] > 0);
  $('#source-count').textContent = `${rows.length} 条来源 / 共 ${all.length} 条`;
  $('#sources-table').innerHTML = rows.length ? `<div class="table-scroll"><table class="sources-table"><thead><tr><th>来源 / 页面</th><th>查询关键词</th><th>检索</th><th>读取</th><th>引用</th></tr></thead><tbody>${rows.map(s => `<tr><td>${link(s.url,s.title || s.domain)}<div class="subline">${esc(s.domain)}</div></td><td><div class="keyword-chips">${s.keywords.map(k => `<span class="chip">${esc(k)}</span>`).join('')}</div></td><td>${num(s.searched)}</td><td><span class="${s.fetched ? 'positive' : 'muted'}">${num(s.fetched)}</span></td><td><span class="${s.cited ? 'positive' : 'muted'}">${num(s.cited)}</span></td></tr>`).join('')}</tbody></table></div>` : empty('当前筛选范围内没有来源。');
}
async function showView() {
  currentView = location.hash.slice(1); if (!descriptions[currentView]) currentView = 'overview';
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== `view-${currentView}`);
  for (const a of document.querySelectorAll('[data-view]')) a.classList.toggle('active',a.dataset.view === currentView);
  $('#page-title').textContent = descriptions[currentView][0]; $('#page-description').textContent = descriptions[currentView][1];
  await refreshView();
}
async function refreshView() {
  if (currentView === 'overview') await overview();
  if (currentView === 'queries') await loadQueries();
  if (currentView === 'companies') await companyStats();
  if (currentView === 'sources') await sources();
  if (currentView === 'keywords') await loadKeywords();
  if (currentView === 'settings') await loadKeyStatus();
}
function renderDetail(tab = 'answer') {
  activeDetailTab = tab;
  const q = detail, r = q.result || {}, sourceList = r.sources || [], cites = r.citations || [];
  $('#detail-tabs').innerHTML = [['answer','原始回答',''],['companies','出现的公司',q.companies.length],['sources','来源记录',sourceList.length],['citations','引用片段',cites.length]].map(([id,label,count]) => `<button class="${tab === id ? 'active' : ''}" data-detail-tab="${id}">${label}${count !== '' ? `<span>${count}</span>` : ''}</button>`).join('');
  const notice = q.error || q.extraction_error;
  let html = notice ? `<div class="info-note warning">${esc(notice)}</div>` : '';
  if (tab === 'answer') html += `<div class="answer-layout"><article class="markdown-body">${r.responseText ? renderMarkdown(r.responseText) : empty('暂时没有回答正文。')}</article><aside class="answer-aside"><div class="eyebrow">这份回答</div><strong>${q.companies.length}<small>家公司被提及</small></strong><dl><div><dt>搜索召回</dt><dd>${sourceList.filter(s => s.searched).length}</dd></div><div><dt>成功读取</dt><dd>${sourceList.filter(s => s.fetched).length}</dd></div><div><dt>回答引用</dt><dd>${sourceList.filter(s => s.cited).length}</dd></div></dl><p>读取由 DeepSeek 官方服务端执行，以工具响应中的成功抓取记录为准。</p><button class="text-button" data-detail-tab="sources">查看来源记录 ↗</button><a class="text-link raw-link" href="/api/queries/${q.id}/raw">下载原始响应 ↓</a></aside></div>`;
  if (tab === 'companies') html += `<div class="section-intro"><h3>正文中出现的公司名称</h3><p>仅保存名称，不绑定目标公司或排名。点击公司可用历史回答计算出现率。</p></div>${q.extraction_status !== 'completed' ? '<div class="info-note warning">公司提取尚未完成，此回答未计入出现率。</div>' : ''}<div class="company-name-grid">${q.companies.map((name,i) => `<button data-company="${esc(name)}" class="name-card"><span>${String(i+1).padStart(2,'0')}</span>${esc(name)}<small>↗</small></button>`).join('')}</div>${!q.companies.length ? empty('暂无公司名称。') : ''}<div class="detail-actions"><button class="button subtle" data-reanalyze="${q.id}" ${q.status !== 'completed' ? 'disabled' : ''}>重新提取名称</button><span class="muted">使用已有回答，不重新联网查询；提取会产生模型用量。</span></div>`;
  if (tab === 'sources') html += `<div class="section-intro"><h3>这次查询的来源足迹</h3><p>检索、读取和引用独立标注；被召回或引用不等于成功读取过全文。</p></div><div class="source-cards">${sourceList.map(s => `<div class="source-card"><div class="source-card-heading"><span class="domain-label">${esc(s.domain)}</span><div class="source-badges">${s.searched ? '<span class="badge">已检索</span>' : ''}${s.fetched ? '<span class="badge completed">已读取</span>' : ''}${s.cited ? '<span class="badge cited">已引用</span>' : ''}</div></div><h3>${link(s.url,s.title || s.url)}</h3>${s.snippet ? `<p>${esc(s.snippet)}</p>` : ''}<div class="subline">${esc(s.siteName || s.domain)}${s.publishedAt ? ` · ${esc(s.publishedAt)}` : ''}</div></div>`).join('')}</div>${!sourceList.length ? empty('暂无来源记录。') : ''}`;
  if (tab === 'citations') html += `<div class="section-intro"><h3>回答使用的引用片段</h3><p>以下内容来自官方响应的引用记录，保留原始片段。</p></div><div class="citation-list">${cites.map((c,i) => `<div class="citation-card"><div><span class="citation-number">${String(i+1).padStart(2,'0')}</span>${link(c.url,c.title || c.url)}</div><blockquote>${esc(c.text || '该引用没有文本片段')}</blockquote></div>`).join('')}</div>${!cites.length ? empty('暂无引用片段。') : ''}`;
  $('#detail-content').innerHTML = html; $('#detail-content').scrollTop = 0;
}
async function showDetail(id) {
  detail = await api('/queries/' + id);
  $('#detail-title').textContent = detail.keyword;
  $('#detail-meta').innerHTML = `${badge(detail.status)}<span>${esc(date(detail.created_at))}</span><span>${esc(detail.model)}</span><span>${detail.thinking ? '深度思考' : '普通模式'}</span><span>样本 #${detail.id}</span>`;
  renderDetail(); $('#detail-dialog').showModal();
}
function editKeyword(id) {
  const k = keywords.find(k => k.id === id), form = $('#keyword-form'); form.reset();
  form.elements.id.value = k?.id || ''; form.elements.text.value = k?.text || ''; form.elements.enabled.checked = k?.enabled ?? true;
  $('#keyword-dialog-title').textContent = k ? '编辑关键词' : '添加关键词'; $('#keyword-dialog').showModal();
}
async function newJob() {
  await loadKeywords();
  const enabled = keywords.filter(k => k.enabled);
  $('#job-keywords').innerHTML = enabled.length ? enabled.map(k => `<label class="job-option"><input type="checkbox" name="keywordIds" value="${k.id}" checked><span>${esc(k.text)}</span></label>`).join('') : empty('请先添加并启用关键词。');
  $('#job-form').elements.thinking.checked = settings.thinking;
  $('#job-form button[type=submit], #job-form .form-footer button').disabled = !enabled.length;
  updateEstimate(); $('#job-dialog').showModal();
}
function updateEstimate() { $('#job-estimate').textContent = `${document.querySelectorAll('#job-keywords input:checked').length} 个关键词，各查询一次`; }
document.addEventListener('click', event => action(async () => {
  const el = event.target.closest('button,[data-close]'); if (!el) return;
  if (el.dataset.close) $(`#${el.dataset.close}`).close();
  if (el.dataset.detail) await showDetail(el.dataset.detail);
  if (el.dataset.detailTab) renderDetail(el.dataset.detailTab);
  if (el.dataset.editKeyword) editKeyword(Number(el.dataset.editKeyword));
  if (el.dataset.toggleKeyword) { const k = keywords.find(k => k.id === Number(el.dataset.toggleKeyword)); await send('/keywords/' + k.id,{...k,enabled:!k.enabled},'PUT'); await loadKeywords(); }
  if (el.dataset.deleteKeyword) { await api('/keywords/'+el.dataset.deleteKeyword,{method:'DELETE'}); await loadKeywords(); toast('已删除关键词配置，历史样本已保留'); }
  if (el.dataset.company) {
    $('#analysis-company').value = el.dataset.company; $('#analysis-aliases').value = '';
    if ($('#detail-dialog').open) { $('#analysis-keyword').value = detail.keyword; $('#detail-dialog').close(); }
    if (location.hash === '#companies') await companyStats(); else location.hash = '#companies';
  }
  if (el.dataset.cancel) { await send('/jobs/'+el.dataset.cancel+'/cancel',{}); await loadHealth(); await refreshView(); }
  if (el.dataset.reanalyze) { el.disabled = true; try { await send('/queries/'+el.dataset.reanalyze+'/reanalyze',{}); toast('已加入提取任务'); } finally { el.disabled = false; } }
}));
$('#new-job').addEventListener('click', () => action(newJob));
$('#add-keyword').addEventListener('click', () => editKeyword());
$('#keyword-form').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const f = event.target, id = f.elements.id.value;
  await send('/keywords'+(id ? '/'+id : ''),{text:f.elements.text.value,enabled:f.elements.enabled.checked},id ? 'PUT' : 'POST');
  $('#keyword-dialog').close(); await loadKeywords(); toast('关键词已保存');
}); });
$('#job-keywords').addEventListener('change',updateEstimate);
$('#job-form').addEventListener('submit', event => { event.preventDefault(); action(async () => {
  const keywordIds = [...$('#job-keywords').querySelectorAll('input:checked')].map(i=>Number(i.value));
  if (!keywordIds.length) throw new Error('请选择至少一个关键词');
  const button = event.target.querySelector('.form-footer button'); button.disabled = true;
  try { const job = await send('/jobs',{keywordIds,thinking:event.target.elements.thinking.checked}); $('#job-dialog').close(); toast(`任务 #${job.id} 已提交`); await loadHealth(); if (location.hash === '#overview') await overview(); else location.hash = '#overview'; }
  finally { button.disabled = false; }
}); });
$('#analysis-form').addEventListener('submit',event => {event.preventDefault();action(companyStats);});
$('#analysis-keyword').addEventListener('change',()=>action(companyStats));
$('#source-keyword').addEventListener('change',()=>action(sources)); $('#source-stage').addEventListener('change',()=>action(sources));
$('#query-keyword').addEventListener('change',()=>{queryOffset=0;action(loadQueries);});
$('#query-prev').addEventListener('click',()=>{queryOffset=Math.max(0,queryOffset-20);action(loadQueries);});
$('#query-next').addEventListener('click',()=>{queryOffset+=20;action(loadQueries);});
$('#refresh-queries').addEventListener('click',()=>action(loadQueries));
$('#refresh-overview').addEventListener('click',()=>action(async()=>{await loadHealth();await overview();}));
async function loadKeyStatus() {
  const state = await api('/credentials');
  $('#key-status').className = 'badge' + (state.configured ? ' completed' : '');
  $('#key-status').textContent = state.configured ? state.source === 'environment' ? '已配置 · 环境变量' : '已配置 · 本机设置' : '尚未配置';
  $('#api-key').placeholder = state.configured ? '已配置，输入新密钥可替换' : 'sk-…';
  $('#remove-key').disabled = !state.configured;
}
async function keyAction(button, fn) {
  const controls = [...$('#credentials-form').querySelectorAll('button')];
  controls.forEach(b => b.disabled=true); $('#key-feedback').textContent='';
  try { await fn(); }
  catch(error) { $('#key-feedback').textContent=error.message; toast(error.message); }
  finally { controls.forEach(b=>b.disabled=false); await loadKeyStatus(); }
}
$('#credentials-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
  const input=$('#api-key'),key=input.value.trim();
  if (!key) { toast('填写新密钥后保存，现有密钥已保留'); return; }
  await keyAction(event.submitter,async()=>{
    await send('/credentials',{apiKey:key},'PUT'); input.value='';
    $('#key-feedback').textContent='密钥已保存并生效。可以验证连接或开始查询。';
    await loadHealth(); toast('密钥已保存');
  });
});});
$('#check-key').addEventListener('click',()=>action(()=>keyAction($('#check-key'),async()=>{
  const key=$('#api-key').value.trim(); $('#key-feedback').textContent='正在连接 DeepSeek…';
  const result=await send('/check-key',key ? {apiKey:key} : {});
  $('#key-feedback').textContent=`连接成功，可用模型：${result.models.join('、') || '已通过验证'}${key ? '。填写的新密钥尚未保存。' : '。'}`;
})));
$('#remove-key').addEventListener('click',()=>action(()=>keyAction($('#remove-key'),async()=>{
  await api('/credentials',{method:'DELETE'}); $('#api-key').value='';
  $('#key-feedback').textContent='密钥已移除。重新填写后可继续查询。'; await loadHealth();
})));
$('#settings-form').addEventListener('submit',event => {event.preventDefault();action(async()=>{
  const f = event.target.elements;
  settings = await send('/settings',{thinking:f.thinking.checked,readUrls:f.readUrls.checked,scheduleEnabled:f.scheduleEnabled.checked,scheduleTimes:f.scheduleTimes.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean),timezone:f.timezone.value.trim()},'PUT'); toast('设置已保存');
});});
window.addEventListener('hashchange',()=>action(showView));
await action(async()=>{
  await loadHealth(); await loadKeywords(); settings = await api('/settings');
  const f = $('#settings-form').elements;
  for (const k of ['thinking','readUrls','scheduleEnabled']) f[k].checked = settings[k];
  f.scheduleTimes.value = settings.scheduleTimes.join(','); f.timezone.value = settings.timezone;
  try { const saved = JSON.parse(localStorage.getItem('visibility-analysis-v2')); if (saved) { $('#analysis-company').value=saved.company || ''; $('#analysis-aliases').value=saved.aliases || ''; $('#analysis-keyword').value=options.includes(saved.keyword) ? saved.keyword : ''; } } catch { /* Optional local view preferences. */ }
  await showView();
});
let polling = false;
setInterval(async()=>{
  if (polling || document.hidden) return;
  polling = true;
  try {
    const wasBusy = health?.active || health?.queued; await loadHealth();
    if (health.active || health.queued || wasBusy) {
      await refreshView();
      if ($('#detail-dialog').open && detail) { detail = await api('/queries/'+detail.id); renderDetail(activeDetailTab); }
    }
  } catch { $('#connection').textContent = '服务连接中断，请检查本机服务'; }
  finally { polling = false; }
},4000);
