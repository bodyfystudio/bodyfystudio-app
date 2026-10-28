// Run with Playwright available in NODE_PATH. Uses fixtures only; no live login.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium} = createRequire(import.meta.url)('playwright');
const server = createServer(async (request, response) => {
  if (request.url === '/admin-accounts.js') {response.setHeader('Content-Type','text/javascript'); response.end(await readFile(new URL('../admin-accounts.js',import.meta.url)));}
  else if (request.url === '/styles.css') {response.setHeader('Content-Type','text/css'); response.end(await readFile(new URL('../styles.css',import.meta.url)));}
  else response.end('<!doctype html><link rel="stylesheet" href="/styles.css"><main id="workspace" style="padding:16px"></main>');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const {createAccountWorkspace} = await import('/admin-accounts.js');
    window.calls = []; window.deny = false;
    window.snapshot = {profile:{id:'client',display_name:'Client <script>alert(1)</script>',email:'client@test.invalid',role:'client'},
      people:[{id:'coach',name:'Test coach',role:'coach'},{id:'client',name:'Test client',role:'client'}],
      plans:[{id:'plan',client_id:'client',coach_id:'coach',title:'Plan A',status:'active',plan_data:{Breakfast:'Oats',Water:8}}],
      progress:[], appointments:[], recipes:[], broadcasts:[], devices:[], activity:[], assignments:[],
      inbox:[{id:'message',title:'Water reminder',message:'Drink water',created_at:new Date().toISOString(),read_at:null}]};
    const supabase = {rpc:async (name,args) => {
      window.calls.push({name,args});
      if(window.deny) return {error:{code:'42501',message:'Super admin access required'}};
      if(name==='admin_manage_account') {
        if(args.section==='plans') Object.assign(window.snapshot.plans[0],args.changes);
        if(args.section==='profile') Object.assign(window.snapshot.profile,args.changes);
      }
      return {data:structuredClone(window.snapshot)};
    }};
    window.workspace = createAccountWorkspace({supabase,notify:()=>{},onClose:()=>{window.closedAccount = true;}});
    await window.workspace.open('client',document.querySelector('#workspace'));
  });
  assert.equal(await page.locator('.account-admin-banner script').count(),0);
  await page.getByRole('button',{name:'Plans',exact:true}).click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Changed plan');
  await page.getByLabel('Detail value').first().fill('Eggs and fruit');
  await page.getByRole('button',{name:'Save changes'}).click();
  await page.getByRole('heading',{name:'Changed plan'}).waitFor();
  let edit = await page.evaluate(() => window.calls.find(c=>c.name==='admin_manage_account'));
  assert.equal(edit.args.target_user,'client');
  assert.equal(edit.args.record_id,'plan');
  assert.deepEqual(edit.args.changes.plan_data,{Breakfast:'Eggs and fruit',Water:8});
  await page.getByRole('button',{name:'Inbox',exact:true}).click();
  await page.getByRole('button',{name:'Mark read',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.calls.some(c=>c.args.section==='inbox'&&c.args.record_id==='message'&&c.args.changes.read===true)));
  await page.getByRole('button',{name:'Profile',exact:true}).click();
  await page.getByRole('button',{name:'Edit name'}).click();
  await page.getByLabel('Name',{exact:true}).fill('Updated client');
  await page.getByRole('button',{name:'Save changes'}).click();
  await page.getByText('Managing Updated client',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.evaluate(async()=>{
    window.snapshot.profile.role='coach';window.snapshot.profile.display_name='Test coach';
    await window.workspace.open('coach',document.querySelector('#workspace'));
  });
  await page.getByRole('button',{name:'Recipes',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Inbox',exact:true}).count(),0);
  await page.getByRole('button',{name:'← Back to accounts'}).click();
  assert.equal(await page.evaluate(()=>window.closedAccount),true);
  await page.evaluate(async()=>{window.deny=true;await window.workspace.open('client',document.querySelector('#workspace'));});
  await page.getByText(/Super admin access required/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Edit name'}).count(),0);
  assert.deepEqual(failures,[]);
  console.log('PASS: client/coach navigation, escaped identity, scoped editing, structured data preservation, inbox updates, return action, permission error, and mobile width.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
