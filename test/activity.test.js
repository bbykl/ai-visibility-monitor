import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { activitySummary, toolActivity, withToolActivity } from '../src/analysis/activity.js';
import { normalizeMessage } from '../src/analysis/sources.js';

const message = {content:[
  {type:'server_tool_use',id:'s1',input:{action:'search',queries:['上海装修 口碑','上海装修 避坑']}},
  {type:'server_tool_use',id:'open',input:{action:'open_page',url:'https://example.com/a'}},
  {type:'server_tool_use',id:'s2',name:'web_search',input:{query:'上海装修 口碑'}},
  // Results deliberately arrive out of order, after all three calls.
  {type:'web_search_tool_result',tool_use_id:'s2',content:[]},
  {type:'web_fetch_tool_result',tool_use_id:'open',content:{type:'web_fetch_tool_result_error',error_code:'url_not_accessible'}},
  {type:'web_search_tool_result',tool_use_id:'s1',content:[
    {type:'web_search_result',url:'https://example.com/a',title:'A',encrypted_content:'never expose this'},
    {type:'web_search_tool_result_error',error_code:'unavailable'},
  ]},
  {type:'server_tool_use',id:'find',input:{action:'find_in_page',url:'https://example.com/b',pattern:'装修'}},
  {type:'web_fetch_tool_result',tool_use_id:'find',content:{type:'web_fetch_result',url:'https://example.com/b',content:{title:null,source:{data:'not part of the public trace'}}}},
  {type:'server_tool_use',id:'read',input:{action:'read_link',url:'https://example.com/c'}},
]};

test('tool trace matches out-of-order results, preserves repeated search terms per call, and separates searches from page actions', () => {
  const steps = toolActivity(message), result = activitySummary(steps);
  assert.deepEqual(steps.map(s=>s.id),['s1','open','s2','find','read']);
  assert.deepEqual(steps.map(s=>s.searchIndex),[1,null,2,null,null]);
  assert.deepEqual(steps.map(s=>s.status),['partial_failed','failed','completed','completed','pending']);
  assert.equal(steps[0].resultCount,1);
  assert.equal(steps[2].resultCount,0);
  assert.deepEqual(steps[1].errors,['url_not_accessible']);
  assert.equal(steps[3].pattern,'装修');
  assert.equal(result.searchCalls,2);
  assert.deepEqual(result.searchQueries,['上海装修 口碑','上海装修 避坑']);
  assert.deepEqual(steps[2].queries,['上海装修 口碑']);
  assert.equal(JSON.stringify(steps).includes('never expose this'),false);
  assert.equal(JSON.stringify(steps).includes('not part of the public trace'),false);
  assert.equal(normalizeMessage(message).searchCalls,2);
});

test('historical SSE restores tool metadata without changing saved answers or company extraction; missing streams retain known summaries', async () => {
  const dir=mkdtempSync(resolve(tmpdir(),'visibility-activity-'));
  try {
    mkdirSync(resolve(dir,'raw'));
    const events=[{type:'message_start',message:{model:'test'}},...message.content.map((content_block,index)=>({type:'content_block_start',index,content_block})),{type:'message_stop'}];
    writeFileSync(resolve(dir,'raw','old.sse'),events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    const saved={raw_file:'old.sse',companies:['甲公司'],result:{responseText:'原始回答',sources:[],searchCalls:99}};
    const restored=await withToolActivity(saved,dir);
    assert.equal(restored.result.searchCalls,2);
    assert.equal(restored.result.toolActivity.length,5);
    assert.equal(restored.result.responseText,'原始回答');
    assert.deepEqual(restored.companies,['甲公司']);
    assert.equal(saved.result.searchCalls,99);
    assert.equal(saved.result.toolActivity,undefined);
    assert.equal(await withToolActivity(restored,dir),restored);
    const missing=await withToolActivity({...saved,raw_file:'missing.sse'},dir);
    assert.equal(missing.result.activityUnavailable,true);
    assert.equal(missing.result.searchCalls,99);
    const noTools=toolActivity({content:[{type:'text',text:'直接回答'}]});
    assert.deepEqual(noTools,[]);
    assert.equal(activitySummary(noTools).searchTriggered,false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
