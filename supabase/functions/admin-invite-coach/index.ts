import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

Deno.serve(async (request) => {
  const appUrl = Deno.env.get('APP_URL');
  const origin = request.headers.get('origin');
  const allowedOrigin = appUrl && origin === new URL(appUrl).origin ? origin : appUrl;
  const headers = { ...corsHeaders, 'Access-Control-Allow-Origin': allowedOrigin ?? 'null' };

  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const legacyServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  let defaultSecretKey: string | undefined;
  try {
    const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    defaultSecretKey = typeof secretKeys.default === 'string' ? secretKeys.default : undefined;
  } catch {
    // Continue with the legacy environment variable when the new key map is absent.
  }
  const serviceRoleKey = defaultSecretKey || legacyServiceRoleKey;
  const authorization = request.headers.get('authorization');
  if (!supabaseUrl || !serviceRoleKey || !appUrl || !authorization?.startsWith('Bearer ')) {
    return Response.json({ error: 'Function is not configured or the caller is not signed in.' }, { status: 401, headers });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const token = authorization.slice('Bearer '.length);
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return Response.json({ error: 'Valid sign-in required.' }, { status: 401, headers });

  const { data: roleRow, error: roleError } = await admin
    .from('user_roles')
    .select('role')
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (roleError) {
    console.error('Could not read caller role from user_roles:', roleError.code, roleError.message);
    return Response.json({ error: 'Could not verify the caller role. Check the function logs.' }, { status: 500, headers });
  }
  if (roleRow?.role !== 'super_admin') {
    console.warn('Rejected coach invite from user without super_admin role:', authData.user.id, roleRow?.role ?? 'missing role');
    return Response.json({ error: 'Super admin access required.' }, { status: 403, headers });
  }

  let body: { name?: unknown; email?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON request.' }, { status: 400, headers });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (name.length < 1 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return Response.json({ error: 'Enter a valid coach name and email.' }, { status: 400, headers });
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { display_name: name },
    redirectTo: appUrl,
  });
  if (inviteError || !invited.user) {
    return Response.json({ error: inviteError?.message ?? 'Coach invitation could not be sent.' }, { status: 400, headers });
  }

  const { error: roleUpdateError } = await admin
    .from('user_roles')
    .update({ role: 'coach', assigned_by: authData.user.id })
    .eq('user_id', invited.user.id);
  if (roleUpdateError) {
    return Response.json({ error: 'The invite was created, but coach access could not be assigned. Contact the project administrator.' }, { status: 500, headers });
  }

  return Response.json({ userId: invited.user.id, email, role: 'coach' }, { status: 200, headers });
});
