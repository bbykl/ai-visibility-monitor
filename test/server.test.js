import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rootDir } from '../src/config.js';
import { Store } from '../src/storage/store.js';

test('server accepts IP/domain access and unmarked writes; credentials never expose secrets, and removal persists', async () => {
  const dir=mkdtempSync(resolve(tmpdir(),'visibility-server-'));
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  let processHandle;
  const start=async(environmentKey='')=>{
    processHandle=spawn(process.execPath,['src/server.js'],{cwd:rootDir,windowsHide:true,
      env:{...process.env,HOST:'0.0.0.0',PORT:String(port),DATA_DIR:dir,DEEPSEEK_API_KEY:environmentKey},stdio:'ignore'});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      if(processHandle.exitCode!==null)throw new Error('Fresh server exited early');
      try{const res=await fetch(`http://127.0.0.1:${port}/api/health`);if(res.ok)return;}catch{}
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error('Fresh server startup timed out');
  };
  const stop=async()=>{if(processHandle && processHandle.exitCode===null){const done=once(processHandle,'exit');processHandle.kill();await done;}processHandle=null;};
  const request=async(path,method='GET',body,headers={})=>{
    const res=await fetch(`http://127.0.0.1:${port}/api${path}`,{method,
      headers:{'Content-Type':'application/json',...headers},
      ...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};
  };
  try{
    const seed = new Store(resolve(dir,'monitor.sqlite'));
    try {
      for (let i=0;i<2;i++) {
        const job = seed.createJob({keywords:['source filter sample','another keyword']},'test');
        for (const keyword of ['source filter sample','another keyword']) {
          const id = seed.createQuery(job,keyword,{model:'test',thinking:false,rawFile:'test.sse'});
          seed.finishQuery(id,{status:'completed',result:{sources:[
            {url:'https://example.com/a',domain:'example.com',title:'A',searched:true,fetched:i===0,cited:false},
            {url:'https://example.com/b',domain:'example.com',title:'B',searched:i===0,fetched:true,cited:true},
          ].map(s=>({...s,snippet:'',publishedAt:null,siteName:null,searchRank:null})),citations:[]},durationMs:1});
        }
      }
    } finally { seed.close(); }
    await start();
    const sourcePath = '/sources?keyword='+encodeURIComponent('source filter sample');
    const ranked = await request(sourcePath+'&sort=searched&direction=desc');
    assert.equal(ranked.status,200);
    assert.deepEqual(ranked.data.map(s=>s.title),['A','B']);
    assert.deepEqual(ranked.data.map(s=>s.searched),[2,1]); // not doubled by another keyword
    assert.deepEqual((await request(sourcePath+'&sort=searched&direction=asc')).data.map(s=>s.title),['B','A']);
    assert.deepEqual((await request(sourcePath+'&sort=fetched')).data.map(s=>s.title),['B','A']);
    assert.deepEqual((await request(sourcePath)).data.map(s=>s.title),['B','A']);
    const domainHeaders={Host:`monitor.example.test:${port}`,Origin:'https://another.example.test'};
    assert.equal((await request('/health','GET',undefined,domainHeaders)).status,200);
    const remoteKeyword=await request('/keywords','POST',{text:'remote access sample'},domainHeaders);
    assert.equal(remoteKeyword.status,201);
    assert.equal((await request(`/keywords/${remoteKeyword.data.id}`,'PUT',{text:'updated remote sample'},{Host:`192.0.2.10:${port}`})).status,200);
    assert.equal((await request(`/keywords/${remoteKeyword.data.id}`,'DELETE',undefined,domainHeaders)).status,200);
    assert.equal((await request('/health')).data.apiConfigured,false);
    assert.deepEqual((await request('/credentials')).data,{configured:false,source:'none'});
    assert.equal((await request('/jobs','POST',{keywordIds:[]})).status,400);
    const nextTime=new Date(Date.now()+12*60*60*1000).toISOString().slice(11,16);
    assert.equal((await request('/settings','PUT',{thinking:false,readUrls:false,scheduleEnabled:true,scheduleTimes:[nextTime],timezone:'UTC'})).status,200);
    assert.equal((await request('/health')).data.scheduler.state,'waiting_api_key');
    await request('/keywords','POST',{text:'isolated schedule test'});
    assert.equal((await request('/jobs')).data.length,2);
    const key='sk-'+'test_http_placeholder_only';
    assert.equal((await request('/credentials','PUT',{apiKey:key},domainHeaders)).status,200);
    const saved=await request('/credentials','PUT',{apiKey:key});
    assert.equal(saved.status,200);assert.equal(JSON.stringify(saved).includes(key),false);
    assert.equal((await request('/health')).data.apiConfigured,true);
    assert.equal((await request('/health')).data.scheduler.state,'ready');
    assert.equal((await request('/jobs')).data.length,2);
    for(const path of ['/settings','/credentials','/health','/jobs','/queries'])assert.equal(JSON.stringify(await request(path)).includes(key),false);
    assert.equal((await request('/credentials','PUT',{apiKey:'sk-invalid'})).status,400);
    await stop();await start('sk-'+'test_environment_fallback_only');
    assert.deepEqual((await request('/credentials')).data,{configured:true,source:'settings'});
    assert.equal((await request('/credentials','DELETE')).status,200);
    await stop();await start('sk-'+'test_environment_fallback_only');
    assert.equal((await request('/health')).data.apiConfigured,false);
    assert.equal((await request('/health')).data.scheduler.state,'waiting_api_key');
    assert.equal((await request('/queries')).data.total,4);
  }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
