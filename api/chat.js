// api/chat.js
// Server-side proxy for NAZE AI — free provider: Google Gemini API.
// API keys live only here, as server environment variables — never in the
// frontend. Get free keys (no credit card) at https://aistudio.google.com/apikey
//
// Multi-key rotation: set GEMINI_API_KEYS to a comma-separated list of up to
// 10 free keys (e.g. from 10 different Google accounts/projects). Each free
// key has its own daily quota, so when one key hits "quota habis" (HTTP 429)
// or is rejected (403), the request automatically retries with the next key
// instead of failing right away. Order is shuffled per-request so load
// spreads across all keys instead of always hammering key #1 first.
// (Backward compatible: a single GEMINI_API_KEY still works fine.)
//
// This function also translates between the Anthropic-style message format
// the frontend already sends (content blocks: text / image) and Gemini's
// native contents[]/parts[] format, then re-emits Gemini's stream as the
// same simple SSE shape the frontend already knows how to read
// ({"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}})
// — so index.html didn't need to change at all.
//
// Deploy layout expected by Vercel (repo root):
//   index.html, manifest.json, sw.js, icon-*.png, apple-touch-icon.png
//   api/chat.js   <-- this file, auto-detected as an Edge Function

export const config = { runtime: 'edge' };

// NOTE (corrected): this was briefly changed to 'gemini-2.5-flash' under the
// mistaken assumption that 'gemini-3.6-flash' wasn't a real model id — it
// actually is: a stable Gemini model Google released July 21, 2026, and it
// fully supports Google Search grounding (used below). Reverted back to
// match what was already confirmed working in this project.
const MODEL = 'gemini-3.6-flash'; // Google's current Flash-tier model (multimodal, free-tier standard usage, supports Search grounding)
const MAX_TOKENS_CAP = 4096;
const MAX_KEYS = 10;

