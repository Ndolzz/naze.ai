# NAZE AI — Panduan Deploy (GitHub + Vercel, 100% Gratis)

Folder ini sudah lengkap dan siap deploy: `index.html`, `manifest.json`, `sw.js`, ikon, dan `api/chat.js` (server proxy ke Gemini yang menyimpan API key dengan aman).

## Provider AI: Google Gemini API (gratis)
- Tidak perlu kartu kredit — cukup akun Google.
- Model: `gemini-3.6-flash` — mendukung teks **dan gambar (vision)**.
- Free tier saat ini kira-kira **1.500 request/hari**. Batas free tier bisa berubah sewaktu-waktu dari sisi Google — cek angka terbaru di https://ai.google.dev sebelum mengandalkannya untuk trafik besar.

## Kenapa tidak cukup GitHub Pages saja?
GitHub Pages hanya bisa menyajikan file statis — tidak bisa menjalankan kode server. NAZE AI butuh 1 fungsi server kecil (`api/chat.js`) supaya API key Gemini tidak pernah muncul di frontend (kalau ditaruh di frontend, siapa saja bisa mengambil dan memakainya). **Vercel** login-nya pakai akun GitHub kamu dan auto-deploy dari repo — alurnya tetap "push ke GitHub", cuma hosting-nya di Vercel.

## Langkah-langkah

**1. Buat repo GitHub**
- Buat repo baru, misalnya `naze-ai`.
- Upload semua isi folder ini ke root repo (termasuk folder `api/` dan file `index.html`).

**2. Ambil API key Gemini (gratis)**
- Buka https://aistudio.google.com/apikey
- Login dengan akun Google → **Create API Key**.
- Salin key-nya. Jangan taruh di file apapun yang di-upload ke GitHub.

**3. Deploy lewat Vercel**
- Buka https://vercel.com → **Sign up / Log in with GitHub**.
- Klik **Add New → Project**, pilih repo `naze-ai`.
- Di bagian **Environment Variables**, tambahkan:
  - Name: `GEMINI_API_KEY`
  - Value: *(tempel API key dari langkah 2)*
- Klik **Deploy**. Tunggu ±1 menit.

**4. Selesai**
- Vercel akan kasih URL seperti `https://naze-ai-xxxx.vercel.app` — HTTPS otomatis.
- Buka di HP Android via Chrome → tombol **"Pasang Aplikasi"** muncul di sidebar untuk install ke homescreen.
- Riwayat chat tersimpan di `localStorage` browser masing-masing pengguna.

## Update aplikasi nanti
Setiap `git push` ke GitHub, Vercel otomatis re-deploy — tidak perlu setting ulang.

## Kalau kuota gratis Gemini habis / mau ganti provider
Karena arsitekturnya sudah dipisah lewat `api/chat.js`, kamu tinggal ganti isi file itu tanpa menyentuh frontend sama sekali. Provider gratis lain yang bisa jadi cadangan (per Agustus 2026):
- **Groq** — sangat cepat, gratis, tapi teks saja (tidak ada vision).
- **OpenRouter** — punya beberapa model gratis (Llama, DeepSeek, Qwen, dll), satu API key untuk banyak model.
- **Mistral La Plateforme** — tier gratis untuk teks.

Cek dokumentasi resmi masing-masing sebelum pindah, karena kuota & syarat tier gratis bisa berubah kapan saja.

