// Two isolated browser sessions share only this test RPC server, never localStorage.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const {localDay}=await import('../client-data.js');
const day=localDay();
const recipe={id:'recipe',title:'Oats',emoji:'🥣',category:'Breakfast',time:10,description:'Breakfast',savedBy:[]};
const accounts=new Map(['a','b'].map(id=>[id,{name:`Client ${id}`,day,streak:0,habits:[],weight_start:null,weight_now:null,
  plans:id==='a'?[{id:'plan-a',title:'Assigned rhythm',status:'active',plan_data:{Breakfast:'Oats',Walk:'20 minutes'}}]:[],
  favorites:[],checklist:[],coach:id==='a'?{id:'coach',name:'Actual assigned coach'}:null,appointments:[]}]));
const calls=[];
const server=createServer(async(request,response)=>{
  if(request.url==='/rpc'){
    let raw='';for await(const chunk of request)raw+=chunk;
    const {name,args}=JSON.parse(raw),state=accounts.get(args.target_user);calls.push({name,args});
    if(name==='save_daily_habits'){
      let habits=state.habits.find(h=>h.entry_date===args.entry_day);
      if(!habits){habits={id:`habits-${args.target_user}`,entry_date:args.entry_day,water:0,steps:0,weight_kg:null};state.habits.push(habits);}
      Object.assign(habits,args.changes);habits.water+=args.water_delta;
    }else if(name==='set_recipe_favorite')state.favorites=args.saved?[args.recipe]:[];
    else if(name==='set_plan_checklist')state.checklist=[{plan_id:args.plan,task_key:args.task,entry_date:args.entry_day,completed:args.done}];
    if(name==='admin_manage_account'){
      if(args.section==='habits')Object.assign(state.habits.find(h=>h.id===args.record_id),args.changes);
      if(args.section==='favorites')state.favorites=args.changes.saved?[args.record_id]:[];
      if(args.section==='checklist')state.checklist=[{plan_id:args.record_id,...args.changes}];
    }
    let snapshot=structuredClone(state);
    if(name==='admin_account_snapshot')snapshot={profile:{id:args.target_user,display_name:state.name,email:`${args.target_user}@test.invalid`,role:'client'},people:[],
      plans:state.plans,progress:[],appointments:[],recipes:[],broadcasts:[],inbox:[],devices:[],activity:[],assignments:[],habits:state.habits,
      checklist:state.checklist,favorites:state.favorites.map(id=>({id,title:'Oats',published:true})),available_recipes:[recipe]};
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({data:snapshot}));return;
  }
  if(['/client-data.js','/admin-accounts.js','/retention.js','/styles.css'].includes(request.url)){
    response.setHeader('Content-Type',request.url.endsWith('.css')?'text/css':'text/javascript');response.end(await readFile(new URL(`..${request.url}`,import.meta.url)));return;
  }
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="app" style="padding:16px"></main>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const contexts=await Promise.all([browser.newContext({viewport:{width:390,height:844}}),browser.newContext({viewport:{width:390,height:844}})]);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  const errors=[];for(const p of pages)p.on('pageerror',e=>errors.push(e.message));
  async function setup(page,id){
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async({id,recipe})=>{
      const mod=await import('/client-data.js');window.mod=mod;
      // A stale demo store must not influence the rendered data.
      localStorage.setItem('bodyfy-studio-demo-v1',JSON.stringify({progress:{water:8,steps:9999}}));
      window.user={id,name:`Client ${id}`,role:'client'};window.data={...mod.emptyPersonal(),recipes:[recipe],notifications:[]};window.messages=[];window.failNext=false;
      window.rpc={rpc:async(name,args)=>{
        if(window.failNext&&name!=='account_personal_snapshot'){window.failNext=false;return {error:{message:'Test connection failed'}};}
        return (await fetch('/rpc',{method:'POST',body:JSON.stringify({name,args})})).json();
      }};
      window.view='home';
      window.render=()=>{document.querySelector('#app').innerHTML=(window.view==='plan'?mod.renderSharedPlan(window.data):mod.renderClientDashboard(window.data,window.user))+'<button data-save-recipe="recipe">'+(window.data.favorites.includes('recipe')?'Unsave recipe':'Save recipe')+'</button>';window.controller.bind();};
      window.controller=mod.createPersonalDataController({supabase:window.rpc,getUser:()=>window.user,getData:()=>window.data,notify:s=>window.messages.push(s),render:window.render});
      await window.controller.load();window.render();
    },{id,recipe});
  }
  await Promise.all(pages.map(p=>setup(p,'a')));
  const [first,second]=pages;
  assert.equal(await first.evaluate(()=>window.data.progress.water),0);
  assert.equal(await first.locator('body').textContent().then(t=>t.includes('Day 12')),false);
  await first.getByRole('button',{name:'+ Log a glass of water',exact:true}).click();
  await first.waitForFunction(()=>window.data.progress.water===1);
  await second.evaluate(async()=>{await window.controller.load();window.render();});
  assert.equal(await second.evaluate(()=>window.data.progress.water),1);
  // Two devices increment the same day; neither overwrites the other device's count.
  await Promise.all(pages.map(p=>p.getByRole('button',{name:'+ Log a glass of water',exact:true}).click()));
  await Promise.all(pages.map(p=>p.waitForFunction(()=>!window.controller.busy())));
  await first.evaluate(async()=>{await window.controller.load();window.render();});
  assert.equal(await first.evaluate(()=>window.data.progress.water),3);
  await first.getByRole('button',{name:'Save recipe',exact:true}).click();
  await first.getByRole('button',{name:'Unsave recipe',exact:true}).waitFor();
  await second.evaluate(async()=>{await window.controller.load();window.view='plan';window.render();});
  await second.getByRole('button',{name:'Unsave recipe',exact:true}).waitFor();
  await second.getByRole('button',{name:'Mark done',exact:true}).first().click();
  await second.getByRole('button',{name:'Done ✓',exact:true}).waitFor();
  await first.evaluate(async()=>{await window.controller.load();window.view='plan';window.render();});
  await first.getByRole('button',{name:'Done ✓',exact:true}).waitFor();
  await first.getByText('Actual assigned coach',{exact:false}).waitFor();
  await first.locator('summary').filter({hasText:'Update steps and weight'}).click();
  await first.getByLabel('Steps today',{exact:true}).fill('4500');
  await first.getByLabel('Weight in kg (optional)').fill('72.4');
  await first.getByRole('button',{name:'Save check-in',exact:true}).click();
  await first.waitForFunction(()=>window.data.progress.steps===4500);
  assert.equal(accounts.get('a').habits[0].weight_kg,72.4);
  await first.evaluate(()=>{window.failNext=true;});
  await first.getByRole('button',{name:'+ Add glass',exact:true}).click();
  await first.waitForFunction(()=>window.messages.some(s=>s.includes('Test connection failed')));
  assert.equal(await first.evaluate(()=>window.data.progress.water),3);
  // Switching accounts clears visible state, favorites, and completions.
  await second.evaluate(async()=>{window.controller.reset();window.user={id:'b',name:'Client b',role:'client'};await window.controller.load();window.render();});
  assert.equal(await second.evaluate(()=>window.data.progress.water),0);
  assert.equal(await second.evaluate(()=>window.data.favorites.length),0);
  assert.equal(await second.getByRole('button',{name:'Done ✓',exact:true}).count(),0);
  await second.getByText(/No active plan yet/).waitFor();
  // A delayed response for the old account must never replace the new account.
  await second.evaluate(async()=>{
    let release;const original=window.rpc.rpc;
    window.user={id:'a',name:'Client a',role:'client'};
    window.rpc.rpc=(name,args)=>args.target_user==='a'?new Promise(resolve=>{release=()=>resolve({data:{...window.data.personal,name:'WRONG ACCOUNT'}});}):original(name,args);
    const stale=window.controller.load();window.controller.reset();window.user={id:'b',name:'Client b',role:'client'};
    await window.controller.load();release();await stale;window.rpc.rpc=original;window.render();
  });
  assert.equal(await second.evaluate(()=>window.data.personal.name),'Client b');
  // Use the admin's actual controls and verify that the client then sees the change.
  await second.evaluate(async()=>{
    const {createAccountWorkspace}=await import('/admin-accounts.js');
    window.admin=createAccountWorkspace({supabase:window.rpc,notify:()=>{},onClose:()=>{}});
    await window.admin.open('a',document.querySelector('#app'));
  });
  await second.getByRole('button',{name:'Daily habits',exact:true}).click();
  await second.getByRole('button',{name:'Edit',exact:true}).click();
  await second.getByLabel('Glasses of water',{exact:true}).fill('6');
  await second.getByRole('button',{name:'Save changes',exact:true}).click();
  await second.getByRole('button',{name:'Edit',exact:true}).waitFor();
  await first.evaluate(async()=>{await window.controller.load();window.render();});
  assert.equal(await first.evaluate(()=>window.data.progress.water),6);
  await second.getByRole('button',{name:'Saved recipes',exact:true}).click();
  await second.getByRole('button',{name:'Remove',exact:true}).click();
  await second.getByText('No recipes saved yet.',{exact:true}).waitFor();
  await first.evaluate(async()=>{await window.controller.load();window.render();});
  assert.equal(await first.evaluate(()=>window.data.favorites.length),0);
  assert.ok(await first.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  assert.ok(calls.some(c=>c.name==='set_plan_checklist'&&c.args.plan==='plan-a'&&c.args.task==='detail:Breakfast'));
  console.log('PASS: two-device habits/favorites/checklists, account switching, stale responses, failed saves, actual plan/coach, admin edits visible to client, and mobile width.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
