export function createHistoryController({supabase,getUser,getRows,reload,render,notify}){
  let lastClear=null,pending=false,epoch=0;
  async function clear(ids,cleared=true){
    if(pending||!ids.length||!['coach','admin'].includes(getUser()?.role))return;
    const user=getUser(),requestEpoch=epoch;pending=true;
    const buttons=[...document.querySelectorAll('[data-clear-broadcast],[data-clear-history],[data-undo-history]')];buttons.forEach(b=>{b.disabled=true;});
    try{
      const {data:affected,error}=await supabase.rpc('set_broadcast_history_cleared',{broadcast_ids:ids,cleared});
      if(getUser()?.id!==user.id||epoch!==requestEpoch)return;
      if(error){notify(`Could not update broadcast history: ${error.message}`);return;}
      lastClear=cleared&&affected?.length?{userId:user.id,ids:affected}:null;
      await reload();
      if(getUser()?.id!==user.id||epoch!==requestEpoch)return;
      render();notify(cleared?'Broadcast history cleared.':'Broadcast history restored.');
    }catch(error){if(getUser()?.id===user.id&&epoch===requestEpoch)notify(`Could not update broadcast history: ${error.message}`);}
    finally{if(epoch===requestEpoch)pending=false;buttons.forEach(b=>{b.disabled=false;});}
  }
  function view(rows,renderRow){
    return `<section class="card" style="margin-top:18px"><div class="card-title-row"><h2 class="card-title">Broadcast history</h2><div class="account-actions"><span class="tag">${rows.length} visible</span><button class="btn btn-outline btn-sm" data-clear-history ${rows.length?'':'disabled'}>Clear all history</button></div></div>${lastClear?.userId===getUser()?.id?'<div class="notice-bar inbox-undo" role="status">Broadcast history cleared. <button class="link-button" data-undo-history>Undo</button></div>':''}${rows.length?`<div class="notification-list">${rows.map(row=>renderRow({...row,clearHistory:true})).join('')}</div>`:'<div class="empty-state"><div class="empty-icon">📣</div><p>No broadcasts in your history.</p></div>'}<p class="field-help" style="margin-top:15px">Clearing hides entries from your account’s history on all your devices. Recipients keep their messages.</p></section>`;
  }
  function bind(root=document){
    root.querySelectorAll('[data-clear-broadcast]').forEach(b=>b.onclick=()=>clear([b.dataset.clearBroadcast]));
    root.querySelector('[data-clear-history]')?.addEventListener('click',()=>clear(getRows().map(row=>row.id)));
    root.querySelector('[data-undo-history]')?.addEventListener('click',()=>clear(lastClear?.ids||[],false));
  }
  return {view,bind,reset(){epoch++;pending=false;lastClear=null;},busy:()=>pending};
}
