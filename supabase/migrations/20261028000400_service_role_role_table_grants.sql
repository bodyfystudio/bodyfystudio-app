-- The invitation Edge Function uses Supabase's server-side service_role.
-- New Supabase projects require explicit table grants; RLS bypass alone is not enough.
-- Limit this grant to the role lookup and coach-role update the function performs.
grant select, update on table public.user_roles to service_role;
