// api/chat.js
// Server-side proxy for NAZE AI.
// Primary: Google Gemini API (vision + Naze Auto Browse via Google Search
// grounding). Fallback chain when Gemini is completely unavailable (all
// keys out of quota/rejected): Groq -> OpenRouter -> Mistral, all free,
// all OpenAI-compatible chat/completions APIs.
//
// API keys live only here, as server environment variables — never in the
// frontend.
//   Gemini:      https://aistudio.google.com/apikey        (GEMINI_API_KEY*)
//   Groq:        https://console.groq.com/keys             (GROQ_API_KEY*)
//   OpenRouter:  https://openrouter.ai/keys                (OPENROUTER_API_KEY*)
//   Mistral:     https://console.mistral.ai/api-keys        (MISTRAL_API_KEY*)
//   Hugging Face (generate gambar): https://huggingface.co/settings/tokens (HF_API_KEY*)
//   Brave Search (browsing utk provider cadangan): https://api.search.brave.com/app/keys (BRAVE_API_KEY*)
//
// Multi-key rotation (any provider): set <PREFIX>S to a comma-separated
// list, or <PREFIX>_1.. <PREFIX>_10, or a single <PREFIX>. E.g.
// GEMINI_API_KEYS="key1,key2,key3" or GEMINI_API_KEY_1 / GEMINI_API_KEY_2 / ...
// Each key has its own daily quota, so when one key hits "quota habis"
// (HTTP 429) or is rejected (401/403), the request automatically retries
// with the next key instead of failing right away.
//
// "Semua API key sama derajat": Gemini is still tried first (it's the only
// one with vision + native Google Search grounding), but if it's completely
// unavailable, the fallback chain (Groq / OpenRouter / Mistral) is no longer
// a fixed Groq->OpenRouter->Mistral order — the order is reshuffled at
// random on every single request, so no one provider is permanently
// favored over another when Gemini is down.
//
// Only Gemini can see images. If a turn includes an image, we never fall
// back (the other providers would just silently ignore the picture, which
// would be worse than a clear error). If a turn falls back to
// Groq/OpenRouter/Mistral, the frontend gets a small honest notice about
// which model actually answered.
//
// Naze Browse for fallback providers: Groq/OpenRouter/Mistral don't have a
// native search tool like Gemini does, so when BRAVE_API_KEY is configured
// and browsing isn't turned off, we give them a "web_search" function tool.
// If the model asks to call it, we run a real Brave Search and feed the
// results back before the model writes its final answer.
//
// Generate gambar: separate from chat entirely (action:"generate_image" in
// the request body) — calls Hugging Face's free Inference API and returns
// a single generated image as a base64 data URI. Needs HF_API_KEY.
//
// This function also translates between the Anthropic-style message format
// the frontend already sends (content blocks: text / image) and each
// provider's native format, then re-emits every provider's stream as the
// same simple SSE shape the frontend already knows how to read
// ({"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}})
// — so index.html didn't need much changed to support this.
//
// Deploy layout expected by Vercel (repo root):
//   index.html, manifest.json, sw.js, icon-*.png, apple-touch-icon.png
//   api/chat.js   <-- this file, auto-detected as an Edge Function

export const config = { runtime: 'edge' };

// NOTE (corrected): this was briefly changed to 'gemini-2.5-flash' under the
// mistaken assumption that 'gemini-3.6-flash' wasn't a real model id — it
// actually is: a stable Gemini model Google released July 21, 2026, and it
// fully supports Google Search grounding (used below).
const GEMINI_MODEL = 'gemini-3.6-flash';
// Raised from 4096 -> 8192: this is a per-request output-token ceiling, not
// a promise every answer gets this much room. It mostly just means fewer
// answers need an automatic continuation round (see MAX_CONTINUATIONS
// below) to finish a long explanation.
const MAX_TOKENS_CAP = 8192;
const MAX_KEYS = 10;

