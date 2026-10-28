// Use the saved delivery list so push and inbox audiences always agree.
export async function loadRecipientSubscriptions(admin,broadcastId){
  const ids=[];
  for(let start=0;;start+=1000){
    const {data,error}=await admin.from('broadcast_recipients').select('client_id').eq('broadcast_id',broadcastId).order('client_id').range(start,start+999);
    if(error)return {error,subscriptions:[],recipientCount:0};
    ids.push(...data.map(row=>row.client_id));if(data.length<1000)break;
  }
  const subscriptions=[];
  for(let batch=0;batch<ids.length;batch+=200){
    for(let start=0;;start+=1000){
      const {data,error}=await admin.from('push_subscriptions').select('user_id,endpoint,p256dh,auth_key').in('user_id',ids.slice(batch,batch+200)).order('user_id').order('endpoint').range(start,start+999);
      if(error)return {error,subscriptions:[],recipientCount:ids.length};
      subscriptions.push(...data);if(data.length<1000)break;
    }
  }
  return {subscriptions,recipientCount:ids.length,error:null};
}
