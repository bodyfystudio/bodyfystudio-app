-- Account administration stays in the caller's session. Never mint a client login.
create table public.admin_account_activity (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  target_id uuid references auth.users(id) on delete set null,
  action text not null,
  record_id text,
  created_at timestamptz not null default now()
);
alter table public.admin_account_activity enable row level security;
revoke all on public.admin_account_activity from anon, authenticated;
grant select on public.admin_account_activity to authenticated;
create policy "admin_activity_read_admin" on public.admin_account_activity
for select to authenticated using (private.has_role('super_admin'::public.app_role));

create function public.admin_account_snapshot(target_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  target_role public.app_role;
  result jsonb;
begin
  if not private.has_role('super_admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'Super admin access required';
  end if;
  select role into target_role from public.user_roles where user_id = target_user;
  if target_role is null then raise exception 'Account not found'; end if;
  select jsonb_build_object(
    'profile', (select jsonb_build_object('id', p.id, 'display_name', p.display_name,
      'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
      'email_confirmed_at', u.email_confirmed_at, 'role', target_role)
      from public.profiles p join auth.users u on u.id = p.id where p.id = target_user),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', r.role)
      order by p.display_name, p.id), '[]'::jsonb) from public.profiles p join public.user_roles r on r.user_id = p.id),
    'assignments', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
      from public.coach_assignments a where a.client_id = target_user or a.coach_id = target_user),
    'plans', (select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]'::jsonb)
      from public.client_plans p where p.client_id = target_user or p.coach_id = target_user),
    'progress', (select coalesce(jsonb_agg(to_jsonb(p) order by p.recorded_at desc), '[]'::jsonb)
      from public.progress_entries p where p.client_id = target_user),
    'appointments', (select coalesce(jsonb_agg(to_jsonb(a) order by a.starts_at desc), '[]'::jsonb)
      from public.appointments a where a.client_id = target_user or a.coach_id = target_user),
    'recipes', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      from public.recipes r where r.author_id = target_user),
    'broadcasts', (select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at desc), '[]'::jsonb)
      from public.broadcasts b where b.author_id = target_user),
    'inbox', (select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('read_at', r.read_at)
      order by r.created_at desc), '[]'::jsonb) from public.broadcast_recipients r
      join public.broadcasts b on b.id = r.broadcast_id where r.client_id = target_user),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('created_at', s.created_at, 'updated_at', s.updated_at)
      order by s.created_at desc), '[]'::jsonb) from public.push_subscriptions s where s.user_id = target_user),
    'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
      from (select id, actor_id, action, record_id, created_at from public.admin_account_activity
      where target_id = target_user order by created_at desc, id desc limit 100) a)
  ) into result;
  insert into public.admin_account_activity(actor_id, target_id, action)
    values (auth.uid(), target_user, 'Opened account');
  return result;
end;
$$;

