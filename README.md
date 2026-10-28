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

Client/coach assignments, client plans, and saving recipes across devices are not implemented yet. Avoid entering real health records until those workflows and the hosted security configuration are reviewed.

## Device push notifications

For iPhone, the client must add the PWA to the Home Screen on iOS/iPadOS 16.4 or later, sign in, and tap **Profile → Enable notifications**. Other supported browsers also require the client to opt in on each device. Push subscriptions are stored per user under row-level security; the VAPID private key is stored only as a Supabase Edge Function secret.

The VAPID key pair has already been generated for this workspace and saved in the ignored `.env.push.local` file. Do not regenerate it after clients subscribe. Add `VITE_VAPID_PUBLIC_KEY` from that file to the Vercel project’s Production environment variables, then redeploy. From PowerShell in the project folder, set the private server secret and deploy the sender:

```powershell
npx supabase secrets set --env-file .env.push.local
npx supabase functions deploy send-broadcast-push
```

Apply `supabase/migrations/20261028000500_push_subscriptions.sql` and `supabase/migrations/20261028000600_push_sender_broadcast_read.sql` in the Supabase SQL Editor before testing push alerts. The coach broadcast still appears in every client’s in-app inbox; device alerts are sent only to opted-in devices.
