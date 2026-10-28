begin;
do $$
declare
  administrator uuid:=gen_random_uuid(); coach_one uuid:=gen_random_uuid(); coach_two uuid:=gen_random_uuid(); client uuid:=gen_random_uuid();
  coach_message uuid; client_message uuid; all_message uuid; outgoing uuid; denied boolean; changed uuid[];
begin
  insert into auth.users(id,email,raw_user_meta_data) values
    (administrator,administrator::text||'@test.invalid','{"display_name":"Coach inbox test admin"}'),
    (coach_one,coach_one::text||'@test.invalid','{"display_name":"Coach inbox test one"}'),
    (coach_two,coach_two::text||'@test.invalid','{"display_name":"Coach inbox test two"}'),
    (client,client::text||'@test.invalid','{"display_name":"Coach inbox test client"}');
  update public.user_roles set role='super_admin' where user_id=administrator;
  update public.user_roles set role='coach' where user_id in (coach_one,coach_two);
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  execute 'set local role authenticated';
  -- Exercise the real recipient trigger. Nothing is committed or pushed to devices.
  insert into public.broadcasts(author_id,kind,title,message,audience) values(administrator,'custom','Coaches update','Team update','coaches') returning id into coach_message;
  insert into public.broadcasts(author_id,kind,title,message,audience) values(administrator,'custom','Client update','Client notice','clients') returning id into client_message;
  insert into public.broadcasts(author_id,kind,title,message,audience) values(administrator,'custom','Everyone update','Studio notice','all') returning id into all_message;
  if not exists(select 1 from public.broadcast_recipients where broadcast_id=coach_message and client_id=coach_one)
    or exists(select 1 from public.broadcast_recipients where broadcast_id=coach_message and client_id=client)
    or not exists(select 1 from public.broadcast_recipients where broadcast_id=all_message and client_id=client)
    or not exists(select 1 from public.broadcast_recipients where broadcast_id=all_message and client_id=coach_two) then raise exception 'Audience fan-out is incorrect';end if;
  perform set_config('request.jwt.claim.sub',coach_one::text,true);
  if not exists(select 1 from public.broadcasts where id=coach_message) then raise exception 'Coach cannot read incoming update';end if;
  if exists(select 1 from public.broadcasts where id=client_message) then raise exception 'Coach can read a private client update';end if;
  if exists(select 1 from public.broadcast_recipients where broadcast_id=coach_message and client_id=coach_two) then raise exception 'Coach can read another inbox';end if;
  update public.broadcast_recipients set read_at=now() where broadcast_id=coach_message and client_id=coach_one;
  if not found then raise exception 'Coach cannot mark inbox read';end if;
  changed:=public.set_notifications_cleared(coach_one,array[coach_message],true);
  if cardinality(changed)<>1 then raise exception 'Coach cannot clear own inbox';end if;
  perform public.set_notifications_cleared(coach_one,array[coach_message],false);
  denied:=false;begin perform public.set_notifications_cleared(coach_two,array[coach_message],true);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Coach cleared another inbox';end if;
  insert into public.broadcasts(author_id,kind,title,message,audience) values(coach_one,'water','Coach reminder','Client water reminder','clients') returning id into outgoing;
  if not exists(select 1 from public.broadcasts where id=outgoing) then raise exception 'Coach lost access to sent history';end if;
  if exists(select 1 from public.broadcast_recipients where broadcast_id=outgoing and client_id=coach_one) then raise exception 'Own broadcast appeared in incoming inbox';end if;
  denied:=false;begin insert into public.broadcasts(author_id,kind,title,message,audience) values(coach_one,'custom','Forbidden coach update','Forbidden','coaches');exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Coach could target coaches';end if;
  denied:=false;begin insert into public.broadcasts(author_id,kind,title,message,audience) values(coach_one,'custom','Forbidden all update','Forbidden','all');exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Coach could target everyone';end if;
  perform set_config('request.jwt.claim.sub',client::text,true);
  if exists(select 1 from public.broadcasts where id=coach_message) then raise exception 'Client can read a private coach update';end if;
  if not exists(select 1 from public.broadcasts where id=outgoing) then raise exception 'Client did not receive normal coach broadcast';end if;
  execute 'reset role';
  if not has_table_privilege('service_role','public.broadcast_recipients','select') then raise exception 'Push sender lacks recipient access';end if;
end;
$$;
rollback;
