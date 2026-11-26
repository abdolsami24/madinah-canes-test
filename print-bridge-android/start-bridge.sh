#!/data/data/com.termux/files/usr/bin/bash
# Madinah Market — Print Bridge starter (Termux)
# Goes to the bridge folder, takes a wake-lock so Android does not
# put the bridge to sleep, and starts the bridge.
cd "$(dirname "$0")" || exit 1
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi
node bridge-android.js "$@"
