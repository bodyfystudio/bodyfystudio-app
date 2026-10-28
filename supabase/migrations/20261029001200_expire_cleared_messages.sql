-- Recovery ends exactly 48 hours after clearing, even between cleanup runs.
alter table public.broadcast_history_hidden add column purged_at timestamptz;
create index recipient_dismissal_expiry_idx on public.broadcast_recipients(dismissed_at) where dismissed_at is not null;
create index history_clear_expiry_idx on public.broadcast_history_hidden(hidden_at) where hidden_at is not null;
create index history_broadcast_lookup_idx on public.broadcast_history_hidden(broadcast_id);

create function private.purge_expired_message_copies()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz:=clock_timestamp()-interval '48 hours'; inbox_count integer; history_count integer; broadcast_count integer;
begin
  delete from public.broadcast_recipients where dismissed_at<=cutoff;
  get diagnostics inbox_count=row_count;
  -- Retain only the account/id tombstone while another account still needs the shared text.
  update public.broadcast_history_hidden set purged_at=clock_timestamp() where hidden_at<=cutoff and purged_at is null;
  get diagnostics history_count=row_count;
  delete from public.broadcasts b where
    exists(select 1 from public.broadcast_history_hidden h where h.broadcast_id=b.id and h.hidden_at<=cutoff)
    and not exists(select 1 from public.broadcast_recipients r where r.broadcast_id=b.id)
    and not exists(
      select 1 from public.user_roles owner where (owner.role='super_admin' or owner.user_id=b.author_id)
      and not exists(select 1 from public.broadcast_history_hidden h
        where h.user_id=owner.user_id and h.broadcast_id=b.id and h.hidden_at<=cutoff)
    );
  get diagnostics broadcast_count=row_count;
  return jsonb_build_object('inbox_copies',inbox_count,'history_copies',history_count,'unused_broadcasts',broadcast_count);
end;
$$;
revoke all on function private.purge_expired_message_copies() from public,anon,authenticated;

-- Raw API reads obey the deadline as well as the UI and recovery RPCs.
drop policy "recipient_read_self_or_admin" on public.broadcast_recipients;
create policy "recipient_read_self_or_admin" on public.broadcast_recipients for select to authenticated
using((client_id=auth.uid() or private.has_role('super_admin')) and (dismissed_at is null or dismissed_at>clock_timestamp()-interval '48 hours'));
drop policy "broadcasts_read_recipient_author_admin" on public.broadcasts;
create policy "broadcasts_read_recipient_author_admin" on public.broadcasts for select to authenticated
using(
  ((author_id=auth.uid() or private.has_role('super_admin')) and not exists(
    select 1 from public.broadcast_history_hidden h where h.user_id=auth.uid() and h.broadcast_id=broadcasts.id and h.hidden_at<=clock_timestamp()-interval '48 hours'
  ))
  or exists(select 1 from public.broadcast_recipients r where r.broadcast_id=broadcasts.id and r.client_id=auth.uid()
    and (r.dismissed_at is null or r.dismissed_at>clock_timestamp()-interval '48 hours'))
);

create function public.can_send_broadcast_push(target_actor uuid,target_broadcast uuid)
returns boolean language sql security definer set search_path = '' as $$
  select exists(select 1 from public.broadcasts b join public.user_roles u on u.user_id=b.author_id
    where b.id=target_broadcast and b.author_id=target_actor and u.role in ('coach','super_admin')
    and not exists(select 1 from public.broadcast_history_hidden h where h.user_id=target_actor and h.broadcast_id=b.id and h.hidden_at<=clock_timestamp()-interval '48 hours'));
$$;
revoke all on function public.can_send_broadcast_push(uuid,uuid) from public,anon,authenticated;
grant execute on function public.can_send_broadcast_push(uuid,uuid) to service_role;

create or replace function public.set_notifications_cleared(target_user uuid, notification_ids uuid[], cleared boolean)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare affected uuid[]; is_admin boolean := private.has_role('super_admin'); clear_time timestamptz;
begin
  if not is_admin and (target_user is distinct from auth.uid() or not (private.has_role('client') or private.has_role('coach'))) then
    raise exception using errcode='42501',message='You can only clear your own inbox'; end if;
  if cleared is null or notification_ids is null then raise exception 'Choose notifications and an action'; end if;
  perform 1 from public.broadcast_recipients where client_id=target_user and broadcast_id=any(notification_ids) for update;
  clear_time:=clock_timestamp();
  if not cleared and exists(select 1 from public.broadcast_recipients where client_id=target_user and broadcast_id=any(notification_ids) and dismissed_at<=clock_timestamp()-interval '48 hours') then
    raise exception 'The 48-hour recovery period has ended. These notifications are permanently deleted.';
  end if;
  with changed as (
    update public.broadcast_recipients set dismissed_at=case when cleared then clear_time else null end
    where client_id=target_user and broadcast_id=any(notification_ids)
      and ((cleared and dismissed_at is null) or (not cleared and dismissed_at>clock_timestamp()-interval '48 hours'))
    returning broadcast_id
  ) select coalesce(array_agg(broadcast_id),'{}'::uuid[]) into affected from changed;
  if is_admin and cardinality(affected)>0 then
    insert into public.admin_account_activity(actor_id,target_id,action)
      values(auth.uid(),target_user,case when cleared then 'Cleared inbox notifications' else 'Restored inbox notifications' end);
  end if;
  return affected;
end;
$$;

