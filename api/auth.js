// api/auth.js
// Login "beneran" pakai GitHub OAuth — 100% gratis, tidak ada tahap billing
// di GitHub sama sekali untuk membuat OAuth App maupun untuk pengguna login.
// Bukan gimmick localStorage: identitas diverifikasi GitHub sendiri, sesi
// disimpan di server (Redis) lewat cookie httpOnly yang tak bisa dibaca
// atau dipalsukan JavaScript halaman.
//
// Alurnya (authorization code flow standar OAuth2, BUKAN implicit/token
// flow, supaya client_secret tidak pernah menyentuh browser sama sekali):
//
//   1. Frontend menaruh nonce acak (`state`) di cookie sekali-pakai, lalu
//      mengarahkan browser (full-page redirect, bukan fetch) ke
//      github.com/login/oauth/authorize dengan client_id (publik) & state.
//   2. Pengguna login/approve di GitHub. GitHub redirect balik ke
//      redirect_uri kita (`/api/auth?action=github_callback`) membawa
//      `code` + `state` yang sama.
//   3. Handler ini (server) mencocokkan `state` dengan cookie nonce tadi
//      (proteksi CSRF), lalu menukar `code` -> access_token ke GitHub
//      lewat request SERVER-KE-SERVER yang menyertakan client_secret —
//      secret ini TIDAK PERNAH dikirim ke browser dalam bentuk apa pun.
//   4. Access_token dipakai sekali untuk ambil profil GitHub (`/user`,
//      `/user/emails`), lalu DIBUANG — tidak disimpan.
//   5. Server bikin sesi sendiri (id acak 256-bit) di Redis dan mengirim
//      cookie httpOnly+Secure+SameSite=Lax, lalu redirect balik ke `/`.
//   6. Profil (nama tampilan) disimpan terpisah dari sesi, dikunci ke id
//      akun GitHub (angka permanen) — logout/sesi kedaluwarsa tidak
//      menghapus profil yang sudah diisi.
//
// SYARAT AGAR FITUR INI MENYALA (lihat README bagian "Login & Profil"):
//   GITHUB_CLIENT_ID              wajib — publik, aman ditempel di frontend
//   GITHUB_CLIENT_SECRET          wajib — RAHASIA, hanya dipakai di sini,
//                                  jangan pernah expose ke frontend
//   UPSTASH_REDIS_REST_URL/TOKEN  wajib — sesi & profil butuh state yang
//                                  benar-benar persisten lintas request,
//                                  bukan in-memory (serverless = stateless
//                                  per request/region). Tanpa ini endpoint
//                                  menjawab 501 yang jujur, bukan pura-pura
//                                  berhasil.
//
// GitHub OAuth App hanya menerima SATU "Authorization callback URL" persis
// (beda dari Google yang boleh banyak origin) — daftarkan persis:
//   https://<domain-deploy-kamu>/api/auth?action=github_callback

export const config = { runtime: 'edge' };

import { HAS_KV, kvGetJSON, kvSetJSON, kvDel, kvIncrWithWindow, clientIp, isAllowedOrigin, parseCookies, newSessionId } from './_lib/kv.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const AUTH_AVAILABLE = HAS_KV && !!GITHUB_CLIENT_ID && !!GITHUB_CLIENT_SECRET;

const SESSION_COOKIE = 'naze_session';
const STATE_COOKIE = 'naze_oauth_state';
const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 hari
const STATE_TTL_SECONDS = 10 * 60; // 10 menit — nonce sekali pakai untuk OAuth callback
const MAX_NAME_LEN = 60;

// Rate limit khusus endpoint auth — jauh lebih ketat dari /api/chat karena
// tidak ada alasan legit untuk login/callback berkali-kali per menit.
const AUTH_RATE = { windowMs: 60_000, windowMax: 20 };

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) }
  });
}

