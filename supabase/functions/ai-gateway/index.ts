// ============================================================
// ai-gateway — שער ה-AI של אפליקציית הושעיה
//
// למה זה קיים: ה-Worker ב-Cloudflare דורש deploy ידני, ושם נשאר קוד ישן
// שקרא למודל שגוגל הוציאה משימוש. Supabase נפרס מכאן והמפתחות כבר שם.
//
// מנהל בלבד: JWT של Supabase + בדיקת אימייל מול ADMIN_EMAILS.
// verify_jwt=false כדי ש-health יהיה ניתן לאבחון ב-curl; כל פעולה אמיתית
// מאמתת בעצמה את המשתמש בגוף הפונקציה.
//
// ⚙ אין כאן zodOutputFormat: ה-subpath @anthropic-ai/sdk/helpers/zod לא נפתר
// ב-runtime של Supabase (worker boot error, path not found). במקומו המודל
// מתבקש JSON והתוצאה עוברת coerce בקוד — שגם מנרמל תאריך וכמויות.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0';

const VERSION = '2026-09-23c';
const MODEL = 'claude-opus-5';

const ADMIN_EMAILS = (Deno.env.get('ADMIN_EMAILS') || 'hoshaya@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

// המפתח של Gemini עשוי לשבת תחת שם אחר ב-Secrets (GOOGLE_API_KEY וכו').
// לכן: קודם השמות המוכרים, ואם אין — סריקה לפי תבנית שם. מוחזר הערך בלבד.
function findEnv(re: RegExp): { name: string; value: string } {
  let env: Record<string, string> = {};
  try { env = Deno.env.toObject(); } catch (_e) { return { name: '', value: '' }; }
  for (const [k, v] of Object.entries(env)) {
    if (!v || /^SUPABASE_/.test(k) || /^SB_/.test(k)) continue;
    if (re.test(k)) return { name: k, value: v };
  }
  return { name: '', value: '' };
}
const GEMINI_HIT = Deno.env.get('GEMINI_KEY')
  ? { name: 'GEMINI_KEY', value: Deno.env.get('GEMINI_KEY')! }
  : Deno.env.get('GEMINI_API_KEY')
    ? { name: 'GEMINI_API_KEY', value: Deno.env.get('GEMINI_API_KEY')! }
    : findEnv(/GEMINI|GOOGLE_AI|GOOGLE_API|GENAI|GENERATIVE/i);
const GEMINI_KEY = GEMINI_HIT.value;

const INV_CATS = ['לטקס', 'מיילר', 'טוויסטינג', 'הליום', 'אביזרים', 'אחר'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const QUOTE_SYSTEM = [
  'אתה עוזר של הושעיה, אמן בלונים מיישוב בית חוגלה.',
  'אתה מקבל שיחה או תמלול ומחלץ פרטים להצעת מחיר.',
  '',
  'החזר אובייקט JSON בלבד, בלי markdown ובלי טקסט נוסף:',
  '{"clientName":"","clientPhone":"","eventType":"","eventDate":"","distanceKm":0,',
  ' "isLocal":false,"items":[{"name":"","qty":1}],"notes":"","transcript":""}',
  '',
  'כללים:',
  '1. items.name חייב להיות מחרוזת מדויקת מהמחירון שנשלח אליך. אל תמציא שמות.',
  '   פריט ללא התאמה במחירון — השמט אותו וציין אותו ב-notes.',
  '2. eventDate בפורמט YYYY-MM-DD. אם אין תאריך ודאי — מחרוזת ריקה. אל תנחש.',
  '3. isLocal = true רק אם נאמר במפורש שהלקוח מבית חוגלה.',
  '4. distanceKm = 0 כשלא צוין מרחק.',
  '5. שדה שלא מופיע בשיחה — מחרוזת ריקה או 0. לעולם לא ניחוש.',
  '6. transcript: תמלול קצר. בקלט טקסט — השאר ריק.',
].join('\n');

const INV_SYSTEM = [
  'אתה מסדר רשימת מלאי של עסק בלונים לשורות מובנות.',
  '',
  'החזר JSON בלבד, בלי markdown:',
  '{"items":[{"name":"","cat":"","qty":0,"min":0}]}',
  '',
  'כללים:',
  '- name: שם קריא בעברית הכולל סוג, צבע וגודל אם הם מופיעים בשורה.',
  '- cat חייב להיות אחת בדיוק מ: ' + INV_CATS.join(', '),
  '  בלוני לטקס רגילים → לטקס · פויל/מיילר (לב, עגול, כוכב, ספרה) → מיילר ·',
  '  בלוני צורות/נקניק/260Q → טוויסטינג · גז או בלוני הליום → הליום ·',
  '  חוטים, משקולות, משאבות, סרטים → אביזרים · כל השאר → אחר',
  '- qty: הכמות שמופיעה בשורה. אם אין מספר — 0.',
  '- min: כמות מינימום רק אם צוינה במפורש, אחרת 0.',
  '- אל תמציא פריטים שלא מופיעים ברשימה.',
].join('\n');

function anthropic() {
  if (!ANTHROPIC_API_KEY) throw new Error('חסר ANTHROPIC_API_KEY ב-Secrets');
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// עם thinking אדפטיבי ה-content מכיל גם בלוקי thinking, אז לא לקחת content[0].
function textOf(res: any): string {
  for (const b of res?.content || []) if (b?.type === 'text') return String(b.text || '');
  return '';
}
function extractJson(text: string) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('התשובה מהמודל אינה JSON');
  return JSON.parse(m[0]);
}
function coerceQuote(o: any) {
  const items = Array.isArray(o?.items) ? o.items : [];
  const d = String(o?.eventDate ?? '');
  return {
    clientName: String(o?.clientName ?? ''),
    clientPhone: String(o?.clientPhone ?? ''),
    eventType: String(o?.eventType ?? ''),
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime()) ? d : '',
    distanceKm: Math.max(0, Math.trunc(Number(o?.distanceKm)) || 0),
    isLocal: Boolean(o?.isLocal),
    items: items
      .map((i: any) => ({ name: String(i?.name ?? '').trim(), qty: Math.max(1, Math.trunc(Number(i?.qty)) || 1) }))
      .filter((i: any) => i.name),
    notes: String(o?.notes ?? ''),
    transcript: String(o?.transcript ?? ''),
  };
}
function coerceInv(o: any) {
  const items = Array.isArray(o?.items) ? o.items : [];
  return items
    .map((r: any) => ({
      name: String(r?.name ?? '').trim(),
      cat: INV_CATS.includes(String(r?.cat)) ? String(r.cat) : 'אחר',
      qty: Math.max(0, Math.trunc(Number(r?.qty)) || 0),
      min: Math.max(0, Math.trunc(Number(r?.min)) || 0),
    }))
    .filter((r: any) => r.name);
}

async function askJson(system: string, content: unknown, effort: 'low' | 'medium', maxTokens = 16000) {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort },
  } as never);
  if ((res as any).stop_reason === 'refusal') throw new Error('הבקשה נדחתה ע"י מסנני הבטיחות');
  return extractJson(textOf(res));
}
async function parseQuote(text: string) {
  return coerceQuote(await askJson(QUOTE_SYSTEM, text, 'medium'));
}

