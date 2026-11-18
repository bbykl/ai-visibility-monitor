import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('source controls request the selected order, filter zero counts, toggle headers and ignore stale responses', async () => {
  const elements = new Map(), requests = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value:'', textContent:'', innerHTML:'', listeners:{}, attrs:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(type,listener){this.listeners[type]=listener;},
      setAttribute(key,value){this.attrs[key]=value;}, removeAttribute(key){delete this.attrs[key];},
      elements:new Proxy({}, {get:(target,key)=>target[key] ||= {value:'',checked:false}}),
    });
    return elements.get(selector);
  };
  element('#source-keyword').value='甲词';
  element('#source-stage').value='all';
  element('#source-sort').value='cited-desc';
  const fixture = [
    {url:'https://example.com/read',title:'已读取',keywords:['甲词'],searched:2,fetched:2,cited:1},
    {url:'https://example.com/search',title:'仅检索',keywords:['甲词'],searched:3,fetched:0,cited:0},
  ];
  const pending = [];
  const source = readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
    .replace("import { renderMarkdown } from './markdown.js';",'const renderMarkdown = text => text;');
  const page = await runInNewContext(`(async()=>{${source}\nreturn {sources};})()`, {
    document:{querySelector:element,querySelectorAll:selector=>selector === '.keyword-select' ? [element('#source-keyword')] : [],addEventListener(){}},
    window:{addEventListener(){}},location:{hash:'#sources'},localStorage:{getItem(){return null;}},
    URL,URLSearchParams,setInterval(){},setTimeout(){},clearTimeout(){},
    fetch:async path=>{
      const url=new URL(path,'http://localhost');
      requests.push(url);
      let data;
      if(url.pathname === '/api/sources') data=pending.length ? await pending.shift() : fixture;
      else data=({'/api/health':{},'/api/keywords':[],'/api/keyword-options':['甲词','乙词'],'/api/settings':{scheduleTimes:[]}})[url.pathname];
      assert.notEqual(data,undefined,`Unexpected request: ${path}`);
      return {ok:true,json:async()=>data};
    },
  });
  const settle = () => new Promise(resolve=>setImmediate(resolve));
  const latest = () => requests.at(-1).searchParams;
  const table=element('#sources-table'), stage=element('#source-stage'), sort=element('#source-sort');
  assert.equal(latest().get('keyword'),'甲词');
  stage.value='fetched';stage.listeners.change();await settle();
  assert.equal(sort.value,'fetched-desc');
  assert.equal(latest().get('sort'),'fetched');
  assert.match(table.innerHTML,/已读取/);assert.doesNotMatch(table.innerHTML,/仅检索/);
  assert.match(element('#source-count').textContent,/1 条来源.*2 条/);
  stage.value='searched';stage.listeners.change();await settle();
  assert.equal(sort.value,'searched-desc');
  assert.match(table.innerHTML,/仅检索/);
  sort.value='searched-asc';sort.listeners.change();await settle();
  assert.equal(latest().get('direction'),'asc');
  table.listeners.click({target:{closest:()=>({dataset:{sourceSort:'searched'}})}});await settle();
  assert.equal(sort.value,'searched-desc');
  assert.match(table.innerHTML,/aria-sort="descending"/);
  let release;
  pending.push(new Promise(resolve=>{release=resolve;}));
  const old=page.sources();
  element('#source-keyword').value='乙词';
  pending.push(Promise.resolve([]));
  await page.sources();
  const current=table.innerHTML;
  release(fixture);await old;
  assert.equal(latest().get('keyword'),'乙词');
  assert.equal(table.innerHTML,current);
  assert.match(current,/当前筛选范围内没有来源/);
  assert.equal(table.attrs['aria-busy'],undefined);
});
