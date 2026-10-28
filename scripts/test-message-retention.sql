-- All records, extension installation, scheduled job, and cleanup work roll back.
begin;
do $$
declare
  coach uuid:=gen_random_uuid(); client_one uuid:=gen_random_uuid(); client_two uuid:=gen_random_uuid(); administrator uuid:=gen_random_uuid();
  kept uuid; unused uuid; recent uuid; old_clear timestamptz:=clock_timestamp()-interval '48 hours'; recent_clear timestamptz:=clock_timestamp()-interval '47 hours';
  denied boolean; snapshot jsonb; affected uuid[];
begin
  insert into auth.users(id,email,raw_user_meta_data) values
    (coach,coach::text||'@test.invalid','{"display_name":"Retention test coach"}'),
    (client_one,client_one::text||'@test.invalid','{"display_name":"Retention test client one"}'),
    (client_two,client_two::text||'@test.invalid','{"display_name":"Retention test client two"}'),
    (administrator,administrator::text||'@test.invalid','{"display_name":"Retention test admin"}');
  update public.user_roles set role='coach' where user_id=coach;
  update public.user_roles set role='super_admin' where user_id=administrator;
  alter table public.broadcasts disable trigger on_broadcast_created;
  insert into public.broadcasts(author_id,kind,title,message,created_at) values(coach,'custom','Kept by another recipient','Kept shared content',now()-interval '100 days') returning id into kept;
  insert into public.broadcasts(author_id,kind,title,message) values(coach,'custom','Fully cleared content','Delete unused content') returning id into unused;
  insert into public.broadcasts(author_id,kind,title,message,created_at) values(coach,'custom','Recently cleared','Keep recovery window',now()-interval '100 days') returning id into recent;
  alter table public.broadcasts enable trigger on_broadcast_created;
  insert into public.broadcast_recipients(client_id,broadcast_id,dismissed_at) values
    (client_one,kept,old_clear),(client_two,kept,null),(client_one,unused,old_clear),(client_one,recent,recent_clear);
  insert into public.broadcast_history_hidden(user_id,broadcast_id,hidden_at) values(coach,kept,old_clear),(coach,recent,recent_clear);
  insert into public.broadcast_history_hidden(user_id,broadcast_id,hidden_at)
    select user_id,unused,old_clear from public.user_roles where role='super_admin' or user_id=coach;
  perform set_config('request.jwt.claim.sub',client_one::text,true);execute 'set local role authenticated';
  affected:=public.set_notifications_cleared(client_one,array[recent],false);
  if cardinality(affected)<>1 then raise exception 'Restore within 48 hours failed';end if;
  perform public.set_notifications_cleared(client_one,array[recent],true);
  denied:=false;begin perform public.set_notifications_cleared(client_one,array[kept],false);exception when raise_exception then denied:=true;end;
  if not denied then raise exception 'Client restored at/after 48 hours';end if;
  perform public.set_notifications_cleared(client_one,array[kept],true);
  if exists(select 1 from public.broadcast_recipients where broadcast_id=kept and client_id=client_one) then raise exception 'Expired inbox exposed through raw reads';end if;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  denied:=false;begin perform public.set_notifications_cleared(client_one,array[kept],false);exception when raise_exception then denied:=true;end;
  if not denied then raise exception 'Admin bypassed inbox expiry';end if;
  snapshot:=public.admin_account_snapshot(client_one);
  if exists(select 1 from jsonb_array_elements(snapshot->'inbox') n where (n->>'id')::uuid in (kept,unused)) then raise exception 'Expired inbox exposed to admin';end if;
  snapshot:=public.admin_account_snapshot(coach);
  if exists(select 1 from jsonb_array_elements(snapshot->'broadcasts') b where (b->>'id')::uuid in (kept,unused)) then raise exception 'Expired history exposed in account management';end if;
  denied:=false;begin perform public.admin_manage_account(coach,'broadcasts',kept,'{"message":"Recovered edit"}');exception when raise_exception then denied:=true;end;
  if not denied then raise exception 'Admin could edit an expired account copy';end if;
  perform set_config('request.jwt.claim.sub',coach::text,true);
  denied:=false;begin perform public.set_broadcast_history_cleared(array[kept],false);exception when raise_exception then denied:=true;end;
  if not denied then raise exception 'Coach restored expired history';end if;
  perform public.set_broadcast_history_cleared(array[kept],true);
  if exists(select 1 from public.broadcasts where id=kept) then raise exception 'Expired sender copy exposed through raw reads';end if;
  affected:=public.set_broadcast_history_cleared(array[recent],false);
  if cardinality(affected)<>1 then raise exception 'Recent history could not be restored';end if;
  execute 'reset role';
  if (select hidden_at from public.broadcast_history_hidden where user_id=coach and broadcast_id=kept)<>old_clear then raise exception 'Repeated clear renewed recovery';end if;
  if (select dismissed_at from public.broadcast_recipients where client_id=client_one and broadcast_id=kept)<>old_clear then raise exception 'Repeated inbox clear renewed recovery';end if;
  if public.can_send_broadcast_push(coach,kept) then raise exception 'Expired sender copy can trigger push';end if;
  if not public.can_send_broadcast_push(coach,recent) then raise exception 'Active sender copy lost push eligibility';end if;
  perform private.purge_expired_message_copies();
  if exists(select 1 from public.broadcast_recipients where client_id=client_one and broadcast_id in (kept,unused)) then raise exception 'Expired recipient rows not deleted';end if;
  if not exists(select 1 from public.broadcast_recipients where client_id=client_two and broadcast_id=kept and dismissed_at is null) then raise exception 'Another recipient was affected';end if;
  if not exists(select 1 from public.broadcasts where id=kept) then raise exception 'Shared content was removed while still needed';end if;
  if exists(select 1 from public.broadcasts where id=unused) then raise exception 'Unreferenced fully cleared content was retained';end if;
  if exists(select 1 from public.broadcast_history_hidden where broadcast_id=unused) then raise exception 'Unused suppression records not reclaimed';end if;
  if not exists(select 1 from public.broadcast_history_hidden where user_id=coach and broadcast_id=kept and purged_at is not null) then raise exception 'Permanent history marker missing';end if;
  if not exists(select 1 from public.broadcast_recipients where client_id=client_one and broadcast_id=recent) then raise exception 'Recent clear was purged early';end if;
  perform set_config('request.jwt.claim.sub',client_one::text,true);
  affected:=public.set_notifications_cleared(client_one,array[kept],false);
  if cardinality(affected)<>0 then raise exception 'Deleted recipient copy was resurrected';end if;
  if has_function_privilege('authenticated','private.purge_expired_message_copies()','execute') then raise exception 'Users can invoke global purge';end if;
  if not exists(select 1 from cron.job where jobname='bodyfy-purge-cleared-messages' and active and schedule='* * * * *') then raise exception 'Automatic cleanup not scheduled';end if;
end;
$$;
rollback;
