import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.');
}

// Sessions live in sessionStorage, not localStorage: closing the tab on a
// shared counting-room laptop signs everyone out.
const storage = typeof window !== 'undefined' ? window.sessionStorage : undefined;

/** The primary signed-in user. Everything the app reads and writes goes through this. */
export const supabase: SupabaseClient = createClient(url, key, {
  auth: { storageKey: 'safetrack-primary', storage, persistSession: true, autoRefreshToken: true },
});

/**
 * The second teller's own session. It is used for exactly one thing:
 * calling sign_batch() as that person, so the database records two distinct
 * signed-in people. It never reads or writes donation data.
 */
export const secondTellerClient: SupabaseClient = createClient(url, key, {
  auth: { storageKey: 'safetrack-second-teller', storage, persistSession: true, autoRefreshToken: true },
});