// ─── Gemini, רק לאודיו: ה-Messages API של Anthropic לא מקבל קלט אודיו ───
const AUDIO_MIME_FIX: Record<string, string> = {
  'audio/mpeg': 'audio/mp3', 'audio/mpga': 'audio/mp3', 'audio/x-m4a': 'audio/aac',
  'audio/m4a': 'audio/aac', 'audio/mp4': 'audio/aac', 'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav', 'audio/opus': 'audio/ogg',
};
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

async function geminiTranscribe(prompt: string, mimeType: string, data: string) {
  let last = '';
  for (const model of GEMINI_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
        }),
      },
    );
    const d = await r.json().catch(() => null);
    if (d && !d.error) return String(d.candidates?.[0]?.content?.parts?.[0]?.text || '');
    last = d?.error?.message || `HTTP ${r.status}`;
    if (!/not found|not supported|unsupported|NOT_FOUND/i.test(last)) break;
  }
  throw new Error('Gemini: ' + last);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    // health פתוח לאבחון ולא מחזיר ערכי מפתחות — רק האם הם קיימים.
    if (body.action === 'health') {
      return json({
        ok: true, version: VERSION, model: MODEL,
        hasAnthropicKey: Boolean(ANTHROPIC_API_KEY),
        hasGeminiKey: Boolean(GEMINI_KEY),
        adminCount: ADMIN_EMAILS.length,
        actions: ['health', 'chat', 'vision', 'audio', 'inventory'],
      });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: { user }, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !user) return json({ ok: false, error: 'נדרשת התחברות' }, 401);
    if (!ADMIN_EMAILS.includes((user.email || '').toLowerCase())) {
      return json({ ok: false, error: 'החשבון אינו מורשה' }, 403);
    }

    if (body.action === 'chat') {
      const transcript = String(body.transcript || '').trim();
      if (!transcript) return json({ ok: false, error: 'חסרה שיחה' }, 400);
      const quote = await parseQuote(`מחירון:\n${String(body.priceList || '')}\n\nשיחה:\n${transcript}`);
      return json({ ok: true, quote });
    }

    if (body.action === 'inventory') {
      const text = String(body.text || '').trim();
      if (!text) return json({ ok: false, error: 'חסרה רשימה' }, 400);
      const items = coerceInv(await askJson(INV_SYSTEM, 'הרשימה:\n' + text, 'low'));
      if (!items.length) return json({ ok: false, error: 'לא זוהו פריטים ברשימה' }, 422);
      return json({ ok: true, items });
    }

    if (body.action === 'vision') {
      const image = String(body.image || '');
      const cats: string[] = Array.isArray(body.categories) ? body.categories : [];
      const m = image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
      if (!m) return json({ ok: false, error: 'פורמט תמונה לא תקין' }, 400);
      if (!cats.length) return json({ ok: false, error: 'חסרה רשימת קטגוריות' }, 400);
      const out = await askJson(
        'אתה מסווג תמונות של עיצובי בלונים לקטגוריה אחת מתוך רשימה סגורה. '
        + 'החזר JSON בלבד: {"category":"","description":""}. '
        + 'category חייב להיות מחרוזת מדויקת מהרשימה. description — משפט קצר בעברית.',
        [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: 'הקטגוריות האפשריות:\n' + cats.join('\n') },
        ],
        'low', 2000,
      );
      const cat = String(out?.category || '');
      return json({ ok: true, category: cats.includes(cat) ? cat : null, description: String(out?.description || '') });
    }

    if (body.action === 'audio') {
      if (!GEMINI_KEY) {
        return json({
          ok: false,
          error: 'תמלול אינו זמין: ה-API של Claude לא מקבל קלט אודיו, ואין מפתח Gemini ב-Secrets (GEMINI_KEY)',
        }, 501);
      }
      const audio = String(body.audio || '');
      const m = audio.match(/^data:([^;,]*);base64,(.+)$/);
      if (!m) return json({ ok: false, error: 'פורמט אודיו לא תקין' }, 400);
      const raw = String(body.mime || m[1]);
      const mimeType = AUDIO_MIME_FIX[raw] || raw;
      if (!mimeType.startsWith('audio/')) return json({ ok: false, error: 'לא קובץ אודיו: ' + (raw || 'לא ידוע') }, 400);

      // שלב 1 — Gemini מתמלל. שלב 2 — Claude מחלץ מהתמלול, אותה צורה כמו בהדבקת שיחה.
      const text = await geminiTranscribe('תמלל את ההקלטה הזו במלואה בעברית. החזר תמלול בלבד.', mimeType, m[2]);
      if (!text.trim()) return json({ ok: false, error: 'התמלול חזר ריק' }, 502);
      const quote = await parseQuote(`מחירון:\n${String(body.priceList || '')}\n\nתמלול שיחה:\n${text}`);
      return json({ ok: true, quote: { ...quote, transcript: quote.transcript || text.slice(0, 1200) }, transcript: text });
    }

    return json({ ok: false, error: 'פעולה לא מוכרת' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