// ROOT CAUSE of "respons terpotong pada API fallback": when a provider hit
// its own max-output-tokens ceiling mid-answer, it legitimately ends its
// stream with a "truncated" finish reason (Gemini: finishReason
// "MAX_TOKENS"; Groq/OpenRouter/Mistral, all OpenAI-compatible:
// finish_reason "length") instead of "the answer is actually done"
// (Gemini: "STOP"; OpenAI-compatible: "stop"). The old code treated *any*
// finish reason as "we're done, close the stream" — so a long answer that
// hit the token ceiling was silently handed to the user as if it were
// complete, mid-sentence. Fix: when we see a length-truncation finish
// reason, don't close the stream — automatically ask the same provider to
// continue from where it stopped, and stitch the continuation onto the
// same SSE stream the frontend is already reading, up to
// MAX_CONTINUATIONS times.
const MAX_CONTINUATIONS = 3;

// Lightweight dev logging (section 13 of the fix brief): provider, model,
// streaming, finish reason, and — for continuations — which round. Never
// logs API keys or full response text, only shape/metadata.
function debugLog(fields) {
  try {
    console.log('[NAZE debug] ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' '));
  } catch (e) {
    /* logging must never break the request */
  }
}

// Free image generation via Hugging Face's hosted Inference API. FLUX.1-schnell
// is a fast, genuinely free-tier-friendly text-to-image model as of 2026.
const HF_IMAGE_MODEL = 'black-forest-labs/FLUX.1-schnell';
const HF_IMAGE_URL = `https://api-inference.huggingface.co/models/${HF_IMAGE_MODEL}`;

// Brave Search free tier (no credit card) — used only to give the fallback
// providers (Groq/OpenRouter/Mistral) a real browsing capability, since none
// of them have anything like Gemini's built-in google_search grounding.
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fallback providers, tried in this order only when Gemini is completely
// unavailable. All three are OpenAI-compatible chat/completions APIs, all
// have a genuine no-credit-card free tier as of 2026. Models chosen for
// being the free-tier options on each provider today — if a provider
// rotates its free catalog, update the `model` string here.
const FALLBACK_PROVIDERS = [
  {
    key: 'groq',
    label: 'Groq (gpt-oss-120b)',
    envPrefix: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b'
  },
  {
    key: 'openrouter',
    label: 'OpenRouter (gpt-oss-120b)',
    envPrefix: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openai/gpt-oss-120b:free',
    extraHeaders: { 'HTTP-Referer': 'https://naze.ai', 'X-Title': 'Naze AI' }
  },
  {
    key: 'mistral',
    label: 'Mistral (mistral-small)',
    envPrefix: 'MISTRAL_API_KEY',
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest'
  }
];

// Generic: collect up to 10 keys for a given env var prefix. Supports
// PREFIXS="key1,key2,..." (comma list), PREFIX_1.._10, and plain PREFIX.
function collectKeys(prefix) {
  const keys = [];
  const plural = process.env[`${prefix}S`];
  if (plural) keys.push(...plural.split(',').map((k) => k.trim()).filter(Boolean));
  if (process.env[prefix]) keys.push(process.env[prefix].trim());
  for (let i = 1; i <= MAX_KEYS; i++) {
    const k = process.env[`${prefix}_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  const unique = [...new Set(keys)].slice(0, MAX_KEYS);
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique;
}

// Generate a single image via Hugging Face's free Inference API and return
// it as a base64 data URI. Kept completely separate from the chat/streaming
// flow — this is a plain request/response JSON call, not SSE.
async function handleGenerateImage(body) {
  const hfKeys = collectKeys('HF_API_KEY');
  if (hfKeys.length === 0) {
    return new Response(
      JSON.stringify({ error: 'Belum ada HF_API_KEY di environment variables server. Ambil token gratis di https://huggingface.co/settings/tokens lalu tambahkan sebagai env var HF_API_KEY.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const prompt = String(body.prompt || '').slice(0, 800).trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Deskripsi gambar kosong.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let lastStatus = 500, lastDetail = '';
  for (const apiKey of shuffle(hfKeys)) {
    try {
      const res = await fetch(HF_IMAGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ inputs: prompt })
      });
      if (res.ok) {
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        if (contentType.startsWith('image/')) {
          const buf = await res.arrayBuffer();
          const b64 = Buffer.from(buf).toString('base64');
          return new Response(
            JSON.stringify({ image: `data:${contentType};base64,${b64}` }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Some HF deployments return JSON (e.g. {error:"loading", estimated_time:...})
        // even with a 200 — treat that as a failure and try the next key.
        lastDetail = await res.text().catch(() => '');
        lastStatus = 503;
        continue;
      }
      lastStatus = res.status;
      lastDetail = await res.text().catch(() => '');
      // 503 usually means the model is "cold" and loading on HF's shared
      // infra — worth trying the next key/attempt rather than giving up.
      if (res.status !== 429 && res.status !== 503) break;
    } catch (e) {
      lastStatus = 502;
      lastDetail = String(e.message || e).slice(0, 300);
    }
  }

  const isLoading = lastStatus === 503;
  return new Response(
    JSON.stringify({
      error: isLoading
        ? 'Model gambar Hugging Face sedang "pemanasan" (cold start) di infrastruktur gratis mereka — coba lagi dalam beberapa detik.'
        : 'Gagal membuat gambar lewat Hugging Face.',
      status: lastStatus,
      detail: lastDetail.slice(0, 400)
    }),
    { status: lastStatus || 500, headers: { 'Content-Type': 'application/json' } }
  );
}

// Run a single Brave Search query. Returns a short array of {title, url,
// snippet} results, or [] on any failure (never throws) — a failed search
// should degrade to "no results" for the model, not break the whole chat.
async function braveSearch(query) {
  const keys = collectKeys('BRAVE_API_KEY');
  if (keys.length === 0) return [];
  for (const apiKey of shuffle(keys)) {
    try {
      const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=5`;
      const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } });
      if (!res.ok) { if (res.status !== 429) break; continue; }
      const j = await res.json();
      const items = (j && j.web && j.web.results) || [];
      return items.slice(0, 5).map((it) => ({
        title: it.title || it.url,
        url: it.url,
        snippet: (it.description || '').replace(/<[^>]+>/g, '').slice(0, 300)
      }));
    } catch (e) {
      continue;
    }
  }
  return [];
}

