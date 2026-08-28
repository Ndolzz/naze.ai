# NAZE AI

Aplikasi chat AI berbasis web (PWA) — mendukung teks, gambar (vision), browsing internet otomatis, dan generate gambar. Dirancang untuk di-deploy gratis sepenuhnya lewat GitHub + Vercel, tanpa server terpisah dan tanpa kartu kredit.

---

## Daftar Isi

- [Ringkasan](#ringkasan)
- [Fitur Utama](#fitur-utama)
- [Arsitektur](#arsitektur)
- [Struktur Proyek](#struktur-proyek)
- [Voice Mode](#voice-mode)
- [Provider AI & Model](#provider-ai--model)
- [Panduan Deploy](#panduan-deploy)
- [Environment Variables](#environment-variables)
- [Mengganti / Menambah Provider](#mengganti--menambah-provider)
- [Update Aplikasi](#update-aplikasi)
- [Keterbatasan](#keterbatasan)
- [Riwayat Perubahan](#riwayat-perubahan)

---

## Ringkasan

NAZE AI adalah antarmuka chat AI single-page yang bisa di-install ke homescreen (PWA), dengan riwayat percakapan tersimpan lokal di perangkat pengguna — tidak ada akun, login, atau database server. Seluruh permintaan ke penyedia AI dijalankan lewat satu fungsi backend ringan (`api/chat.js`) sehingga API key tidak pernah terekspos ke browser.

## Fitur Utama

- **Chat multimodal** — teks dan gambar (vision) lewat Google Gemini.
- **Fallback multi-provider** — jika Gemini gagal, permintaan otomatis dialihkan ke Groq, OpenRouter, atau Mistral secara bergiliran acak.
- **Naze Auto Browse** — pencarian internet otomatis (Google Search grounding di Gemini, Brave Search untuk provider cadangan), lengkap dengan kartu sumber yang bisa diklik.
- **Generate gambar** — pembuatan gambar dari teks lewat Hugging Face Inference API.
- **Voice Mode** — bicara langsung dengan Naze lewat mikrofon (Speech-to-Text) dan dengarkan jawabannya (Text-to-Speech), memakai Web Speech API bawaan browser — gratis, tanpa API key tambahan. Lihat [Voice Mode](#voice-mode).
- **PWA & offline-ready** — dapat dipasang ke homescreen, service worker dengan strategi *network-first* agar update selalu diterima saat online.
- **Auto-continue** — jawaban yang terpotong karena batas token akan otomatis disambung oleh backend, bukan dipotong begitu saja.
- **Riwayat lokal** — seluruh percakapan tersimpan di `localStorage` perangkat masing-masing pengguna.

## Arsitektur

GitHub Pages saja tidak cukup karena hanya menyajikan file statis, sedangkan NAZE AI butuh satu fungsi server (`api/chat.js`) agar API key penyedia AI tidak pernah muncul di frontend. **Vercel** dipilih karena login menggunakan akun GitHub dan mendukung auto-deploy langsung dari repo — alur kerja tetap "push ke GitHub", hanya hosting-nya yang berjalan di Vercel.

```
Browser (index.html, PWA)
        │  fetch('/api/chat')
        ▼
Vercel Serverless Function (api/chat.js)
        │  menyimpan API key sebagai environment variable
        ▼
Gemini → Groq → OpenRouter → Mistral (fallback berurutan)
Hugging Face (generate gambar, jalur terpisah)
```

## Struktur Proyek

| File / Folder                | Deskripsi                                                             |
|-------------------------------|------------------------------------------------------------------------|
| `index.html`                  | Markup halaman (single-page app) — styling & logika dipecah ke `css/` dan `js/` |
| `css/styles.css`               | Seluruh styling aplikasi                                              |
| `js/`                          | Logika frontend, dipecah per topik (bukan satu file raksasa lagi): `storage.js` (localStorage/cloud storage helper), `state.js` (state global & konstanta), `pwa.js` (service worker & install prompt), `preferences.js` (tema, aksen, toggle pengaturan), `chats.js` (daftar & manajemen chat), `utils.js` (helper umum), `markdown.js` (render markdown + highlight kode), `attachments.js` (lampiran & file), `message-render.js` (render bubble pesan & kartu sumber), `chat-engine.js` (kirim pesan, streaming, retry/continue), `events.js` (pengikatan event UI), `settings.js` (navigasi panel pengaturan, kelola memori), `auth.js` (login GitHub & profil), `main.js` (bootstrap aplikasi — **dimuat terakhir**, lihat catatan di bawah) |
| `src/voice/`                   | Layer Voice Mode (bicara dengan Naze) — lihat bagian [Voice Mode](#voice-mode) |
| `api/chat.js`                  | Serverless function — proxy aman ke semua penyedia AI                 |
| `api/auth.js`                  | Serverless function — login GitHub & profil (verifikasi token, sesi, profil) |
| `api/_lib/kv.js`               | Helper Redis (Upstash) + request, dipakai `api/auth.js`               |
| `manifest.json`                | Konfigurasi PWA (nama, ikon, warna tema)                              |
| `sw.js`                        | Service worker untuk caching & dukungan offline                       |
| `icon-192.png`, `icon-512-maskable.png`, `apple-touch-icon.png` | Ikon aplikasi untuk berbagai platform |

> **Catatan urutan pemuatan script:** semua file di `js/` dan `src/voice/` adalah *classic script* (bukan ES module), dimuat lewat tag `<script src="...">` berurutan di `index.html`, dan berbagi satu global scope yang sama (persis seperti dulu ketika masih satu file). Urutan tag `<script>` di `index.html` **harus** tetap: `storage → state → pwa → preferences → chats → utils → markdown → attachments → message-render → chat-engine → events → settings → auth → src/voice/* → main`. `main.js` (berisi bootstrap `init()`) dimuat paling akhir karena langsung memanggil fungsi-fungsi dari semua modul lain saat file itu dieksekusi.

## Voice Mode

Fitur "bicara dengan Naze" — sepenuhnya memakai Web Speech API bawaan browser (`SpeechRecognition`/`webkitSpeechRecognition` untuk input suara, `speechSynthesis` untuk membacakan jawaban). **Tidak ada API key tambahan, tidak ada layanan voice berbayar, tidak ada endpoint backend baru** — input suara hanya menghasilkan teks yang lalu dikirim lewat pipeline chat yang sama seperti mengetik manual.

| File                                   | Tanggung jawab |
|-----------------------------------------|-----------------|
| `src/voice/speech-recognition.js`       | Wrapper Speech-to-Text: `continuous`, `interimResults`, bahasa (`id-ID` default, `en-US` opsional), event `start/result/end/error/nomatch` |
| `src/voice/speech-synthesis.js`         | Wrapper Text-to-Speech: `speak()/stop()/pause()/resume()/isSpeaking()/getVoices()`, pemilihan suara otomatis (prioritas `id-ID` → `id` → `en-US` → default browser) |
| `src/voice/speech-cleaner.js`           | `cleanTextForSpeech()` — membersihkan markdown (heading, bold/italic, code block, list, link, URL, tabel, citation marker) dari jawaban AI sebelum dibacakan. **Tidak pernah mengubah pesan asli di chat** — hanya salinan sementara untuk TTS. |
| `src/voice/voice-controller.js`         | State machine (`idle → listening → processing → speaking → idle`, plus `error`/`unsupported`). Mengirim transcript final lewat `sendMessage()` yang sudah ada (bukan endpoint baru), lalu membaca balasan terakhir dari array `messages` yang sama dipakai UI chat. |
| `src/voice/voice-ui.js`                 | Tombol mikrofon di composer, panel Voice Mode, dan halaman Pengaturan → Voice Mode (Enable Voice, bahasa, pilih suara, rate/pitch/volume, Continuous Mode). Preferensi disimpan lewat helper storage yang sudah ada (`stGet`/`stSet`, key `voicePrefs`) — bukan sistem storage baru. |

**Continuous Voice Mode** (default OFF): setelah Naze selesai membacakan jawaban, mikrofon otomatis mendengarkan lagi (dengan jeda singkat supaya suara Naze sendiri tidak ikut tertangkap mikrofon). Mode ini tidak pernah otomatis mengulang saat *tidak* ada suara terdeteksi (`no-speech`/error) — itu hanya membawa status kembali ke idle, untuk mencegah loop tak berujung.

**Graceful degradation:** jika browser tidak mendukung `SpeechRecognition`, tombol mikrofon otomatis disembunyikan dan sisa aplikasi (termasuk Text-to-Speech, jika didukung) tetap berjalan normal sebagai chat teks biasa.

## Provider AI & Model

| Peran            | Provider      | Model                        | Kemampuan                              |
|-------------------|---------------|-------------------------------|-----------------------------------------|
| Utama             | Google Gemini | `gemini-3.6-flash`            | Teks, vision (gambar), Google Search grounding |
| Fallback          | Groq          | `openai/gpt-oss-120b`         | Teks saja                               |
| Fallback          | OpenRouter    | `openai/gpt-oss-120b`         | Teks saja                               |
| Fallback          | Mistral       | `mistral-small-latest`        | Teks saja                               |
| Generate gambar   | Hugging Face  | `black-forest-labs/FLUX.1-schnell` | Text-to-image, jalur terpisah dari chat |
| Web search (fallback) | Brave Search | —                          | Function-calling untuk provider cadangan |

Gemini selalu dicoba lebih dulu untuk setiap pesan karena satu-satunya provider dengan vision dan Google Search grounding native. Jika pesan menyertakan gambar dan Gemini gagal total, sistem menampilkan error yang jelas alih-alih diam-diam mengirim ke provider lain tanpa kemampuan vision.

## Login dengan GitHub & Profil

NAZE AI punya login sungguhan (bukan sekadar simpan nama di `localStorage`): verifikasi identitas dilakukan GitHub, sesi disimpan di server (Redis) lewat cookie `httpOnly`, dan JavaScript di halaman tidak pernah bisa membaca atau memalsukan cookie sesi itu.

Dipilih GitHub OAuth (bukan Google) karena **100% gratis tanpa tahap billing sama sekali** — membuat OAuth App di GitHub tidak pernah meminta kartu, dan tidak ada biaya berapa pun jumlah user yang login.

Alur singkatnya (authorization code flow standar OAuth2):
1. Klik "Login dengan GitHub" (di panel **Akun**) → browser di-redirect penuh ke halaman approve GitHub.
2. Pengguna approve di GitHub → GitHub redirect balik ke `/api/auth?action=github_callback` membawa kode otorisasi.
3. **Server** (bukan browser) menukar kode itu jadi access token ke GitHub — pertukaran ini butuh `GITHUB_CLIENT_SECRET` yang **tidak pernah dikirim ke browser** dalam bentuk apa pun.
4. Server ambil profil GitHub pakai token itu, lalu **buang tokennya** (tidak disimpan) — bikin sesi acak 256-bit di Redis, kirim cookie `httpOnly; Secure; SameSite=Lax`, redirect balik ke NAZE.
5. Login pertama kali: profil belum punya nama, jadi panel Akun otomatis meminta nama tampilan sebelum disimpan.

### Yang perlu disiapkan

| Variabel | Wajib | Rahasia? | Fungsi |
|---|:---:|:---:|---|
| `GITHUB_CLIENT_ID` | Ya | Tidak — aman ditempel di frontend | Identitas publik OAuth App |
| `GITHUB_CLIENT_SECRET` | Ya | **Ya — jangan pernah expose ke frontend** | Dipakai server untuk menukar kode → access token |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Ya | Token-nya iya | Penyimpanan sesi & profil — wajib untuk login (beda dari pemakaiannya di rate limiting `/api/chat`, yang opsional). Sesi login butuh state persisten, bukan in-memory |

### Langkah setup (semuanya gratis, tanpa kartu di titik mana pun)

1. Buka **[github.com/settings/developers](https://github.com/settings/developers) → OAuth Apps → New OAuth App**.
2. Isi:
   - **Application name**: bebas, mis. `NAZE AI`
   - **Homepage URL**: `https://naze-xxxx.vercel.app` (domain deploy kamu)
   - **Authorization callback URL**: `https://naze-xxxx.vercel.app/api/auth?action=github_callback` — **harus persis sama** dengan ini (GitHub hanya menerima satu callback URL per OAuth App, beda dari Google yang boleh banyak origin).
3. **Register application** → salin **Client ID** yang muncul → jadi env var `GITHUB_CLIENT_ID` di Vercel.
4. Klik **Generate a new client secret** → salin (hanya muncul sekali) → jadi env var `GITHUB_CLIENT_SECRET` di Vercel (env var server, **jangan** yang diawali `NEXT_PUBLIC_`/`VITE_`/dsb kalau suatu saat pakai framework — di setup statis ini otomatis aman karena hanya dibaca `api/auth.js`).
5. Redeploy.

Kalau kamu ganti domain (custom domain, atau branch preview Vercel yang URL-nya beda), Authorization callback URL di pengaturan GitHub OAuth App juga harus diupdate — GitHub akan menolak callback yang URL-nya tidak persis cocok.

Kalau `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` atau Upstash belum diisi, panel Akun akan bilang jujur "fitur login belum dikonfigurasi" — bukan pura-pura berhasil lalu gagal diam-diam.

### Kenapa ini bukan gimmick

- `client_secret` cuma pernah ada di server (`api/auth.js`), tidak pernah ikut terkirim ke browser dalam bentuk apa pun — pertukaran kode→token murni request server-ke-server ke GitHub.
- Alur callback dilindungi nonce `state` acak (cookie sekali-pakai, kedaluwarsa 10 menit) — mencegah orang lain memicu login palsu lewat link yang disusupkan.
- Sesi memakai cookie `httpOnly` (JavaScript halaman tidak bisa membacanya sama sekali, apalagi memalsukannya) + `Secure` + `SameSite=Lax`, disimpan di Redis dengan id acak 256-bit — bukan token yang bisa ditebak.
- Profil (nama tampilan) disimpan terpisah dari sesi, dikunci ke id akun GitHub yang permanen — logout atau sesi kedaluwarsa tidak menghapus profil.
- Endpoint `/api/auth` ikut lapisan hardening yang sama seperti `/api/chat`: rate limiting per-IP dan validasi input server-side (validasi Origin diterapkan ke aksi POST; endpoint callback GET sengaja tidak dicek Origin karena memang navigasi lintas-situs dari github.com by design — proteksinya nonce `state`, bukan Origin).

## Panduan Deploy

### 1. Buat Repo GitHub
Buat repository baru (misalnya `naze-ai`) dan upload seluruh isi folder ini ke root repo, termasuk folder `api/`.

### 2. Ambil API Key Gemini
1. Buka [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Login dengan akun Google → **Create API Key**
3. Salin key tersebut. Jangan pernah menaruhnya di file apa pun yang di-upload ke GitHub.

### 3. Deploy ke Vercel
1. Buka [vercel.com](https://vercel.com) → **Sign up / Log in with GitHub**
2. **Add New → Project**, pilih repo `naze-ai`
3. Di bagian **Environment Variables**, tambahkan:

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | API key dari langkah 2 |

4. Klik **Deploy** dan tunggu kurang lebih 1 menit.

### 4. Selesai
Vercel akan memberikan URL seperti `https://naze-ai-xxxx.vercel.app` dengan HTTPS otomatis. Buka di Chrome Android untuk memasang aplikasi ke homescreen lewat tombol **"Pasang Aplikasi"** di sidebar.

## Environment Variables

Semua variabel bersifat opsional kecuali `GEMINI_API_KEY`. Setiap variabel mendukung tiga format penulisan yang setara — satu key polos, penomoran (`_1`, `_2`, dst.), atau daftar dipisah koma (`...S`) — untuk keperluan multi-key/load-balancing.

| Variabel            | Wajib | Fungsi                                  | Dapatkan di |
|----------------------|:---:|-------------------------------------------|-------------|
| `GEMINI_API_KEY`      | Ya  | Provider utama (teks, vision, browsing)   | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GROQ_API_KEY`        | Tidak | Fallback teks                           | [console.groq.com/keys](https://console.groq.com/keys) |
| `OPENROUTER_API_KEY`  | Tidak | Fallback teks                           | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `MISTRAL_API_KEY`     | Tidak | Fallback teks                           | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| `HF_API_KEY`          | Tidak | Generate gambar                         | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) |
| `BRAVE_API_KEY`       | Tidak | Web search untuk provider fallback      | [api.search.brave.com/app/keys](https://api.search.brave.com/app/keys) |
| `UPSTASH_REDIS_REST_URL` | Tidak | Rate limiting server-side yang konsisten di semua region Vercel Edge | [console.upstash.com](https://console.upstash.com) (Redis database → "REST API") |
| `UPSTASH_REDIS_REST_TOKEN` | Tidak | Pasangan token untuk `UPSTASH_REDIS_REST_URL` di atas | sama seperti di atas |

Variabel yang tidak diisi otomatis dianggap tidak tersedia dan fitur terkait dilewati tanpa error.

### Rate limiting: kenapa `UPSTASH_REDIS_REST_URL` opsional tapi disarankan

`/api/chat` membatasi jumlah request per IP (per menit, per beberapa detik "burst", dan jumlah request yang berjalan bersamaan) sepenuhnya di backend — ini berlaku sama persis baik dipanggil dari aplikasi NAZE maupun langsung lewat curl/Postman/script lain.

- **Dengan `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`** (gratis, tanpa kartu kredit, di [upstash.com](https://upstash.com)): penghitung rate limit tersimpan di Redis, konsisten di semua lokasi Edge Vercel — abuse dari satu IP akan benar-benar terblokir di mana pun request itu mendarat.
- **Tanpa keduanya**: NAZE tetap membatasi request, tapi memakai penghitung in-memory yang hanya "hidup" selama satu instance Edge tertentu masih warm — cukup untuk menghentikan satu script yang menghajar endpoint dari satu titik, tapi tidak terkoordinasi lintas region. Untuk deployment publik yang benar-benar tahan abuse, disarankan mengisi kedua variabel ini.

## Mengganti / Menambah Provider

Karena seluruh logika pemanggilan AI terpusat di `api/chat.js`, mengganti atau menambah provider cukup dilakukan di satu file tersebut tanpa menyentuh frontend sama sekali.

## Update Aplikasi

Setiap `git push` ke GitHub akan memicu re-deploy otomatis di Vercel — tidak perlu konfigurasi ulang.

## Keterbatasan

- File dokumen (`pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`) belum diekstrak isinya di browser; NAZE akan memberi tahu keterbatasan ini secara terbuka, bukan berpura-pura sudah membacanya.
- Model dan `max_tokens` dikunci di `api/chat.js` sehingga permintaan dari frontend tidak bisa memalsukan model atau menyedot kuota berlebihan.
- Tier gratis semua provider tidak memiliki jaminan SLA — bisa lebih lambat atau terkena limit pada jam sibuk. Cocok untuk proyek pribadi/skala kecil, bukan beban produksi besar.
- Deteksi kebutuhan browsing pada provider fallback menggunakan function-calling standar (bukan grounding native seperti Gemini), sehingga keandalannya tetap tergantung keputusan model.
- Gambar hasil generate disimpan penuh (base64) di `localStorage`, sama seperti foto yang diunggah pengguna — penggunaan intensif dapat mempercepat penyimpanan lokal menjadi penuh.

## Riwayat Perubahan

**Struktur proyek & Voice Mode (terbaru)**
- `index.html` dipecah dari satu file raksasa menjadi `index.html` + `css/styles.css` + 14 modul `js/*.js` per topik, agar lebih mudah dikelola untuk update-update besar berikutnya. Perilaku aplikasi tidak berubah — hanya lokasi kodenya.
- **Voice Mode**: fitur baru untuk bicara dengan Naze lewat mikrofon dan mendengarkan jawabannya, 100% pakai Web Speech API bawaan browser (gratis, tanpa API key tambahan, tanpa endpoint backend baru). Lihat [Voice Mode](#voice-mode).

**Stabilitas streaming**
- Perbedaan antara jawaban yang benar-benar selesai dan yang terpotong batas token kini ditangani dengan benar — backend otomatis mengirim permintaan lanjutan (maksimal 3x) alih-alih memotong jawaban begitu saja.
- Batas toleransi jeda tanpa token baru dinaikkan (20 detik untuk Gemini, 35 detik untuk provider fallback) agar jawaban tidak terpotong saat model sedang browsing atau berpikir lama.
- Parser SSE untuk kedua jenis provider dibuat lebih tahan terhadap chunk yang gagal di-parse.

**Naze Auto Browse**
- Pencarian internet otomatis lewat Google Search grounding (Gemini) dan Brave Search function-calling (provider fallback), dengan tiga mode: Auto, Always, dan Off.
- Kartu sumber (**Naze Sources**) menampilkan link dan ringkasan query asli dari hasil pencarian, tanpa ada yang dikarang di frontend/backend.

**Fallback multi-provider**
- Urutan provider cadangan (Groq, OpenRouter, Mistral) diacak setiap permintaan agar beban terbagi merata.
- Pesan bergambar tidak dialihkan ke provider fallback yang tidak mendukung vision — sistem menampilkan error yang jelas, bukan mengabaikan gambar secara diam-diam.

**Generate gambar**
- Fitur pembuatan gambar lewat Hugging Face FLUX.1-schnell, berjalan independen dari alur chat/Auto Browse.

**Performa**
- Riwayat chat yang dikirim ke AI dipangkas (±12 giliran terakhir, maksimal 3 gambar terbaru dengan data penuh) untuk mempercepat respons dan menghemat kuota harian, tanpa memengaruhi riwayat lengkap yang tersimpan di perangkat.
- Render Markdown dan syntax-highlighting digabung maksimal sekali per frame layar saat streaming, alih-alih diproses ulang di setiap potongan teks yang masuk.
- Pencarian riwayat chat di sidebar menggunakan debounce (±250ms).
- Kompresi otomatis untuk gambar berukuran besar (>1.2MB) sebelum diunggah.

**Perbaikan lain**
- Service worker kini mengarah ke file yang benar dan menggunakan strategi network-first agar update selalu terdeteksi saat online.
- Auto-scroll hanya aktif jika posisi pengguna memang sudah berada di dekat bagian bawah percakapan.
- Baris baru pada pesan pengguna (Shift+Enter) kini tampil sesuai format aslinya.
- Tautan pada jawaban AI dibuka dengan `rel="noopener noreferrer"` untuk mencegah celah reverse-tabnabbing.
- Seluruh ikon emoji diganti menjadi SVG kustom agar tampilan konsisten di semua perangkat.
