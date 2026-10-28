// All account reads and writes use the real admin session and checked database RPCs.
import {localDay, planTasks} from './client-data.js';
const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {client:'Client', coach:'Coach', super_admin:'Super admin'};
const definitions = {
  habits: {title:'Daily habits', fields:[['entry_date','Day','date'],['water','Glasses of water','number'],['steps','Steps','number'],['weight_kg','Weight in kg (optional)','number']]},
  plans: {title:'Plans', fields:[['title','Title','text'],['status','Status',['draft','active','completed','paused']],['starts_on','Starts on','date'],['ends_on','Ends on','date'],['plan_data','Plan details','object']]},
  progress: {title:'Progress', fields:[['recorded_at','Recorded at','datetime-local'],['metrics','Measurements','object'],['note','Notes','textarea']]},
  appointments: {title:'Appointments', fields:[['starts_at','Starts at','datetime-local'],['duration_minutes','Duration in minutes','number'],['status','Status',['requested','confirmed','cancelled','completed']],['meeting_url','Meeting link','url'],['client_note','Client notes','textarea']]},
  recipes: {title:'Recipes', fields:[['title','Title','text'],['category','Category',['Breakfast','Lunch','Dinner','Snacks','Drinks']],['description','Description','textarea'],['ingredients','Ingredients (one per line)','lines'],['steps','Method (one step per line)','lines'],['prep_minutes','Preparation time in minutes','number'],['calories_estimate','Estimated calories','number'],['emoji','Symbol','text'],['published','Published','checkbox']]},
  broadcasts: {title:'Broadcasts', fields:[['title','Title','text'],['kind','Type',['custom','water','fruit','zoom']],['message','Message','textarea'],['action_url','Zoom link','url']]},
};

