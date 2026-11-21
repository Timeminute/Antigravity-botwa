#!/usr/bin/env bash
set -e

echo "=========================================="
echo "  Setup Bot WA All-in-One untuk Termux    "
echo "  (Baileys - tanpa Chromium)              "
echo "=========================================="

if command -v pkg >/dev/null 2>&1; then
    echo "[1/3] Memperbarui repositori Termux..."
    pkg update -y && pkg upgrade -y

    echo "[2/3] Menginstal Node.js, FFmpeg, Python, Git, dan Curl..."
    pkg install -y nodejs-lts ffmpeg python git curl
else
    echo "[Info] Perintah 'pkg' tidak ditemukan. Melewati instalasi paket Termux."
fi

echo "[3/3] Menginstal / memperbarui yt-dlp dan dependensi Node.js..."
if command -v pip >/dev/null 2>&1; then
    pip install --upgrade yt-dlp || pip install --upgrade --break-system-packages yt-dlp
else
    echo "[Peringatan] pip tidak ditemukan. Pastikan python dan yt-dlp terinstal."
fi

npm install

chmod +x start.sh install.sh 2>/dev/null || true

echo ""
echo "=========================================="
echo "  Instalasi Selesai!                      "
echo "  Login pertama (kode pairing):           "
echo "    node index.js                         "
echo "  Setelah login, jalankan terus-menerus:  "
echo "    bash start.sh                         "
echo "=========================================="
