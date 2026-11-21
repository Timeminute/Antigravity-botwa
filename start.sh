#!/usr/bin/env bash

# Aktifkan wake-lock agar Termux tidak dimatikan Android saat layar mati
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
fi

cleanup() {
    echo ""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Menghentikan Bot WA..."
    if command -v termux-wake-unlock >/dev/null 2>&1; then
        termux-wake-unlock
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM

while true; do
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Memeriksa koneksi internet..."
    if curl -sI --connect-timeout 5 https://web.whatsapp.com >/dev/null 2>&1 || ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Internet terhubung! Menjalankan Bot WA..."
        node index.js
        EXIT_CODE=$?

        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bot berhenti (Exit Code: $EXIT_CODE). Restart otomatis dalam 5 detik... (Tekan Ctrl+C untuk batal)"
        sleep 5
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Tidak ada koneksi internet. Mencoba lagi dalam 10 detik..."
        sleep 10
    fi
done
