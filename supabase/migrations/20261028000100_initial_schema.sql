-- BodyfyStudio application schema.
-- All client-facing data is protected by RLS. Never put a Supabase secret/service
-- role key in the PWA; it bypasses these policies.

create schema if not exists private;

create type public.app_role as enum ('client', 'coach', 'super_admin');
create type public.plan_status as enum ('draft', 'active', 'completed', 'paused');
create type public.appointment_status as enum ('requested', 'confirmed', 'cancelled', 'completed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 80)
);

-- Roles are stored separately from editable profile fields. Authenticated users
-- can read their own role, but cannot insert or update role assignments.
create table public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'client',
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.coach_assignments (
  client_id uuid primary key references auth.users(id) on delete cascade,
  coach_id uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint coach_assignment_distinct_users check (client_id <> coach_id)
);
create index coach_assignments_coach_id_idx on public.coach_assignments(coach_id);

create table public.client_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id) on delete cascade,
  coach_id uuid not null references auth.users(id) on delete restrict,
  title text not null,
  plan_data jsonb not null default '{}'::jsonb,
  status public.plan_status not null default 'draft',
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_plan_dates check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index client_plans_client_created_idx on public.client_plans(client_id, created_at desc);

-- Progress can contain personal wellness information. Keep entries append-only
-- for clients in this first schema; only the owner, assigned coach, and admin can read.
create table public.progress_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  metrics jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index progress_entries_client_recorded_idx on public.progress_entries(client_id, recorded_at desc);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete restrict,
  title text not null,
  category text not null check (category in ('Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks')),
  description text not null default '',
  ingredients text[] not null default '{}',
  steps text[] not null default '{}',
  prep_minutes integer not null default 15 check (prep_minutes between 1 and 600),
  calories_estimate integer check (calories_estimate is null or calories_estimate between 0 and 5000),
  emoji text not null default '🥗',
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recipes_published_category_idx on public.recipes(published, category, created_at desc);

create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('custom', 'water', 'fruit', 'zoom')),
  title text not null check (char_length(title) between 1 and 100),
  message text not null check (char_length(message) between 1 and 500),
  action_url text,
  created_at timestamptz not null default now(),
  constraint zoom_broadcast_requires_url check (kind <> 'zoom' or action_url is not null),
  constraint zoom_broadcast_url_domain check (
    action_url is null or action_url ~* '^https://([a-z0-9-]+[.])*zoom[.]us/'
  )
);
create index broadcasts_created_idx on public.broadcasts(created_at desc);

create table public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  client_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (broadcast_id, client_id)
);
create index broadcast_recipients_client_created_idx on public.broadcast_recipients(client_id, created_at desc);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id) on delete cascade,
  coach_id uuid not null references auth.users(id) on delete restrict,
  starts_at timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 240),
  status public.appointment_status not null default 'requested',
  meeting_url text,
  client_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index appointments_client_starts_idx on public.appointments(client_id, starts_at);
create index appointments_coach_starts_idx on public.appointments(coach_id, starts_at);

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function private.touch_updated_at();
create trigger client_plans_touch_updated_at before update on public.client_plans
for each row execute function private.touch_updated_at();
create trigger recipes_touch_updated_at before update on public.recipes
for each row execute function private.touch_updated_at();
create trigger appointments_touch_updated_at before update on public.appointments
for each row execute function private.touch_updated_at();

-- New self-registered users are clients only. User-supplied auth metadata never
-- selects a role; privileged roles are assigned separately by the super admin.
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  safe_name text;
begin
  safe_name := left(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 80);
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(safe_name, left(split_part(new.email, '@', 1), 80)));
  insert into public.user_roles (user_id, role)
  values (new.id, 'client'::public.app_role);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_auth_user();

create function private.has_role(required_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = required_role
  );
$$;

