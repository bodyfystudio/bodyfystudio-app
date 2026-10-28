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
  let secretKey: string | undefined;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    secretKey = typeof keys.default === 'string' ? keys.default : undefined;
  } catch {
    // Fall back to the legacy service-role key if the new key map is not configured.
  }
  secretKey ||= Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = request.headers.get('authorization');
  if (!supabaseUrl || !secretKey || !appUrl || !authorization?.startsWith('Bearer ')) {
    return Response.json({ error: 'Function is not configured or the caller is not signed in.' }, { status: 401, headers });
  }

  const admin = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const token = authorization.slice('Bearer '.length);
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return Response.json({ error: 'Valid sign-in required.' }, { status: 401, headers });

  const { data: callerRole, error: roleError } = await admin
    .from('user_roles').select('role').eq('user_id', authData.user.id).maybeSingle();
  if (roleError) {
    console.error('Could not verify account-list caller role:', roleError.code, roleError.message);
    return Response.json({ error: 'Could not verify your admin access.' }, { status: 500, headers });
  }
  if (callerRole?.role !== 'super_admin') {
    return Response.json({ error: 'Super admin access required.' }, { status: 403, headers });
  }

  const perPage = 1000;
  const authUsers = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error('Could not list Auth users:', error.message);
      return Response.json({ error: 'Could not load account directory.' }, { status: 500, headers });
    }
    authUsers.push(...data.users);
    if (data.users.length < perPage) break;
  }

  const userRoles = [];
  for (let start = 0; start < authUsers.length; start += perPage) {
    const { data, error } = await admin.from('user_roles').select('user_id,role').range(start, start + perPage - 1);
    if (error) {
      console.error('Could not load account roles:', error.code, error.message);
      return Response.json({ error: 'Could not load account roles.' }, { status: 500, headers });
    }
    userRoles.push(...data);
  }

  const rolesById = new Map(userRoles.map((row) => [row.user_id, row.role]));
  const users = authUsers.map((user) => ({
    id: user.id,
    email: user.email ?? '',
    name: typeof user.user_metadata?.display_name === 'string' && user.user_metadata.display_name.trim()
      ? user.user_metadata.display_name.trim()
      : (user.email?.split('@')[0] || 'BodyfyStudio user'),
    role: rolesById.get(user.id) ?? 'client',
    createdAt: user.created_at,
  }));

  return Response.json({ users }, { status: 200, headers });
});
