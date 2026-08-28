// api/_lib/kv.js
// Helper Redis (Upstash REST) + request untuk fitur login/profil di
// api/auth.js. Sengaja dipisah dari api/chat.js dan TIDAK saling
// mengimpor apa pun dari sana — supaya menambah fitur login ini nol risiko
// terhadap chat.js yang sudah diaudit & di-harden sebelumnya.
//
// Login butuh state yang benar-benar persisten lintas request/region
// (siapa login, profil apa) — beda dengan rate limiting di chat.js yang
// boleh degradasi ke in-memory. Untuk sesi login, in-memory TIDAK cukup
// (Vercel Edge Function stateless per-request/region), jadi Upstash Redis
// WAJIB dikonfigurasi (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
// agar fitur login menyala. Tanpa itu, api/auth.js akan menjawab 501 yang
// jujur, bukan pura-pura berhasil.

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const HAS_KV = !!(UPSTASH_URL && UPSTASH_TOKEN);

async function pipeline(commands) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('upstash_error_' + res.status);
  return res.json();
}

export async function kvGetJSON(key) {
  if (!HAS_KV) return null;
  const [res] = await pipeline([['GET', key]]);
  const raw = res && res.result;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function kvSetJSON(key, value, ttlSeconds) {
  if (!HAS_KV) return false;
  const cmd = ttlSeconds ? [['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]] : [['SET', key, JSON.stringify(value)]];
  await pipeline(cmd);
  return true;
}

export async function kvDel(key) {
  if (!HAS_KV) return false;
  await pipeline([['DEL', key]]);
  return true;
}

// Fixed-window rate limit counter, murni via Redis (tanpa fallback
// in-memory) — cukup untuk endpoint auth yang trafiknya jauh lebih jarang
// dari /api/chat, dan kalau Upstash memang tidak ada, seluruh fitur login
// sudah nonaktif duluan (lihat HAS_KV di api/auth.js), jadi baris ini tidak
// pernah dipanggil tanpa Upstash.
export async function kvIncrWithWindow(key, windowMs) {
  const [incrRes] = await pipeline([['INCR', key], ['PEXPIRE', key, String(windowMs), 'NX']]);
  const count = Number(incrRes && incrRes.result);
  return Number.isFinite(count) ? count : 1;
}

// Sama seperti clientIp() di api/chat.js: hitung dari KANAN pada
// X-Forwarded-For (bukan dari kiri, yang bisa dipalsukan klien) karena tiap
// hop tepercaya (Vercel Edge) MENAMBAHKAN IP-nya sendiri di ujung kanan.
const TRUSTED_PROXY_HOPS = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10) || 1);
export function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - TRUSTED_PROXY_HOPS);
      return parts[idx] || parts[parts.length - 1] || 'unknown';
    }
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

// Sama seperti isAllowedOrigin() di api/chat.js — tolak fetch() lintas-situs
// dari browser (Origin ada tapi host beda), izinkan request tanpa header
// Origin sama sekali (curl/script).
export function isAllowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const selfHost = req.headers.get('host');
    return !selfHost || originHost === selfHost;
  } catch (e) {
    return false;
  }
}

export function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function newSessionId() {
  try { return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''); } // 256-bit-ish, unguessable
  catch (e) { return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12); }
}
