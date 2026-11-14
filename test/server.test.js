import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rootDir } from '../src/config.js';

test('fresh checkout boots without a key; credential HTTP responses never expose it, and removal persists', async () => {
  const dir=mkdtempSync(resolve(tmpdir(),'visibility-server-'));
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  let processHandle;
  const start=async(environmentKey='')=>{
    processHandle=spawn(process.execPath,['src/server.js'],{cwd:rootDir,windowsHide:true,
      env:{...process.env,PORT:String(port),DATA_DIR:dir,DEEPSEEK_API_KEY:environmentKey},stdio:'ignore'});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      if(processHandle.exitCode!==null)throw new Error('Fresh server exited early');
      try{const res=await fetch(`http://127.0.0.1:${port}/api/health`);if(res.ok)return;}catch{}
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error('Fresh server startup timed out');
  };
  const stop=async()=>{if(processHandle && processHandle.exitCode===null){const done=once(processHandle,'exit');processHandle.kill();await done;}processHandle=null;};
  const request=async(path,method='GET',body,marked=true)=>{
    const res=await fetch(`http://127.0.0.1:${port}/api${path}`,{method,
      headers:{'Content-Type':'application/json',...(marked?{'X-Requested-With':'visibility-monitor'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};
  };
  try{
    await start();
    assert.equal((await request('/health')).data.apiConfigured,false);
    assert.deepEqual((await request('/credentials')).data,{configured:false,source:'none'});
    assert.equal((await request('/jobs','POST',{keywordIds:[]})).status,400);
    const nextTime=new Date(Date.now()+12*60*60*1000).toISOString().slice(11,16);
    assert.equal((await request('/settings','PUT',{thinking:false,readUrls:false,scheduleEnabled:true,scheduleTimes:[nextTime],timezone:'UTC'})).status,200);
    assert.equal((await request('/health')).data.scheduler.state,'waiting_api_key');
    await request('/keywords','POST',{text:'isolated schedule test'});
    assert.equal((await request('/jobs')).data.length,0);
    const key='sk-'+'test_http_placeholder_only';
    assert.equal((await request('/credentials','PUT',{apiKey:key},false)).status,403);
    const saved=await request('/credentials','PUT',{apiKey:key});
    assert.equal(saved.status,200);assert.equal(JSON.stringify(saved).includes(key),false);
    assert.equal((await request('/health')).data.apiConfigured,true);
    assert.equal((await request('/health')).data.scheduler.state,'ready');
    assert.equal((await request('/jobs')).data.length,0);
    for(const path of ['/settings','/credentials','/health','/jobs','/queries'])assert.equal(JSON.stringify(await request(path)).includes(key),false);
    assert.equal((await request('/credentials','PUT',{apiKey:'sk-invalid'})).status,400);
    await stop();await start('sk-'+'test_environment_fallback_only');
    assert.deepEqual((await request('/credentials')).data,{configured:true,source:'settings'});
    assert.equal((await request('/credentials','DELETE')).status,200);
    await stop();await start('sk-'+'test_environment_fallback_only');
    assert.equal((await request('/health')).data.apiConfigured,false);
    assert.equal((await request('/health')).data.scheduler.state,'waiting_api_key');
    assert.equal((await request('/queries')).data.total,0);
  }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
