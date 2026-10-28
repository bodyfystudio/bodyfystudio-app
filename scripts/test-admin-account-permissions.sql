-- Run after migration 007. Fixtures and all edits are rolled back.
begin;
do $$
declare
  administrator uuid := gen_random_uuid();
  client_one uuid := gen_random_uuid();
  client_two uuid := gen_random_uuid();
  coach uuid := gen_random_uuid();
  plan uuid;
  recipe uuid;
  broadcast uuid;
  progress uuid;
  appointment uuid;
  snapshot jsonb;
  denied boolean;
begin
  insert into auth.users(id, email, raw_user_meta_data) values
    (administrator, administrator::text || '@test.invalid', '{"display_name":"Workspace test admin"}'),
    (client_one, client_one::text || '@test.invalid', '{"display_name":"Workspace test client one"}'),
    (client_two, client_two::text || '@test.invalid', '{"display_name":"Workspace test client two"}'),
    (coach, coach::text || '@test.invalid', '{"display_name":"Workspace test coach"}');
  update public.user_roles set role = 'super_admin' where user_id = administrator;
  update public.user_roles set role = 'coach' where user_id = coach;
  if has_function_privilege('anon', 'public.admin_account_snapshot(uuid)', 'execute')
    or has_function_privilege('anon', 'public.admin_manage_account(uuid,text,uuid,jsonb)', 'execute') then
    raise exception 'Anonymous callers can execute account RPCs';
  end if;
  foreach client_one in array array[client_one, coach] loop
    perform set_config('request.jwt.claim.sub', client_one::text, true);
    denied := false;
    begin perform public.admin_account_snapshot(client_two);
    exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'Non-admin could read another account'; end if;
    denied := false;
    begin perform public.admin_manage_account(client_two, 'profile', null, '{"display_name":"Unauthorized"}');
    exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'Non-admin could change another account'; end if;
  end loop;
  -- The loop variable is now the coach. Recover the original first client fixture.
  select id into client_one from public.profiles where display_name = 'Workspace test client one';
  perform set_config('request.jwt.claim.sub', administrator::text, true);
  perform public.admin_manage_account(client_one, 'profile', null, '{"display_name":"Updated test client"}');
  perform public.admin_manage_account(client_one, 'assignment', null, jsonb_build_object('coach_id', coach));
  perform public.admin_manage_account(client_one, 'plans', null, jsonb_build_object('coach_id', coach,
    'title','Test plan', 'status','active', 'plan_data',jsonb_build_object('Breakfast','Oats')));
  select id into plan from public.client_plans where client_id = client_one;
  perform public.admin_manage_account(client_one, 'plans', plan, '{"title":"Updated plan","status":"paused"}');
  perform public.admin_manage_account(client_one, 'progress', null, '{"metrics":{"water":5},"note":"Check-in"}');
  select id into progress from public.progress_entries where client_id = client_one;
  perform public.admin_manage_account(client_one, 'progress', progress, '{"metrics":{"water":6},"note":"Updated check-in"}');
  perform public.admin_manage_account(coach, 'appointments', null, jsonb_build_object('client_id',client_one,
    'starts_at',now(), 'duration_minutes',30, 'status','confirmed'));
  select id into appointment from public.appointments where client_id = client_one;
  perform public.admin_manage_account(client_one, 'appointments', appointment, '{"status":"completed"}');
  insert into public.recipes(author_id, title, category) values (coach,'Test recipe','Breakfast') returning id into recipe;
  perform public.admin_manage_account(coach, 'recipes', recipe, '{"title":"Updated recipe","published":true,"ingredients":["Oats","Milk"]}');
  -- Suppress the global fan-out trigger for this rollback-only fixture so no real inbox receives even a temporary insert.
  alter table public.broadcasts disable trigger on_broadcast_created;
  insert into public.broadcasts(author_id,kind,title,message) values (coach,'water','Test reminder','Water') returning id into broadcast;
  alter table public.broadcasts enable trigger on_broadcast_created;
  insert into public.broadcast_recipients(broadcast_id,client_id) values (broadcast,client_one);
  perform public.admin_manage_account(coach, 'broadcasts', broadcast, '{"message":"Updated water reminder"}');
  perform public.admin_manage_account(client_one, 'inbox', broadcast, '{"read":true}');
  denied := false;
  begin perform public.admin_manage_account(client_two, 'plans', plan, '{"title":"Wrong account"}');
  exception when others then denied := true; end;
  if not denied then raise exception 'Cross-account record update was accepted'; end if;
  denied := false;
  begin perform public.admin_manage_account(client_one, 'plans', plan, jsonb_build_object('client_id',client_two));
  exception when others then denied := true; end;
  if not denied then raise exception 'Record ownership could be rewritten'; end if;
  snapshot := public.admin_account_snapshot(client_one);
  if snapshot#>>'{profile,display_name}' <> 'Updated test client'
    or snapshot#>>'{plans,0,title}' <> 'Updated plan'
    or snapshot#>>'{plans,0,status}' <> 'paused'
    or snapshot#>>'{progress,0,metrics,water}' <> '6'
    or snapshot#>>'{appointments,0,status}' <> 'completed'
    or snapshot#>>'{inbox,0,message}' <> 'Updated water reminder'
    or snapshot#>>'{inbox,0,read_at}' is null
    or jsonb_array_length(snapshot->'assignments') <> 1 then raise exception 'Account changes did not persist'; end if;
  if not exists(select 1 from public.admin_account_activity where actor_id = administrator and target_id = client_one and action = 'Updated plans') then
    raise exception 'Admin actor was not recorded';
  end if;
  snapshot := public.admin_account_snapshot(coach);
  if snapshot#>>'{recipes,0,title}' <> 'Updated recipe' or jsonb_array_length(snapshot#>'{recipes,0,ingredients}') <> 2 then
    raise exception 'Coach recipe update failed'; end if;
  perform public.admin_manage_account(coach, 'unassign', null, jsonb_build_object('client_id',client_one));
  if exists(select 1 from public.coach_assignments where client_id = client_one) then raise exception 'Unassign failed'; end if;
  raise notice 'PASS: role checks, anonymous denial, scoped reads and edits, assignment, record ownership, and audit actor';
end;
$$;
rollback;
