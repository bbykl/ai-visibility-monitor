import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Scheduler } from '../src/jobs/scheduler.js';

function setup() {
  const store=new Store(':memory:');
  store.saveSettings({...store.settings(),scheduleEnabled:true,scheduleTimes:['09:00'],timezone:'Asia/Shanghai'});
  const callbacks=[],submissions=[];
  const runner={configured:false,active:null,queue:[],submit:(...args)=>submissions.push(args)};
  const scheduler=new Scheduler(store,runner,{schedule:(expression,callback,options)=>{
    callbacks.push({expression,callback,options});return {destroy(){}};
  }});
  return {store,runner,scheduler,callbacks,submissions};
}

test('scheduled ticks without a key wait quietly; configuring a key resumes only on the next tick',()=>{
  const {store,runner,scheduler,callbacks,submissions}=setup();
  try {
    store.saveKeyword({text:'推荐公司'});
    assert.equal(scheduler.status().state,'waiting_api_key');
    assert.equal(callbacks.length,1);
    assert.equal(callbacks[0].options.timezone,'Asia/Shanghai');
    for(let i=0;i<3;i++) assert.equal(callbacks[0].callback(),false);
    assert.equal(submissions.length,0);
    assert.equal(scheduler.lastError,null);
    assert.equal(store.jobs().length,0);
    runner.configured=true;
    assert.equal(scheduler.status().state,'ready');
    assert.equal(submissions.length,0); // No catch-up or immediate paid request.
    assert.equal(callbacks[0].callback(),true);
    assert.deepEqual(submissions,[[[],'schedule']]);
    runner.queue=[42];
    assert.equal(scheduler.status().state,'busy');
    assert.equal(callbacks[0].callback(),false);
    runner.queue=[];runner.configured=false;
    assert.equal(callbacks[0].callback(),false);
    assert.equal(scheduler.status().state,'waiting_api_key');
    assert.equal(submissions.length,1);
  }finally{scheduler.stop();store.close();}
});

test('scheduled work waits for enabled keywords and disabled schedules never submit work',()=>{
  const {store,runner,scheduler,callbacks,submissions}=setup();
  try {
    runner.configured=true;
    const id=store.saveKeyword({text:'推荐公司',enabled:false});
    assert.equal(scheduler.status().state,'waiting_keywords');
    assert.equal(callbacks[0].callback(),false);
    assert.equal(submissions.length,0);
    store.saveKeyword({text:'推荐公司',enabled:true},id);
    assert.equal(scheduler.status().state,'ready');
    store.saveSettings({...store.settings(),scheduleEnabled:false});scheduler.reload();
    assert.equal(scheduler.status().state,'disabled');
    assert.equal(callbacks[0].callback(),false);
    assert.equal(submissions.length,0);
  }finally{scheduler.stop();store.close();}
});