function sessionCookieHeader(sessionId, maxAgeSeconds) {
  return [`${SESSION_COOKIE}=${sessionId}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`].join('; ');
}
function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function stateCookieHeader(state) {
  // Nonce anti-CSRF sekali pakai. Tidak httpOnly karena JS di frontend yang
  // menaruhnya sebelum redirect — bukan data rahasia, cuma nilai yang harus
  // "cocok" dengan yang dikirim balik GitHub.
  return [`${STATE_COOKIE}=${state}`, 'Path=/', 'Secure', 'SameSite=Lax', `Max-Age=${STATE_TTL_SECONDS}`].join('; ');
}
function clearStateCookieHeader() {
  return `${STATE_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
}

async function getSessionSub(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const session = await kvGetJSON(`naze:session:${sid}`);
  if (!session || !session.sub) return null;
  return { sub: session.sub, sid };
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    name: profile.name || profile.providerName || profile.providerLogin || '',
    providerName: profile.providerName || '',
    providerLogin: profile.providerLogin || '',
    email: profile.email || '',
    picture: profile.picture || '',
    needsName: !profile.name
  };
}

// Tukar authorization code -> access token. Server-ke-server, client_secret
// disertakan di body request, tidak pernah terlihat oleh browser.
async function exchangeGithubCode(code, redirectUri) {
  let res;
  try {
    res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri })
    });
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) return { ok: false, reason: 'http_' + res.status };
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, reason: 'bad_json' };
  // GitHub sering balas 200 OK tapi body-nya {"error":"bad_verification_code", ...}
  // saat client_id/client_secret/redirect_uri tidak cocok dengan yang dipakai
  // di /authorize sebelumnya, atau code sudah kedaluwarsa/dipakai ulang.
  if (data.error) return { ok: false, reason: data.error };
  if (!data.access_token) return { ok: false, reason: 'no_token_in_response' };
  return { ok: true, accessToken: data.access_token };
}

async function fetchGithubUser(accessToken) {
  // GitHub API mewajibkan User-Agent, kalau tidak ada akan ditolak 403.
  const headers = { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'naze-ai-login', Accept: 'application/vnd.github+json' };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) return null;
  const user = await userRes.json().catch(() => null);
  if (!user || !user.id) return null;

  let email = user.email || '';
  if (!email) {
    // Banyak akun GitHub menyembunyikan email publiknya — ambil email utama
    // yang sudah terverifikasi lewat endpoint terpisah (butuh scope user:email).
    try {
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
      if (emailsRes.ok) {
        const emails = await emailsRes.json().catch(() => []);
        const pick = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)) : null;
        if (pick) email = pick.email;
      }
    } catch (e) { /* email opsional, biarkan kosong kalau gagal */ }
  }

  return { id: String(user.id), login: user.login || '', name: user.name || user.login || '', email, picture: user.avatar_url || '' };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // ---- GET: status login, atau callback redirect dari GitHub -----------
  if (req.method === 'GET') {
    if (action === 'github_callback') {
      return handleGithubCallback(req, url);
    }

    if (!AUTH_AVAILABLE) {
      return json({ authAvailable: false, loggedIn: false, githubClientId: null }, 200);
    }
    const session = await getSessionSub(req).catch(() => null);
    if (!session) {
      return json({ authAvailable: true, loggedIn: false, githubClientId: GITHUB_CLIENT_ID }, 200);
    }
    const profile = await kvGetJSON(`naze:user:${session.sub}`);
    if (!profile) {
      return json({ authAvailable: true, loggedIn: false, githubClientId: GITHUB_CLIENT_ID }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
    }
    return json({ authAvailable: true, loggedIn: true, githubClientId: GITHUB_CLIENT_ID, profile: publicProfile(profile) }, 200);
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Endpoint JSON (POST) hanya boleh dipanggil fetch() dari origin sendiri.
  // (GET callback di atas SENGAJA tidak kena cek ini — itu navigasi
  // cross-site yang memang datang dari github.com by design; proteksinya
  // memakai nonce `state`, bukan Origin header.)
  if (!isAllowedOrigin(req)) {
    return json({ error: 'Origin tidak diizinkan.' }, 403);
  }

  if (!AUTH_AVAILABLE) {
    return json({
      error: HAS_KV
        ? 'GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET belum diisi di environment variables server.'
        : 'Fitur login belum dikonfigurasi di server (UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN belum diisi — sesi login butuh penyimpanan persisten, bukan in-memory).'
    }, 501);
  }

  const ip = clientIp(req);
  let windowCount = 0;
  try {
    windowCount = await kvIncrWithWindow(`naze:auth:win:${ip}`, AUTH_RATE.windowMs);
  } catch (e) {
    return json({ error: 'Layanan login sedang bermasalah, coba lagi sebentar.' }, 503);
  }
  if (windowCount > AUTH_RATE.windowMax) {
    return json({ error: 'Terlalu banyak percobaan. Coba lagi sebentar lagi.' }, 429, { 'Retry-After': '30' });
  }

  let body;
  try {
    const rawText = await req.text();
    if (new TextEncoder().encode(rawText).length > 4096) return json({ error: 'Request terlalu besar.' }, 400);
    body = rawText ? JSON.parse(rawText) : {};
  } catch (e) {
    return json({ error: 'Body request tidak valid (bukan JSON).' }, 400);
  }

  const postAction = body && body.action;

  const session = await getSessionSub(req);
  if (!session) {
    return json({ error: 'Belum login.' }, 401);
  }

  if (postAction === 'update_profile') {
    let name = body && body.name;
    if (typeof name !== 'string') return json({ error: 'Field "name" harus berupa teks.' }, 400);
    name = name.trim().replace(/[\r\n\t]+/g, ' ').slice(0, MAX_NAME_LEN);
    if (!name) return json({ error: 'Nama tidak boleh kosong.' }, 400);

    const userKey = `naze:user:${session.sub}`;
    const existing = await kvGetJSON(userKey);
    if (!existing) return json({ error: 'Profil tidak ditemukan.' }, 404);
    const profile = { ...existing, name, updatedAt: new Date().toISOString() };
    await kvSetJSON(userKey, profile, 0);
    return json({ profile: publicProfile(profile) }, 200);
  }

  if (postAction === 'logout') {
    await kvDel(`naze:session:${session.sid}`);
    return json({ loggedIn: false }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
  }

  return json({ error: 'Nilai "action" tidak dikenali.' }, 400);
}

async function handleGithubCallback(req, url) {
  const redirectUri = `${url.origin}/api/auth?action=github_callback`;

  function redirectHome(status, extraSetCookies) {
    const headers = new Headers();
    headers.set('Location', `${url.origin}/?login=${status}`);
    headers.append('Set-Cookie', clearStateCookieHeader());
    (extraSetCookies || []).forEach((c) => headers.append('Set-Cookie', c));
    return new Response(null, { status: 302, headers });
  }

  if (!AUTH_AVAILABLE) return redirectHome('unavailable');

  const ip = clientIp(req);
  try {
    const windowCount = await kvIncrWithWindow(`naze:auth:win:${ip}`, AUTH_RATE.windowMs);
    if (windowCount > AUTH_RATE.windowMax) return redirectHome('rate_limited');
  } catch (e) {
    return redirectHome('kv_error_' + String((e && e.message) || e).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40));
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  const expectedState = cookies[STATE_COOKIE];

  // GitHub sendiri bisa menolak duluan (redirect_uri mismatch, dsb) dan
  // memanggil callback ini dengan ?error=... alih-alih ?code=... — deteksi
  // itu secara eksplisit supaya pesannya jelas, bukan ikut jatuh ke "no_code".
  const githubError = url.searchParams.get('error');
  if (githubError) return redirectHome('github_denied_' + githubError);

  if (!code || !state) return redirectHome('no_code_or_state');
  if (!expectedState) return redirectHome('state_cookie_missing');
  if (state !== expectedState) return redirectHome('state_mismatch');

  const exchange = await exchangeGithubCode(code, redirectUri);
  if (!exchange.ok) return redirectHome('exchange_failed_' + exchange.reason);

  const ghUser = await fetchGithubUser(exchange.accessToken);
  if (!ghUser) return redirectHome('profile_fetch_failed');

  const sub = `github:${ghUser.id}`;
  const userKey = `naze:user:${sub}`;
  const existing = await kvGetJSON(userKey);
  const now = new Date().toISOString();
  const profile = existing
    ? { ...existing, email: ghUser.email, providerName: ghUser.name, providerLogin: ghUser.login, picture: ghUser.picture, updatedAt: now }
    : { sub, email: ghUser.email, providerName: ghUser.name, providerLogin: ghUser.login, picture: ghUser.picture, name: '', createdAt: now, updatedAt: now };
  await kvSetJSON(userKey, profile, 0); // profil tidak kedaluwarsa

  const sid = newSessionId();
  await kvSetJSON(`naze:session:${sid}`, { sub, createdAt: now }, SESSION_TTL_SECONDS);

  return redirectHome('success', [sessionCookieHeader(sid, SESSION_TTL_SECONDS)]);
}
