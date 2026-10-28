-- Only a super admin may change another user's client/coach role.
-- This function intentionally cannot assign or modify super_admin roles.
create or replace function public.admin_set_user_role(target_user uuid, new_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_role('super_admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'Super admin access required';
  end if;
  if target_user = (select auth.uid()) then
    raise exception using errcode = '42501', message = 'You cannot change your own role';
  end if;
  if new_role not in ('client'::public.app_role, 'coach'::public.app_role) then
    raise exception using errcode = '22023', message = 'Only client and coach roles can be assigned here';
  end if;

  update public.user_roles
  set role = new_role,
      assigned_by = (select auth.uid())
  where user_id = target_user;

  if not found then
    raise exception using errcode = 'P0002', message = 'Account role not found';
  end if;
end;
$$;

revoke all on function public.admin_set_user_role(uuid, public.app_role) from public, anon;
grant execute on function public.admin_set_user_role(uuid, public.app_role) to authenticated;