## Update terbaru (perbaikan bug + ikon custom)
- **Bug offline/cache diperbaiki:** `sw.js` sebelumnya mencoba menyimpan file `naze-ai.html` yang tidak pernah ada (file sebenarnya `index.html`), sehingga service worker gagal ter-install total dan mode offline tidak pernah benar-benar aktif. Sekarang sudah mengarah ke file yang benar.
- **Bug "update tidak muncul" diperbaiki:** strategi cache app shell diganti dari cache-first menjadi network-first (dengan cache sebagai fallback offline), supaya setiap kali kamu `git push` dan Vercel re-deploy, pengguna langsung dapat versi terbaru saat online — tidak nyangkut di versi lama.
- Nomor versi cache dinaikkan (`v1` → `v2`) supaya cache lama yang rusak otomatis dibersihkan di perangkat pengguna.
- **Semua ikon emoji diganti jadi SVG custom** (kartu saran, menu lampiran, tombol tutup panel, toggle tema, tombol hapus riwayat, ikon lampiran, tombol Deep, dsb.) — supaya tampilannya konsisten di semua HP, tidak berubah-ubah tergantung font emoji bawaan keyboard/OS masing-masing.
- Panel "Tentang NAZE AI" kini mencantumkan info pembuat.
- **Bug performa streaming diperbaiki:** jawaban AI sebelumnya di-render ulang total (parse Markdown + syntax-highlight semua blok kode dari nol) di setiap potongan teks yang masuk saat streaming, bikin jawaban panjang/berisi kode terasa patah-patah. Sekarang render digabung maksimal sekali per frame layar.
- **Bug auto-scroll diperbaiki:** dulu layar dipaksa scroll ke bawah tiap ada teks baru dari AI, jadi kalau kamu scroll ke atas baca chat lama saat AI masih ngetik, ketarik paksa ke bawah. Sekarang auto-scroll cuma jalan kalau posisi kamu memang sudah di dekat bawah.
- **Bug riwayat panjang diperbaiki:** seluruh riwayat chat (termasuk semua gambar lama dalam base64 penuh) sebelumnya dikirim ulang ke Gemini di setiap pesan baru, jadi makin panjang chat makin lambat & makin boros kuota gratis harian. Sekarang hanya ~12 giliran percakapan terakhir yang dikirim sebagai konteks, dan hanya 3 gambar paling baru yang dikirim data penuhnya — riwayat lengkap tetap tersimpan utuh di perangkat, cuma yang dikirim ke AI yang dipangkas.
- **Bug bubble chat diperbaiki:** pesan yang kamu ketik dengan baris baru (Shift+Enter) sebelumnya tampil menyatu jadi satu baris di bubble kamu sendiri — CSS bubble belum diatur untuk mempertahankan `\n`. Sekarang baris baru tetap tampil seperti yang kamu ketik.
- **Bug keamanan kecil diperbaiki:** link yang muncul di jawaban AI dibuka via `target="_blank"` tanpa `rel="noopener noreferrer"`, celah kecil (reverse-tabnabbing) di mana halaman tujuan bisa memanipulasi tab NAZE yang masih terbuka. Sudah ditambahkan.

## Update performa besar
- **Debounce pencarian chat** — pencarian di sidebar sekarang delay ~250ms, tidak render ulang di setiap huruf yang diketik.
- **Highlight kode ditunda saat streaming** — sebelumnya syntax-highlight kode dijalankan ulang di setiap potongan teks yang masuk (berat kalau jawabannya banyak kode). Sekarang kode ditampilkan polos dulu selama streaming, baru di-highlight sekali setelah jawaban selesai.
- **Kompresi gambar otomatis** — foto berukuran besar (>1.2MB) di-resize & dikompres di browser sebelum dikirim (maks sisi terpanjang 1600px, kualitas JPEG 82%), jadi lebih cepat terkirim dan lebih hemat kuota. Foto kecil tidak disentuh sama sekali. Muncul info singkat "Menyiapkan gambar..." saat proses ini jalan.
- **Label "menganalisis gambar"** — saat pesan yang dikirim ada lampiran foto, indikator loading otomatis berubah jadi "NAZE sedang menganalisis gambar..." bukan teks generik.
- **Timeout otomatis** — kalau server tidak merespons sama sekali dalam 25 detik, permintaan otomatis dibatalkan dan muncul pesan "Waktu tunggu habis" dengan tombol Retry, daripada aplikasi terlihat macet selamanya.
- **Pesan error lebih spesifik** — sekarang dibedakan: tidak ada koneksi internet, kuota/rate-limit habis, server bermasalah, atau timeout — masing-masing dengan pesan yang jelas dan aman (tidak pernah menampilkan detail teknis/API key ke pengguna).
- **Pencatatan performa (dev-only)** — TTFT (waktu sampai token pertama muncul) dan total waktu generate dicatat ke console browser (`console.debug`) untuk keperluan debugging, tidak pernah tampil ke pengguna biasa.

