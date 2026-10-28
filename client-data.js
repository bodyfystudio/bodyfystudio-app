const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const pretty = value => value == null ? '' : typeof value === 'object' ? Array.isArray(value) ? value.map(pretty).join('\n') : Object.entries(value).map(([k,v])=>`${k}: ${pretty(v)}`).join('\n') : String(value);
export function planTasks(plan) {
  const details = plan.plan_data;
  if (!details || typeof details !== 'object') return [];
  if (Array.isArray(details.tasks)) return details.tasks.map((task,index) => ({
    key:`task:${String(task?.id ?? '') || String(task?.title ?? '') || index+1}`,
    title:typeof task === 'string' ? task : task?.title || `Step ${index+1}`,
    description:typeof task === 'object' ? pretty(task.description || task.details || '') : '',
    time:typeof task === 'object' ? task.time || '' : '',
  }));
  if (Array.isArray(details)) return [];
  return Object.entries(details).map(([key,value])=>({key:`detail:${key}`,title:key,description:pretty(value),time:''}));
}
export function activePlans(personal, day = personal?.day || localDay()) {
  return (personal?.plans || []).filter(p=>p.status==='active'&&(!p.starts_on||p.starts_on<=day)&&(!p.ends_on||p.ends_on>=day));
}
export function emptyPersonal() {
  return {personal:null, personalReady:false, personalError:'', progress:{water:0,steps:0,streak:0,weightStart:null,weightNow:null,week:Array(7).fill(0)}, completed:[], favorites:[]};
}
const completion = (personal,plan,key) => personal?.checklist.some(c=>c.plan_id===plan&&c.task_key===key&&c.completed) || false;
function taskRows(plan,personal,limit) {
  return planTasks(plan).slice(0,limit).map(task=>{
    const done=completion(personal,plan.id,task.key);
    return `<div class="today-row"><div class="today-info"><strong>${esc(task.title)}</strong>${task.time?`<span>${esc(task.time)}</span>`:''}<p class="account-detail">${esc(task.description)}</p></div><button class="btn btn-sm ${done?'btn-primary':'btn-outline'}" data-personal-action data-complete="${esc(task.key)}" data-plan-id="${plan.id}" data-done="${!done}" aria-pressed="${done}">${done?'Done ✓':'Mark done'}</button></div>`;
  }).join('');
}
function readiness(data) {
  return !data.personalReady ? `<section class="card empty-state" role="status">${esc(data.personalError || 'Loading your account…')}<button class="btn btn-outline btn-sm" data-personal-action data-reload-personal>Retry</button></section>` : '';
}
function habitForm(data) {
  const today=data.personal?.habits.find(h=>h.entry_date===data.personal.day);
  return `<details class="habit-form"><summary>Update steps and weight</summary><form data-habit-form><div class="split-field"><div class="field"><label for="habit-steps">Steps today</label><input id="habit-steps" name="steps" type="number" min="0" max="250000" step="1" required value="${data.progress.steps}"></div><div class="field"><label for="habit-weight">Weight in kg (optional)</label><input id="habit-weight" name="weight_kg" type="number" min="1" max="600" step="0.01" value="${esc(today?.weight_kg ?? '')}"></div></div><button class="btn btn-primary btn-sm" data-personal-action>Save check-in</button></form></details>`;
}
function appointments(personal) {
  const items=personal.appointments.filter(a=>a.status!=='cancelled'&&new Date(a.starts_at)>=new Date()).slice(0,3);
  return items.length?`<section class="card" style="margin-top:18px"><h2 class="card-title">Upcoming appointments</h2>${items.map(a=>`<div class="today-row"><div class="today-info"><strong>${esc(new Date(a.starts_at).toLocaleString('en-IN'))}</strong><span>${a.duration_minutes} minutes · ${esc(a.status)}</span>${a.client_note?`<p>${esc(a.client_note)}</p>`:''}</div>${safeMeetingUrl(a.meeting_url)?`<a class="btn btn-outline btn-sm" href="${esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">Join meeting</a>`:''}</div>`).join('')}</section>`:'';
}
function safeMeetingUrl(value) {try {return new URL(value).protocol==='https:';} catch {return false;}}
export function renderClientDashboard(data,user) {
  if(!data.personalReady)return readiness(data);
  const p=data.progress, personal=data.personal, plans=activePlans(personal), unread=data.notifications.filter(n=>!n.read).length;
  const weightChange=p.weightStart!=null&&p.weightNow!=null?`${(p.weightStart-p.weightNow).toFixed(1)} kg`:'—';
  return `<div class="page-heading"><div><div class="eyebrow">${esc(new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'}))}</div><h1>Hello, ${esc(user.name.split(' ')[0])}</h1><p>Your check-ins and plan stay with your account on every device.</p></div><button class="btn btn-outline" data-nav="plan">View my plan →</button></div>
    <div class="grid grid-2"><section class="card hero-card"><div class="hero-copy"><div class="eyebrow">Your journey so far</div><h2>Steady steps.<br>Real change.</h2><p>Keep following your plan and give yourself credit for every small win.</p></div><div class="hero-stats"><div class="hero-stat"><strong>${p.streak} days</strong><span>check-in streak</span></div><div class="hero-stat"><strong>${weightChange}</strong><span>weight change logged</span></div><div class="hero-stat"><strong>${unread}</strong><span>new reminders</span></div></div></section>
    <section class="card"><div class="card-title-row"><h2 class="card-title">Today’s check-in</h2><span class="tag">${esc(personal.day)}</span></div><div class="grid grid-2"><div class="metric-card"><span class="metric-label">Water</span><strong class="metric-value">${p.water} / 8</strong><span class="metric-label">glasses logged today</span></div><div class="metric-card"><span class="metric-label">Movement</span><strong class="metric-value">${p.steps.toLocaleString()}</strong><span class="metric-label">steps logged today</span></div></div><button class="btn btn-outline btn-sm" data-personal-action data-action="quick-water">+ Log a glass of water</button>${habitForm(data)}</section></div>
    <div class="grid grid-2" style="margin-top:18px"><section class="card plan-card"><div class="card-title-row"><h2 class="card-title">Your plan today</h2><button class="link-button" data-nav="plan">See full plan →</button></div>${plans.length?plans.map(plan=>`<h3 class="card-title">${esc(plan.title)}</h3>${taskRows(plan,personal,3)||'<p>Your coach has not added checklist details yet.</p>'}`).join(''):'<div class="empty-state">Your coach has not assigned an active plan yet.</div>'}</section>
    <section class="card"><div class="card-title-row"><h2 class="card-title">Recipe inspiration</h2><button class="link-button" data-nav="recipes">Browse recipes →</button></div><div class="meal-list">${data.recipes.slice(0,3).map(r=>`<div class="meal-item"><div class="meal-emoji">${esc(r.emoji)}</div><div class="meal-meta"><strong>${esc(r.title)}</strong><span>${esc(r.category)} · ${r.time} min</span></div><button class="link-button" data-recipe="${r.id}">Open</button></div>`).join('')||'<p class="empty-state">Your coach’s recipes will appear here.</p>'}</div></section></div>${appointments(personal)}`;
}
export function renderSharedPlan(data) {
  if(!data.personalReady)return readiness(data);
  const personal=data.personal, plans=activePlans(personal);
  const past=personal.plans.filter(p=>!plans.includes(p));
  return `<div class="page-heading"><div><div class="eyebrow">Your personal plan</div><h1>Your plan & check-ins</h1><p>${personal.coach?`Your coach: ${esc(personal.coach.name)}`:'A coach has not been assigned yet.'}</p></div></div><div class="grid grid-2"><div>${plans.map(plan=>`<section class="card account-record"><div class="card-title-row"><h2 class="card-title">${esc(plan.title)}</h2><span class="tag">${planTasks(plan).filter(t=>completion(personal,plan.id,t.key)).length} / ${planTasks(plan).length} done today</span></div>${plan.starts_on||plan.ends_on?`<p class="field-help">${esc(plan.starts_on || 'Open start')} – ${esc(plan.ends_on || 'Ongoing')}</p>`:''}${taskRows(plan,personal)||'<p>Your coach has not added checklist details yet.</p>'}</section>`).join('')||'<section class="card empty-state">No active plan yet. Your assigned plan will appear here when your coach or studio admin publishes it.</section>'}
    ${past.length?`<details class="card"><summary>Other plans (${past.length})</summary>${past.map(plan=>`<div class="today-row"><div class="today-info"><strong>${esc(plan.title)}</strong><span>${esc(plan.status)}${plan.starts_on?' · '+esc(plan.starts_on):''}</span><div class="account-detail">${esc(pretty(plan.plan_data))}</div></div></div>`).join('')}</details>`:''}</div>
    <section class="card"><h2 class="card-title">Your progress</h2><div class="grid grid-2" style="margin-top:18px"><div class="metric-card"><span class="metric-label">Water today</span><strong class="metric-value">${data.progress.water}/8</strong><button class="link-button" data-personal-action data-action="quick-water">+ Add glass</button></div><div class="metric-card"><span class="metric-label">Steps today</span><strong class="metric-value">${data.progress.steps.toLocaleString()}</strong></div></div>${habitForm(data)}<h3 class="card-title" style="margin:20px 0 12px">Last 7 days</h3><div class="habit-week">${data.progress.week.map((score,i)=>{const day=new Date(`${personal.day}T12:00:00`);day.setDate(day.getDate()-6+i);return `<div><div class="habit-bar" style="height:${Math.max(3,score)}px" title="${esc(localDay(day))}: ${score}% of water and movement goals"></div><small>${esc(day.toLocaleDateString('en-IN',{weekday:'short'}))}</small></div>`;}).join('')}</div><p class="field-help">Daily water and movement logged against 8 glasses and 8,000 steps.</p></section></div>${appointments(personal)}`;
}

