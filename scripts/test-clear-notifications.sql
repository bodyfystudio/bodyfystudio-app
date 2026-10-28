begin;
do $$
declare
  first_client uuid:=gen_random_uuid(); second_client uuid:=gen_random_uuid(); administrator uuid:=gen_random_uuid(); coach uuid:=gen_random_uuid();
  first_message uuid; new_message uuid; changed uuid[]; denied boolean; snapshot jsonb;
begin
  insert into auth.users(id,email,raw_user_meta_data) values
    (first_client,first_client::text||'@test.invalid','{"display_name":"Clear test one"}'),
    (second_client,second_client::text||'@test.invalid','{"display_name":"Clear test two"}'),
    (administrator,administrator::text||'@test.invalid','{"display_name":"Clear test admin"}'),
    (coach,coach::text||'@test.invalid','{"display_name":"Clear test coach"}');
  update public.user_roles set role='super_admin' where user_id=administrator;
  update public.user_roles set role='coach' where user_id=coach;
  -- Rollback-only fixture: prevent a broadcast fan-out into real client inboxes.
  alter table public.broadcasts disable trigger on_broadcast_created;
  insert into public.broadcasts(author_id,kind,title,message) values(coach,'custom','Past update','Test notification') returning id into first_message;
  insert into public.broadcasts(author_id,kind,title,message) values(coach,'custom','New update','New notification') returning id into new_message;
  alter table public.broadcasts enable trigger on_broadcast_created;
  insert into public.broadcast_recipients(client_id,broadcast_id) values(first_client,first_message),(second_client,first_message),(first_client,new_message);
  perform set_config('request.jwt.claim.sub',first_client::text,true);
  changed:=public.set_notifications_cleared(first_client,array[first_message],true);
  if cardinality(changed)<>1 or changed[1]<>first_message then raise exception 'Clear did not return affected ids';end if;
  if exists(select 1 from public.broadcast_recipients where client_id=first_client and broadcast_id=first_message and dismissed_at is null) then raise exception 'Notification remained visible';end if;
  if not exists(select 1 from public.broadcast_recipients where client_id=second_client and broadcast_id=first_message and dismissed_at is null) then raise exception 'Other recipient was affected';end if;
  if not exists(select 1 from public.broadcast_recipients where client_id=first_client and broadcast_id=new_message and dismissed_at is null) then raise exception 'New notification was cleared';end if;
  if not exists(select 1 from public.broadcasts where id=first_message) then raise exception 'Broadcast history was deleted';end if;
  changed:=public.set_notifications_cleared(first_client,array[first_message],true);
  if cardinality(changed)<>0 then raise exception 'Duplicate clear returned already-cleared ids for undo';end if;
  changed:=public.set_notifications_cleared(first_client,array[first_message],false);
  if cardinality(changed)<>1 then raise exception 'Undo did not restore the item';end if;
  denied:=false;begin perform public.set_notifications_cleared(second_client,array[first_message],true);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Client cleared another inbox';end if;
  perform set_config('request.jwt.claim.sub',coach::text,true);
  denied:=false;begin perform public.set_notifications_cleared(first_client,array[first_message],true);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Coach cleared a client inbox';end if;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  perform public.set_notifications_cleared(first_client,array[first_message],true);
  snapshot:=public.admin_account_snapshot(first_client);
  if not exists(select 1 from jsonb_array_elements(snapshot->'inbox') n where (n->>'id')::uuid=first_message and n->>'dismissed_at' is not null) then raise exception 'Cleared history missing from admin view';end if;
  if not exists(select 1 from public.admin_account_activity where actor_id=administrator and target_id=first_client and action='Cleared inbox notifications') then raise exception 'Admin clear was not audited';end if;
  if has_function_privilege('anon','public.set_notifications_cleared(uuid,uuid[],boolean)','execute') then raise exception 'Anonymous clearing is allowed';end if;
end;
$$;
rollback;
