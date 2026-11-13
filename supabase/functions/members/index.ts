// SafeTrack: church member management (needs the Auth admin API, so it runs
// server-side with the project's secret key, which Supabase provides to Edge
// Functions automatically). Every action re-checks the caller's membership.
//
// POST body: { action: 'list' | 'create' | 'update' | 'remove', church_id, ... }
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const secretKey = (() => {
  try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default; } catch { return undefined; }
})() ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });

const ROLES = new Set(['administrator', 'treasurer', 'envelope', 'teller']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adminRule = (m: string) => /administrator/i.test(m) ? 'A church must keep at least one active administrator.' : m;

async function membership(userId: string, churchId: string) {
  const { data } = await admin.from('church_members').select('role, display_name')
    .eq('church_id', churchId).eq('user_id', userId).eq('is_active', true).maybeSingle();
  return data as { role: string; display_name: string } | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(token);
    if (!auth?.user) return json({ error: 'Session expired. Please sign in again.' }, 401);
    const caller = auth.user;

    const body = await req.json().catch(() => ({}));
    const churchId = String(body.church_id ?? '');
    if (!UUID.test(churchId)) return json({ error: 'Invalid church id' }, 400);
    const me = await membership(caller.id, churchId);
    if (!me) return json({ error: 'Not a member of this church' }, 403);

    if (body.action === 'list') {
      const { data, error } = await admin.from('church_members')
        .select('user_id, role, display_name, is_active').eq('church_id', churchId).order('display_name');
      if (error) throw error;
      const members = await Promise.all((data ?? []).map(async (m) => {
        const { data: u } = await admin.auth.admin.getUserById(m.user_id);
        return { ...m, email: u.user?.email ?? '' };
      }));
      return json({ members });
    }

    if (me.role !== 'administrator') return json({ error: 'Administrator access required' }, 403);

    if (body.action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const display_name = String(body.display_name ?? '').trim();
      const role = String(body.role ?? '');
      const password = String(body.password ?? '');
      if (!EMAIL.test(email)) return json({ error: 'Enter a valid email address' }, 400);
      if (!display_name) return json({ error: 'Name is required' }, 400);
      if (!ROLES.has(role)) return json({ error: 'Invalid role' }, 400);
      if (password.length < 8) return json({ error: 'Temporary password must be at least 8 characters' }, 400);

      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { display_name },
      });
      if (error || !created?.user) {
        return json({ error: /already/i.test(error?.message ?? '') ? 'That email already has a SafeTrack login.' : (error?.message ?? 'Could not create login') }, 409);
      }
      const { error: mErr } = await admin.from('church_members').insert({ church_id: churchId, user_id: created.user.id, role, display_name });
      if (mErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw mErr;
      }
      return json({ user_id: created.user.id }, 201);
    }

    const userId = String(body.user_id ?? '');
    if (!UUID.test(userId)) return json({ error: 'Invalid user id' }, 400);
    if (!(await admin.from('church_members').select('user_id').eq('church_id', churchId).eq('user_id', userId).maybeSingle()).data) {
      return json({ error: 'Not a member of this church' }, 404);
    }

    if (body.action === 'update') {
      const patch: Record<string, string> = {};
      if (body.display_name) patch.display_name = String(body.display_name).trim();
      if (body.role) {
        if (!ROLES.has(body.role)) return json({ error: 'Invalid role' }, 400);
        patch.role = body.role;
      }
      if (Object.keys(patch).length) {
        const { error } = await admin.from('church_members').update(patch).eq('church_id', churchId).eq('user_id', userId);
        if (error) return json({ error: adminRule(error.message) }, 400);
      }
      if (body.password) {
        if (String(body.password).length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
        const { error } = await admin.auth.admin.updateUserById(userId, { password: String(body.password) });
        if (error) throw error;
      }
      return json({ success: true });
    }

    if (body.action === 'remove') {
      if (userId === caller.id) return json({ error: 'You cannot remove yourself.' }, 400);
      // Membership only: past sign-offs stay on record under their name.
      const { error } = await admin.from('church_members').delete().eq('church_id', churchId).eq('user_id', userId);
      if (error) return json({ error: adminRule(error.message) }, 400);
      return json({ success: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message ?? 'Server error' }, 500);
  }
});
