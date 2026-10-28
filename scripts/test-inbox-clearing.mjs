import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const {loadInboxRows}=await import('../notifications.js');
const many=Array.from({length:1005},(_,i)=>({broadcast_id:`message-${i}`}));const ranges=[];
const query={select(){return this;},eq(key,value){assert.equal(value,'client-a');return this;},is(key,value){assert.equal(key,'dismissed_at');assert.equal(value,null);return this;},order(){return this;},range(start,end){ranges.push([start,end]);return Promise.resolve({data:many.slice(start,end+1)});}};
const all=await loadInboxRows({from:()=>query},'client-a');assert.equal(all.data.length,1005);assert.equal(ranges.length,2);
const server=createServer(async(req,res)=>{
  if(req.url==='/notifications.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../notifications.js',import.meta.url)));}
  else if(req.url==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(await readFile(new URL('../styles.css',import.meta.url)));}
  else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="app" style="padding:16px"></main>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async()=>{
    const {createInboxController}=await import('/notifications.js');
    window.user={id:'client-a',role:'client'};window.messages=[];window.failNext=false;window.calls=[];
    window.rows=[{id:'one',kind:'water',title:'Water reminder',message:'Drink water',created:Date.now(),read:false},{id:'two',kind:'custom',title:'Past update',message:'An older message',created:Date.now()-1000,read:true}];
    window.visible=[...window.rows];
    const supabase={rpc:async(name,args)=>{
      window.calls.push({name,args});if(window.failNext){window.failNext=false;return {error:{message:'Connection failed'}};}
      const changed=window.rows.filter(r=>args.notification_ids.includes(r.id)&&Boolean(r.cleared)!==args.cleared);changed.forEach(r=>{r.cleared=args.cleared;});return {data:changed.map(r=>r.id)};
    }};
    window.render=()=>{document.querySelector('#app').innerHTML=window.controller.view(window.visible);window.controller.bind();};
    window.controller=createInboxController({supabase,getUser:()=>window.user,getNotices:()=>window.visible,reload:async()=>{window.visible=window.rows.filter(r=>!r.cleared);},render:window.render,notify:s=>window.messages.push(s)});
    window.render();
  });
  await page.getByRole('button',{name:'Clear Water reminder',exact:true}).click();
  await page.getByRole('button',{name:'Undo',exact:true}).waitFor();
  assert.equal(await page.locator('.notification-item').count(),1);
  assert.deepEqual(await page.evaluate(()=>window.calls[0].args.notification_ids),['one']);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.notification-item').length===2);
  await page.evaluate(()=>{window.failNext=true;});
  await page.getByRole('button',{name:'Clear all',exact:true}).click();
  await page.waitForFunction(()=>window.messages.some(s=>s.includes('Connection failed')));
  assert.equal(await page.locator('.notification-item').count(),2);
  await page.getByRole('button',{name:'Clear all',exact:true}).click();
  await page.getByText('You’re all caught up.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Clear all',exact:true}).isDisabled(),true);
  // A message arriving after Clear all stays visible, including after Undo.
  await page.evaluate(()=>{window.rows.push({id:'new',title:'New message',message:'Arrived later',kind:'custom',created:Date.now(),read:false});window.visible=window.rows.filter(r=>!r.cleared);window.render();});
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.notification-item').length===3);
  assert.equal(await page.getByText('New message',{exact:true}).count(),1);
  await page.getByRole('button',{name:'Clear all',exact:true}).click();
  await page.getByRole('button',{name:'Undo',exact:true}).waitFor();
  await page.evaluate(()=>{window.controller.reset();window.user={id:'client-b',role:'client'};window.visible=[];window.render();});
  assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).count(),0);
  await page.evaluate(()=>{window.controller.reset();window.user={id:'coach-a',role:'coach'};window.rows=[{id:'coach-update',title:'Studio update',message:'Team update',kind:'custom',created:Date.now(),read:false}];window.visible=[...window.rows];window.render();});
  await page.getByText('Studio announcements and updates for your coach account.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Clear Studio update',exact:true}).click();
  await page.getByText('You’re all caught up.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).args.target_user),'coach-a');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  console.log('PASS: individual clear, clear all, undo, failed save, new arrivals, account reset, and mobile layout.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
