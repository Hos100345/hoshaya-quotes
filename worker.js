// Hoshaya Inventory & Quotes Worker

// Cloudflare Workers Script




const GEMINI_MODEL = "gemini-2.0-flash"; // עדכון מ-1.5-flash

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent";

const MORNING_TOKEN_URL = "https://api.greeninvoice.co.il/api/v1/account/token";

const MORNING_API_URL = "https://api.greeninvoice.co.il/api/v1/documents";




export default {

  async fetch(request, env) {

    // CORS headers

    const headers = {

      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",

      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",

      "Access-Control-Allow-Headers": "Content-Type",

    };




    if (request.method === "OPTIONS") {

      return new Response(null, { headers });

    }




    const url = new URL(request.url);

    const path = url.pathname;




    try {

      if (path === "/gemini" && request.method === "POST") {

        return await handleGeminiText(request, env, headers);

      }

      if (path === "/gemini-vision" && request.method === "POST") {

        return await handleGeminiVision(request, env, headers);

      }

      if (path === "/morning" && request.method === "POST") {

        return await handleMorning(request, env, headers);

      }

      return err("Unknown endpoint", 404, headers);

    } catch (e) {

      console.error(e);

      return err("Server error: " + e.message, 500, headers);

    }

  },

};




// ═══════════════════════════════════════════════════════════

// GEMINI TEXT

// ═══════════════════════════════════════════════════════════

async function handleGeminiText(request, env, headers) {

  const body = await request.json();

  const prompt = body.prompt;

  if (!prompt) return err("Missing prompt", 400, headers);




  const res = await fetch(GEMINI_URL, {

    method: "POST",

    headers: {

      "Content-Type": "application/json",

      "x-goog-api-key": env.GEMINI_KEY,

    },

    body: JSON.stringify({

      contents: [{ parts: [{ text: prompt }] }],

      generationConfig: { temperature: 1, topK: 40, topP: 0.95, maxOutputTokens: 8192 },

    }),

  });




  const data = await res.json();

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  return ok({ text, candidates: data.candidates }, headers);

}




// ═══════════════════════════════════════════════════════════

// GEMINI VISION

// ═══════════════════════════════════════════════════════════

async function handleGeminiVision(request, env, headers) {

  const body = await request.json();

  const prompt = body.prompt;

  const imageBase64 = body.image; // data:image/...;base64,xxxxx




  if (!prompt || !imageBase64) return err("Missing prompt or image", 400, headers);




  // פענוח base64 image

  const matches = imageBase64.match(/data:image\/(\w+);base64,(.+)/);

  if (!matches) return err("Invalid image format", 400, headers);

  const mimeType = `image/${matches[1]}`;

  const base64Data = matches[2];




  const res = await fetch(GEMINI_URL, {

    method: "POST",

    headers: {

      "Content-Type": "application/json",

      "x-goog-api-key": env.GEMINI_KEY,

    },

    body: JSON.stringify({

      contents: [

        {

          parts: [

            { text: prompt },

            { inlineData: { mimeType, data: base64Data } },

          ],

        },

      ],

      generationConfig: { temperature: 1, topK: 40, topP: 0.95, maxOutputTokens: 8192 },

    }),

  });




  const data = await res.json();

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  return ok({ text, candidates: data.candidates }, headers);

}




// ═══════════════════════════════════════════════════════════

// MORNING (GREEN INVOICE)

// ═══════════════════════════════════════════════════════════

async function handleMorning(request, env, headers) {

  const payload = await request.json();




  // קבל token

  const tokenRes = await fetch(MORNING_TOKEN_URL, {

    method: "POST",

    headers: { "Content-Type": "application/x-www-form-urlencoded" },

    body: `id=${env.MORNING_ID}&secret=${env.MORNING_SECRET}`,

  });




  const tokenData = await tokenRes.json();

  if (!tokenData.token) return err("Morning auth failed", 401, headers);




  const token = tokenData.token;




  // שלח מסמך

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

    headers: {

      "Content-Type": "application/json",

      Authorization: `Bearer ${token}`,

    },

    body: JSON.stringify(doc),

  });




  const docData = await docRes.json();

  if (docData.error) return err("Morning error: " + docData.error, 400, headers);




  return ok(docData, headers);

}




// ═══════════════════════════════════════════════════════════

// HELPERS

// ═══════════════════════════════════════════════════════════

function ok(data, headers) {

  return new Response(JSON.stringify({ ok: true, ...data }), {

    headers: { ...headers, "Content-Type": "application/json" },

  });

}




function err(msg, status = 400, headers) {

  return new Response(JSON.stringify({ ok: false, error: msg }), {

    status,

    headers: { ...headers, "Content-Type": "application/json" },

  });

}
