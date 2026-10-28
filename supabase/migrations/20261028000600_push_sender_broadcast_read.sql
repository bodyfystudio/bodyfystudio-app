-- The push sender verifies and reads a coach's broadcast with service_role.
-- Keep this permission read-only; the function authorizes the caller and
-- constrains the query to broadcasts authored by that caller.
grant select on public.broadcasts to service_role;
