#!/usr/bin/env bash
set -u
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SELF_DIR/extension/manifest.json" | head -n1)"
BUILD_XPI="$SELF_DIR/dist/persona-route-manager-v${VERSION}.xpi"
TARGET_USER="${SUDO_USER:-${USER:-}}"
TARGET_HOME=""
if [[ -n "$TARGET_USER" ]] && id "$TARGET_USER" >/dev/null 2>&1; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
fi

printf 'Persona Mullvad Router diagnostics\n\n'
printf '%-32s %s\n' 'source extension version:' "${VERSION:-UNKNOWN}"
printf '%-32s ' 'wireguard tools:'
if command -v wg >/dev/null && command -v ip >/dev/null; then echo OK; else echo MISSING; fi
printf '%-32s ' 'systemd service:'
service_state="$(systemctl is-active persona-mullvad-router.service 2>/dev/null || true)"
if [[ "$service_state" == "active" ]]; then
  service_active=1
  echo ACTIVE
else
  service_active=0
  echo INACTIVE
fi
printf '%-32s ' 'native host executable:'
[[ -x /usr/local/lib/persona-mullvad-router/native_host.py ]] && echo OK || echo MISSING
printf '%-32s ' 'native manifest:'
if [[ -f /usr/lib/mozilla/native-messaging-hosts/com.persona.mullvad_router.json || -f /usr/lib64/mozilla/native-messaging-hosts/com.persona.mullvad_router.json || -f /usr/lib/librewolf/native-messaging-hosts/com.persona.mullvad_router.json || -f /usr/lib64/librewolf/native-messaging-hosts/com.persona.mullvad_router.json ]]; then echo OK; else echo MISSING; fi
printf '%-32s ' 'control socket:'
[[ -S /run/persona-mullvad-router/control.sock ]] && echo OK || echo MISSING
printf '%-32s ' 'WireGuard configs installed:'
count=$(find /etc/persona-mullvad-router/configs -maxdepth 1 -name '*.conf' -type f 2>/dev/null | wc -l)
echo "$count"
printf '%-32s ' 'current build XPI:'
[[ -f "$BUILD_XPI" ]] && echo PRESENT || echo MISSING

printf '%-32s ' 'LibreWolf distro XPI:'
found=0
for root in /usr/lib/librewolf /usr/lib64/librewolf /usr/local/lib/librewolf /usr/local/lib64/librewolf /opt/librewolf; do
  if [[ -f "$root/distribution/extensions/persona-route-manager@local.xpi" ]]; then
    echo "$root/distribution/extensions/persona-route-manager@local.xpi"
    found=1
    break
  fi
done
[[ $found -eq 1 ]] || echo NOT-FOUND

printf '%-32s ' 'LibreWolf XDG override:'
if [[ -n "$TARGET_HOME" && -f "$TARGET_HOME/.config/librewolf/librewolf/librewolf.overrides.cfg" ]]; then
  echo PRESENT
else
  echo NOT-FOUND
fi

if command -v persona-mullvad-router >/dev/null 2>&1; then
  echo
  persona-mullvad-router status 2>&1 || true
else
  echo
  echo 'CLI not installed.'
fi

echo
if [[ $service_active -eq 1 ]]; then
  echo 'Recent service log:'
  journalctl -u persona-mullvad-router.service -n 20 --no-pager 2>/dev/null || true
fi
