// api/chat.js
// Server-side proxy for NAZE AI — free provider: Google Gemini API.
// The Gemini API key lives only here, in the GEMINI_API_KEY environment
// variable — never in the frontend. Get a free key (no credit card) at
// https://aistudio.google.com/apikey
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

const MODEL = 'gemini-3.6-flash'; // free-tier, multimodal (text + vision)
const MAX_TOKENS_CAP = 4096;

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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'GEMINI_API_KEY belum diset di environment variables server.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Body request tidak valid.' }), { status: 400 });
  }

  const payload = {
    contents: toGeminiContents(body.messages),
    systemInstruction: body.system ? { parts: [{ text: String(body.system).slice(0, 4000) }] } : undefined,
    generationConfig: { maxOutputTokens: Math.min(body.max_tokens || 4000, MAX_TOKENS_CAP) }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      // If the client hits "Stop" (or the tab closes), req.signal aborts —
      // propagate that to the Gemini call too, so we stop burning free-tier
      // quota on a response nobody is reading anymore.
      signal: req.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      return new Response(null, { status: 499 });
    }
    return new Response(
      JSON.stringify({ error: 'Tidak bisa menghubungi Gemini API.', detail: String(e.message || e).slice(0, 300) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return new Response(
      JSON.stringify({ error: 'Gemini API error', status: upstream.status, detail: detail.slice(0, 400) }),
      { status: upstream.status || 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Re-encode Gemini's SSE chunks into the simple protocol the frontend expects.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';

  const stream = new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
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
        const parts = evt?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p.text || '').join('');
        if (text) {
          const out = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(out) + '\n\n'));
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