create function private.can_access_client(target_client uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_client = (select auth.uid())
    or private.has_role('super_admin'::public.app_role)
    or exists (
      select 1 from public.coach_assignments ca
      where ca.client_id = target_client and ca.coach_id = (select auth.uid())
    );
$$;

create function private.can_manage_client(target_client uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role('super_admin'::public.app_role)
    or (
      private.has_role('coach'::public.app_role)
      and exists (
        select 1 from public.coach_assignments ca
        where ca.client_id = target_client and ca.coach_id = (select auth.uid())
      )
    );
$$;

-- Create one in-app inbox item per current client when a coach broadcasts.
create function private.create_broadcast_recipients()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.broadcast_recipients (broadcast_id, client_id)
  select new.id, ur.user_id
  from public.user_roles ur
  where ur.role = 'client'::public.app_role;
  return new;
end;
$$;

create trigger on_broadcast_created
after insert on public.broadcasts
for each row execute function private.create_broadcast_recipients();

-- Restrict access to the helper schema and functions. Security-definer helpers
-- use a fixed empty search_path and schema-qualified relations.
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.has_role(public.app_role) to authenticated;
grant execute on function private.can_access_client(uuid) to authenticated;
grant execute on function private.can_manage_client(uuid) to authenticated;

-- No public/anonymous database access. Grant only the operations the app needs.
revoke all on public.profiles, public.user_roles, public.coach_assignments,
  public.client_plans, public.progress_entries, public.recipes,
  public.broadcasts, public.broadcast_recipients, public.appointments
from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.user_roles to authenticated;
grant select on public.coach_assignments to authenticated;
grant select, insert, update on public.client_plans to authenticated;
grant select, insert on public.progress_entries to authenticated;
grant select, insert, update, delete on public.recipes to authenticated;
grant select, insert on public.broadcasts to authenticated;
grant select on public.broadcast_recipients to authenticated;
grant update (read_at) on public.broadcast_recipients to authenticated;
grant select, insert, update on public.appointments to authenticated;

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.coach_assignments enable row level security;
alter table public.client_plans enable row level security;
alter table public.progress_entries enable row level security;
alter table public.recipes enable row level security;
alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;
alter table public.appointments enable row level security;

create policy "profiles_read_self_coach_or_admin" on public.profiles
for select to authenticated
using (private.can_access_client(id));
create policy "profiles_update_self_only" on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy "roles_read_self_or_admin" on public.user_roles
for select to authenticated
using (user_id = (select auth.uid()) or private.has_role('super_admin'::public.app_role));

create policy "assignments_read_participants_or_admin" on public.coach_assignments
for select to authenticated
using (client_id = (select auth.uid()) or coach_id = (select auth.uid()) or private.has_role('super_admin'::public.app_role));
create policy "assignments_manage_admin_only" on public.coach_assignments
for all to authenticated
using (private.has_role('super_admin'::public.app_role))
with check (private.has_role('super_admin'::public.app_role));

create policy "plans_read_client_coach_or_admin" on public.client_plans
for select to authenticated
using (private.can_access_client(client_id));
create policy "plans_create_assigned_coach_or_admin" on public.client_plans
for insert to authenticated
with check (
  private.has_role('super_admin'::public.app_role)
  or (private.has_role('coach'::public.app_role) and coach_id = (select auth.uid()) and private.can_manage_client(client_id))
);
create policy "plans_update_assigned_coach_or_admin" on public.client_plans
for update to authenticated
using (
  private.has_role('super_admin'::public.app_role)
  or (coach_id = (select auth.uid()) and private.can_manage_client(client_id))
)
with check (
  private.has_role('super_admin'::public.app_role)
  or (coach_id = (select auth.uid()) and private.can_manage_client(client_id))
);

create policy "progress_read_client_coach_or_admin" on public.progress_entries
for select to authenticated
using (private.can_access_client(client_id));
create policy "progress_client_insert_self" on public.progress_entries
for insert to authenticated
with check (client_id = (select auth.uid()) and private.has_role('client'::public.app_role));

create policy "recipes_read_published_or_own_draft_or_admin" on public.recipes
for select to authenticated
using (published or author_id = (select auth.uid()) or private.has_role('super_admin'::public.app_role));
create policy "recipes_create_coach_or_admin" on public.recipes
for insert to authenticated
with check (
  author_id = (select auth.uid())
  and (private.has_role('coach'::public.app_role) or private.has_role('super_admin'::public.app_role))
);
create policy "recipes_update_author_or_admin" on public.recipes
for update to authenticated
using (private.has_role('super_admin'::public.app_role) or (author_id = (select auth.uid()) and private.has_role('coach'::public.app_role)))
with check (private.has_role('super_admin'::public.app_role) or (author_id = (select auth.uid()) and private.has_role('coach'::public.app_role)));
create policy "recipes_delete_author_or_admin" on public.recipes
for delete to authenticated
using (private.has_role('super_admin'::public.app_role) or (author_id = (select auth.uid()) and private.has_role('coach'::public.app_role)));

create policy "broadcasts_read_authenticated" on public.broadcasts
for select to authenticated using (true);
create policy "broadcasts_create_coach_or_admin" on public.broadcasts
for insert to authenticated
with check (
  author_id = (select auth.uid())
  and (private.has_role('coach'::public.app_role) or private.has_role('super_admin'::public.app_role))
);

create policy "recipient_read_self_or_staff" on public.broadcast_recipients
for select to authenticated
using (client_id = (select auth.uid()) or private.has_role('coach'::public.app_role) or private.has_role('super_admin'::public.app_role));
create policy "recipient_mark_read_self" on public.broadcast_recipients
for update to authenticated
using (client_id = (select auth.uid()))
with check (client_id = (select auth.uid()));

create policy "appointments_read_participants_or_admin" on public.appointments
for select to authenticated
using (client_id = (select auth.uid()) or coach_id = (select auth.uid()) or private.has_role('super_admin'::public.app_role));
create policy "appointments_client_request" on public.appointments
for insert to authenticated
with check (
  client_id = (select auth.uid())
  and private.has_role('client'::public.app_role)
  and status = 'requested'::public.appointment_status
  and meeting_url is null
  and exists (
    select 1 from public.coach_assignments ca
    where ca.client_id = (select auth.uid()) and ca.coach_id = appointments.coach_id
  )
);
create policy "appointments_staff_update" on public.appointments
for update to authenticated
using (
  private.has_role('super_admin'::public.app_role)
  or (coach_id = (select auth.uid()) and private.can_manage_client(client_id))
)
with check (
  private.has_role('super_admin'::public.app_role)
  or (coach_id = (select auth.uid()) and private.can_manage_client(client_id))
);

-- Table owners and service_role retain administrative migration/trigger access.
