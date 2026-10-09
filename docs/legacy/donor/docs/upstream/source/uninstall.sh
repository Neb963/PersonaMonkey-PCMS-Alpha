#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ID="persona-route-manager@local"
ETCDIR=/etc/persona-mullvad-router

if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo "$SELF_DIR/uninstall.sh" "$@"
  fi
  echo "Root privileges are required and sudo was not found." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to safely restore LibreWolf preferences; no system changes were made." >&2
  exit 1
fi
if [[ ! -f "$SELF_DIR/scripts/librewolf_prefs.py" ]]; then
  echo "LibreWolf preference helper is missing; no system changes were made." >&2
  exit 1
fi
if ! python3 "$SELF_DIR/scripts/librewolf_prefs.py" uninstall "$ETCDIR"; then
  echo "Could not safely restore LibreWolf preferences; uninstall aborted before system changes." >&2
  exit 1
fi

# Ask the running daemon to lower WireGuard first, then stop the service.
if [[ -S /run/persona-mullvad-router/control.sock && -x /usr/local/bin/persona-mullvad-router ]]; then
  /usr/local/bin/persona-mullvad-router down >/dev/null 2>&1 || true
fi
systemctl disable --now persona-mullvad-router.service >/dev/null 2>&1 || true
if ip link show prm-mv >/dev/null 2>&1; then
  ip link delete prm-mv >/dev/null 2>&1 || true
fi

rm -f /etc/systemd/system/persona-mullvad-router.service
systemctl daemon-reload >/dev/null 2>&1 || true

for d in \
  /usr/lib/mozilla/native-messaging-hosts \
  /usr/lib64/mozilla/native-messaging-hosts \
  /usr/lib/librewolf/native-messaging-hosts \
  /usr/lib64/librewolf/native-messaging-hosts; do
  rm -f "$d/com.persona.mullvad_router.json" 2>/dev/null || true
done

# Remove the exact extension deployment path recorded at install time.
if [[ -f "$ETCDIR/librewolf-extension-path.txt" ]]; then
  xpi_path="$(head -n1 "$ETCDIR/librewolf-extension-path.txt" || true)"
  [[ -n "$xpi_path" ]] && rm -f "$xpi_path" 2>/dev/null || true
fi
# Also clean common native-package paths in case an older install did not record it.
for root in /usr/lib/librewolf /usr/lib64/librewolf /usr/local/lib/librewolf /usr/local/lib64/librewolf /opt/librewolf; do
  rm -f "$root/distribution/extensions/$EXTENSION_ID.xpi" 2>/dev/null || true
done

rm -f /usr/local/bin/persona-mullvad-router
rm -rf /usr/local/lib/persona-mullvad-router /usr/local/share/persona-mullvad-router
# Installed configs contain the Mullvad WireGuard private key.
rm -rf "$ETCDIR" /run/persona-mullvad-router

printf 'Persona Mullvad Router removed. Fully restart LibreWolf to unload the distro extension.\n'