create or replace function public.set_broadcast_history_cleared(broadcast_ids uuid[],cleared boolean)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare is_admin boolean:=private.has_role('super_admin'); affected uuid[]; clear_time timestamptz;
begin
  if not is_admin and not private.has_role('coach') then raise exception using errcode='42501',message='Coach or super admin access required';end if;
  if cleared is null or broadcast_ids is null then raise exception 'Choose broadcasts and an action';end if;
  if exists(select 1 from unnest(broadcast_ids) requested(id) where requested.id is null or not exists(
    select 1 from public.broadcasts b where b.id=requested.id and (is_admin or b.author_id=auth.uid())
  )) then raise exception using errcode='42501',message='Broadcast is not available in your history';end if;
  perform 1 from public.broadcast_history_hidden where user_id=auth.uid() and broadcast_id=any(broadcast_ids) for update;
  clear_time:=clock_timestamp();
  if not cleared and exists(select 1 from public.broadcast_history_hidden where user_id=auth.uid() and broadcast_id=any(broadcast_ids)
    and (purged_at is not null or hidden_at<=clock_timestamp()-interval '48 hours')) then
    raise exception 'The 48-hour recovery period has ended. This broadcast history is permanently deleted.';
  end if;
  if cleared then
    with changed as (
      insert into public.broadcast_history_hidden as h(user_id,broadcast_id,hidden_at)
      select distinct auth.uid(),id,clear_time from unnest(broadcast_ids) id
      on conflict(user_id,broadcast_id) do update set hidden_at=excluded.hidden_at where h.hidden_at is null returning broadcast_id
    ) select coalesce(array_agg(broadcast_id),'{}'::uuid[]) into affected from changed;
  else
    with changed as (
      update public.broadcast_history_hidden set hidden_at=null,purged_at=null where user_id=auth.uid() and broadcast_id=any(broadcast_ids) and hidden_at>clock_timestamp()-interval '48 hours' and purged_at is null returning broadcast_id
    ) select coalesce(array_agg(broadcast_id),'{}'::uuid[]) into affected from changed;
  end if;
  if is_admin and cardinality(affected)>0 then insert into public.admin_account_activity(actor_id,target_id,action)
    values(auth.uid(),auth.uid(),case when cleared then 'Cleared broadcast history' else 'Restored broadcast history' end);end if;
  return affected;
end;
$$;

create or replace function public.admin_account_snapshot(target_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.admin_account_snapshot_v1(target_user);
  return result || jsonb_build_object(
    'broadcasts',(select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at desc),'[]'::jsonb) from public.broadcasts b where b.author_id=target_user
      and not exists(select 1 from public.broadcast_history_hidden h where h.user_id=target_user and h.broadcast_id=b.id and h.hidden_at<=clock_timestamp()-interval '48 hours')),
    'habits',(select coalesce(jsonb_agg(to_jsonb(h) order by h.entry_date desc), '[]'::jsonb) from public.daily_habits h where client_id = target_user),
    'favorites',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'published',r.published)), '[]'::jsonb) from public.recipe_favorites f join public.recipes r on r.id = f.recipe_id where f.user_id = target_user),
    'checklist',(select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_date desc), '[]'::jsonb) from public.plan_checklist c where client_id = target_user),
    'available_recipes',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title) order by r.title), '[]'::jsonb) from public.recipes r where published),
    'inbox',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('read_at',r.read_at,'dismissed_at',r.dismissed_at) order by r.created_at desc), '[]'::jsonb)
      from public.broadcast_recipients r join public.broadcasts b on b.id=r.broadcast_id where r.client_id=target_user and (r.dismissed_at is null or r.dismissed_at>clock_timestamp()-interval '48 hours'))
  );
end;
$$;

create or replace function public.admin_manage_account(target_user uuid, section text, record_id uuid, changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare day date;
begin
  if not private.has_role('super_admin') then raise exception using errcode = '42501', message = 'Super admin access required'; end if;
  if not exists(select 1 from public.user_roles where user_id = target_user and role in ('client','coach')) then raise exception 'Choose a client or coach account'; end if;
  if section='broadcasts' and exists(select 1 from public.broadcast_history_hidden where user_id=target_user and broadcast_id=record_id and hidden_at<=clock_timestamp()-interval '48 hours') then
    raise exception 'The 48-hour recovery period has ended. This broadcast history is permanently deleted.';
  end if;
  if section='inbox' and exists(select 1 from public.broadcast_recipients where client_id=target_user and broadcast_id=record_id and dismissed_at<=clock_timestamp()-interval '48 hours') then
    raise exception 'The 48-hour recovery period has ended. This notification is permanently deleted.';
  end if;
  if section = 'habits' then
    day := (changes->>'entry_date')::date;
    if record_id is not null and not exists(select 1 from public.daily_habits where id = record_id and client_id = target_user and entry_date = day) then raise exception 'Habit entry does not belong to this account and day'; end if;
    perform public.save_daily_habits(target_user,day,changes-'entry_date',0);
  elsif section = 'favorites' then perform public.set_recipe_favorite(target_user,record_id,(changes->>'saved')::boolean);
  elsif section = 'checklist' then perform public.set_plan_checklist(target_user,record_id,changes->>'task_key',(changes->>'entry_date')::date,(changes->>'completed')::boolean);
  else perform public.admin_manage_account_v1(target_user,section,record_id,changes); end if;
end;
$$;

-- Server-side scheduling continues even when no app is open.
create extension if not exists pg_cron;
select cron.schedule('bodyfy-purge-cleared-messages','* * * * *','select private.purge_expired_message_copies();');