export function createPersonalDataController({supabase,getUser,getData,notify,render}) {
  let pending=false, generation=0, identityEpoch=0;
  function reset() {generation++;identityEpoch++; pending=false;Object.assign(getData(),emptyPersonal());}
  async function load() {
    const user=getUser(); if(!user)return false;
    const request=++generation;
    let personal,error;
    try {const result=await supabase.rpc('account_personal_snapshot',{target_user:user.id,entry_day:localDay()});personal=result.data;error=result.error;}
    catch(failure){error=failure;}
    if(request!==generation||getUser()?.id!==user.id)return false;
    const data=getData();
    if(error){Object.assign(data,emptyPersonal());data.personalError=`Could not load your saved data: ${error.message}`;return false;}
    const today=personal.habits.find(h=>h.entry_date===personal.day)||{water:0,steps:0};
    data.personal=personal;data.personalReady=true;data.personalError='';data.favorites=personal.favorites;
    data.progress={water:Number(today.water),steps:Number(today.steps),streak:personal.streak||0,weightStart:personal.weight_start,weightNow:personal.weight_now,
      week:Array.from({length:7},(_,i)=>{const day=new Date(`${personal.day}T12:00:00`);day.setDate(day.getDate()-6+i);const h=personal.habits.find(row=>row.entry_date===localDay(day));return h?Math.round((Math.min(1,h.water/8)+Math.min(1,h.steps/8000))*50):0;})};
    for(const recipe of data.recipes)recipe.savedBy=personal.favorites.includes(recipe.id)?[user.id]:[];
    if(personal.name)user.name=personal.name;
    return true;
  }
  async function write(name,args,message) {
    if(pending)return false;
    if(!getData().personalReady){notify('Your saved data has not loaded. Please retry.');return false;}
    const user=getUser(),epoch=identityEpoch;
    pending=true;
    const buttons=[...document.querySelectorAll('[data-personal-action],[data-save-recipe]')];
    buttons.forEach(b=>{b.disabled=true;});
    try {
      const {error}=await supabase.rpc(name,{target_user:user.id,...args});
      if(getUser()?.id!==user.id||identityEpoch!==epoch)return false;
      if(error){notify(`Could not save: ${error.message}`);return false;}
      const loaded=await load();
      if(getUser()?.id!==user.id||identityEpoch!==epoch)return false;
      if(loaded){render();notify(message);}else{render();notify('Saved, but the latest data could not reload. Please retry.');}
      return loaded;
    } catch(error) {if(getUser()?.id===user.id&&identityEpoch===epoch)notify(`Could not save: ${error.message}`);return false;}
    finally {if(identityEpoch===epoch)pending=false;buttons.forEach(b=>{b.disabled=false;});}
  }
  function bind(root=document) {
    root.querySelectorAll('[data-save-recipe]').forEach(b=>{b.disabled=!getData().personalReady;b.onclick=()=>{
      const saved=!getData().favorites.includes(b.dataset.saveRecipe);
      return write('set_recipe_favorite',{recipe:b.dataset.saveRecipe,saved},saved?'Saved to your favorites.':'Removed from favorites.');
    };});
    root.querySelectorAll('[data-action="quick-water"]').forEach(b=>b.onclick=()=>write('save_daily_habits',{entry_day:localDay(),changes:{},water_delta:1},'Water check-in saved.'));
    root.querySelectorAll('[data-complete]').forEach(b=>b.onclick=()=>write('set_plan_checklist',{plan:b.dataset.planId,task:b.dataset.complete,entry_day:localDay(),done:b.dataset.done==='true'},'Checklist saved.'));
    root.querySelectorAll('[data-habit-form]').forEach(form=>form.onsubmit=event=>{
      event.preventDefault();const values=new FormData(form);
      return write('save_daily_habits',{entry_day:localDay(),changes:{steps:Number(values.get('steps')),weight_kg:values.get('weight_kg')===''?null:Number(values.get('weight_kg'))},water_delta:0},'Check-in saved.');
    });
    root.querySelectorAll('[data-reload-personal]').forEach(b=>b.onclick=async()=>{if(await load())render();else{render();notify(getData().personalError);}});
  }
  return {load,reset,bind,busy:()=>pending};
}
