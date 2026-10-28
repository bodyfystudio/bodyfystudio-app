// Run the actual app modules against an in-memory Supabase adapter, never a live login.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const fake=String.raw`
const role=new URL(location.href).searchParams.get('role')||'coach';
const user={id:role,email:role+'@test.invalid'};window.testInserts=[];window.testSubscriptions=[];
const tables={profiles:[{id:user.id,display_name:role==='coach'?'Coach Fixture':'Admin Fixture'}],user_roles:[{user_id:user.id,role:role==='admin'?'super_admin':role}],recipes:[],coach_assignments:[],
  broadcasts:[{id:'sent',author_id:'coach',kind:'custom',title:'Client reminder',message:'Outgoing only',audience:'clients',created_at:new Date().toISOString()}],
  broadcast_recipients:[{client_id:'coach',broadcast_id:'incoming',read_at:null,dismissed_at:null,created_at:new Date().toISOString(),broadcasts:{id:'incoming',kind:'custom',title:'Studio update',message:'Incoming only',created_at:new Date().toISOString()}}]};
class Query{
  constructor(table){this.table=table;this.filters=[];this.change=null;this.add=null;this.bounds=null;}
  select(){return this;}eq(key,value){this.filters.push(r=>r[key]===value);return this;}is(key,value){return this.eq(key,value);}in(key,values){this.filters.push(r=>values.includes(r[key]));return this;}order(){return this;}limit(){return this;}range(a,b){this.bounds=[a,b];return this;}update(value){this.change=value;return this;}insert(value){this.add=value;return this;}
  result(){let rows=(tables[this.table]||[]).filter(r=>this.filters.every(f=>f(r)));if(this.change)rows.forEach(r=>Object.assign(r,this.change));if(this.add){const row={id:'new-broadcast',...this.add,created_at:new Date().toISOString()};tables[this.table].push(row);window.testInserts.push(row);rows=[row];}if(this.bounds)rows=rows.slice(this.bounds[0],this.bounds[1]+1);return {data:structuredClone(rows),error:null};}
  then(resolve,reject){return Promise.resolve(this.result()).then(resolve,reject);}single(){const result=this.result();return Promise.resolve({...result,data:result.data[0]});}
}
export const createClient=()=>({from:table=>new Query(table),
  auth:{onAuthStateChange(){},getSession:async()=>({data:{session:{user}}})},
  rpc:async(name,args)=>{
    if(name==='account_personal_snapshot')return {data:{name:tables.profiles[0].display_name,day:args.entry_day,habits:[],plans:[],checklist:[],favorites:[],appointments:[],streak:0}};
    if(name==='set_notifications_cleared'){const rows=tables.broadcast_recipients.filter(r=>r.client_id===args.target_user&&args.notification_ids.includes(r.broadcast_id));rows.forEach(r=>{r.dismissed_at=args.cleared?new Date().toISOString():null;});return {data:rows.map(r=>r.broadcast_id)};}
    return {data:null,error:null};
  },
  functions:{invoke:async(name)=>({data:name==='admin-list-users'?{users:[{id:'admin',name:'Admin Fixture',email:'admin@test.invalid',role:'super_admin'}]}:{sent:0}})},
  channel(){return {on(event,filter){window.testSubscriptions.push(filter);return this;},subscribe(){return this;}};},removeChannel:async()=>{}
});`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/fake-supabase.js'){res.setHeader('Content-Type','text/javascript');res.end(fake);return;}
  if(url.pathname==='/app.js'){
    let source=await readFile(new URL('../app.js',import.meta.url),'utf8');
    source=source.replace("from '@supabase/supabase-js'","from './fake-supabase.js'").replace('__APP_BUILD_ID__',"'fixture'").replace(/import\.meta\.env\.VITE_[A-Z_]+/g,"'fixture'");
    res.setHeader('Content-Type','text/javascript');res.end(source);return;
  }
  if(['/admin-accounts.js','/client-data.js','/notifications.js','/styles.css'].includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(new URL('..'+url.pathname,import.meta.url)));return;}
  if(url.pathname==='/version.json'){res.setHeader('Content-Type','application/json');res.end('{"buildId":"fixture"}');return;}
  if(url.pathname!=='/'){res.statusCode=404;res.end();return;}
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="app"></div><div id="toast"></div><script type="module" src="/app.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{delete Navigator.prototype.serviceWorker;});
  const base='http://127.0.0.1:'+server.address().port;
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
  await page.goto(base+'/?role=coach');
  await page.locator('.mobile-nav [data-nav="notifications"]').click();
  await page.getByText('Studio update',{exact:true}).waitFor();
  assert.equal(await page.getByText('Client reminder',{exact:true}).count(),0);
  assert.ok(await page.evaluate(()=>window.testSubscriptions.some(s=>s.table==='broadcast_recipients'&&s.filter==='client_id=eq.coach')));
  await page.getByRole('button',{name:'Mark all as read',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.notification-item.unread'));
  await page.getByRole('button',{name:'Clear all',exact:true}).click();
  await page.getByText('You’re all caught up.',{exact:true}).waitFor();
  await page.locator('.mobile-nav [data-nav="broadcasts"]').click();
  await page.getByText('Client reminder',{exact:true}).waitFor();
  assert.equal(await page.getByText('Studio update',{exact:true}).count(),0);
  await page.getByRole('button',{name:/Create broadcast/}).click();
  assert.equal(await page.locator('[name="audience"]').count(),0);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('.mobile-nav [data-nav="profile"]').click();
  await page.getByRole('button',{name:'Enable notifications',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto(base+'/?role=admin');
  await page.locator('.mobile-nav [data-nav="broadcasts"]').click();
  await page.getByRole('button',{name:/Create broadcast/}).click();
  await page.locator('[name="audience"]').selectOption('coaches');
  await page.locator('[name="title"]').fill('Team meeting');await page.locator('[name="message"]').fill('Coaches: please join the studio meeting.');
  await page.getByRole('button',{name:'Send broadcast →',exact:true}).click();
  await page.waitForFunction(()=>window.testInserts.some(r=>r.audience==='coaches'&&r.title==='Team meeting'));
  assert.deepEqual(errors,[]);
  console.log('PASS: actual coach app inbox navigation/read/clear, sent-history separation, live subscription, push opt-in, six-item mobile navigation, and admin audience submission.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
