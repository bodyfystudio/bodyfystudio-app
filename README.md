# BodyfyStudio PWA

A responsive, installable web app for BodyfyStudio clients and coaches. Vite bundles the app and Supabase JavaScript client. Supabase Auth, shared recipes, broadcasts, and account role management use the project configured in `.env.local`.

## Run locally

1. Install Node.js (LTS).
2. Copy `.env.example` to `.env.local` and set your Supabase Project URL and **publishable** key. Never put a secret/service-role key in a `VITE_` variable.
3. In Supabase Auth URL Configuration, add `http://localhost:5173` to the Redirect URLs.
4. Install dependencies and start the dev server:

   ```powershell
   npm install
   npm run dev
   ```

5. Open the localhost URL Vite prints.

For a production bundle, run `npm run build`; Vite writes it to `dist/`.

## Supabase setup

See [supabase/README.md](supabase/README.md) for migration order, first super admin bootstrap, and Edge Function deployment. New public sign-ups receive only the client role. Super admin access is never assignable from public signup.

## Current integration scope

- Email/password sign-up and login use Supabase Auth.
- Coach-published recipes are shared through the `recipes` table.
- Coach broadcasts are saved to Supabase and create per-client inbox entries through the SQL trigger.
- Clients can receive live inbox updates while the app is open when the Realtime migration is enabled.
- Clients can opt into device push alerts for coach broadcasts; each device must grant permission.
- Super admins can manage client/coach roles through a protected SQL RPC and invite coaches through a protected Edge Function.
- Super admins can open any client or coach from **Accounts → Open account**. The workspace reads shared profile, assignment, plan, progress, appointment, recipe, broadcast, inbox, and device-registration information. It supports editing records, creating plans/progress/appointments, assigning or unassigning coaches, and marking inbox messages read/unread.

Apply `supabase/migrations/20261029000700_admin_account_workspace.sql` for account management. Its RPCs check the caller's current database role, restrict edits to the selected account's records, and record the real admin as the actor in `admin_account_activity`. It never replaces the admin session with a client's login. Device endpoint credentials and Auth secrets are excluded. Editing broadcast history updates the shared inbox message without sending a second push.

Apply `supabase/migrations/20261029000800_shared_client_data.sql` for shared client habits, recipe favorites, and daily plan checklists. Home and My plan read the account's assigned coach and published plans from Supabase. Water/steps/weight are stored by client and local calendar day; favorites persist across days; checklist completion belongs to a plan task and day. The admin workspace exposes the same data under **Daily habits**, **Checklist**, and **Saved recipes**. New and unassigned accounts show empty states rather than sample wellness measurements.

The old anonymous `bodyfy-studio-demo-v1` browser store is no longer read or written. Its sample values are not imported because the store does not identify a reliable account owner. Existing shared plan, progress, recipe, and appointment records are preserved. Saving requires a connection; failed writes do not appear successful. Realtime and app-resume refreshes load changes made from another device or the admin workspace.

Migration `20261029000900_clear_notifications.sql` adds per-recipient inbox clearing. Clients can clear one notification, clear all currently loaded notifications, and undo the latest clear. Inbox loading paginates past the default database row limit. Dismissal is shared across their devices; broadcast history and other recipients are retained. The super admin can clear or restore individual messages in an account's Inbox, with admin actions audited. `scripts/test-clear-notifications.sql` and `node scripts/test-inbox-clearing.mjs` cover recipient isolation, restoration, new arrivals, and UI behavior.

Regression checks: `scripts/test-admin-account-permissions.sql` and `scripts/test-shared-client-data.sql` use temporary fixtures inside rollback-only transactions. `node scripts/test-admin-workspace.mjs` and `node scripts/test-client-sync.mjs` exercise the UI with fixture RPCs, including two independent browser sessions. They require Playwright; optionally set `PLAYWRIGHT_CHANNEL=msedge` to use installed Edge.

The admin workspace manages shared assignments and plan records. In the plan editor, each Plan details name/value pair becomes a checklist item in the client app. Set a plan to Active and choose applicable dates to make it current. Existing structured `tasks` lists are also supported. Daily habit edits are audited under the actual administrator's identity.

## Device push notifications

For iPhone, the client must add the PWA to the Home Screen on iOS/iPadOS 16.4 or later, sign in, and tap **Profile → Enable notifications**. Other supported browsers also require the client to opt in on each device. Push subscriptions are stored per user under row-level security; the VAPID private key is stored only as a Supabase Edge Function secret.

The VAPID key pair has already been generated for this workspace and saved in the ignored `.env.push.local` file. Do not regenerate it after clients subscribe. Add `VITE_VAPID_PUBLIC_KEY` from that file to the Vercel project’s Production environment variables, then redeploy. From PowerShell in the project folder, set the private server secret and deploy the sender:

```powershell
npx supabase secrets set --env-file .env.push.local
npx supabase functions deploy send-broadcast-push
```

Apply `supabase/migrations/20261028000500_push_subscriptions.sql` and `supabase/migrations/20261028000600_push_sender_broadcast_read.sql` in the Supabase SQL Editor before testing push alerts. The coach broadcast still appears in every client’s in-app inbox; device alerts are sent only to opted-in devices.
