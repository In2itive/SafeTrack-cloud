// SafeTrack: one-line treasurer insight from aggregate numbers only.
// GEMINI_API_KEY is an Edge Function secret; it never reaches the browser.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { GoogleGenAI } from 'npm:@google/genai@1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    // Act as the caller: RLS decides whether they belong to a church.
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}').default ?? Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    });
    const { data: member } = await userClient.from('church_members').select('church_id').eq('is_active', true).limit(1).maybeSingle();
    if (!member) return json({ error: 'Not a member of a church' }, 403);

    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ insight: 'AI Assistant offline. (No API key configured.)' });

    const body = await req.json().catch(() => ({}));
    const total = Number(body.totalValue) || 0;
    const batches = Number(body.totalBatches) || 0;
    const count = Number(body.donationCount) || 0;

    const ai = new GoogleGenAI({ apiKey: key });
    const response = await ai.models.generateContent({
      model: Deno.env.get('GEMINI_MODEL') ?? 'gemini-3-flash-preview',
      contents: `You are a helpful church treasurer assistant. Vault stats: total value $${total.toFixed(2)}, ` +
                `${batches} batches processed, ${count} donations recorded. Give a one-sentence encouraging ` +
                `summary or practical tip for the treasurer. Professional yet warm.`,
    });
    return json({ insight: response.text || 'Keep up the good work managing the funds!' });
  } catch (e) {
    console.error(e);
    return json({ insight: 'Unable to generate insights at this moment.' });
  }
});
