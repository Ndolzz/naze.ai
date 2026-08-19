# NAZE AI — Panduan Deploy (GitHub + Vercel, 100% Gratis)

Folder ini sudah lengkap dan siap deploy: `index.html`, `manifest.json`, `sw.js`, ikon, dan `api/chat.js` (server proxy ke Gemini yang menyimpan API key dengan aman).

## Provider AI: Google Gemini API (gratis)
- Tidak perlu kartu kredit — cukup akun Google.
- Model: `gemini-2.5-flash` — mendukung teks **dan gambar (vision)**.
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

## Catatan jujur
- File `pdf/doc/docx/xls/xlsx/ppt/pptx` masih belum diekstrak isinya di browser — NAZE akan menandainya secara terbuka, bukan berpura-pura sudah membaca.
- `api/chat.js` mengunci model ke `gemini-2.5-flash` dan membatasi `max_tokens`, supaya request dari frontend tidak bisa memalsukan model atau menyedot kuota berlebihan.
- Tier gratis tidak punya jaminan SLA — bisa lebih lambat atau kena limit di jam sibuk. Cukup untuk proyek pribadi/skala kecil, bukan untuk beban produksi besar.
