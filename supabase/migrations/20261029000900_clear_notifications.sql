-- Clearing is per recipient. Keep the shared broadcast and administrative history.
alter table public.broadcast_recipients add column dismissed_at timestamptz;
create function public.set_notifications_cleared(target_user uuid, notification_ids uuid[], cleared boolean)
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare affected uuid[]; is_admin boolean := private.has_role('super_admin');
begin
  if not is_admin and (target_user is distinct from auth.uid() or not private.has_role('client')) then
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
revoke all on function public.set_notifications_cleared(uuid,uuid[],boolean) from public,anon;
grant execute on function public.set_notifications_cleared(uuid,uuid[],boolean) to authenticated;

create or replace function public.admin_account_snapshot(target_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.admin_account_snapshot_v1(target_user);
  return result || jsonb_build_object(
    'habits',(select coalesce(jsonb_agg(to_jsonb(h) order by h.entry_date desc), '[]'::jsonb) from public.daily_habits h where client_id = target_user),
    'favorites',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'published',r.published)), '[]'::jsonb) from public.recipe_favorites f join public.recipes r on r.id = f.recipe_id where f.user_id = target_user),
    'checklist',(select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_date desc), '[]'::jsonb) from public.plan_checklist c where client_id = target_user),
    'available_recipes',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'title',r.title) order by r.title), '[]'::jsonb) from public.recipes r where published),
    'inbox',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('read_at',r.read_at,'dismissed_at',r.dismissed_at) order by r.created_at desc), '[]'::jsonb)
      from public.broadcast_recipients r join public.broadcasts b on b.id=r.broadcast_id where r.client_id=target_user)
  );
end;
$$;