// Collect up to 10 free API keys from env vars. Supports either:
//   GEMINI_API_KEYS = "key1,key2,key3,..."   (comma-separated, up to 10)
// or individually numbered:
//   GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... GEMINI_API_KEY_10
// plus the original single GEMINI_API_KEY for backward compatibility.
function collectApiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEYS) {
    keys.push(...process.env.GEMINI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean));
  }
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY.trim());
  for (let i = 1; i <= MAX_KEYS; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  // De-dupe while preserving order, then cap at 10.
  const unique = [...new Set(keys)].slice(0, MAX_KEYS);
  // Shuffle so different requests start with a different key (spreads load
  // across all 10 free quotas instead of always draining key #1 first).
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique;
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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const apiKeys = collectApiKeys();
  if (apiKeys.length === 0) {
    return new Response(
      JSON.stringify({ error: 'Belum ada API key Gemini di environment variables server (set GEMINI_API_KEYS atau GEMINI_API_KEY).' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Body request tidak valid.' }), { status: 400 });
  }

  // Naze Auto Browse: 'auto' (model decides on its own whether a Google
  // Search is needed — the default), 'always' (nudge it to prefer
  // searching), or 'never' (no browsing tool at all). The actual
  // decide/search/verify/cite pipeline is Google's managed grounding
  // service, not something we hand-roll — that's what actually gives
  // truthful sources instead of invented ones.
  const browseMode = ['auto', 'always', 'never'].includes(body.browseMode) ? body.browseMode : 'auto';

  let systemText = body.system ? String(body.system).slice(0, 4000) : '';
  if (browseMode === 'always' && systemText) {
    systemText += '\n\nPENTING: Untuk permintaan pengguna ini, gunakan alat Google Search minimal satu kali untuk memverifikasi jawabanmu dengan informasi terkini sebelum menjawab — kecuali permintaannya murni matematika, penulisan kreatif, atau brainstorming yang jelas tidak butuh fakta eksternal.';
  }

  const payload = {
    contents: toGeminiContents(body.messages),
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    generationConfig: { maxOutputTokens: Math.min(body.max_tokens || 4000, MAX_TOKENS_CAP) }
  };
  // Gemini API note: a request can't mix the built-in google_search tool
  // with custom function-calling tools — we don't use any, so this is safe.
  if (browseMode !== 'never') {
    payload.tools = [{ google_search: {} }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

  // Try each key in turn for a given payload. A key that's out of quota (429)
  // or rejected (403) just moves on to the next one instead of failing the
  // whole request right away — that's the point of having several free keys.
  async function attemptWithKeys(reqPayload) {
    let upstream = null, lastErrStatus = 500, lastErrDetail = '';
    for (const apiKey of apiKeys) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(reqPayload),
          // If the client hits "Stop" (or the tab closes), req.signal aborts —
          // propagate that to the Gemini call too, so we stop burning free-tier
          // quota on a response nobody is reading anymore.
          signal: req.signal
        });
        if (res.ok && res.body) { upstream = res; break; }
        lastErrStatus = res.status;
        lastErrDetail = await res.text().catch(() => '');
        // 429 = quota habis untuk key ini, 403 = key ditolak/invalid — lanjut ke key berikutnya.
        if (res.status !== 429 && res.status !== 403) break;
      } catch (e) {
        if (e.name === 'AbortError') { throw e; }
        lastErrStatus = 502;
        lastErrDetail = String(e.message || e).slice(0, 300);
        // Network-level error on this key — try the next one too.
      }
    }
    return { upstream, lastErrStatus, lastErrDetail };
  }

  let result;
  try {
    result = await attemptWithKeys(payload);
  } catch (e) {
    return new Response(null, { status: 499 });
  }

  // Fallback: if a request WITH the google_search tool fails outright (not a
  // quota issue), some free-tier / no-billing projects reject the grounding
  // tool itself even though plain chat works fine on the same key. Rather
  // than let Auto Browse break every single message (even ones that don't
  // need browsing), retry once without the tool so the chat still works —
  // just without browsing for that turn.
  let browsingFellBack = false;
  if (!result.upstream && payload.tools && result.lastErrStatus !== 429) {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.tools;
    try {
      const retryResult = await attemptWithKeys(fallbackPayload);
      if (retryResult.upstream) {
        result = retryResult;
        browsingFellBack = true;
      } else {
        // keep the original (grounded) error — it's more informative than the fallback's
      }
    } catch (e) {
      return new Response(null, { status: 499 });
    }
  }

  const { upstream, lastErrStatus, lastErrDetail } = result;

  if (!upstream) {
    const isQuota = lastErrStatus === 429;
    return new Response(
      JSON.stringify({
        error: isQuota
          ? `Semua ${apiKeys.length} API key kehabisan kuota gratis hari ini. Coba lagi nanti.`
          : 'Gemini API error',
        status: lastErrStatus,
        detail: lastErrDetail.slice(0, 400)
      }),
      { status: lastErrStatus || 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Re-encode Gemini's SSE chunks into the simple protocol the frontend expects.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';
  let finished = false; // set once Gemini reports a finishReason, so we stop as soon as we see it

  // Naze Sources: collected honestly from Gemini's own groundingMetadata —
  // never invented here. Deduped as we go (a query/source can repeat across
  // streamed chunks); queries keep first-seen order, sources keyed by URL.
  const groundingQueries = [];
  const seenQueries = new Set();
  const groundingSources = new Map(); // uri -> title

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
        // Gemini marks the last chunk of a real answer with finishReason
        // (e.g. "STOP"). Some connections keep the underlying HTTP stream
        // open for a while after this instead of closing it right away,
        // which used to leave the client's "typing" cursor spinning
        // forever. Don't wait for upstream to close on its own — end the
        // response the moment we know the answer is complete.
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
      // Client (or upstream ReadableStream consumer) stopped reading — release
      // the upstream Gemini connection instead of letting it dangle.
      reader.cancel().catch(() => {});
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}