## Update: Naze Auto Browse (browsing internet otomatis)
- **Koreksi (penting):** update sebelumnya sempat salah mengklaim `gemini-3.6-flash` bukan model asli dan menggantinya ke `gemini-2.5-flash` — itu keliru. `gemini-3.6-flash` **model asli dan valid**, dirilis Google 21 Juli 2026, stabil, dan mendukung penuh Google Search grounding. Sudah dikembalikan ke `gemini-3.6-flash` seperti semula. Kalau kamu sempat coba `gemini-2.5-flash` di awal bikin project ini dan error, itu jelas menunjukkan API key/project kamu memang lebih cocok/support ke `gemini-3.6-flash` — jadi biarkan seperti itu.
- NAZE sekarang bisa mencari di internet secara otomatis lewat **Grounding with Google Search** bawaan Gemini — bukan pipeline pencarian custom, karena itu memang cara paling jujur untuk dapat sumber & kutipan yang benar-benar nyata (Gemini yang memutuskan kapan perlu mencari, menjalankan pencariannya, dan mengembalikan sumber asli — bukan dikarang).
- **Pengaturan → Naze Browse**, tiga mode: **Auto** (NAZE sendiri yang memutuskan kapan browsing perlu — default), **Always** (NAZE diarahkan untuk selalu coba mencari dulu sebelum menjawab), **Off** (browsing dimatikan total).
- Saat browsing aktif, indikator loading berubah jadi ikon globe + teks yang mencerminkan itu. Setelah jawaban selesai, kalau NAZE benar-benar melakukan pencarian, muncul kartu **Naze Sources** di bawah jawaban berisi link sumber asli (judul + domain, bisa diklik, `target="_blank" rel="noopener noreferrer"`) dan ringkasan query yang dicari — semuanya persis seperti yang dikembalikan Gemini, tidak ada yang dikarang di frontend/backend.
- Catatan jujur soal "Always": Gemini tidak punya cara untuk *memaksa* tool bawaan google_search dipanggil (beda dengan function-calling biasa) — mode ini hanya menambahkan instruksi sistem yang kuat supaya modelnya lebih condong mencari dulu, bukan jaminan mutlak.
- Bug yang diketahui di sisi Google (bukan sesuatu yang bisa kita perbaiki dari kode ini): ada laporan `gemini-3.6-flash` + `google_search` kadang memotong awal teks jawaban saat browsing aktif (lebih sering kalau minta output berformat kaku seperti JSON). Kalau jawaban NAZE terasa "mulai di tengah kalimat" pas lagi browsing, ini kemungkinan penyebabnya — belum ada fix resmi dari Google per sekarang.

## Update: Fallback multi-provider (Groq, OpenRouter, Mistral)
Kalau Gemini benar-benar gagal (semua key habis kuota/ditolak), backend otomatis coba provider cadangan secara berurutan — **Groq → OpenRouter → Mistral** — sebelum akhirnya menyerah. Ketiganya API gratis tanpa kartu kredit per 2026.

**Jujur soal batasannya:** cuma Gemini yang bisa lihat gambar dan punya Auto Browse (Google Search grounding). Kalau pesan ada gambar, sistem TIDAK akan pindah ke provider cadangan (daripada diam-diam ngabaikan gambarnya, lebih baik kasih error jelas). Kalau memang jatuh ke provider cadangan, muncul badge kecil di bawah jawaban yang bilang jelas: "Dijawab oleh Groq/OpenRouter/Mistral — tanpa gambar/Auto Browse untuk pesan ini."

**Env variable baru yang perlu ditambahkan di Vercel** (format sama seperti Gemini — bisa `_1`/`_2`/dst, comma-list `...S`, atau satu key polos):
- `GROQ_API_KEY` — ambil gratis di https://console.groq.com/keys (tanpa kartu kredit)
- `OPENROUTER_API_KEY` — ambil gratis di https://openrouter.ai/keys
- `MISTRAL_API_KEY` — ambil gratis (tier Experiment) di https://console.mistral.ai/api-keys

Semua opsional — kalau tidak diisi, fallback provider itu otomatis dilewati (tidak error, cuma dianggap tidak tersedia). Model yang dipakai: `openai/gpt-oss-120b` (Groq & OpenRouter — model open-weight OpenAI sendiri, ini paling dekat dengan "GPT gratis" yang beneran ada) dan `mistral-small-latest` (Mistral). Catatan: OpenAI sendiri **tidak** punya free tier API sama sekali per 2026 (wajib kartu kredit) — jadi tidak ada cara pakai GPT-4o/GPT-5 asli secara gratis lewat API resmi OpenAI.

## Update: bug bubble kiri (jawaban AI terpotong) diperbaiki
Sebelumnya, kalau tidak ada teks baru masuk selama 4 detik di tengah jawaban AI, aplikasi langsung menganggap jawaban sudah selesai dan memutus koneksi — padahal Gemini kadang diam >4 detik di tengah jawaban (terutama saat Naze Auto Browse sedang menjalankan pencarian Google). Akibatnya sebagian jawaban hilang / tidak keluar semua. Jeda toleransi sekarang dinaikkan jadi 20 detik (35 detik saat memakai provider cadangan), jadi hanya koneksi yang benar-benar macet yang dipotong.

