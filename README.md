# Bot WA All-in-One (Termux Android, Baileys)

Bot WhatsApp untuk mengunduh media publik (Instagram, TikTok, Facebook, X/Twitter, Threads, YouTube) dan membuat stiker dari gambar/video/GIF. Versi ini memakai **Baileys** (koneksi WebSocket langsung), jadi **tidak butuh Chromium** dan jauh lebih hemat RAM di HP.

## Instalasi
```bash
unzip bot-wa-termux.zip && cd bot-wa-termux
bash install.sh
```

## Login pertama (kode pairing, tanpa scan QR)
```bash
node index.js
```
Masukkan nomor WhatsApp bot (contoh `6281234567890`, awalan `0` otomatis jadi `62`). Lalu di HP:
**WhatsApp > Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon saja**, dan masukkan kode 8 karakter yang tampil di Termux.

Alternatif tanpa prompt: `WA_NUMBER=6281234567890 node index.js`.
Alternatif QR (dipindai dari perangkat lain): `USE_QR=1 node index.js`.

Setelah berhasil login, hentikan dengan Ctrl+C lalu jalankan terus-menerus:
```bash
bash start.sh
```

## Cara pakai
- **Tanya AI (Antigravity agy):** Kirim pesan teks apa pun tanpa link di chat pribadi (DM), bot akan otomatis menjawab via `agy -p`.
  - Di grup: tag/mention bot, reply pesan bot, atau gunakan awalan `.ai <pertanyaan>`.
  - (Opsional) Ingin bot merespons semua chat di grup tanpa perlu di-tag? Jalankan dengan `AI_GROUP_ALL=1 node index.js`.
- **Downloader:** Kirim link IG / TikTok / FB / X / Threads / YouTube -> bot otomatis mengunduh medianya.
- **Stiker:** Kirim gambar / video / GIF -> bot membalas stiker. Tambahkan kata `stiker` di pesan berisi link gambar.
- **YouTube:** Kirim link YouTube -> balas `1` (video) atau `2` (mp3). `0` untuk batal.

## Pengaturan Antigravity (agy)
1. Pastikan CLI `agy` sudah terpasang dan sudah login di Termux Anda:
   ```bash
   agy
   ```
2. Bot otomatis mendeteksi lokasi binary `agy` di sistem (`$PREFIX/bin/agy`, `~/.local/bin/agy`, atau PATH).
3. Jika lokasi `agy` berada di path khusus, jalankan dengan:
   ```bash
   AGY_PATH=/path/ke/agy node index.js
   ```

## Troubleshooting
- Reset login: `npm run clean:session` lalu `node index.js`.
- Log detail koneksi: `DEBUG_BAILEYS=1 node index.js`.
- Unduhan gagal: `pip install -U yt-dlp`.
- Folder `auth_info/` berisi sesi login, jangan di-upload ke GitHub (sudah ada di `.gitignore`).
