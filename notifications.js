const esc=(s='')=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeLink=value=>{try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='zoom.us'||url.hostname.endsWith('.zoom.us'));}catch{return false;}};
export async function loadInboxRows(supabase,userId){
  const rows=new Map();
  for(let start=0;;start+=1000){
    const {data,error}=await supabase.from('broadcast_recipients').select('broadcast_id,read_at,broadcasts(id,kind,title,message,action_url,created_at)').eq('client_id',userId).is('dismissed_at',null).order('created_at',{ascending:false}).order('broadcast_id',{ascending:false}).range(start,start+999);
    if(error)return {data:null,error};
    for(const row of data)rows.set(row.broadcast_id,row);
    if(data.length<1000)return {data:[...rows.values()],error:null};
  }
}
export function createInboxController({supabase,getUser,getNotices,reload,render,notify}){
  let lastClear=null,pending=false,epoch=0;
  async function clear(ids,cleared=true){
    if(pending||!ids.length||getUser()?.role!=='client')return;
    const user=getUser(),requestEpoch=epoch;pending=true;
    const buttons=[...document.querySelectorAll('[data-clear-notice],[data-clear-inbox],[data-undo-clear]')];buttons.forEach(b=>{b.disabled=true;});
    try{
      const {data:affected,error}=await supabase.rpc('set_notifications_cleared',{target_user:user.id,notification_ids:ids,cleared});
      if(getUser()?.id!==user.id||epoch!==requestEpoch)return;
      if(error){notify(`Could not clear notifications: ${error.message}`);return;}
      lastClear=cleared&&affected?.length?{userId:user.id,ids:affected}:null;
      await reload();
      if(getUser()?.id!==user.id||epoch!==requestEpoch)return;
      render();notify(cleared?'Notifications cleared.':'Notifications restored.');
    }catch(error){if(getUser()?.id===user.id&&epoch===requestEpoch)notify(`Could not update notifications: ${error.message}`);}
    finally{if(epoch===requestEpoch)pending=false;buttons.forEach(b=>{b.disabled=false;});}
  }
  function view(notices){
    const rows=[...notices].sort((a,b)=>b.created-a.created);
    const canUndo=lastClear?.userId===getUser()?.id;
    return `<div class="page-heading"><div><div class="eyebrow">Your updates</div><h1>Notifications</h1><p>Reminders and updates from your BodyfyStudio coach.</p></div><div class="account-actions"><button class="btn btn-outline" data-action="mark-read" ${rows.length?'':'disabled'}>Mark all as read</button><button class="btn btn-outline" data-clear-inbox ${rows.length?'':'disabled'}>Clear all</button></div></div>
    ${canUndo?'<div class="notice-bar inbox-undo" role="status">Notifications cleared. <button class="link-button" data-undo-clear>Undo</button></div>':''}
    <section class="card"><div class="card-title-row"><h2 class="card-title">Recent updates</h2><span class="tag">${rows.length} total</span></div>${rows.length?`<div class="notification-list">${rows.map(n=>{
      const icon=n.kind==='zoom'?'🎥':n.kind==='water'?'💧':n.kind==='fruit'?'🍊':'✦';
      return `<article class="notification-item ${n.read?'':'unread'}"><div class="notification-icon">${icon}</div><div class="notification-content"><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><time>${esc(new Date(n.created).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}))}</time>${n.kind==='zoom'&&safeLink(n.link)?`<div style="margin-top:10px"><a class="btn btn-primary btn-sm" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer" data-notice-link="${n.id}">Join Zoom meeting ↗</a></div>`:''}</div><div class="notification-actions">${n.read?'':'<span class="tag">New</span>'}<button class="link-button" data-clear-notice="${n.id}" aria-label="Clear ${esc(n.title)}">Clear</button></div></article>`;
    }).join('')}</div>`:'<div class="empty-state"><div class="empty-icon">🔔</div><strong>You’re all caught up.</strong><br>New coach reminders will appear here.</div>'}</section><div class="notice-bar" style="margin-top:15px">Clearing removes messages from your inbox on all your devices. New notifications will still arrive.</div>`;
  }
  function bind(root=document){
    root.querySelectorAll('[data-clear-notice]').forEach(b=>b.onclick=()=>clear([b.dataset.clearNotice]));
    root.querySelector('[data-clear-inbox]')?.addEventListener('click',()=>clear(getNotices().map(n=>n.id)));
    root.querySelector('[data-undo-clear]')?.addEventListener('click',()=>clear(lastClear?.ids||[],false));
  }
  return {view,bind,reset(){epoch++;pending=false;lastClear=null;},busy:()=>pending};
}
