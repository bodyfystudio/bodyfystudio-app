-- Account-owned data replaces the anonymous browser-wide demonstration store.
create table public.daily_habits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  water integer not null default 0 check (water between 0 and 100),
  steps integer not null default 0 check (steps between 0 and 250000),
  weight_kg numeric(5,2) check (weight_kg between 1 and 600),
  updated_at timestamptz not null default now(),
  unique(client_id, entry_date)
);
create table public.recipe_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, recipe_id)
);
create table public.plan_checklist (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references public.client_plans(id) on delete cascade,
  task_key text not null check (char_length(task_key) between 1 and 500),
  entry_date date not null,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique(client_id, plan_id, task_key, entry_date)
);
alter table public.daily_habits enable row level security;
alter table public.recipe_favorites enable row level security;
alter table public.plan_checklist enable row level security;
revoke all on public.daily_habits, public.recipe_favorites, public.plan_checklist from anon, authenticated;
grant select on public.daily_habits, public.recipe_favorites, public.plan_checklist to authenticated;
create policy "habits_read_owner_coach_admin" on public.daily_habits for select to authenticated using (private.can_access_client(client_id));
create policy "favorites_read_owner_admin" on public.recipe_favorites for select to authenticated using (user_id = auth.uid() or private.has_role('super_admin'));
create policy "checklist_read_owner_coach_admin" on public.plan_checklist for select to authenticated using (private.can_access_client(client_id));

create function private.plan_task_keys(plan_data jsonb) returns setof text
language sql immutable set search_path = '' as $$
  select 'task:' || coalesce(nullif(item->>'id',''), nullif(item->>'title',''), n::text)
  from jsonb_array_elements(case when jsonb_typeof(plan_data->'tasks') = 'array' then plan_data->'tasks' else '[]'::jsonb end) with ordinality a(item,n)
  union all
  select 'detail:' || k from jsonb_object_keys(case when jsonb_typeof(plan_data) = 'object' and jsonb_typeof(plan_data->'tasks') is distinct from 'array' then plan_data else '{}'::jsonb end) k;
$$;
revoke all on function private.plan_task_keys(jsonb) from public, anon, authenticated;

create function public.save_daily_habits(target_user uuid, entry_day date, changes jsonb, water_delta integer default 0)
returns void language plpgsql security definer set search_path = '' as $$
declare is_admin boolean := private.has_role('super_admin');
begin
  if not is_admin and (target_user is distinct from auth.uid() or not private.has_role('client')) then
    raise exception using errcode = '42501', message = 'You can only update your own habits'; end if;
  if not exists(select 1 from public.user_roles where user_id = target_user and role = 'client') then raise exception 'Client account required'; end if;
  if entry_day is null or entry_day > current_date + 1 then raise exception 'Choose a valid day'; end if;
  if jsonb_typeof(changes) is distinct from 'object' or exists(select 1 from jsonb_object_keys(changes) k where k not in ('water','steps','weight_kg')) then raise exception 'Unsupported habit field'; end if;
  if water_delta not between 0 and 1 or water_delta is null then raise exception 'Invalid water increment'; end if;
  insert into public.daily_habits(client_id, entry_date) values (target_user, entry_day) on conflict do nothing;
  update public.daily_habits h set
    water = (case when changes ? 'water' then (changes->>'water')::integer else h.water end) + water_delta,
    steps = case when changes ? 'steps' then (changes->>'steps')::integer else h.steps end,
    weight_kg = case when changes ? 'weight_kg' then (changes->>'weight_kg')::numeric else h.weight_kg end,
    updated_at = now()
    where client_id = target_user and entry_date = entry_day;
  if is_admin then insert into public.admin_account_activity(actor_id,target_id,action,record_id)
    values(auth.uid(),target_user,'Updated daily habits',entry_day::text); end if;
end;
$$;