// One cheap non-streaming request with a `web_search` function tool
// defined. If the model responds with a tool call, we return the query it
// asked for so the caller can run a real Brave Search and continue the
// conversation. If it just answers directly (most turns), returns null and
// the caller proceeds with the normal streaming call using the *same*
// messages (no extra tokens wasted on a throwaway completion — we ignore
// this probe's own text output either way; the caller always makes the
// real streaming call afterwards).
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Cari informasi terkini di internet. Gunakan hanya jika pertanyaan pengguna butuh fakta terkini/spesifik yang mungkin di luar pengetahuanmu.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Kata kunci pencarian' } },
      required: ['query']
    }
  }
};

async function tryToolCallProbe(provider, keys, messages, maxTokens) {
  const payload = {
    model: provider.model,
    messages,
    max_tokens: Math.min(maxTokens || 4000, MAX_TOKENS_CAP),
    tools: [WEB_SEARCH_TOOL],
    tool_choice: 'auto',
    stream: false
  };
  for (const apiKey of keys) {
    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(provider.extraHeaders || {}) },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        if (res.status === 429 || res.status === 401 || res.status === 403) continue;
        return null;
      }
      const j = await res.json();
      const call = j?.choices?.[0]?.message?.tool_calls?.[0];
      if (call && call.function && call.function.name === 'web_search') {
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          if (args.query) return { query: String(args.query).slice(0, 300) };
        } catch (e) { return null; }
      }
      return null;
    } catch (e) {
      continue;
    }
  }
  return null;
}

function hasImageContent(messages) {
  return (messages || []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image')
  );
}

function toGeminiContents(messages) {
  return (messages || []).map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const parts = blocks.map((block) => {
      if (block.type === 'image' && block.source && block.source.data) {
        return { inlineData: { mimeType: block.source.media_type || 'image/jpeg', data: block.source.data } };
      }
      return { text: block.text || '' };
    });
    return { role, parts };
  });
}

// Single attempt (trying each key in turn) to open a streaming
// chat/completions request against one OpenAI-compatible provider. Shared
// between the initial request and any automatic continuation requests, so
// both go through identical key-rotation/error-handling logic.
async function fetchProviderStream(provider, keys, messages, maxTokens, signal) {
  const payload = { model: provider.model, messages, max_tokens: maxTokens, stream: true };
  for (const apiKey of keys) {
    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(provider.extraHeaders || {})
        },
        body: JSON.stringify(payload),
        signal
      });
      if (res.ok && res.body) return res;
      const status = res.status;
      if (status !== 429 && status !== 401 && status !== 403) break;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // network hiccup on this key — try the next one
    }
  }
  return null;
}

