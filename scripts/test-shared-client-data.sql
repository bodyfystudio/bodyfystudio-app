-- Apply migration 008 first; all fixtures and changes in this check roll back.
begin;
do $$
declare
  administrator uuid := gen_random_uuid();
  first_client uuid := gen_random_uuid();
  other_client uuid := gen_random_uuid();
  coach uuid := gen_random_uuid();
  plan uuid; recipe uuid; habit uuid; snapshot jsonb; denied boolean;
begin
  insert into auth.users(id,email,raw_user_meta_data) values
    (administrator,administrator::text||'@test.invalid','{"display_name":"Personal data test admin"}'),
    (first_client,first_client::text||'@test.invalid','{"display_name":"Personal data test client"}'),
    (other_client,other_client::text||'@test.invalid','{"display_name":"Personal data other client"}'),
    (coach,coach::text||'@test.invalid','{"display_name":"Personal data test coach"}');
  update public.user_roles set role='super_admin' where user_id=administrator;
  update public.user_roles set role='coach' where user_id=coach;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  perform public.save_daily_habits(other_client,current_date,'{"water":7}',0);
  insert into public.coach_assignments(client_id,coach_id) values(first_client,coach);
  insert into public.client_plans(client_id,coach_id,title,status,starts_on,plan_data)
    values(first_client,coach,'Assigned plan','active',current_date,'{"Breakfast":"Oats","Walk":"20 minutes"}') returning id into plan;
  insert into public.recipes(author_id,title,category,published) values(coach,'Saved breakfast','Breakfast',true) returning id into recipe;
  perform set_config('request.jwt.claim.sub',first_client::text,true);
  perform public.save_daily_habits(first_client,current_date,'{"steps":6200,"weight_kg":72.4}',1);
  perform public.save_daily_habits(first_client,current_date,'{}',1);
  perform public.save_daily_habits(first_client,current_date-1,'{"water":3,"weight_kg":73}',0);
  perform public.set_recipe_favorite(first_client,recipe,true);
  perform public.set_recipe_favorite(first_client,recipe,true);
  perform public.set_plan_checklist(first_client,plan,'detail:Breakfast',current_date,true);
  snapshot:=public.account_personal_snapshot(first_client,current_date);
  if snapshot#>>'{habits,1,water}' <> '2' or snapshot#>>'{habits,1,steps}' <> '6200'
    or snapshot#>>'{coach,name}' <> 'Personal data test coach'
    or (snapshot->>'streak')::integer <> 2
    or jsonb_array_length(snapshot->'favorites') <> 1
    or snapshot#>>'{plans,0,title}' <> 'Assigned plan'
    or snapshot#>>'{checklist,0,completed}' <> 'true' then raise exception 'Saved client data failed to round trip'; end if;
  -- A new day is empty, while favorites remain and yesterday's completions do not leak into today.
  snapshot:=public.account_personal_snapshot(first_client,current_date+1);
  if jsonb_array_length(snapshot->'checklist')<>0 or jsonb_array_length(snapshot->'favorites')<>1 then raise exception 'Daily reset or persistent favorites failed'; end if;
  denied:=false;begin perform public.account_personal_snapshot(other_client,current_date);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Client read another account';end if;
  denied:=false;begin perform public.save_daily_habits(other_client,current_date,'{}',1);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Client changed another account’s habits';end if;
  denied:=false;begin perform public.set_recipe_favorite(other_client,recipe,true);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Client changed another account’s favorites';end if;
  denied:=false;begin perform public.set_plan_checklist(other_client,plan,'detail:Breakfast',current_date,true);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Client changed another account’s checklist';end if;
  denied:=false;begin perform public.set_plan_checklist(first_client,plan,'invented-task',current_date,true);exception when others then denied:=true;end;
  if not denied then raise exception 'Invented task was accepted';end if;
  denied:=false;begin perform public.save_daily_habits(first_client,current_date,'{"water":-1}',0);exception when check_violation then denied:=true;end;
  if not denied then raise exception 'Invalid habit count was accepted';end if;
  perform set_config('request.jwt.claim.sub',coach::text,true);
  denied:=false;begin perform public.save_daily_habits(first_client,current_date,'{}',1);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Coach could edit client habits';end if;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  snapshot:=public.admin_account_snapshot(first_client);
  if jsonb_array_length(snapshot->'habits')<>2 or jsonb_array_length(snapshot->'favorites')<>1 or jsonb_array_length(snapshot->'checklist')<>1 then raise exception 'Admin snapshot omitted shared data';end if;
  select id into habit from public.daily_habits where client_id=first_client and entry_date=current_date;
  perform public.admin_manage_account(first_client,'habits',habit,jsonb_build_object('entry_date',current_date,'water',4,'steps',8000,'weight_kg',72));
  perform public.admin_manage_account(first_client,'favorites',recipe,'{"saved":false}');
  perform public.admin_manage_account(first_client,'checklist',plan,jsonb_build_object('task_key','detail:Breakfast','entry_date',current_date,'completed',false));
  denied:=false;begin perform public.admin_manage_account(other_client,'habits',habit,jsonb_build_object('entry_date',current_date,'water',7));exception when others then denied:=true;end;
  if not denied then raise exception 'Admin habit editor accepted an unrelated record id';end if;
  perform set_config('request.jwt.claim.sub',first_client::text,true);
  snapshot:=public.account_personal_snapshot(first_client,current_date);
  if snapshot#>>'{habits,1,water}'<>'4' or jsonb_array_length(snapshot->'favorites')<>0 or snapshot#>>'{checklist,0,completed}'<>'false' then raise exception 'Admin changes did not reach client data';end if;
  if has_function_privilege('authenticated','public.admin_account_snapshot_v1(uuid)','execute') or has_function_privilege('anon','public.save_daily_habits(uuid,date,jsonb,integer)','execute') then raise exception 'Unexpected RPC grant';end if;
  -- Verify RLS through the actual authenticated role, including spoofed direct table writes.
  execute 'set local role authenticated';
  if exists(select 1 from public.daily_habits where client_id=other_client) then raise exception 'RLS leaked another client';end if;
  denied:=false;begin insert into public.daily_habits(client_id,entry_date,water) values(other_client,current_date,1);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Direct table writes bypassed the RPC';end if;
  execute 'reset role';
  if not exists(select 1 from public.admin_account_activity where actor_id=administrator and target_id=first_client and action='Updated daily habits') then raise exception 'Admin habit audit missing';end if;
end;
$$;
rollback;