create function public.set_recipe_favorite(target_user uuid, recipe uuid, saved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare is_admin boolean := private.has_role('super_admin');
begin
  if auth.uid() is null or (not is_admin and target_user is distinct from auth.uid()) then
    raise exception using errcode = '42501', message = 'You can only update your own favorites'; end if;
  if saved is null then raise exception 'Choose whether to save this recipe'; end if;
  if saved then
    if not exists(select 1 from public.recipes where id = recipe and published) then raise exception 'Published recipe not found'; end if;
    insert into public.recipe_favorites(user_id,recipe_id) values(target_user,recipe) on conflict do nothing;
  else delete from public.recipe_favorites where user_id = target_user and recipe_id = recipe; end if;
  if is_admin then insert into public.admin_account_activity(actor_id,target_id,action,record_id)
    values(auth.uid(),target_user,'Updated recipe favorites',recipe::text); end if;
end;
$$;

create function public.set_plan_checklist(target_user uuid, plan uuid, task text, entry_day date, done boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare is_admin boolean := private.has_role('super_admin');
begin
  if not is_admin and (target_user is distinct from auth.uid() or not private.has_role('client')) then
    raise exception using errcode = '42501', message = 'You can only update your own checklist'; end if;
  if entry_day is null or entry_day > current_date + 1 or done is null then raise exception 'Choose a valid day and completion'; end if;
  if not exists(select 1 from public.client_plans p where p.id = plan and p.client_id = target_user
    and (is_admin or (p.status = 'active' and (p.starts_on is null or p.starts_on <= entry_day) and (p.ends_on is null or p.ends_on >= entry_day)))
    and task in (select private.plan_task_keys(p.plan_data))) then raise exception 'Task is not part of this client’s current plan'; end if;
  insert into public.plan_checklist(client_id,plan_id,task_key,entry_date,completed)
    values(target_user,plan,task,entry_day,done)
    on conflict(client_id,plan_id,task_key,entry_date) do update set completed = excluded.completed, updated_at = now();
  if is_admin then insert into public.admin_account_activity(actor_id,target_id,action,record_id)
    values(auth.uid(),target_user,'Updated plan checklist',plan::text); end if;
end;
$$;

create function public.account_personal_snapshot(target_user uuid, entry_day date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; streak integer;
begin
  if auth.uid() is null or (target_user is distinct from auth.uid() and not private.has_role('super_admin')) then
    raise exception using errcode = '42501', message = 'You can only read your own personal data'; end if;
  if entry_day is null then raise exception 'Choose a day'; end if;
  with days as (
    select entry_date as d from public.daily_habits where client_id = target_user and entry_date <= entry_day and (water > 0 or steps > 0 or weight_kg is not null)
    union select entry_date from public.plan_checklist where client_id = target_user and completed and entry_date <= entry_day
  ), numbered as (select d, row_number() over(order by d desc)::integer as n, max(d) over() as latest from days)
  select count(*)::integer into streak from numbered where latest >= entry_day - 1 and d = latest - (n-1);
  select jsonb_build_object(
    'day',entry_day, 'name',(select display_name from public.profiles where id = target_user), 'streak',streak,
    'habits',(select coalesce(jsonb_agg(to_jsonb(h) order by h.entry_date), '[]'::jsonb) from public.daily_habits h where client_id = target_user and entry_date between entry_day-6 and entry_day),
    'weight_start',(select weight_kg from public.daily_habits where client_id = target_user and weight_kg is not null and entry_date <= entry_day order by entry_date limit 1),
    'weight_now',(select weight_kg from public.daily_habits where client_id = target_user and weight_kg is not null and entry_date <= entry_day order by entry_date desc limit 1),
    'plans',(select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id), '[]'::jsonb) from public.client_plans p where client_id = target_user and status <> 'draft'),
    'checklist',(select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.plan_checklist c where client_id = target_user and entry_date = entry_day),
    'favorites',(select coalesce(jsonb_agg(recipe_id), '[]'::jsonb) from public.recipe_favorites where user_id = target_user),
    'coach',(select jsonb_build_object('id',p.id,'name',p.display_name) from public.coach_assignments a join public.profiles p on p.id = a.coach_id where client_id = target_user),
    'appointments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.starts_at), '[]'::jsonb) from public.appointments a where client_id = target_user)
  ) into result;
  return result;
end;
$$;

-- Preserve the original account administration routines and extend their checked interface.
alter function public.admin_account_snapshot(uuid) rename to admin_account_snapshot_v1;
revoke all on function public.admin_account_snapshot_v1(uuid) from authenticated;
create function public.admin_account_snapshot(target_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.admin_account_snapshot_v1(target_user);
  return result || jsonb_build_object(
    'habits',(select coalesce(jsonb_agg(to_jsonb(h) order by h.entry_date desc), '[]'::jsonb) from public.daily_habits h where client_id = target_user),
    'favorites',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'published',r.published)), '[]'::jsonb) from public.recipe_favorites f join public.recipes r on r.id = f.recipe_id where f.user_id = target_user),
    'checklist',(select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_date desc), '[]'::jsonb) from public.plan_checklist c where client_id = target_user),
    'available_recipes',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title) order by r.title), '[]'::jsonb) from public.recipes r where published)
  );
end;
$$;
alter function public.admin_manage_account(uuid,text,uuid,jsonb) rename to admin_manage_account_v1;
revoke all on function public.admin_manage_account_v1(uuid,text,uuid,jsonb) from authenticated;
create function public.admin_manage_account(target_user uuid, section text, record_id uuid, changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare day date;
begin
  if not private.has_role('super_admin') then raise exception using errcode = '42501', message = 'Super admin access required'; end if;
  if not exists(select 1 from public.user_roles where user_id = target_user and role in ('client','coach')) then raise exception 'Choose a client or coach account'; end if;
  if section = 'habits' then
    day := (changes->>'entry_date')::date;
    if record_id is not null and not exists(select 1 from public.daily_habits where id = record_id and client_id = target_user and entry_date = day) then raise exception 'Habit entry does not belong to this account and day'; end if;
    perform public.save_daily_habits(target_user,day,changes-'entry_date',0);
  elsif section = 'favorites' then perform public.set_recipe_favorite(target_user,record_id,(changes->>'saved')::boolean);
  elsif section = 'checklist' then perform public.set_plan_checklist(target_user,record_id,changes->>'task_key',(changes->>'entry_date')::date,(changes->>'completed')::boolean);
  else perform public.admin_manage_account_v1(target_user,section,record_id,changes); end if;
end;
$$;
revoke all on function public.save_daily_habits(uuid,date,jsonb,integer), public.set_recipe_favorite(uuid,uuid,boolean), public.set_plan_checklist(uuid,uuid,text,date,boolean), public.account_personal_snapshot(uuid,date), public.admin_account_snapshot(uuid), public.admin_manage_account(uuid,text,uuid,jsonb) from public,anon;
grant execute on function public.save_daily_habits(uuid,date,jsonb,integer), public.set_recipe_favorite(uuid,uuid,boolean), public.set_plan_checklist(uuid,uuid,text,date,boolean), public.account_personal_snapshot(uuid,date), public.admin_account_snapshot(uuid), public.admin_manage_account(uuid,text,uuid,jsonb) to authenticated;

do $$
declare table_name text;
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['daily_habits','recipe_favorites','plan_checklist','client_plans','coach_assignments','appointments'] loop
      if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name) then
        execute format('alter publication supabase_realtime add table public.%I',table_name);
      end if;
    end loop;
  end if;
end;
$$;
