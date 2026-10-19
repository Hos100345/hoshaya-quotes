// morning-proxy — הלוגיקה הטהורה (בלי Deno ובלי Supabase), כדי שאפשר לבדוק אותה ב-Node.
// כל הקריאות ל-Morning (greeninvoice) עוברות כאן; המפתח לא יוצא מהשרת.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export const BASE = 'https://api.greeninvoice.co.il/api/v1';

export class MorningError extends Error {
  status: number;
  constructor(msg: string, status = 502) { super(msg); this.status = status; }
}

// לקוח Morning עם טוקן במטמון (תקף כשעה; שומרים 50 דקות). 401/403 מה-API → טוקן חדש וניסיון חוזר אחד.
export function makeMorning(id: string, secret: string, f: Fetch = fetch, now: () => number = () => Date.now()) {
  let tok = '', at = 0;
  const hasKeys = () => Boolean(id && secret);

  async function token(force = false): Promise<string> {
    if (!hasKeys()) throw new MorningError('מפתח Morning לא הוגדר בשרת (Secrets)', 503);
    if (!force && tok && now() - at < 50 * 60 * 1000) return tok;
    const r = await f(BASE + '/account/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, secret }),
    });
    const d = await r.json().catch(() => null);
    if (!d || !d.token) {
      throw new MorningError(d && d.errorMessage ? String(d.errorMessage) : `התחברות ל-Morning נכשלה (${r.status})`, 502);
    }
    tok = d.token; at = now();
    return tok;
  }

  async function call(path: string, method: string, body?: unknown): Promise<{ status: number; data: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(attempt > 0);
      const r = await f(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ((r.status === 401 || r.status === 403) && attempt === 0) continue;
      const data = await r.json().catch(() => null);
      return { status: r.status, data };
    }
    throw new MorningError('התחברות ל-Morning נכשלה', 502);
  }
  return { token, call, hasKeys };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function cleanSearchName(v: unknown): string {
  const s = str(v, 80);
  return s.length >= 2 ? s : '';
}
export function cleanClientId(v: unknown): string {
  return typeof v === 'string' && /^[\w-]{8,64}$/.test(v) ? v : '';
}

// ⛔ רשימה לבנה: רק דרישת תשלום (חשבון עסקה, type 300) ורק השדות שהאפליקציה שולחת. שפה/מטבע/מע"מ נקבעים כאן.
export function buildDocument(p: any): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  if (!p || typeof p !== 'object') return { ok: false, error: 'חסר מסמך' };
  if (p.type !== 300) return { ok: false, error: 'אפשר להפיק רק דרישת תשלום (type 300)' };
  const income = Array.isArray(p.income) ? p.income : [];
  if (income.length < 1 || income.length > 60) return { ok: false, error: 'מספר שורות לא תקין' };
  const rows: Record<string, unknown>[] = [];
  for (const r of income) {
    const description = str(r && r.description, 200);
    if (!description) return { ok: false, error: 'שורה בלי תיאור' };
    if (!isNum(r.quantity) || r.quantity <= 0 || r.quantity > 1000) return { ok: false, error: 'כמות לא תקינה' };
    if (!isNum(r.price) || r.price < 0 || r.price > 100000) return { ok: false, error: 'מחיר לא תקין' };
    rows.push({ description, quantity: r.quantity, price: r.price, vatType: 0 });
  }
  const c = p.client;
  if (!c || typeof c !== 'object') return { ok: false, error: 'חסר לקוח' };
  const name = str(c.name, 100);
  if (!name) return { ok: false, error: 'חסר שם לקוח' };
  const phones: { phone: string }[] = [];
  if (Array.isArray(c.phones)) {
    for (const ph of c.phones.slice(0, 3)) {
      const n = str(ph && ph.phone, 30);
      if (n && /^[\d+\-\s()]+$/.test(n)) phones.push({ phone: n });
    }
  }
  const cid = c.id ? cleanClientId(c.id) : '';
  if (c.id && !cid) return { ok: false, error: 'מזהה לקוח לא תקין' };
  const client: Record<string, unknown> = cid ? { id: cid, name, phones } : { name, phones, add: true };
  const discount = p.discount == null ? 0 : p.discount;
  if (!isNum(discount) || discount < 0 || discount > 100000) return { ok: false, error: 'הנחה לא תקינה' };
  return {
    ok: true,
    doc: {
      description: str(p.description, 200) || 'שירותי בלונים',
      type: 300, lang: 'he', currency: 'ILS', vatType: 0, discount,
      client, income: rows, remarks: str(p.remarks, 500),
    },
  };
}
