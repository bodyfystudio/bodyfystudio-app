-- Account-owned history preferences never delete broadcasts or recipient inboxes.
create table public.broadcast_history_hidden (
  user_id uuid not null references auth.users(id) on delete cascade,
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  hidden_at timestamptz default now(),
  primary key(user_id,broadcast_id)
);
alter table public.broadcast_history_hidden enable row level security;
revoke all on public.broadcast_history_hidden from anon,authenticated;
grant select on public.broadcast_history_hidden to authenticated;
create policy "history_preferences_read_self" on public.broadcast_history_hidden for select to authenticated
using(user_id=auth.uid() and (private.has_role('coach') or private.has_role('super_admin')));

create function public.get_broadcast_history()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare is_admin boolean:=private.has_role('super_admin'); result jsonb;
begin
  if not is_admin and not private.has_role('coach') then raise exception using errcode='42501',message='Coach or super admin access required';end if;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at desc,b.id),'[]'::jsonb) into result
    from public.broadcasts b where (is_admin or b.author_id=auth.uid())
    and not exists(select 1 from public.broadcast_history_hidden h where h.user_id=auth.uid() and h.broadcast_id=b.id and h.hidden_at is not null);
  return result;
end;
$$;

create function public.set_broadcast_history_cleared(broadcast_ids uuid[],cleared boolean)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare is_admin boolean:=private.has_role('super_admin'); affected uuid[];
begin
  if not is_admin and not private.has_role('coach') then raise exception using errcode='42501',message='Coach or super admin access required';end if;
  if cleared is null or broadcast_ids is null then raise exception 'Choose broadcasts and an action';end if;
  if exists(select 1 from unnest(broadcast_ids) requested(id) where requested.id is null or not exists(
    select 1 from public.broadcasts b where b.id=requested.id and (is_admin or b.author_id=auth.uid())
  )) then raise exception using errcode='42501',message='Broadcast is not available in your history';end if;
  if cleared then
    with changed as (
      insert into public.broadcast_history_hidden as h(user_id,broadcast_id)
      select distinct auth.uid(),id from unnest(broadcast_ids) id
      on conflict(user_id,broadcast_id) do update set hidden_at=excluded.hidden_at where h.hidden_at is null returning broadcast_id
    ) select coalesce(array_agg(broadcast_id),'{}'::uuid[]) into affected from changed;
  else
    with changed as (
      update public.broadcast_history_hidden set hidden_at=null where user_id=auth.uid() and broadcast_id=any(broadcast_ids) and hidden_at is not null returning broadcast_id
    ) select coalesce(array_agg(broadcast_id),'{}'::uuid[]) into affected from changed;
  end if;
  if is_admin and cardinality(affected)>0 then insert into public.admin_account_activity(actor_id,target_id,action)
    values(auth.uid(),auth.uid(),case when cleared then 'Cleared broadcast history' else 'Restored broadcast history' end);end if;
  return affected;
end;
$$;
revoke all on function public.get_broadcast_history(),public.set_broadcast_history_cleared(uuid[],boolean) from public,anon;
grant execute on function public.get_broadcast_history(),public.set_broadcast_history_cleared(uuid[],boolean) to authenticated;
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.broadcast_history_hidden;
  end if;
end;
$$;
