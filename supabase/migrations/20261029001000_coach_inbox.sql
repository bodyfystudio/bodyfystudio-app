alter table public.broadcasts add column audience text not null default 'clients'
  check (audience in ('clients','coaches','all'));

create or replace function private.create_broadcast_recipients()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.audience <> 'clients' and not exists (
    select 1 from public.user_roles where user_id=new.author_id and role='super_admin'
  ) then raise exception using errcode='42501',message='Only the super admin can message coaches'; end if;
  insert into public.broadcast_recipients(broadcast_id,client_id)
    select new.id,user_id from public.user_roles
    where user_id<>new.author_id and (
      (role='client' and new.audience in ('clients','all'))
      or (role='coach' and new.audience in ('coaches','all'))
    );
  return new;
end;
$$;
drop policy "broadcasts_create_coach_or_admin" on public.broadcasts;
create policy "broadcasts_create_coach_or_admin" on public.broadcasts for insert to authenticated
with check(author_id=auth.uid() and (private.has_role('super_admin') or (private.has_role('coach') and audience='clients')));

-- A coach's inbox is private. A sender retains access to their own broadcast.
drop policy "recipient_read_self_or_staff" on public.broadcast_recipients;
create policy "recipient_read_self_or_admin" on public.broadcast_recipients for select to authenticated
using(client_id=auth.uid() or private.has_role('super_admin'));
drop policy "broadcasts_read_authenticated" on public.broadcasts;
create policy "broadcasts_read_recipient_author_admin" on public.broadcasts for select to authenticated
using(author_id=auth.uid() or private.has_role('super_admin') or exists(
  select 1 from public.broadcast_recipients r where r.broadcast_id=broadcasts.id and r.client_id=auth.uid()
));
grant select on public.broadcast_recipients to service_role;

create or replace function public.set_notifications_cleared(target_user uuid, notification_ids uuid[], cleared boolean)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare affected uuid[]; is_admin boolean := private.has_role('super_admin');
begin
  if not is_admin and (target_user is distinct from auth.uid() or not (private.has_role('client') or private.has_role('coach'))) then
    raise exception using errcode='42501',message='You can only clear your own inbox'; end if;
  if cleared is null or notification_ids is null then raise exception 'Choose notifications and an action'; end if;
  with changed as (
    update public.broadcast_recipients set dismissed_at=case when cleared then now() else null end
    where client_id=target_user and broadcast_id=any(notification_ids)
      and ((cleared and dismissed_at is null) or (not cleared and dismissed_at is not null))
    returning broadcast_id
  ) select coalesce(array_agg(broadcast_id),'{}'::uuid[]) into affected from changed;
  if is_admin and cardinality(affected)>0 then
    insert into public.admin_account_activity(actor_id,target_id,action)
      values(auth.uid(),target_user,case when cleared then 'Cleared inbox notifications' else 'Restored inbox notifications' end);
  end if;
  return affected;
end;
$$;
