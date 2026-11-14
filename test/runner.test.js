import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Runner } from '../src/jobs/runner.js';

async function settled(store, id) {
  const deadline = Date.now() + 5000;
  while (['queued','running'].includes(store.job(id).status)) {
    if (Date.now() > deadline) throw new Error('测试任务没有结束');
    await new Promise(r=>setTimeout(r,10));
  }
  return store.job(id);
}
test('keyword queries have no company prerequisite; switching company and reanalysis reuse the same web answer', async () => {
  const dir = mkdtempSync(resolve(tmpdir(),'visibility-runner-'));
  const store = new Store(':memory:'); let calls = 0;
  const runner = new Runner(store, { dataDir:dir, configured:true,
    query:async()=>{calls++; return {responseText:'3. **甲装饰**值得考虑。',sources:[],citations:[],usage:{},stopReason:'end_turn'};},
    extract:async()=>({companies:['甲装饰'],usage:{input_tokens:5}}),
  });
  try {
    store.saveKeyword({text:'装修推荐'});
    store.saveKeyword({text:'装修推荐'});
    const jobId = runner.submit([]);
    assert.equal((await settled(store,jobId)).status,'completed');
    assert.equal(calls,1); assert.equal(store.listQueries().total,1);
    const query = store.query(1);
    assert.deepEqual(query.companies,['甲装饰']);
    assert.equal(query.targets,undefined);
    assert.equal(store.companyStats({company:'甲装饰',keyword:'装修推荐'}).rate,1);
    assert.equal(store.companyStats({company:'乙装饰',keyword:'装修推荐'}).rate,0);
    assert.equal(calls,1);
    const analysisId = runner.reanalyze(1);
    assert.equal((await settled(store,analysisId)).status,'completed');
    assert.equal(calls,1); assert.equal(store.listQueries().total,1);
    assert.equal(store.query(1).extraction_usage.input_tokens,10);
  } finally { await runner.shutdown();store.close();rmSync(dir,{recursive:true,force:true}); }
});
test('failed company extraction keeps answer but does not count absence; queued cancellation is durable', async () => {
  const dir = mkdtempSync(resolve(tmpdir(),'visibility-failure-'));
  const store = new Store(':memory:');
  const runner = new Runner(store,{dataDir:dir,configured:true,
    query:async()=>({responseText:'完整回答',sources:[],citations:[],usage:{}}),
    extract:async()=>{throw new Error('模拟提取失败');},
  });
  try {
    store.saveKeyword({text:'推荐'});
    const first = runner.submit([]), second = runner.submit([]);
    assert.equal(runner.cancel(second),true);
    assert.equal(store.job(second).status,'cancelled');
    assert.equal((await settled(store,first)).status,'partial_failed');
    assert.equal(store.query(1).status,'completed');
    assert.equal(store.query(1).extraction_status,'failed');
    assert.equal(store.companyStats({company:'甲装饰'}).evaluated,0);
    assert.equal(store.companyStats({company:'甲装饰'}).rate,null);
  } finally { await runner.shutdown();store.close();rmSync(dir,{recursive:true,force:true}); }
});
