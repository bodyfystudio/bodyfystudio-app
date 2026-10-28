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
- Super admins can manage client/coach roles through a protected SQL RPC and invite coaches through a protected Edge Function.

Device push alerts while the app is closed, client/coach assignments, client plans, and saving recipes across devices are not implemented yet. Avoid entering real health records until those workflows and the hosted security configuration are reviewed.
