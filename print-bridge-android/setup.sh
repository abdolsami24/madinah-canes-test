#!/data/data/com.termux/files/usr/bin/bash
# Madinah Market — Print Bridge setup (Termux, Android tablet)
# Safe to run again: it only installs what is missing, rewrites the
# boot script with the same content, and starts the bridge.
set -e
cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"

echo "Installing Node.js (this can take a minute)..."
pkg update -y
pkg install -y nodejs

echo "Setting up auto-start (Termux:Boot)..."
mkdir -p "$HOME/.termux/boot"
{
  printf '%s\n' '#!/data/data/com.termux/files/usr/bin/bash'
  printf 'cd "%s"\n' "$SCRIPT_DIR"
  printf '%s\n' './start-bridge.sh'
} > "$HOME/.termux/boot/start-bridge.sh"
chmod +x "$HOME/.termux/boot/start-bridge.sh"
chmod +x "$SCRIPT_DIR/start-bridge.sh"

echo ""
echo "Starting the bridge — the first time, it will ask you to pair."
echo "Keep this Termux window open."
echo ""
exec ./start-bridge.sh
