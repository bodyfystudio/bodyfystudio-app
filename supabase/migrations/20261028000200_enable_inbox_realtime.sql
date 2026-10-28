-- Enable live in-app inbox updates. Run once after the initial schema migration.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'broadcast_recipients'
  ) then
    alter publication supabase_realtime add table public.broadcast_recipients;
  end if;
end
$$;
