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
//
// Multi-key rotation (any provider): set <PREFIX>S to a comma-separated
// list, or <PREFIX>_1.. <PREFIX>_10, or a single <PREFIX>. E.g.
// GEMINI_API_KEYS="key1,key2,key3" or GEMINI_API_KEY_1 / GEMINI_API_KEY_2 / ...
// Each key has its own daily quota, so when one key hits "quota habis"
// (HTTP 429) or is rejected (401/403), the request automatically retries
// with the next key instead of failing right away.
//
// Honest limitation: only Gemini can see images and only Gemini has Auto
// Browse (Google Search grounding) — none of the fallback providers offer
// either. If a turn includes an image, we never fall back (the other
// providers would just silently ignore the picture, which would be worse
// than a clear error). If a turn falls back to Groq/OpenRouter/Mistral, the
// frontend gets a small honest notice about which model actually answered.
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
const MAX_TOKENS_CAP = 4096;
const MAX_KEYS = 10;

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
    return streamGeminiResponse(geminiResult.upstream);
  }

  // Gemini is completely unavailable. Fall back to Groq -> OpenRouter ->
  // Mistral — but never for a turn with an image, since none of them can
  // see it (better an honest error than a reply that silently ignores the
  // picture the user asked about).
  if (!imagePresent) {
    for (const provider of FALLBACK_PROVIDERS) {
      const keys = collectKeys(provider.envPrefix);
      if (keys.length === 0) continue;
      const fbPayload = {
        model: provider.model,
        messages: toOpenAIMessages(body.messages, systemText),
        max_tokens: Math.min(body.max_tokens || 4000, MAX_TOKENS_CAP),
        stream: true
      };
      let upstream = null;
      for (const apiKey of keys) {
        try {
          const res = await fetch(provider.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...(provider.extraHeaders || {})
            },
            body: JSON.stringify(fbPayload),
            signal: req.signal
          });
          if (res.ok && res.body) { upstream = res; break; }
          const status = res.status;
          if (status !== 429 && status !== 401 && status !== 403) break;
        } catch (e) {
          if (e.name === 'AbortError') { throw e; }
          // network hiccup on this key — try the next one
        }
      }
      if (upstream) {
        return streamOpenAICompatibleResponse(upstream, provider.label);
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
function streamGeminiResponse(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';
  let finished = false;

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

  const stream = new ReadableStream({
    async pull(controller) {
      if (finished) { controller.close(); return; }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        enqueueGroundingIfAny(controller);
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      const { done, value } = chunk;
      if (done) {
        enqueueGroundingIfAny(controller);
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
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
          const out = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
        }
        if (evt?.candidates?.[0]?.finishReason) {
          finished = true;
          reader.cancel().catch(() => {});
          enqueueGroundingIfAny(controller);
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    }
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
function streamOpenAICompatibleResponse(upstream, providerLabel) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';
  let announced = false;

  const stream = new ReadableStream({
    async pull(controller) {
      if (!announced) {
        announced = true;
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'provider_notice', provider: providerLabel }) + '\n\n'));
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      const { done, value } = chunk;
      if (done) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        if (jsonStr === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        let evt;
        try {
          evt = JSON.parse(jsonStr);
        } catch (e) {
          continue;
        }
        const text = evt?.choices?.[0]?.delta?.content;
        if (text) {
          const out = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}
