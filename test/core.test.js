import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readSSE, MessageAccumulator } from '../src/providers/sse.js';
import { normalizeMessage } from '../src/analysis/sources.js';
import { validateCompanies, matchesCompany } from '../src/analysis/companies.js';
import { Store } from '../src/storage/store.js';

const response = {
  model: 'deepseek-flash', stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 30 },
  content: [
    { type: 'server_tool_use', id: 'search-1', input: { action:'search', queries:['装修推荐'] } },
    { type: 'web_search_tool_result', tool_use_id:'search-1', content:[
      { type:'web_search_result', url:'https://example.com/a#first', title:'A', snippet:'A 来源' },
      { type:'web_search_result', url:'https://example.com/a#second', title:'A' },
      { type:'web_search_tool_result_error', error_code:'unavailable' },
    ] },
    { type:'server_tool_use', id:'fetch-1', input:{ action:'open_page',url:'https://example.com/b' } },
    { type:'web_fetch_tool_result', tool_use_id:'fetch-1', content:{type:'web_fetch_result',url:'https://example.com/b',content:{title:'B'}} },
    { type:'server_tool_use', id:'fetch-2', input:{action:'open_page',url:'https://example.com/error'} },
    { type:'web_fetch_tool_result', tool_use_id:'fetch-2', content:{type:'web_fetch_tool_result_error',error_code:'url_not_accessible'} },
    { type:'thinking', thinking:'思考不能出现在正文' },
    { type:'text', text:'3. 甲装饰值得考虑。', citations:[{url:'https://example.com/a',title:'A',cited_text:'3. 甲装饰值得考虑。'}] },
    { type:'text', text:'乙设计也有推荐。', citations:[{url:'https://example.com/c',title:null,cited_text:'乙设计也有推荐。'}] },
  ],
};

test('SSE survives individual UTF-8 bytes, CRLF boundaries, multiline data and keepalives', async () => {
  const bytes = new TextEncoder().encode(': ping\r\nevent: update\r\ndata: 第一行\r\ndata: 第二行\r\n\r\ndata: 未结束');
  let i = 0;
  const stream = new ReadableStream({ pull(controller) { if (i === bytes.length) controller.close(); else controller.enqueue(bytes.slice(i,++i)); } });
  const frames = []; for await (const frame of readSSE(stream)) frames.push(frame);
  assert.deepEqual(frames,[{ event:'update',data:'第一行\n第二行' }]);
});
test('stream merges blocks and citations while treating premature EOF as incomplete', () => {
  const m = new MessageAccumulator();
  m.accept({type:'message_start',message:{model:'deepseek-flash',usage:{input_tokens:8}}});
  m.accept({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  m.accept({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'甲'}});
  m.accept({type:'content_block_delta',index:0,delta:{type:'citations_delta',citation:{url:'https://example.com',cited_text:'甲'}}});
  m.accept({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}});
  assert.equal(m.stopped,false);
  m.accept({type:'message_stop'});
  assert.equal(m.stopped,true); assert.equal(m.message().content[0].citations.length,1);
  assert.deepEqual(m.message().usage,{input_tokens:8,output_tokens:3});
  assert.throws(()=>m.accept({type:'error',error:{message:'不可用'}}),/不可用/);
});
test('sources distinguish recall, successful fetch, citation and tool errors', () => {
  const result = normalizeMessage(response);
  assert.equal(result.sources.length,3);
  assert.equal(result.sources[0].searched,true); assert.equal(result.sources[0].cited,true); assert.equal(result.sources[0].fetched,false);
  assert.equal(result.sources[1].fetched,true); assert.equal(result.sources[1].cited,false);
  assert.equal(result.sources[2].cited,true); assert.equal(result.sources[2].searched,false);
  assert.equal(result.searchCalls,1); assert.equal(result.toolErrors.length,2);
  assert.equal(result.toolErrors[1].url,'https://example.com/error');
  assert.equal(result.responseText,'3. 甲装饰值得考虑。乙设计也有推荐。');
});
test('company extraction retains only original names, includes negative mentions, deduplicates and avoids substring matches', () => {
  const text = '3. 甲装饰值得考虑。乙设计也有推荐。';
  const companies = validateCompanies([
    {name:'甲装饰',explicitRank:3,evidence:'3. 甲装饰值得考虑。'},
    {name:'乙设计',explicitRank:null,evidence:'乙设计也有推荐。'},
    {name:'丙装修',explicitRank:1,evidence:'不存在'},
  ],text);
  assert.deepEqual(companies,['甲装饰','乙设计']);
  assert.deepEqual(validateCompanies(['乙公司','甲公司','甲公司','不存在'], '甲公司被投诉，乙公司被推荐'), ['甲公司','乙公司']);
  assert.equal(matchesCompany(companies,'甲'),false);
  assert.equal(matchesCompany(companies,'甲装饰集团',['甲装饰']),true);
});
test('storage commits sources atomically and retains history after keyword deletion', () => {
  const store = new Store(':memory:');
  try {
    const keywordId = store.saveKeyword({text:'装修推荐'});
    const jobId = store.createJob({keywords:['装修推荐']},'manual');
    const id = store.createQuery(jobId,'装修推荐',{model:'deepseek-flash',thinking:true,rawFile:'sample.sse'});
    store.finishQuery(id,{status:'completed',result:normalizeMessage(response),companies:['甲装饰'],extractionStatus:'completed',durationMs:12});
    assert.equal(store.query(id).result.citations.length,2);
    assert.equal(store.listQueries().items[0].searched,1);
    assert.equal(store.topSources().length,3);
    assert.equal(store.companyStats({company:'甲装饰'}).found,1);
    store.removeKeyword(keywordId);
    assert.deepEqual(store.query(id).companies,['甲装饰']);
    assert.deepEqual(store.keywordOptions(),['装修推荐']);
    const second = store.createQuery(jobId,'另一个词',{model:'deepseek-flash',thinking:false,rawFile:'two.sse'});
    assert.throws(()=>store.finishQuery(second,{status:'completed',result:{sources:[{url:'https://bad.test',domain:'bad.test',searched:true}]},durationMs:1}));
    assert.equal(store.query(second).status,'running');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE domain='bad.test'").get().n,0);
  } finally { store.close(); }
});
test('restart marks unfinished work interrupted without replaying it', () => {
  const dir = mkdtempSync(resolve(tmpdir(),'visibility-test-'));
  const file = resolve(dir,'test.sqlite');
  let store = new Store(file);
  const id = store.createJob({keywords:['词']},'manual');
  store.startJob(id); store.close();
  store = new Store(file);
  try { assert.equal(store.job(id).status,'interrupted'); }
  finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