## Update: Generate Gambar (Hugging Face, gratis)
- Tombol baru di menu lampiran (ikon "+") → **Buat Gambar (AI)**. Mode ini menonaktifkan chat biasa untuk pesan berikutnya — ketik deskripsi gambar, kirim, NAZE akan menghasilkan satu gambar lewat model `black-forest-labs/FLUX.1-schnell` di Hugging Face Inference API (gratis, tanpa kartu kredit).
- Gambar hasil generate ditampilkan langsung di bubble sebagai `<img>`, dengan badge kecil "Dibuat oleh Hugging Face (FLUX.1-schnell)".
- **Env variable baru:** `HF_API_KEY` (atau `HF_API_KEYS`/`HF_API_KEY_1`../`HF_API_KEY_10` untuk banyak key, format sama seperti provider lain). Ambil token gratis di https://huggingface.co/settings/tokens.
- Kalau model sedang "cold start" di infrastruktur gratis Hugging Face, akan muncul pesan error yang jujur menyarankan coba lagi beberapa detik kemudian (bukan error teknis mentah).
- Fitur ini terpisah total dari alur chat/Auto Browse — tidak memengaruhi maupun dipengaruhi oleh status Gemini/Groq/OpenRouter/Mistral.

## Update: Naze Browse untuk provider cadangan (Brave Search, gratis)
- Sebelumnya, kalau Gemini benar-benar habis kuota dan permintaan jatuh ke Groq/OpenRouter/Mistral, ketiganya sama sekali tidak bisa browsing (beda dari Gemini yang punya Google Search grounding bawaan).
- Sekarang, kalau `BRAVE_API_KEY` diisi dan Naze Browse tidak di-set "Off", provider cadangan diberi kemampuan memanggil `web_search` (function-calling standar OpenAI-compatible). Kalau modelnya minta mencari, NAZE menjalankan pencarian asli lewat Brave Search API, memasukkan hasilnya ke percakapan, baru model menulis jawaban akhir — sumber yang muncul di kartu "Naze Sources" adalah hasil pencarian yang sungguhan, bukan karangan.
- **Env variable baru:** `BRAVE_API_KEY` (atau `BRAVE_API_KEYS`/`BRAVE_API_KEY_1`.. dst). Ambil gratis (~2.000 pencarian/bulan) di https://api.search.brave.com/app/keys.
- Kalau `BRAVE_API_KEY` tidak diisi, provider cadangan berjalan seperti biasa tanpa browsing — tidak error.

## Update: semua API key provider cadangan kini "sama derajat"
- Sebelumnya urutan provider cadangan selalu tetap: Groq → OpenRouter → Mistral setiap kali Gemini gagal total, jadi Groq selalu jadi yang paling sering "kebagian jatah" duluan.
- Sekarang urutan itu diacak ulang di setiap permintaan yang jatuh ke fallback, jadi ketiga provider cadangan punya peluang yang sama untuk dicoba lebih dulu — bukan hierarki tetap.
- Gemini tetap dicoba paling pertama untuk setiap pesan (satu-satunya yang punya vision + Google Search grounding asli) — "sama derajat" berlaku di antara provider *cadangan*, bukan menyamakan Gemini dengan yang lain, karena kemampuannya memang tidak setara.

## Catatan jujur
- File `pdf/doc/docx/xls/xlsx/ppt/pptx` masih belum diekstrak isinya di browser — NAZE akan menandainya secara terbuka, bukan berpura-pura sudah membaca.
- `api/chat.js` mengunci model ke `gemini-3.6-flash` dan membatasi `max_tokens`, supaya request dari frontend tidak bisa memalsukan model atau menyedot kuota berlebihan.
- Tier gratis tidak punya jaminan SLA — bisa lebih lambat atau kena limit di jam sibuk. Cukup untuk proyek pribadi/skala kecil, bukan untuk beban produksi besar.
- Deteksi "kapan model perlu browsing" di provider cadangan pakai function-calling standar (bukan grounding native seperti Gemini) — cukup andal di Groq/OpenRouter (gpt-oss-120b) dan Mistral, tapi tetap tergantung keputusan modelnya sendiri, sama seperti mode "Auto" di Gemini.
- Gambar yang di-generate ikut tersimpan penuh (base64) di `localStorage` browser seperti foto yang diunggah pengguna — kalau sering generate gambar besar, penyimpanan lokal bisa lebih cepat penuh.