create function public.admin_manage_account(target_user uuid, section text, record_id uuid, changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target_role public.app_role;
  table_name text;
  permitted text[];
  key text;
  assignments text;
  relationship text;
  affected integer;
  coach uuid;
  client uuid;
begin
  if not private.has_role('super_admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'Super admin access required';
  end if;
  select role into target_role from public.user_roles where user_id = target_user for share;
  if target_role is null then raise exception 'Account not found'; end if;
  if target_role = 'super_admin' then raise exception 'Use your own profile for super admin accounts'; end if;
  if jsonb_typeof(changes) is distinct from 'object' then raise exception 'Invalid account changes'; end if;

  if section = 'profile' then
    if exists(select 1 from jsonb_object_keys(changes) k where k <> 'display_name') then raise exception 'Unsupported profile field'; end if;
    update public.profiles set display_name = trim(changes->>'display_name') where id = target_user;
  elsif section = 'assignment' then
    client := case when target_role = 'client' then target_user else (changes->>'client_id')::uuid end;
    coach := case when target_role = 'coach' then target_user else nullif(changes->>'coach_id', '')::uuid end;
    if not exists(select 1 from public.user_roles where user_id = client and role = 'client') then raise exception 'Choose a client account'; end if;
    if coach is null then
      delete from public.coach_assignments where client_id = client;
    else
      if not exists(select 1 from public.user_roles where user_id = coach and role = 'coach') then raise exception 'Choose a coach account'; end if;
      insert into public.coach_assignments(client_id, coach_id, assigned_by) values (client, coach, auth.uid())
        on conflict (client_id) do update set coach_id = excluded.coach_id, assigned_by = excluded.assigned_by;
    end if;
  elsif section = 'unassign' then
    delete from public.coach_assignments
      where client_id = (changes->>'client_id')::uuid
      and (client_id = target_user or coach_id = target_user);
    if not found then raise exception 'Assignment does not belong to this account'; end if;
  elsif section = 'inbox' then
    update public.broadcast_recipients set read_at = case when (changes->>'read')::boolean then now() else null end
      where client_id = target_user and broadcast_id = record_id;
    if not found then raise exception 'Inbox item not found'; end if;
  else
    case section
      when 'plans' then table_name := 'client_plans'; permitted := array['title','plan_data','status','starts_on','ends_on']; relationship := 't.client_id = $1 or t.coach_id = $1';
      when 'progress' then table_name := 'progress_entries'; permitted := array['recorded_at','metrics','note']; relationship := 't.client_id = $1';
      when 'appointments' then table_name := 'appointments'; permitted := array['starts_at','duration_minutes','status','meeting_url','client_note']; relationship := 't.client_id = $1 or t.coach_id = $1';
      when 'recipes' then table_name := 'recipes'; permitted := array['title','category','description','ingredients','steps','prep_minutes','calories_estimate','emoji','published']; relationship := 't.author_id = $1';
      when 'broadcasts' then table_name := 'broadcasts'; permitted := array['title','message','kind','action_url']; relationship := 't.author_id = $1';
      else raise exception 'Unsupported account section';
    end case;
    if record_id is null then
      if section not in ('plans', 'progress', 'appointments') then raise exception 'Create coach content from the publishing tools'; end if;
      client := case when target_role = 'client' then target_user else (changes->>'client_id')::uuid end;
      coach := case when target_role = 'coach' then target_user else (changes->>'coach_id')::uuid end;
      if not exists(select 1 from public.user_roles where user_id = client and role = 'client') then raise exception 'Choose a client account'; end if;
      if section <> 'progress' and not exists(select 1 from public.user_roles where user_id = coach and role = 'coach') then raise exception 'Choose a coach account'; end if;
      if section = 'plans' then
        insert into public.client_plans(client_id, coach_id, title, plan_data, status, starts_on, ends_on)
          values (client, coach, changes->>'title', coalesce(changes->'plan_data', '{}'::jsonb),
            (changes->>'status')::public.plan_status, (changes->>'starts_on')::date, (changes->>'ends_on')::date) returning id into record_id;
      elsif section = 'progress' then
        insert into public.progress_entries(client_id, recorded_at, metrics, note)
          values (client, coalesce((changes->>'recorded_at')::timestamptz, now()), coalesce(changes->'metrics', '{}'::jsonb), changes->>'note') returning id into record_id;
      else
        insert into public.appointments(client_id, coach_id, starts_at, duration_minutes, status, meeting_url, client_note)
          values (client, coach, (changes->>'starts_at')::timestamptz, (changes->>'duration_minutes')::integer,
            (changes->>'status')::public.appointment_status, changes->>'meeting_url', changes->>'client_note') returning id into record_id;
      end if;
    else
      for key in select jsonb_object_keys(changes) loop
        if not (key = any(permitted)) then raise exception 'Unsupported account field: %', key; end if;
      end loop;
      select string_agg(format('%I = v.%I', k, k), ', ') into assignments from jsonb_object_keys(changes) k;
      if assignments is null then raise exception 'No changes supplied'; end if;
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $3) v where t.id = $2 and (%s)',
        table_name, assignments, table_name, relationship) using target_user, record_id, changes;
      get diagnostics affected = row_count;
      if affected <> 1 then raise exception 'Record does not belong to this account'; end if;
    end if;
  end if;
  insert into public.admin_account_activity(actor_id, target_id, action, record_id)
    values (auth.uid(), target_user, 'Updated ' || section, record_id::text);
end;
$$;

revoke all on function public.admin_account_snapshot(uuid) from public, anon;
revoke all on function public.admin_manage_account(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.admin_account_snapshot(uuid) to authenticated;
grant execute on function public.admin_manage_account(uuid, text, uuid, jsonb) to authenticated;
