cat << 'EOF' > ~/termux-wa/chrome-wrapper.sh
#!/data/data/com.termux/files/usr/bin/bash
unset LD_PRELOAD
if head -c 2 /data/data/com.termux/files/usr/bin/chromium-browser 2>/dev/null | grep -q '^#!'; then
    exec /data/data/com.termux/files/usr/bin/bash /data/data/com.termux/files/usr/bin/chromium-browser "$@"
else
    exec /data/data/com.termux/files/usr/bin/chromium-browser "$@"
fi
EOF
chmod +x ~/termux-wa/chrome-wrapper.sh