export function createAccountWorkspace({supabase, notify, onClose, onChanged}) {
  let targetId, snapshot, section = 'profile', error = '', loading = false, generation = 0;
  let draft = null, saving = false, host, checklistDay = localDay();
  const person = id => snapshot?.people.find(p => p.id === id)?.name || 'Unknown account';
  const date = value => value ? new Date(value).toLocaleString('en-IN') : '—';
  const editable = () => snapshot?.profile.role !== 'super_admin';
  const button = (text, attributes = '') => `<button type="button" class="btn btn-outline btn-sm" ${attributes}>${text}</button>`;
  const paragraphs = value => `<div class="account-detail">${escapeHtml(value || '—')}</div>`;
  function describe(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) return value.map(describe).join('\n');
    if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replace(/_/g, ' ')}: ${describe(item)}`).join('\n');
    return String(value);
  }
  function detail(label, value) { return `<div><div class="metric-label">${escapeHtml(label)}</div>${paragraphs(value)}</div>`; }
  function options(people, selected) {return people.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');}
  function relationshipField(role, selected) {
    return `<div class="field"><label>${role === 'coach' ? 'Coach' : 'Client'}<select name="${role}_id" required>${options(snapshot.people.filter(p => p.role === role), selected)}</select></label></div>`;
  }
  function localDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
  }
  function field([key, label, type], record) {
    const value = record[key];
    if (type === 'object') return `<fieldset class="account-object" data-object="${key}"><legend>${label}</legend><div data-object-rows>${Object.entries(value || {}).map(([name, item]) => objectRow(name, item)).join('')}</div>${button('Add detail', `data-add-detail="${key}"`)}<p class="field-help">Add a name and value for each detail. Existing structured values are preserved until edited.</p></fieldset>`;
    let control;
    if (Array.isArray(type)) control = `<select name="${key}">${type.map(v => `<option ${v === value ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    else if (type === 'checkbox') control = `<input name="${key}" type="checkbox" ${value ? 'checked' : ''}>`;
    else if (type === 'textarea' || type === 'lines') control = `<textarea name="${key}" ${key === 'message' ? 'maxlength="500" required' : ''}>${escapeHtml(type === 'lines' ? (value || []).join('\n') : value || '')}</textarea>`;
    else control = `<input name="${key}" type="${type}" value="${escapeHtml(type === 'datetime-local' ? localDate(value) : value ?? '')}" ${['display_name','title','starts_at','recorded_at','duration_minutes','prep_minutes','entry_date','water','steps'].includes(key) ? 'required' : ''} ${type === 'number' ? `min="${['calories_estimate','water','steps'].includes(key) ? 0 : 1}" step="${key === 'weight_kg' ? '0.01' : '1'}"` : ''} ${key === 'entry_date' ? `max="${localDay()}" ${record.id ? 'readonly' : ''}` : ''} ${key === 'display_name' ? 'maxlength="80"' : ''} ${key === 'title' && section === 'broadcasts' ? 'maxlength="100"' : ''}>`;
    return `<div class="field"><label>${label}${control}</label></div>`;
  }
  function objectRow(key = '', value = '') {
    return `<div class="account-object-row"><input aria-label="Detail name" data-detail-key value="${escapeHtml(key)}" placeholder="Name"><input aria-label="Detail value" data-detail-value value="${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}" placeholder="Value">${button('Remove', 'data-remove-detail')}</div>`;
  }
  function renderEditor() {
    if (!draft) return '';
    const fields = section === 'profile' ? [['display_name','Name','text']] : definitions[section].fields;
    const role = snapshot.profile.role;
    return `<section class="card account-editor"><h2 class="card-title">${draft.id ? 'Edit' : 'Add'} ${section === 'profile' ? 'profile' : definitions[section].title.toLowerCase()}</h2><form data-account-editor>
      ${!draft.id && ['plans','appointments'].includes(section) ? relationshipField(role === 'client' ? 'coach' : 'client', '') : ''}
      ${fields.map(f => field(f, draft)).join('')}
      ${section === 'broadcasts' ? '<p class="field-help">Editing updates the message in inboxes. It does not send another push alert.</p>' : ''}
      <div class="account-actions"><button class="btn btn-primary" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save changes'}</button>${button('Cancel', 'data-cancel-edit')}</div>
      </form></section>`;
  }
  function renderProfile() {
    const p = snapshot.profile;
    return `<section class="card"><div class="card-title-row"><h2 class="card-title">Account information</h2>${editable() ? button('Edit name', 'data-edit-profile') : ''}</div><div class="grid grid-2">${detail('Name', p.display_name)}${detail('Email', p.email)}${detail('Role', labels[p.role])}${detail('Created', date(p.created_at))}${detail('Last signed in', date(p.last_sign_in_at))}${detail('Email confirmed', p.email_confirmed_at ? 'Yes' : 'Pending')}${detail('Devices with push enabled', snapshot.devices.length)}</div></section>
      ${p.role === 'client' ? '<div class="notice-bar">Plans, daily habits, checklist completions, and saved recipes are shared with this client’s app across devices.</div>' : ''}`;
  }
  function renderAssignments() {
    const role = snapshot.profile.role;
    return `<section class="card"><h2 class="card-title">${role === 'client' ? 'Assigned coach' : 'Assigned clients'}</h2>${snapshot.assignments.map(a => `<div class="today-row"><div class="today-info"><strong>${escapeHtml(person(role === 'client' ? a.coach_id : a.client_id))}</strong><span>Assigned ${date(a.created_at)}</span></div>${editable() ? button('Unassign', `data-unassign="${a.client_id}"`) : ''}</div>`).join('') || '<p class="empty-state">No assignments yet.</p>'}
      ${editable() ? `<form data-assignment-form>${relationshipField(role === 'client' ? 'coach' : 'client', snapshot.assignments[0]?.coach_id)}<button class="btn btn-primary" ${saving ? 'disabled' : ''}>${role === 'client' ? 'Assign coach' : 'Assign client'}</button></form>` : ''}</section>`;
  }
  function renderRecords() {
    const def = definitions[section];
    const rows = snapshot[section];
    return `<div class="card-title-row"><h2 class="card-title">${def.title} · ${rows.length}</h2>${editable() && ['habits','plans','progress','appointments'].includes(section) ? button('Add record', 'data-new-record') : ''}</div>${rows.map(row => `<article class="card account-record"><div class="card-title-row"><h3 class="card-title">${escapeHtml(row.title || row.entry_date || (section === 'appointments' ? date(row.starts_at) : date(row.recorded_at)))}</h3>${editable() ? button('Edit', `data-edit-record="${row.id}"`) : ''}</div><div class="grid grid-2">${row.client_id ? detail('Client', person(row.client_id)) : ''}${row.coach_id ? detail('Coach', person(row.coach_id)) : ''}${def.fields.map(([key, label]) => detail(label, describe(row[key]))).join('')}</div></article>`).join('') || '<section class="card empty-state">No records for this account yet.</section>'}`;
  }
  function renderFavorites() {
    return `<section class="card"><h2 class="card-title">Saved recipes · ${snapshot.favorites.length}</h2>${snapshot.favorites.map(r=>`<div class="today-row"><div class="today-info"><strong>${escapeHtml(r.title)}</strong><span>${r.published ? 'Published' : 'Currently unpublished'}</span></div>${button('Remove',`data-remove-favorite="${r.id}"`)}</div>`).join('') || '<p class="empty-state">No recipes saved yet.</p>'}<form data-favorite-form><div class="field"><label>Save a recipe<select name="recipe_id" required>${snapshot.available_recipes.map(r=>`<option value="${r.id}">${escapeHtml(r.title)}</option>`).join('')}</select></label></div><button class="btn btn-primary" ${snapshot.available_recipes.length ? '' : 'disabled'}>Save recipe</button></form></section>`;
  }
  function renderChecklist() {
    const plans=snapshot.plans.filter(p=>p.status!=='draft'&&(!p.starts_on||p.starts_on<=checklistDay)&&(!p.ends_on||p.ends_on>=checklistDay));
    return `<div class="field"><label>Checklist day<input type="date" data-checklist-day value="${checklistDay}" max="${localDay()}"></label></div>${plans.map(plan=>`<section class="card account-record"><h2 class="card-title">${escapeHtml(plan.title)}</h2>${planTasks(plan).map(task=>{const done=snapshot.checklist.some(c=>c.plan_id===plan.id&&c.task_key===task.key&&c.entry_date===checklistDay&&c.completed);return `<div class="today-row"><div class="today-info"><strong>${escapeHtml(task.title)}</strong><div class="account-detail">${escapeHtml(task.description)}</div></div>${button(done?'Done ✓':'Mark done',`data-checklist-plan="${plan.id}" data-task="${escapeHtml(task.key)}" data-completed="${!done}" aria-pressed="${done}"`)}</div>`;}).join('')||'<p class="empty-state">No checklist details yet.</p>'}</section>`).join('')||'<section class="card empty-state">No plan for this day.</section>'}`;
  }
  function renderInbox() {
    return `<section class="card"><h2 class="card-title">Inbox · ${snapshot.inbox.length}</h2>${snapshot.inbox.map(n => `<article class="notification-item"><div class="notification-content"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.message)}</p><time>${date(n.created_at)} · ${n.read_at ? 'Read' : 'Unread'}</time>${n.action_url ? detail('Meeting link', n.action_url) : ''}</div>${editable() ? button(n.read_at ? 'Mark unread' : 'Mark read', `data-inbox-id="${n.id}" data-read="${!n.read_at}"`) : ''}</article>`).join('') || '<p class="empty-state">No messages for this account yet.</p>'}</section>`;
  }
  function renderActivity() {
    return `<section class="card"><h2 class="card-title">Recent admin activity</h2>${snapshot.activity.map(a => `<div class="today-row"><div class="today-info"><strong>${escapeHtml(a.action)}</strong><span>${escapeHtml(person(a.actor_id))} · ${date(a.created_at)}</span></div></div>`).join('') || '<p class="empty-state">No activity yet.</p>'}</section>`;
  }
  function render() {
    if (!host?.isConnected) return;
    if (loading || !snapshot) {
      host.innerHTML = `${button('← Back to accounts', 'data-close-account')}<section class="card empty-state" role="status">${escapeHtml(error || 'Loading account…')}${error ? button('Retry', 'data-retry-account') : ''}</section>`;
      bind(); return;
    }
    const tabs = [['profile','Profile'],['assignments','Assignments'],['plans','Plans'],...(snapshot.profile.role === 'client' ? [['habits','Daily habits'],['checklist','Checklist'],['progress','Progress'],['inbox','Inbox']] : [['recipes','Recipes'],['broadcasts','Broadcasts']]),['favorites','Saved recipes'],['appointments','Appointments'],['activity','Admin activity']];
    host.innerHTML = `<div class="account-admin-banner"><div><strong>Managing ${escapeHtml(snapshot.profile.display_name)}</strong><span>${labels[snapshot.profile.role]} · ${escapeHtml(snapshot.profile.email)}</span></div>${button('← Back to accounts', 'data-close-account')}</div><nav class="recipe-filter" aria-label="Account sections">${tabs.map(([id, title]) => `<button class="filter-chip ${section === id ? 'active' : ''}" data-account-section="${id}" aria-pressed="${section === id}">${title}</button>`).join('')}</nav>${error ? `<div class="notice-bar" role="alert">${escapeHtml(error)}</div>` : ''}${draft ? renderEditor() : section === 'profile' ? renderProfile() : section === 'assignments' ? renderAssignments() : section === 'favorites' ? renderFavorites() : section === 'checklist' ? renderChecklist() : section === 'inbox' ? renderInbox() : section === 'activity' ? renderActivity() : renderRecords()}`;
    bind();
  }
  async function load() {
    const request = ++generation;
    loading = true; error = ''; render();
    const {data, error: failure} = await supabase.rpc('admin_account_snapshot', {target_user:targetId});
    if (request !== generation) return;
    loading = false;
    if (failure) { error = failure.code === 'PGRST202' ? 'Account management needs database migration 007. Please apply it in Supabase.' : `Could not open account: ${failure.message}`; snapshot = null; }
    else {snapshot = data; if (!snapshot?.profile) {error = 'Account profile not found.'; snapshot = null;}}
    render();
  }
  async function update(part, id, changes) {
    if (saving) return;
    saving = true; error = '';
    host.querySelectorAll('button').forEach(b => {b.disabled = true;});
    const {error: failure} = await supabase.rpc('admin_manage_account', {target_user:targetId, section:part, record_id:id || null, changes});
    saving = false;
    if (failure) {error = `Could not save changes: ${failure.message}`; render(); return;}
    draft = null;
    await load();
    onChanged?.(); notify('Account changes saved.');
  }
  async function submitEditor(event) {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form), changes = {};
    const fields = section === 'profile' ? [['display_name','Name','text']] : definitions[section].fields;
    try {
      for (const [key, , type] of fields) {
        const raw = values.get(key);
        if (type === 'object') {
          const object = {};
          for (const row of form.querySelector(`[data-object="${key}"]`).querySelectorAll('.account-object-row')) {
            const name = row.querySelector('[data-detail-key]').value.trim();
            if (!name) throw new Error('Each detail needs a name.');
            if (Object.hasOwn(object, name) || ['__proto__','constructor','prototype'].includes(name)) throw new Error('Detail names must be unique.');
            const text = row.querySelector('[data-detail-value]').value;
            const original = draft[key]?.[name];
            if (text === (typeof original === 'object' ? JSON.stringify(original) : String(original ?? ''))) object[name] = Object.hasOwn(draft[key] || {}, name) ? original : '';
            else {try {object[name] = JSON.parse(text);} catch {object[name] = text;}}
          }
          changes[key] = object;
        } else if (type === 'checkbox') changes[key] = values.has(key);
        else if (type === 'lines') changes[key] = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
        else if (type === 'number') changes[key] = raw === '' ? null : Number(raw);
        else if (type === 'datetime-local') changes[key] = raw ? new Date(raw).toISOString() : null;
        else changes[key] = raw === '' && ['date','url'].includes(type) ? null : String(raw || '').trim();
      }
      if (!draft.id) for (const role of ['client','coach']) if (values.has(`${role}_id`)) changes[`${role}_id`] = values.get(`${role}_id`);
      Object.assign(draft, changes);
      await update(section, draft.id, changes);
    } catch (failure) {error = failure.message; render();}
  }
  function bind() {
    host.querySelector('[data-close-account]')?.addEventListener('click', () => {generation++; onClose();});
    host.querySelector('[data-retry-account]')?.addEventListener('click', load);
    host.querySelectorAll('[data-account-section]').forEach(b => b.onclick = () => {section = b.dataset.accountSection; draft = null; error = ''; render();});
    host.querySelector('[data-edit-profile]')?.addEventListener('click', () => {draft = {...snapshot.profile}; render();});
    host.querySelectorAll('[data-edit-record]').forEach(b => b.onclick = () => {draft = structuredClone(snapshot[section].find(r => r.id === b.dataset.editRecord)); render();});
    host.querySelector('[data-new-record]')?.addEventListener('click', () => {draft = section==='habits'?{entry_date:localDay(),water:0,steps:0,weight_kg:null}:{status:section === 'plans' ? 'draft' : 'requested', recorded_at:new Date().toISOString(), starts_at:new Date().toISOString(), duration_minutes:30, plan_data:{}, metrics:{}}; render();});
    host.querySelector('[data-cancel-edit]')?.addEventListener('click', () => {draft = null; error = ''; render();});
    host.querySelector('[data-account-editor]')?.addEventListener('submit', submitEditor);
    host.querySelectorAll('[data-add-detail]').forEach(b => b.onclick = () => {b.parentElement.querySelector('[data-object-rows]').insertAdjacentHTML('beforeend', objectRow());});
    host.querySelectorAll('[data-inbox-id]').forEach(b => b.onclick = () => update('inbox', b.dataset.inboxId, {read:b.dataset.read === 'true'}));
    host.querySelectorAll('[data-unassign]').forEach(b => b.onclick = () => update('unassign', null, {client_id:b.dataset.unassign}));
    host.querySelectorAll('[data-remove-favorite]').forEach(b=>b.onclick=()=>update('favorites',b.dataset.removeFavorite,{saved:false}));
    host.querySelector('[data-favorite-form]')?.addEventListener('submit',e=>{e.preventDefault();update('favorites',new FormData(e.currentTarget).get('recipe_id'),{saved:true});});
    host.querySelector('[data-checklist-day]')?.addEventListener('change',e=>{if(e.target.value&&e.target.value<=localDay()){checklistDay=e.target.value;render();}});
    host.querySelectorAll('[data-checklist-plan]').forEach(b=>b.onclick=()=>update('checklist',b.dataset.checklistPlan,{task_key:b.dataset.task,entry_date:checklistDay,completed:b.dataset.completed==='true'}));
    host.querySelector('[data-assignment-form]')?.addEventListener('submit', e => {e.preventDefault(); update('assignment', null, Object.fromEntries(new FormData(e.currentTarget)));});
    host.onclick = e => {const b = e.target.closest('[data-remove-detail]'); if (b) b.closest('.account-object-row').remove();};
  }
  return {
    open(id, container) {targetId = id; host = container; snapshot = null; draft = null; section = 'profile'; checklistDay=localDay(); return load();},
    mount(container) {host = container; render();},
    close() {generation++; snapshot = null; host = null;},
  };
}
