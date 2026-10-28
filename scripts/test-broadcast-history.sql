begin;
do $$
declare
  coach uuid:=gen_random_uuid(); other_coach uuid:=gen_random_uuid(); administrator uuid:=gen_random_uuid(); client uuid:=gen_random_uuid();
  own_broadcast uuid; other_broadcast uuid; new_broadcast uuid; affected uuid[]; denied boolean; history jsonb;
begin
  insert into auth.users(id,email,raw_user_meta_data) values
    (coach,coach::text||'@test.invalid','{"display_name":"History test coach"}'),
    (other_coach,other_coach::text||'@test.invalid','{"display_name":"History test other coach"}'),
    (administrator,administrator::text||'@test.invalid','{"display_name":"History test admin"}'),
    (client,client::text||'@test.invalid','{"display_name":"History test client"}');
  update public.user_roles set role='coach' where user_id in (coach,other_coach);
  update public.user_roles set role='super_admin' where user_id=administrator;
  alter table public.broadcasts disable trigger on_broadcast_created;
  insert into public.broadcasts(author_id,kind,title,message) values(coach,'custom','Own history','One') returning id into own_broadcast;
  insert into public.broadcasts(author_id,kind,title,message) values(other_coach,'custom','Other history','Two') returning id into other_broadcast;
  insert into public.broadcasts(author_id,kind,title,message) values(coach,'custom','New history','Three') returning id into new_broadcast;
  alter table public.broadcasts enable trigger on_broadcast_created;
  insert into public.broadcast_recipients(client_id,broadcast_id) values(client,own_broadcast);
  perform set_config('request.jwt.claim.sub',coach::text,true);execute 'set local role authenticated';
  affected:=public.set_broadcast_history_cleared(array[own_broadcast,own_broadcast],true);
  if cardinality(affected)<>1 then raise exception 'Individual history clear failed';end if;
  history:=public.get_broadcast_history();
  if exists(select 1 from jsonb_array_elements(history) b where (b->>'id')::uuid=own_broadcast)
    or not exists(select 1 from jsonb_array_elements(history) b where (b->>'id')::uuid=new_broadcast)
    or exists(select 1 from jsonb_array_elements(history) b where (b->>'id')::uuid=other_broadcast) then raise exception 'History visibility incorrect';end if;
  affected:=public.set_broadcast_history_cleared(array[own_broadcast],true);
  if cardinality(affected)<>0 then raise exception 'Duplicate clear was not idempotent';end if;
  affected:=public.set_broadcast_history_cleared(array[own_broadcast],false);
  if cardinality(affected)<>1 then raise exception 'Undo failed';end if;
  denied:=false;begin perform public.set_broadcast_history_cleared(array[other_broadcast],true);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Coach cleared another coach’s broadcast';end if;
  perform public.set_broadcast_history_cleared(array[own_broadcast,new_broadcast],true);
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  history:=public.get_broadcast_history();
  if not exists(select 1 from jsonb_array_elements(history) b where (b->>'id')::uuid=own_broadcast) then raise exception 'Coach clear affected admin history';end if;
  perform public.set_broadcast_history_cleared(array[other_broadcast],true);
  perform set_config('request.jwt.claim.sub',other_coach::text,true);
  history:=public.get_broadcast_history();
  if not exists(select 1 from jsonb_array_elements(history) b where (b->>'id')::uuid=other_broadcast) then raise exception 'Admin clear affected coach history';end if;
  if exists(select 1 from public.broadcast_history_hidden where user_id<>other_coach) then raise exception 'Private preferences leaked';end if;
  perform set_config('request.jwt.claim.sub',client::text,true);
  denied:=false;begin perform public.get_broadcast_history();exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Client accessed staff history';end if;
  if not exists(select 1 from public.broadcast_recipients where client_id=client and broadcast_id=own_broadcast and dismissed_at is null) then raise exception 'Recipient inbox was changed';end if;
  if not exists(select 1 from public.broadcasts where id=own_broadcast) then raise exception 'Original broadcast was deleted';end if;
  execute 'reset role';
  if has_function_privilege('anon','public.set_broadcast_history_cleared(uuid[],boolean)','execute') then raise exception 'Anonymous history changes allowed';end if;
  if not exists(select 1 from public.admin_account_activity where actor_id=administrator and action='Cleared broadcast history') then raise exception 'Admin action was not audited';end if;
end;
$$;
rollback;
