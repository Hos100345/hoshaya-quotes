// Hoshaya Inventory & Quotes Worker — Cloudflare Workers
//
// גוגל מוציאה מודלים משימוש מדי כמה חודשים, ואז כל ה-AI באפליקציה מת בשקט.
// לכן אין כאן מודל קשיח אחד: יש רשימה, והקוד יורד בה עד שאחד עונה.
// GET /health ו-GET /models מאפשרים לראות מה חי בלי לנחש.

const WORKER_VERSION = "2026-09-23";

// לפי סדר העדפה. אם כולם ייפלו — GET /models יראה מה כן קיים.
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MORNING_TOKEN_URL = "https://api.greeninvoice.co.il/api/v1/account/token";
const MORNING_API_URL = "https://api.greeninvoice.co.il/api/v1/documents";

// Gemini מקבל רק חלק משמות ה-MIME שהדפדפן מייצר.
const AUDIO_MIME_FIX = {
  "audio/mpeg": "audio/mp3",
  "audio/mpga": "audio/mp3",
  "audio/x-m4a": "audio/aac",
  "audio/m4a": "audio/aac",
  "audio/mp4": "audio/aac",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/opus": "audio/ogg",
};

export default {
  async fetch(request, env) {
    const headers = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers });

    const path = new URL(request.url).pathname;
    const isPost = request.method === "POST";

    try {
      if (path === "/health") return handleHealth(env, headers);
      if (path === "/models") return handleModels(env, headers);
      if (path === "/gemini" && isPost) return await handleText(request, env, headers);
      if (path === "/gemini-vision" && isPost) return await handleVision(request, env, headers);
      if (path === "/gemini-audio" && isPost) return await handleAudio(request, env, headers);
      if (path === "/morning" && isPost) return await handleMorning(request, env, headers);
      return err(`Unknown endpoint: ${request.method} ${path}`, 404, headers);
    } catch (e) {
      return err("Server error: " + e.message, 500, headers);
    }
  },
};

// ═══════════════ אבחון ═══════════════

function handleHealth(env, headers) {
  return ok({
    version: WORKER_VERSION,
    hasGeminiKey: Boolean(env.GEMINI_KEY),
    hasMorningCreds: Boolean(env.MORNING_ID && env.MORNING_SECRET),
    models: GEMINI_MODELS,
    endpoints: ["GET /health", "GET /models", "POST /gemini", "POST /gemini-vision", "POST /gemini-audio", "POST /morning"],
  }, headers);
}

// מה גוגל באמת מציעה למפתח הזה — התשובה לשאלה "איזה מודל לשים ברשימה".
async function handleModels(env, headers) {
  if (!env.GEMINI_KEY) return err("GEMINI_KEY is not set on the Worker", 500, headers);
  const res = await fetch(`${GEMINI_BASE}/models`, { headers: { "x-goog-api-key": env.GEMINI_KEY } });
  const data = await res.json().catch(() => null);
  if (!data || data.error) return err("Gemini: " + (data?.error?.message || `HTTP ${res.status}`), 502, headers);
  const usable = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""));
  return ok({ usable, configured: GEMINI_MODELS }, headers);
}

// ═══════════════ Gemini ═══════════════

async function callGemini(env, parts, headers) {
  if (!env.GEMINI_KEY) return err("GEMINI_KEY is not set on the Worker", 500, headers);
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 1, topK: 40, topP: 0.95, maxOutputTokens: 8192 },
  });

  let last = null;
  for (const model of GEMINI_MODELS) {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
      body,
    });
    const data = await res.json().catch(() => null);
    if (data && !data.error) {
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return ok({ text, model, candidates: data.candidates }, headers);
    }
    last = data?.error || { message: `HTTP ${res.status}` };
    // ממשיכים לדגם הבא רק כשהבעיה היא המודל. מפתח שגוי או מכסה — עוצרים מיד.
    if (!/not found|not supported|unsupported|NOT_FOUND/i.test(last.message || "")) break;
  }
  return err("Gemini: " + (last?.message || "unknown"), 502, headers);
}

async function handleText(request, env, headers) {
  const { prompt } = await request.json();
  if (!prompt) return err("Missing prompt", 400, headers);
  return callGemini(env, [{ text: prompt }], headers);
}

async function handleVision(request, env, headers) {
  const { prompt, image } = await request.json();
  if (!prompt || !image) return err("Missing prompt or image", 400, headers);
  const m = image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) return err("Invalid image format", 400, headers);
  return callGemini(env, [{ text: prompt }, { inlineData: { mimeType: m[1], data: m[2] } }], headers);
}

async function handleAudio(request, env, headers) {
  const body = await request.json();
  const { prompt, audio } = body;
  if (!prompt || !audio) return err("Missing prompt or audio", 400, headers);
  const m = audio.match(/^data:([^;,]*);base64,(.+)$/);
  if (!m) return err("Invalid audio format", 400, headers);
  // body.mime גובר: בוררי קבצים בנייד מחזירים לעיתים MIME ריק או שגוי.
  const raw = body.mime || m[1];
  const mimeType = AUDIO_MIME_FIX[raw] || raw;
  if (!mimeType.startsWith("audio/")) return err("Not an audio file: " + (raw || "unknown"), 400, headers);
  return callGemini(env, [{ text: prompt }, { inlineData: { mimeType, data: m[2] } }], headers);
}

// ═══════════════ Morning (Green Invoice) ═══════════════

async function handleMorning(request, env, headers) {
  if (!env.MORNING_ID || !env.MORNING_SECRET) return err("Morning credentials are not set on the Worker", 500, headers);
  const payload = await request.json();

  const tokenRes = await fetch(MORNING_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `id=${env.MORNING_ID}&secret=${env.MORNING_SECRET}`,
  });
  const tokenData = await tokenRes.json().catch(() => null);
  if (!tokenData?.token) return err("Morning auth failed", 401, headers);

  const doc = {
    description: payload.description || "שירות",
    type: payload.type || 320,
    lang: payload.lang || "he",
    currency: payload.currency || "ILS",
    vatType: payload.vatType || 0,
    discount: payload.discount || 0,
    client: payload.client || {},
    income: payload.income || [],
    remarks: payload.remarks || "",
  };

  const docRes = await fetch(MORNING_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenData.token}` },
    body: JSON.stringify(doc),
  });
  const docData = await docRes.json().catch(() => null);
  if (!docData || docData.error) return err("Morning error: " + (docData?.error || `HTTP ${docRes.status}`), 400, headers);
  return ok(docData, headers);
}

// ═══════════════ helpers ═══════════════

function ok(data, headers) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function err(msg, status = 400, headers = {}) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
