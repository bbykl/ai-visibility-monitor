import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('dynamic company rates use valid keyword samples and count each company once per answer', () => {
  const store = new Store(':memory:');
  try {
    const job = store.createJob({keywords:['甲词','乙词']},'test');
    const add = (keyword,companies,extractionStatus='completed',status='completed') => {
      const id = store.createQuery(job,keyword,{model:'test',thinking:false,rawFile:'test.sse'});
      store.finishQuery(id,{status,companies,extractionStatus,result:{sources:[{
        url:'https://example.com/'+encodeURIComponent(keyword),domain:'example.com',title:keyword,snippet:'',publishedAt:null,siteName:null,
        searched:true,fetched:keyword==='甲词',cited:true,searchRank:1,
      }],citations:[]},durationMs:1});
    };
    add('甲词',['甲公司','甲公司','乙公司']);
    add('乙词',['乙公司']);
    const job2 = store.createJob({keywords:['甲词','乙词','甲词延长']},'test');
    const addSecond = (keyword,companies,status='completed',extraction='completed') => {
      const id = store.createQuery(job2,keyword,{model:'test',thinking:false,rawFile:'test2.sse'});
      store.finishQuery(id,{status,companies,extractionStatus:extraction,result:{sources:[],citations:[]},durationMs:1});
    };
    addSecond('甲词',[]);
    addSecond('乙词',[],'completed','failed');
    addSecond('甲词延长',['甲公司']);
    const selected = store.companyStats({keyword:'甲词',company:'甲公司'});
    assert.equal(selected.evaluated,2); assert.equal(selected.found,1); assert.equal(selected.rate,.5);
    assert.equal(selected.companies.find(c=>c.name==='甲公司').count,1);
    assert.equal(store.companyStats({keyword:'甲词',company:'集团甲',aliases:['甲公司']}).rate,.5);
    assert.equal(store.companyStats({keyword:'甲词',company:'甲'}).rate,0);
    assert.equal(store.companyStats({keyword:'乙词',company:'乙公司'}).evaluated,1);
    assert.equal(store.companyStats({keyword:'乙词',company:'乙公司'}).excluded,1);
    assert.equal(store.companyStats({keyword:'不存在',company:'甲公司'}).rate,null);
    assert.equal(store.listQueries({keyword:'甲词'}).total,2);
    assert.deepEqual(store.topSources('甲词').map(s=>s.keywords),[['甲词']]);
    assert.equal(store.topSources('乙词')[0].fetched,0);
    assert.equal(store.topSources('不存在').length,0);
    assert.equal(store.listQueries().total,5);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM target_results').get().n,0);
  } finally { store.close(); }
});

test('legacy migration preserves answers and sources while converting companies and keyword configuration only once', () => {
  const dir=mkdtempSync(resolve(tmpdir(),'visibility-migrate-')),path=resolve(dir,'test.sqlite');
  let store=new Store(path);
  try {
    // Build an old-format database in place using the retained legacy tables.
    store.db.prepare("DELETE FROM migrations WHERE name='keyword-first-v2'").run();
    store.db.prepare('INSERT INTO targets(name,aliases,keywords,enabled,created_at) VALUES(?,?,?,?,?)').run('甲公司','[]','["历史关键词"]',1,new Date().toISOString());
    const job=store.createJob({keywords:['历史关键词'],targets:[{name:'甲公司'}]},'manual');
    const id=store.createQuery(job,'历史关键词',{model:'test',thinking:true,rawFile:'saved.sse'});
    store.finishQuery(id,{status:'completed',companies:[],extractionStatus:'completed',result:{responseText:'甲公司',sources:[],citations:[]},durationMs:1});
    store.db.prepare('UPDATE queries SET companies=? WHERE id=?').run(JSON.stringify([{name:'甲公司',explicitRank:1,evidence:'甲公司'}]),id);
    store.close();store=new Store(path);
    assert.deepEqual(store.query(id).companies,['甲公司']);
    assert.equal(store.query(id).result.responseText,'甲公司');
    assert.deepEqual(store.keywords().map(k=>k.text),['历史关键词']);
    assert.equal(store.companyStats({company:'甲公司'}).rate,1);
    store.removeKeyword(store.keywords()[0].id);
    store.close();store=new Store(path);
    assert.equal(store.keywords().length,0); // restart does not recreate deliberately removed configuration
    assert.deepEqual(store.keywordOptions(),['历史关键词']);
  } finally { store.close();rmSync(dir,{recursive:true,force:true}); }
});
