import { createClient } from 'npm:@supabase/supabase-js@2';
import { ApplicationServer, importVapidKeys } from 'jsr:@negrel/webpush@0.5.0';

const appUrl = Deno.env.get('APP_URL') ?? 'https://bodyfystudio-app.vercel.app';
const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': appUrl,
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });

  const authorization = request.headers.get('authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || (() => {
    try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default; } catch { return undefined; }
  })();
  const vapidKeysB64 = Deno.env.get('VAPID_KEYS_JSON_B64');
  if (!authorization?.startsWith('Bearer ') || !supabaseUrl || !serviceKey || !vapidKeysB64) {
    return Response.json({ error: 'Push service is not configured or the caller is not signed in.' }, { status: 503, headers: corsHeaders });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(authorization.slice('Bearer '.length));
  if (authError || !authData.user) return Response.json({ error: 'Valid sign-in required.' }, { status: 401, headers: corsHeaders });

  let body: { broadcastId?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400, headers: corsHeaders }); }
  const broadcastId = typeof body.broadcastId === 'string' ? body.broadcastId : '';
  if (!broadcastId) return Response.json({ error: 'Broadcast ID is required.' }, { status: 400, headers: corsHeaders });

  const { data: roleRow, error: roleError } = await admin.from('user_roles').select('role').eq('user_id', authData.user.id).maybeSingle();
  if (roleError) return Response.json({ error: 'Could not verify account role.' }, { status: 500, headers: corsHeaders });
  if (!['coach', 'super_admin'].includes(roleRow?.role)) return Response.json({ error: 'Coach access required.' }, { status: 403, headers: corsHeaders });

  const { data: broadcast, error: broadcastError } = await admin.from('broadcasts')
    .select('id,author_id,title,message,action_url').eq('id', broadcastId).eq('author_id', authData.user.id).maybeSingle();
  if (broadcastError) return Response.json({ error: 'Could not load this broadcast.' }, { status: 500, headers: corsHeaders });
  if (!broadcast) return Response.json({ error: 'Broadcast not found or not owned by caller.' }, { status: 404, headers: corsHeaders });

  const { data: clientRoles, error: clientsError } = await admin.from('user_roles').select('user_id').eq('role', 'client');
  if (clientsError) return Response.json({ error: 'Could not load client accounts.' }, { status: 500, headers: corsHeaders });
  const clientIds = (clientRoles ?? []).map((row) => row.user_id);
  if (!clientIds.length) return Response.json({ sent: 0, failed: 0, message: 'No client accounts are registered.' }, { headers: corsHeaders });

  const { data: subscriptions, error: subscriptionsError } = await admin.from('push_subscriptions')
    .select('user_id,endpoint,p256dh,auth_key').in('user_id', clientIds);
  if (subscriptionsError) return Response.json({ error: 'Could not load notification subscriptions.' }, { status: 500, headers: corsHeaders });
  if (!subscriptions?.length) return Response.json({ sent: 0, failed: 0, message: 'No clients have enabled push notifications yet.' }, { headers: corsHeaders });

  let vapidKeys;
  try {
    const exportedKeys = JSON.parse(atob(vapidKeysB64));
    vapidKeys = await importVapidKeys(exportedKeys);
  } catch (error) {
    console.error('Could not import VAPID keys:', error);
    return Response.json({ error: 'Push keys are invalid.' }, { status: 500, headers: corsHeaders });
  }
  const pushServer = await ApplicationServer.new({ contactInformation: 'mailto:bodyfystudio@gmail.com', vapidKeys });
  const payload = JSON.stringify({
    title: broadcast.title,
    body: broadcast.message,
    url: broadcast.action_url || appUrl,
    tag: `bodyfy-${broadcast.id}`,
  });

  let sent = 0;
  let failed = 0;
  await Promise.all(subscriptions.map(async (row) => {
    try {
      const subscriber = pushServer.subscribe({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth_key } });
      await subscriber.pushTextMessage(payload, { ttl: 3600 });
      sent += 1;
    } catch (error) {
      failed += 1;
      const status = Number((error as { response?: Response })?.response?.status ?? 0);
      if (status === 404 || status === 410) {
        await admin.from('push_subscriptions').delete().eq('user_id', row.user_id).eq('endpoint', row.endpoint);
      } else {
        console.error('Push delivery failed with status:', status || 'unknown');
      }
    }
  }));

  return Response.json({ sent, failed }, { headers: corsHeaders });
});
