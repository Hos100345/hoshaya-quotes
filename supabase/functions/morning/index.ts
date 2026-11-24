// Morning (חשבונית ירוקה) — פרוקסי בצד שרת למערכת הניהול.
// המפתח לעולם לא בדפדפן ולא בגיט: Supabase secrets MORNING_ID / MORNING_SECRET.
// גישה: רק משתמש מחובר שהמייל שלו ב-ADMIN_EMAILS (כמו site-gallery).
// פעולות מותרות בלבד (allowlist) — לא פרוקסי פתוח ל-API של Morning.
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.greeninvoice.co.il/api/v1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let token: string | null = null, tokenAt = 0;
async function morningToken(): Promise<string> {
  // הטוקן של Morning תקף כשעה; שומרים 50 דקות בזיכרון של המופע
  if (token && Date.now() - tokenAt < 50 * 60 * 1000) return token;
  // trim: הדבקה בדשבורד מוסיפה לפעמים רווח/שורה ריקה בסוף — Morning מחזיר אז 404
  const id = Deno.env.get("MORNING_ID")?.trim(), secret = Deno.env.get("MORNING_SECRET")?.trim();
  if (!id || !secret) throw Object.assign(new Error("המפתח של Morning עוד לא הוגדר בשרת"), { status: 503 });
  const r = await fetch(`${API}/account/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, secret }), signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => null);
  if (!d?.token) {
    console.log("MORNING_TOKEN_FAIL", r.status, d?.errorCode ?? "", d?.errorMessage ?? "");
    throw Object.assign(new Error((d?.errorMessage ? d.errorMessage + " · " : "") + `התחברות ל-Morning נכשלה (${r.status}${d?.errorCode ? ", קוד " + d.errorCode : ""})`), { status: 502 });
  }
  token = d.token; tokenAt = Date.now();
  return token!;
}

async function call(path: string, body: unknown) {
  const t = await morningToken();
  const r = await fetch(`${API}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) { token = null; } // טוקן שפג — בפעם הבאה ייווצר חדש
  const d = await r.json().catch(() => ({}));
  return json(d, r.ok ? 200 : r.status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    // מי מחובר? אותו דפוס כמו site-gallery / manage-subscriber: service_role + getUser(jwt)
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.getUser(jwt).catch(() => ({ data: { user: null } }));
    const admins = (Deno.env.get("ADMIN_EMAILS") || "hoshaya@gmail.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (!user?.email || !admins.includes(user.email.toLowerCase())) {
      console.log("MORNING_FORBIDDEN", user ? "not_admin" : "no_user");
      return json({ error: user ? "אין הרשאה למייל הזה" : "ההתחברות פגה — התחברו מחדש בלשונית המלאי" }, 403);
    }

    const { action, ...p } = await req.json().catch(() => ({}));
    if (action === "status") {
      return json({ configured: !!(Deno.env.get("MORNING_ID") && Deno.env.get("MORNING_SECRET")) });
    }
    if (action === "clients.search") {
      const name = String(p.name ?? "").trim().slice(0, 80);
      if (name.length < 2) return json({ items: [] });
      // ⚠️ הפרמטר הוא `name`, לא `search` (search מתעלם מהטקסט בלי שגיאה)
      return await call("/clients/search", { page: 1, pageSize: 15, name });
    }
    if (action === "documents.create") {
      const doc = p.doc ?? {};
      // רק דרישת תשלום (300) בשקלים — העסק עוסק פטור; כל סוג אחר נדחה
      if (doc.type !== 300 || doc.currency !== "ILS" || !Array.isArray(doc.income) || !doc.income.length) {
        return json({ error: "מסמך לא תקין: מותרת רק דרישת תשלום (300) בשקלים עם שורות" }, 400);
      }
      return await call("/documents", doc);
    }
    return json({ error: "פעולה לא מוכרת" }, 400);
  } catch (e) {
    const err = e as Error & { status?: number };
    return json({ error: err.message || String(e) }, err.status ?? 500);
  }
});