function toOpenAIMessages(messages, systemText) {
  const out = [];
  if (systemText) out.push({ role: 'system', content: systemText });
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    // Images silently dropped here — callers must check hasImageContent()
    // first and skip the fallback chain entirely when a turn has one.
    const text = blocks.filter((b) => b.type !== 'image').map((b) => b.text || '').join('\n');
    out.push({ role, content: text });
  }
  return out;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  let earlyBody;
  try {
    earlyBody = await req.clone().json();
  } catch (e) {
    earlyBody = null;
  }
  if (earlyBody && earlyBody.action === 'generate_image') {
    return handleGenerateImage(earlyBody);
  }

  const geminiKeys = collectKeys('GEMINI_API_KEY');
  if (geminiKeys.length === 0 && FALLBACK_PROVIDERS.every((p) => collectKeys(p.envPrefix).length === 0)) {
    return new Response(
      JSON.stringify({ error: 'Belum ada API key sama sekali di environment variables server (Gemini/Groq/OpenRouter/Mistral).' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Body request tidak valid.' }), { status: 400 });
  }

  const imagePresent = hasImageContent(body.messages);

  // Naze Auto Browse: 'auto' (model decides on its own whether a Google
  // Search is needed — the default), 'always' (nudge it to prefer
  // searching), or 'never' (no browsing tool at all). Only meaningful for
  // Gemini — none of the fallback providers have a search tool at all.
  const browseMode = ['auto', 'always', 'never'].includes(body.browseMode) ? body.browseMode : 'auto';

  let systemText = body.system ? String(body.system).slice(0, 4000) : '';
  if (browseMode === 'always' && systemText) {
    systemText += '\n\nPENTING: Untuk permintaan pengguna ini, gunakan alat Google Search minimal satu kali untuk memverifikasi jawabanmu dengan informasi terkini sebelum menjawab — kecuali permintaannya murni matematika, penulisan kreatif, atau brainstorming yang jelas tidak butuh fakta eksternal.';
  }

  const geminiPayload = {
    contents: toGeminiContents(body.messages),
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    generationConfig: { maxOutputTokens: Math.min(body.max_tokens || 4000, MAX_TOKENS_CAP) }
  };
  // Gemini API note: a request can't mix the built-in google_search tool
  // with custom function-calling tools — we don't use any, so this is safe.
  if (browseMode !== 'never') {
    geminiPayload.tools = [{ google_search: {} }];
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

  // Try each Gemini key in turn for a given payload. A key that's out of
  // quota (429) or rejected (403) just moves on to the next one instead of
  // failing the whole request right away.
  async function attemptGeminiWithKeys(reqPayload) {
    let upstream = null, lastErrStatus = 500, lastErrDetail = '';
    for (const apiKey of geminiKeys) {
      try {
        const res = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(reqPayload),
          signal: req.signal
        });
        if (res.ok && res.body) { upstream = res; break; }
        lastErrStatus = res.status;
        lastErrDetail = await res.text().catch(() => '');
        if (res.status !== 429 && res.status !== 403) break;
      } catch (e) {
        if (e.name === 'AbortError') { throw e; }
        lastErrStatus = 502;
        lastErrDetail = String(e.message || e).slice(0, 300);
      }
    }
    return { upstream, lastErrStatus, lastErrDetail };
  }

  let geminiResult = { upstream: null, lastErrStatus: 500, lastErrDetail: '' };
  if (geminiKeys.length > 0) {
    try {
      geminiResult = await attemptGeminiWithKeys(geminiPayload);
    } catch (e) {
      return new Response(null, { status: 499 });
    }

    // Fallback #1: if a request WITH the google_search tool fails outright
    // (not a quota issue), some free-tier / no-billing projects reject the
    // grounding tool itself even though plain chat works fine on the same
    // key. Retry once without the tool so the chat still works — just
    // without browsing for that turn.
    if (!geminiResult.upstream && geminiPayload.tools && geminiResult.lastErrStatus !== 429) {
      const noToolsPayload = { ...geminiPayload };
      delete noToolsPayload.tools;
      try {
        const retry = await attemptGeminiWithKeys(noToolsPayload);
        if (retry.upstream) geminiResult = retry;
      } catch (e) {
        return new Response(null, { status: 499 });
      }
    }
  }

  if (geminiResult.upstream) {
    debugLog({ provider: 'gemini', model: GEMINI_MODEL, streaming: true, maxOutputTokens: geminiPayload.generationConfig.maxOutputTokens });
    return streamGeminiResponse(geminiResult.upstream, {
      initialPayload: geminiPayload,
      attemptWithKeys: attemptGeminiWithKeys
    });
  }

  // Gemini is completely unavailable. Fall back to Groq -> OpenRouter ->
  // Mistral — but never for a turn with an image, since none of them can
  // see it (better an honest error than a reply that silently ignores the
  // picture the user asked about).
  if (!imagePresent) {
    // "Semua API key sama derajat": Gemini still goes first (only it has
    // vision + native search grounding), but once Gemini is completely out,
    // the fallback providers are no longer tried in a fixed
    // Groq -> OpenRouter -> Mistral order every time — the order is
    // reshuffled per request so each one gets an equal shot at being tried
    // first.
    const braveAvailable = collectKeys('BRAVE_API_KEY').length > 0;
    const canBrowseFallback = braveAvailable && browseMode !== 'never';
    const cappedTokens = Math.min(body.max_tokens || 4000, MAX_TOKENS_CAP);

    for (const provider of shuffle(FALLBACK_PROVIDERS)) {
      const keys = collectKeys(provider.envPrefix);
      if (keys.length === 0) continue;
      let baseMessages = toOpenAIMessages(body.messages, systemText);
      let providerNoticeExtra = null;

      if (canBrowseFallback) {
        // Non-streaming probe first: does the model want to call
        // web_search for this turn? Cheap and only costs one extra request
        // when browsing is actually used.
        const toolCall = await tryToolCallProbe(provider, keys, baseMessages, cappedTokens);
        if (toolCall && toolCall.query) {
          const results = await braveSearch(toolCall.query);
          const resultsText = results.length
            ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
            : '(Tidak ada hasil ditemukan.)';
          baseMessages = [
            ...baseMessages,
            { role: 'assistant', content: `[Memanggil web_search untuk: "${toolCall.query}"]` },
            { role: 'user', content: `Hasil pencarian web untuk "${toolCall.query}":\n\n${resultsText}\n\nGunakan hasil ini (sebutkan sumbernya) untuk menjawab pertanyaan sebelumnya.` }
          ];
          providerNoticeExtra = { queries: [toolCall.query], sources: results.map((r) => ({ uri: r.url, title: r.title })) };
        }
      }

      let upstream;
      try {
        upstream = await fetchProviderStream(provider, keys, baseMessages, cappedTokens, req.signal);
      } catch (e) {
        if (e.name === 'AbortError') { throw e; }
        upstream = null;
      }
      if (upstream) {
        debugLog({ provider: provider.key, model: provider.model, streaming: true, maxOutputTokens: cappedTokens });
        return streamOpenAICompatibleResponse(upstream, provider.label, providerNoticeExtra, {
          provider,
          keys,
          baseMessages,
          cappedTokens,
          signal: req.signal
        });
      }
    }
  }

  // Nothing worked at all — return Gemini's own error, it's the most
  // informative one we have (the fallback attempts above don't retain
  // per-provider error detail to keep this readable).
  const isQuota = geminiResult.lastErrStatus === 429;
  return new Response(
    JSON.stringify({
      error: isQuota
        ? `Semua ${geminiKeys.length} API key Gemini kehabisan kuota gratis hari ini, dan tidak ada provider cadangan (Groq/OpenRouter/Mistral) yang berhasil menjawab. Coba lagi nanti.`
        : imagePresent
        ? 'Gemini API error (pesan ini berisi gambar, jadi tidak bisa dialihkan ke provider cadangan yang tidak mendukung vision).'
        : 'Semua provider (Gemini + cadangan) gagal menjawab.',
      status: geminiResult.lastErrStatus,
      detail: geminiResult.lastErrDetail.slice(0, 400)
    }),
    { status: geminiResult.lastErrStatus || 500, headers: { 'Content-Type': 'application/json' } }
  );
}

// Re-encode Gemini's SSE chunks into the simple protocol the frontend expects,
// plus collect+forward Naze Sources (Google Search grounding metadata).
//
// ctx.initialPayload / ctx.attemptWithKeys enable automatic continuation:
// if a candidate's finishReason comes back as "MAX_TOKENS" (truncated by
// the output-token ceiling) rather than "STOP" (genuinely done), we send a
// follow-up request asking Gemini to continue from where it left off and
// splice the new text_delta events onto the same SSE stream — the
// frontend never knows a second request happened, it just keeps receiving
// tokens. Only a real finish reason (STOP, SAFETY, etc.) or running out of
// continuation attempts ends the stream.
function streamGeminiResponse(initialUpstream, ctx) {
  const { initialPayload, attemptWithKeys } = ctx;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const groundingQueries = [];
  const seenQueries = new Set();
  const groundingSources = new Map();

  function collectGrounding(evt) {
    const gm = evt?.candidates?.[0]?.groundingMetadata;
    if (!gm) return;
    if (Array.isArray(gm.webSearchQueries)) {
      for (const q of gm.webSearchQueries) {
        if (q && !seenQueries.has(q)) { seenQueries.add(q); groundingQueries.push(q); }
      }
    }
    if (Array.isArray(gm.groundingChunks)) {
      for (const gc of gm.groundingChunks) {
        const web = gc && gc.web;
        if (web && web.uri && !groundingSources.has(web.uri)) {
          groundingSources.set(web.uri, web.title || web.uri);
        }
      }
    }
  }

  function enqueueGroundingIfAny(controller) {
    if (groundingSources.size === 0 && groundingQueries.length === 0) return;
    const out = {
      type: 'grounding_metadata',
      queries: groundingQueries,
      sources: [...groundingSources.entries()].map(([uri, title]) => ({ uri, title }))
    };
    controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
  }

  // Fully drains one upstream SSE response, forwarding every text_delta as
  // it arrives (so the user keeps seeing tokens stream in live — this is
  // not buffered). Resolves once that upstream ends, with whatever finish
  // reason (if any) it reported and the text it produced this round.
  async function pumpOneUpstream(upstream, controller) {
    const reader = upstream.body.getReader();
    let buf = '';
    let finishReason = null;
    let accumulatedText = '';
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        break;
      }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        let evt;
        try {
          evt = JSON.parse(jsonStr);
        } catch (e) {
          // A single malformed chunk shouldn't kill the whole response —
          // skip it and keep reading the rest of the stream.
          continue;
        }
        const blockReason = evt?.promptFeedback?.blockReason;
        if (blockReason) {
          const out = { type: 'content_block_delta', delta: { type: 'text_delta', text: `\n\n_[Permintaan diblokir oleh filter keamanan Gemini: ${blockReason}]_` } };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
          continue;
        }
        collectGrounding(evt);
        const parts = evt?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p.text || '').join('');
        if (text) {
          accumulatedText += text;
          const out = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
        }
        if (evt?.candidates?.[0]?.finishReason) {
          finishReason = evt.candidates[0].finishReason;
          try { reader.cancel(); } catch (e) {}
          return { finishReason, accumulatedText };
        }
      }
    }
    return { finishReason, accumulatedText };
  }

  // Builds the follow-up request: original conversation, plus what the
  // model has said so far as a "model" turn, plus a plain instruction to
  // keep going without repeating itself. Always rebuilt from the ORIGINAL
  // payload (not the previous continuation's payload) so repeated rounds
  // don't stack redundant "continue" turns on top of each other.
  function buildContinuationPayload(basePayload, priorText) {
    const contents = [...basePayload.contents, { role: 'model', parts: [{ text: priorText }] }, {
      role: 'user',
      parts: [{ text: 'Lanjutkan jawabanmu persis dari kata terakhir yang terpotong di atas. Jangan mengulang bagian yang sudah kamu tulis, dan jangan menyapa ulang — langsung sambung kalimatnya.' }]
    }];
    const cont = { ...basePayload, contents };
    // A continuation is finishing a thought it already started; it doesn't
    // need to run a fresh Google Search.
    delete cont.tools;
    return cont;
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let upstream = initialUpstream;
        let fullText = '';
        for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
          const { finishReason, accumulatedText } = await pumpOneUpstream(upstream, controller);
          fullText += accumulatedText;
          if (finishReason !== 'MAX_TOKENS') break; // real finish (STOP/SAFETY/etc.) or connection just closed
          if (round === MAX_CONTINUATIONS) break; // don't loop forever on a runaway answer
          debugLog({ provider: 'gemini', finishReason, continuationRound: round + 1 });
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'continuation_notice' }) + '\n\n'));
          const contPayload = buildContinuationPayload(initialPayload, fullText);
          let result;
          try {
            result = await attemptWithKeys(contPayload);
          } catch (e) {
            break;
          }
          if (!result || !result.upstream) break; // couldn't continue — hand back what we have rather than erroring
          upstream = result.upstream;
        }
      } finally {
        enqueueGroundingIfAny(controller);
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
    cancel() {}
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}

