// ============================================================
// morning-proxy — כל הקריאות ל-Morning (greeninvoice) מצד שרת.
//
// למה: המפתח (id+secret) ישב בקוד של index.html בריפו ציבורי — כל מי שפתח את הדף יכול היה להפיק מסמכים
// בחשבון. עכשיו המפתח חי רק ב-Supabase Secrets, והאפליקציה קוראת לכאן עם ה-JWT של המנהל.
//
// Secrets (דשבורד Supabase → Edge Functions → Secrets):
//   MORNING_API_ID      — מזהה המפתח (id)
//   MORNING_API_SECRET  — הסוד (secret)
//   ADMIN_EMAILS        — קיים כבר (אותו אחד של ai-gateway)
//
// מנהל בלבד: JWT + אימייל מול ADMIN_EMAILS (כמו ai-gateway). verify_jwt=true.
// פעולות: health · clients_search · document_create (דרישת תשלום type 300 בלבד) · client_set_active
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { MorningError, buildDocument, cleanClientId, cleanSearchName, makeMorning } from './lib.ts';

const VERSION = '2026-10-18a';
const ADMIN_EMAILS = (Deno.env.get('ADMIN_EMAILS') || 'hoshaya@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const morning = makeMorning(Deno.env.get('MORNING_API_ID') || '', Deno.env.get('MORNING_API_SECRET') || '');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const upstreamError = (d: any, status: number) =>
  d && (d.errorMessage || d.message) ? String(d.errorMessage || d.message) : `שגיאת Morning (${status})`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !user) return json({ ok: false, error: 'נדרשת התחברות' }, 401);
    if (!ADMIN_EMAILS.includes((user.email || '').toLowerCase())) return json({ ok: false, error: 'החשבון אינו מורשה' }, 403);

    const body = await req.json().catch(() => ({}));

    if (body.action === 'health') {
      // מחזיר רק האם המפתחות קיימים (ואם probe — האם Morning מקבל אותם). אף ערך לא יוצא.
      const out: Record<string, unknown> = { ok: true, version: VERSION, hasKeys: morning.hasKeys() };
      if (body.probe === true && morning.hasKeys()) {
        try { await morning.token(true); out.tokenOk = true; }
        catch (e) { out.tokenOk = false; out.tokenError = (e as Error).message; }
      }
      return json(out);
    }

    if (body.action === 'clients_search') {
      const name = cleanSearchName(body.name);
      if (!name) return json({ ok: false, error: 'חיפוש קצר מדי' }, 400);
      // ⚠️ הפרמטר הוא `name`, לא `search` — עם `search` ה-API מתעלם מהטקסט בלי שגיאה
      const r = await morning.call('/clients/search', 'POST', { page: 1, pageSize: 15, name });
      if (r.status < 200 || r.status >= 300) return json({ ok: false, error: upstreamError(r.data, r.status) }, 502);
      return json({ ok: true, data: r.data });
    }

    if (body.action === 'document_create') {
      const built = buildDocument(body.payload);
      if (!built.ok) return json({ ok: false, error: built.error }, 422);
      const r = await morning.call('/documents', 'POST', built.doc);
      if (r.status < 200 || r.status >= 300 || !r.data || !r.data.id) {
        return json({ ok: false, error: upstreamError(r.data, r.status) }, 502);
      }
      return json({ ok: true, doc: r.data });
    }

    if (body.action === 'client_set_active') {
      const id = cleanClientId(body.id);
      if (!id || typeof body.active !== 'boolean') return json({ ok: false, error: 'בקשה לא תקינה' }, 400);
      // ⚠️ צורת הבקשה לא אומתה מול החשבון — אם Morning דורש עוד שדות, השגיאה שלו חוזרת כמו שהיא
      const r = await morning.call(`/clients/${id}`, 'PUT', { active: body.active });
      if (r.status < 200 || r.status >= 300) return json({ ok: false, error: upstreamError(r.data, r.status) }, 502);
      return json({ ok: true, data: r.data });
    }

    return json({ ok: false, error: 'פעולה לא מוכרת' }, 400);
  } catch (e) {
    if (e instanceof MorningError) return json({ ok: false, error: e.message }, e.status);
    console.error('morning-proxy:', (e as Error)?.message || e);
    return json({ ok: false, error: 'שגיאה בשרת' }, 500);
  }
});
