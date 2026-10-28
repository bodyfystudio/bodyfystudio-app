# Supabase schema and access policies

Apply each migration in `migrations/` in filename order using the Supabase SQL Editor:

1. `20261028000100_initial_schema.sql` — tables, roles, and row-level security (already applied in this project).
2. `20261028000200_enable_inbox_realtime.sql` — live inbox updates (already applied in this project).
3. `20261028000300_admin_role_management.sql` — protected super-admin RPC for changing client/coach roles.
4. `20261028000400_service_role_role_table_grants.sql` — the minimal `user_roles` table permissions needed by the invitation function. This fixes the `42501 permission denied for table user_roles` error.

The PWA only uses the project URL and publishable key. Never put a secret/service-role key or database password in browser code or a `VITE_` variable.

## First super admin

The first super admin is bootstrapped once after registering that email. This is intentionally not available to public sign-ups:

```sql
update public.user_roles ur
set role = 'super_admin'::public.app_role,
    assigned_by = ur.user_id
from auth.users au
where au.id = ur.user_id
  and lower(au.email) = lower('your-admin-email@example.com');
```

The app’s Accounts & access page can then promote existing accounts between client and coach. It cannot grant or revoke super admin access.

## Deploy coach invitations

`functions/admin-invite-coach/index.ts` is a protected Edge Function. It verifies the caller's Supabase access token, checks the caller's super-admin role, sends an Auth invitation, and assigns the invited account the coach role. `functions/admin-list-users/index.ts` separately returns Auth emails to verified super admins for the Accounts page. The service-role key is read only from the Edge Function environment.

Using the Supabase CLI from the project folder:

```powershell
npx supabase login
npx supabase link --project-ref lxhshlircwjupgmaotxi
npx supabase secrets set APP_URL=http://localhost:5173
npx supabase functions deploy admin-invite-coach
npx supabase functions deploy admin-list-users
```

Keep JWT verification enabled. In **Authentication → URL Configuration**, allow `http://localhost:5173` as a redirect URL. When deployed, change `APP_URL` to the app’s HTTPS origin and add that origin to Supabase’s redirect URL allow list. Supabase provides the service-role secret to its Edge Function runtime; if your project’s function environment does not show `SUPABASE_SERVICE_ROLE_KEY`, add it as a function secret in the dashboard. Never expose that key to the browser or put it in `.env.local`.

After all migrations and both Edge Functions are deployed, sign in as super admin, open **Accounts & access**, and invite coaches there. New public sign-ups remain clients by default. Email addresses are returned only by the super-admin-only function; they are not added to the broadly readable profile table.