// Re-encode an OpenAI-compatible SSE stream (Groq / OpenRouter / Mistral all
// speak this same wire format) into the protocol the frontend expects, and
// announce which fallback provider actually answered so the UI can be
// honest about it (no vision, no Auto Browse on this turn).
//
// ctx (optional) carries what's needed to auto-continue when a chunk's
// finish_reason comes back "length" (truncated by the output-token
// ceiling) instead of "stop" (genuinely done) — the same MAX_TOKENS ->
// MAX_TOKENS-continuation idea as streamGeminiResponse, adapted to the
// OpenAI-compatible wire format. Without ctx (shouldn't normally happen)
// this just streams the one response through, same as before.
function streamOpenAICompatibleResponse(initialUpstream, providerLabel, groundingExtra, ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Fully drains one upstream SSE response. A provider's [DONE] sentinel
  // ends this round (not necessarily the whole answer — that's decided by
  // finish_reason, which arrives on an earlier chunk). Never lets one
  // malformed chunk abort the rest of the response.
  async function pumpOneUpstream(upstream, controller) {
    const reader = upstream.body.getReader();
    let buf = '';
    let finishReason = null;
    let accumulatedText = '';
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        break;
      }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        if (jsonStr === '[DONE]') {
          return { finishReason, accumulatedText };
        }
        let evt;
        try {
          evt = JSON.parse(jsonStr);
        } catch (e) {
          // malformed/partial chunk — skip it, keep reading
          continue;
        }
        const choice = evt?.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          accumulatedText += text;
          const out = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }
    return { finishReason, accumulatedText };
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'provider_notice', provider: providerLabel }) + '\n\n'));
        if (groundingExtra && (groundingExtra.sources?.length || groundingExtra.queries?.length)) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'grounding_metadata', queries: groundingExtra.queries || [], sources: groundingExtra.sources || [] }) + '\n\n'));
        }

        let upstream = initialUpstream;
        let fullText = '';
        const canContinue = !!(ctx && ctx.provider && ctx.keys && ctx.baseMessages);
        for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
          const { finishReason, accumulatedText } = await pumpOneUpstream(upstream, controller);
          fullText += accumulatedText;
          if (!canContinue || finishReason !== 'length') break; // real finish ("stop") or continuation not available
          if (round === MAX_CONTINUATIONS) break;
          debugLog({ provider: ctx.provider.key, finishReason, continuationRound: round + 1 });
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'continuation_notice' }) + '\n\n'));
          const contMessages = [
            ...ctx.baseMessages,
            { role: 'assistant', content: fullText },
            { role: 'user', content: 'Lanjutkan jawaban sebelumnya persis dari kata/kalimat terakhir yang terpotong. Jangan mengulang bagian yang sudah diberikan, jangan menyapa ulang.' }
          ];
          let next;
          try {
            next = await fetchProviderStream(ctx.provider, ctx.keys, contMessages, ctx.cappedTokens, ctx.signal);
          } catch (e) {
            break;
          }
          if (!next) break; // couldn't continue — hand back what we have rather than erroring
          upstream = next;
        }
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
    cancel() {}
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}
