#!/usr/bin/env bash
set -euo pipefail

ORIGINAL_ARGS=("$@")
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="$SELF_DIR/extension/manifest.json"
VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST_PATH" | head -n1)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not read extension version from $MANIFEST_PATH" >&2; exit 1; }
XPI_SRC="${PRM_XPI_PATH:-$SELF_DIR/dist/persona-route-manager-v${VERSION}.xpi}"
XPI_SHA256="${PRM_XPI_SHA256:-}"
EXTENSION_ID="persona-route-manager@local"
SOURCE=""
ENTRY_PATTERN=""
START_NOW=1
INSTALL_BROWSER=1
CONFIGURE_LIBREWOLF=1
TARGET_USER="${PRM_TARGET_USER:-${SUDO_USER:-${USER:-}}}"
ORIGINAL_XDG_CONFIG_HOME="${PRM_XDG_CONFIG_HOME:-}"
XPI_PIN_DIR=""
STAGE=""
BACKUP_PATH=""
ROLLBACK_DIR=""
ROLLBACK_ARMED=0
ROLLBACK_SERVICE_ENABLED=0
ROLLBACK_SERVICE_ACTIVE=0
ROLLBACK_TUNNEL_UP=0
ROLLBACK_PREFS_PATH=""
REUSING_INSTALLED_CONFIG=0
BROWSER_INSTALL_EXPLICIT=0
[[ -n "${PRM_XPI_PATH:-}${PRM_XPI_SHA256:-}" ]] && BROWSER_INSTALL_EXPLICIT=1

LIBDIR=/usr/local/lib/persona-mullvad-router
SHAREDIR=/usr/local/share/persona-mullvad-router
ETCDIR=/etc/persona-mullvad-router
CONFDIR="$ETCDIR/configs"

usage() {
  cat <<EOF2
PersonaMonkey Mullvad Router ${VERSION}

Bridge upgrade / repair (recommended when already installed):
  ./install.sh

Fresh bridge + browser install:
  node scripts/build-extension.mjs
  ./install.sh /path/to/mullvad-wireguard.zip --xpi SIGNED.xpi --xpi-sha256 TRUSTED_SHA256

With no config argument, the installer reuses the already installed WireGuard
configuration, writes a private backup ZIP into the desktop user's home, removes
the old bridge runtime, installs the current bridge, and starts it. Browser/XPI
installation is skipped automatically in this upgrade mode unless a trusted XPI
digest is supplied.

Usage:
  ./install.sh [MULLVAD_WIREGUARD.zip|.conf|directory] [options]

Options:
  --entry TEXT          Prefer an imported WireGuard entry config by exact id/substring.
  --xpi PATH            Install this XPI instead of dist/persona-route-manager-v${VERSION}.xpi.
  --xpi-sha256 HEX      Require this trusted SHA-256 digest for the Mozilla-signed XPI.
  --user USER           Desktop user running LibreWolf (normally auto-detected).
  --no-start            Install without bringing the Mullvad entry tunnel up.
  --no-browser-install  Do not deploy the XPI into the LibreWolf installation.
  --no-librewolf-config Do not modify the user's LibreWolf XDG overrides file.
  -h, --help            Show this help.

Any supplied or auto-discovered configuration remains local. Persistent browser
installation requires a Mozilla-signed XPI and its trusted SHA-256 digest,
obtained independently of the XPI file. The local build output is unsigned and
is not accepted for persistent installation.
EOF2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --entry) ENTRY_PATTERN="${2:-}"; shift 2 ;;
    --xpi) XPI_SRC="${2:-}"; BROWSER_INSTALL_EXPLICIT=1; shift 2 ;;
    --xpi-sha256) XPI_SHA256="${2:-}"; BROWSER_INSTALL_EXPLICIT=1; shift 2 ;;
    --user) TARGET_USER="${2:-}"; shift 2 ;;
    --no-start) START_NOW=0; shift ;;
    --no-browser-install) INSTALL_BROWSER=0; shift ;;
    --no-librewolf-config) CONFIGURE_LIBREWOLF=0; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *)
      if [[ -n "$SOURCE" ]]; then
        echo "Only one config source may be supplied." >&2
        exit 2
      fi
      SOURCE="$1"
      shift
      ;;
  esac
done

# Make the recommended install literally one command: ./install.sh
if [[ $EUID -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Root privileges are required and sudo was not found." >&2
    exit 1
  fi
  exec sudo env \
    PRM_TARGET_USER="${TARGET_USER:-${USER:-}}" \
    PRM_XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}" \
    PRM_XPI_SHA256="$XPI_SHA256" \
    "$SELF_DIR/install.sh" "${ORIGINAL_ARGS[@]}"
fi

if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "Could not determine the desktop user. Re-run with --user YOUR_USERNAME." >&2
  exit 1
fi
if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "User does not exist: $TARGET_USER" >&2
  exit 1
fi

TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_GID="$(id -g "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"

log() { printf '[persona-router] %s\n' "$*"; }
warn() { printf '[persona-router] WARNING: %s\n' "$*" >&2; }

cleanup_temporary_files() {
  [[ -z "$STAGE" ]] || rm -rf "$STAGE"
  [[ -z "$XPI_PIN_DIR" ]] || rm -rf "$XPI_PIN_DIR"
  [[ -z "$ROLLBACK_DIR" ]] || rm -rf "$ROLLBACK_DIR"
}

restore_previous_runtime() {
  [[ $ROLLBACK_ARMED -eq 1 && -n "$ROLLBACK_DIR" ]] || return 0
  warn "Installation failed after the existing runtime was removed; restoring the previous PersonaMonkey bridge."

  set +e

  # Remove any partially installed replacement before restoring the snapshot.
  local partial_xpi=""
  if [[ -f "$ETCDIR/librewolf-extension-path.txt" ]]; then
    partial_xpi="$(head -n1 "$ETCDIR/librewolf-extension-path.txt" 2>/dev/null || true)"
  fi
  systemctl disable --now persona-mullvad-router.service >/dev/null 2>&1 || true
  [[ -z "$partial_xpi" ]] || rm -f "$partial_xpi" >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/persona-mullvad-router.service
  rm -f /usr/local/bin/persona-mullvad-router
  rm -rf "$LIBDIR" "$SHAREDIR" "$ETCDIR"
  for d in \
    /usr/lib/mozilla/native-messaging-hosts \
    /usr/lib64/mozilla/native-messaging-hosts \
    /usr/lib/librewolf/native-messaging-hosts \
    /usr/lib64/librewolf/native-messaging-hosts; do
    rm -f "$d/com.persona.mullvad_router.json" >/dev/null 2>&1 || true
  done

  [[ ! -d "$ROLLBACK_DIR/lib" ]] || cp -a "$ROLLBACK_DIR/lib" "$LIBDIR"
  [[ ! -d "$ROLLBACK_DIR/share" ]] || cp -a "$ROLLBACK_DIR/share" "$SHAREDIR"
  [[ ! -d "$ROLLBACK_DIR/etc" ]] || cp -a "$ROLLBACK_DIR/etc" "$ETCDIR"
  [[ ! -f "$ROLLBACK_DIR/routerctl" ]] || install -m 0755 "$ROLLBACK_DIR/routerctl" /usr/local/bin/persona-mullvad-router
  [[ ! -f "$ROLLBACK_DIR/service" ]] || install -m 0644 "$ROLLBACK_DIR/service" /etc/systemd/system/persona-mullvad-router.service

  for d in \
    /usr/lib/mozilla/native-messaging-hosts \
    /usr/lib64/mozilla/native-messaging-hosts \
    /usr/lib/librewolf/native-messaging-hosts \
    /usr/lib64/librewolf/native-messaging-hosts; do
    local saved="$ROLLBACK_DIR$d/com.persona.mullvad_router.json"
    if [[ -f "$saved" ]]; then
      mkdir -p "$d"
      cp -a "$saved" "$d/com.persona.mullvad_router.json"
    fi
  done

  if [[ -f "$ROLLBACK_DIR/browser-xpi-path.txt" && -f "$ROLLBACK_DIR/browser-extension.xpi" ]]; then
    local old_xpi
    old_xpi="$(head -n1 "$ROLLBACK_DIR/browser-xpi-path.txt" 2>/dev/null || true)"
    if [[ -n "$old_xpi" ]]; then
      mkdir -p "$(dirname "$old_xpi")"
      cp -a "$ROLLBACK_DIR/browser-extension.xpi" "$old_xpi"
    fi
  fi

  if [[ -n "$ROLLBACK_PREFS_PATH" ]]; then
    if [[ -f "$ROLLBACK_DIR/librewolf-overrides.cfg" ]]; then
      mkdir -p "$(dirname "$ROLLBACK_PREFS_PATH")"
      cp -a "$ROLLBACK_DIR/librewolf-overrides.cfg" "$ROLLBACK_PREFS_PATH"
      chown "$TARGET_UID:$TARGET_GID" "$ROLLBACK_PREFS_PATH" >/dev/null 2>&1 || true
    elif [[ -f "$ROLLBACK_DIR/librewolf-overrides.absent" ]]; then
      rm -f "$ROLLBACK_PREFS_PATH" >/dev/null 2>&1 || true
    fi
  fi

  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ -f /etc/systemd/system/persona-mullvad-router.service ]]; then
    if [[ $ROLLBACK_SERVICE_ENABLED -eq 1 ]]; then
      systemctl enable persona-mullvad-router.service >/dev/null 2>&1 || true
    else
      systemctl disable persona-mullvad-router.service >/dev/null 2>&1 || true
    fi
    if [[ $ROLLBACK_SERVICE_ACTIVE -eq 1 ]]; then
      systemctl start persona-mullvad-router.service >/dev/null 2>&1 || true
      if [[ $ROLLBACK_TUNNEL_UP -eq 1 && -x /usr/local/bin/persona-mullvad-router ]]; then
        /usr/local/bin/persona-mullvad-router up >/dev/null 2>&1 || true
      fi
    fi
  fi

  ROLLBACK_ARMED=0
  set -e
}

on_exit() {
  local status=$?
  if [[ $status -ne 0 && $ROLLBACK_ARMED -eq 1 ]]; then
    restore_previous_runtime
  fi
  cleanup_temporary_files
  exit "$status"
}
trap on_exit EXIT

install_deps() {
  local missing=0
  for c in python3 wg ip systemctl; do
    command -v "$c" >/dev/null 2>&1 || missing=1
  done
  [[ $missing -eq 0 ]] && return 0

  log "Installing required WireGuard/network tools..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 wireguard-tools iproute2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 wireguard-tools iproute
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --needed --noconfirm python wireguard-tools iproute2
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install python3 wireguard-tools iproute2
  elif command -v apk >/dev/null 2>&1; then
    apk add python3 wireguard-tools iproute2
  elif command -v xbps-install >/dev/null 2>&1; then
    xbps-install -Sy wireguard-tools iproute2 python3
  else
    echo "Missing python3/wg/ip/systemctl and no supported package manager was found." >&2
    exit 1
  fi

  local still_missing=()
  for c in python3 wg ip systemctl; do
    command -v "$c" >/dev/null 2>&1 || still_missing+=("$c")
  done
  if [[ ${#still_missing[@]} -gt 0 ]]; then
    echo "Dependency installation completed, but these commands are still missing: ${still_missing[*]}" >&2
    echo "Install your distribution's wireguard-tools, iproute2/iproute, python3 and systemd packages, then rerun ./install.sh." >&2
    exit 1
  fi
}

select_source() {
  [[ -n "$SOURCE" ]] && return

  if [[ -d "$CONFDIR" && -n "$(find "$CONFDIR" -maxdepth 1 -type f -name '*.conf' -print -quit)" ]]; then
    SOURCE="$CONFDIR"
    REUSING_INSTALLED_CONFIG=1
  elif [[ -f "$ETCDIR/prm-mv.conf" ]]; then
    SOURCE="$ETCDIR/prm-mv.conf"
    REUSING_INSTALLED_CONFIG=1
  else
    echo "No installed Mullvad WireGuard configuration was found." >&2
    echo "For a first install, supply a Mullvad WireGuard ZIP, .conf file, or directory:" >&2
    echo "  ./install.sh /path/to/mullvad-wireguard.zip --no-browser-install" >&2
    exit 2
  fi

  if [[ $INSTALL_BROWSER -eq 1 && $BROWSER_INSTALL_EXPLICIT -eq 0 ]]; then
    INSTALL_BROWSER=0
    CONFIGURE_LIBREWOLF=0
  fi
  log "Reusing installed WireGuard configuration from $SOURCE"
}

backup_existing_config() {
  local has_private_config=0
  if [[ -d "$CONFDIR" && -n "$(find "$CONFDIR" -maxdepth 1 -type f -name '*.conf' -print -quit)" ]]; then
    has_private_config=1
  elif [[ -f "$ETCDIR/prm-mv.conf" ]]; then
    has_private_config=1
  fi
  [[ $has_private_config -eq 1 ]] || return 0

  BACKUP_PATH="$TARGET_HOME/persona-mullvad-router-private-backup-$(date +%Y%m%d-%H%M%S)-$$.zip"
  python3 "$SELF_DIR/native/backup_configs.py" "$ETCDIR" "$BACKUP_PATH"
  chown "$TARGET_UID:$TARGET_GID" "$BACKUP_PATH"
  chmod 600 "$BACKUP_PATH"
  log "Backed up existing private WireGuard configuration to $BACKUP_PATH"
}

snapshot_existing_runtime() {
  ROLLBACK_DIR="$(mktemp -d)"
  chmod 700 "$ROLLBACK_DIR"

  systemctl is-enabled --quiet persona-mullvad-router.service >/dev/null 2>&1 && ROLLBACK_SERVICE_ENABLED=1 || true
  systemctl is-active --quiet persona-mullvad-router.service >/dev/null 2>&1 && ROLLBACK_SERVICE_ACTIVE=1 || true
  ip link show prm-mv >/dev/null 2>&1 && ROLLBACK_TUNNEL_UP=1 || true

  [[ ! -d "$LIBDIR" ]] || cp -a "$LIBDIR" "$ROLLBACK_DIR/lib"
  [[ ! -d "$SHAREDIR" ]] || cp -a "$SHAREDIR" "$ROLLBACK_DIR/share"
  [[ ! -d "$ETCDIR" ]] || cp -a "$ETCDIR" "$ROLLBACK_DIR/etc"
  [[ ! -f /usr/local/bin/persona-mullvad-router ]] || cp -a /usr/local/bin/persona-mullvad-router "$ROLLBACK_DIR/routerctl"
  [[ ! -f /etc/systemd/system/persona-mullvad-router.service ]] || cp -a /etc/systemd/system/persona-mullvad-router.service "$ROLLBACK_DIR/service"

  for d in \
    /usr/lib/mozilla/native-messaging-hosts \
    /usr/lib64/mozilla/native-messaging-hosts \
    /usr/lib/librewolf/native-messaging-hosts \
    /usr/lib64/librewolf/native-messaging-hosts; do
    if [[ -f "$d/com.persona.mullvad_router.json" ]]; then
      mkdir -p "$ROLLBACK_DIR$d"
      cp -a "$d/com.persona.mullvad_router.json" "$ROLLBACK_DIR$d/com.persona.mullvad_router.json"
    fi
  done

  if [[ -f "$ETCDIR/librewolf-extension-path.txt" ]]; then
    local old_xpi
    old_xpi="$(head -n1 "$ETCDIR/librewolf-extension-path.txt" 2>/dev/null || true)"
    if [[ -n "$old_xpi" && -f "$old_xpi" ]]; then
      printf '%s\n' "$old_xpi" > "$ROLLBACK_DIR/browser-xpi-path.txt"
      cp -a "$old_xpi" "$ROLLBACK_DIR/browser-extension.xpi"
    fi
  fi

  if [[ -n "$ORIGINAL_XDG_CONFIG_HOME" && "$ORIGINAL_XDG_CONFIG_HOME" == /* ]]; then
    ROLLBACK_PREFS_PATH="$ORIGINAL_XDG_CONFIG_HOME/librewolf/librewolf/librewolf.overrides.cfg"
  else
    ROLLBACK_PREFS_PATH="$TARGET_HOME/.config/librewolf/librewolf/librewolf.overrides.cfg"
  fi
  if [[ -f "$ROLLBACK_PREFS_PATH" ]]; then
    cp -a "$ROLLBACK_PREFS_PATH" "$ROLLBACK_DIR/librewolf-overrides.cfg"
  else
    : > "$ROLLBACK_DIR/librewolf-overrides.absent"
  fi

  # From this point until successful completion, any installer failure restores
  # the exact runtime snapshot instead of leaving a half-upgraded bridge.
  ROLLBACK_ARMED=1
}

validate_xpi() {
  [[ $INSTALL_BROWSER -eq 1 ]] || return 0
  if [[ ! "$XPI_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
    echo "A trusted --xpi-sha256 value is required for persistent browser installation." >&2
    echo "Obtain the digest independently of the XPI from trusted release metadata." >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 is required to verify the XPI before system changes; install it and retry." >&2
    exit 1
  fi
  XPI_SRC="$(readlink -f "$XPI_SRC")"
  if [[ ! -f "$XPI_SRC" ]]; then
    echo "Current extension XPI not found: $XPI_SRC" >&2
    echo "Provide a Mozilla-signed release XPI with --xpi PATH." >&2
    exit 1
  fi

  local pinned_xpi
  if ! pinned_xpi="$(python3 "$SELF_DIR/scripts/validate_xpi.py" "$XPI_SRC" \
    --version "$VERSION" --extension-id "$EXTENSION_ID" --sha256 "$XPI_SHA256" --pin-verified)"; then
    exit 1
  fi
  XPI_SRC="$pinned_xpi"
  XPI_PIN_DIR="$(dirname -- "$pinned_xpi")"
}

router_ping() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$TARGET_USER" -- /usr/local/bin/persona-mullvad-router ping >/dev/null 2>&1
  else
    /usr/local/bin/persona-mullvad-router ping >/dev/null 2>&1
  fi
}

wait_for_router_daemon() {
  local stable=0
  for _ in {1..40}; do
    if systemctl is-active --quiet persona-mullvad-router.service \
      && [[ -S /run/persona-mullvad-router/control.sock ]] \
      && router_ping; then
      stable=$((stable + 1))
      if [[ $stable -ge 2 ]]; then
        return 0
      fi
    else
      stable=0
    fi
    sleep 0.25
  done

  echo "Router service did not become healthy." >&2
  systemctl --no-pager --full status persona-mullvad-router.service >&2 || true
  journalctl -u persona-mullvad-router.service -n 30 --no-pager >&2 || true
  return 1
}

stop_existing_router() {
  if [[ -S /run/persona-mullvad-router/control.sock && -x /usr/local/bin/persona-mullvad-router ]]; then
    /usr/local/bin/persona-mullvad-router down >/dev/null 2>&1 || true
  fi
  systemctl stop persona-mullvad-router.service >/dev/null 2>&1 || true

  # Cleanup a stale interface from an interrupted/older install.
  if ip link show prm-mv >/dev/null 2>&1; then
    ip link delete prm-mv >/dev/null 2>&1 || true
  fi
}

remove_existing_bridge_runtime() {
  stop_existing_router

  rm -f /etc/systemd/system/persona-mullvad-router.service
  rm -f /usr/local/bin/persona-mullvad-router
  rm -rf "$LIBDIR"
  for d in \
    /usr/lib/mozilla/native-messaging-hosts \
    /usr/lib64/mozilla/native-messaging-hosts \
    /usr/lib/librewolf/native-messaging-hosts \
    /usr/lib64/librewolf/native-messaging-hosts; do
    rm -f "$d/com.persona.mullvad_router.json" 2>/dev/null || true
  done
  systemctl daemon-reload >/dev/null 2>&1 || true
}

disconnect_mullvad_app() {
  command -v mullvad >/dev/null 2>&1 || return 0
  local status
  status="$(mullvad status 2>/dev/null || true)"
  if grep -qi 'Connected' <<<"$status" && ! grep -qi 'Disconnected' <<<"$status"; then
    log "Disconnecting the Mullvad desktop app; this bridge will own its WireGuard entry tunnel."
    mullvad disconnect >/dev/null 2>&1 || true
    for _ in {1..20}; do
      sleep 0.25
      status="$(mullvad status 2>/dev/null || true)"
      if ! grep -qi 'Connected' <<<"$status" || grep -qi 'Disconnected' <<<"$status"; then
        return 0
      fi
    done
    warn "Mullvad app still appears connected. The local tunnel may refuse to start until it is disconnected."
  fi
}

configure_librewolf_xdg() {
  [[ $INSTALL_BROWSER -eq 1 && $CONFIGURE_LIBREWOLF -eq 1 ]] || return 0

  local xdg cfg tmp
  if [[ -n "$ORIGINAL_XDG_CONFIG_HOME" && "$ORIGINAL_XDG_CONFIG_HOME" == /* ]]; then
    xdg="$ORIGINAL_XDG_CONFIG_HOME"
  else
    xdg="$TARGET_HOME/.config"
  fi
  cfg="$xdg/librewolf/librewolf/librewolf.overrides.cfg"

  # Create only our missing directories as the target user; don't recursively
  # chown or change modes on an existing user configuration tree.
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$TARGET_USER" -- mkdir -p "$(dirname "$cfg")"
  else
    mkdir -p "$(dirname "$cfg")"
    chown "$TARGET_UID:$TARGET_GID" "$(dirname "$cfg")"
  fi
  python3 "$SELF_DIR/scripts/librewolf_prefs.py" configure "$cfg" "$ETCDIR" \
    --install-browser "$INSTALL_BROWSER" --configure-librewolf "$CONFIGURE_LIBREWOLF" \
    --owner "$TARGET_UID:$TARGET_GID"
  log "Configured LibreWolf XDG overrides: $cfg"
}

find_librewolf_root() {
  local candidate real bin
  local -a candidates=()
  if command -v librewolf >/dev/null 2>&1; then
    bin="$(command -v librewolf)"
    real="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
    candidates+=("$(dirname "$real")")
  fi
  candidates+=(
    /usr/lib/librewolf
    /usr/lib64/librewolf
    /usr/local/lib/librewolf
    /usr/local/lib64/librewolf
    /opt/librewolf
  )

  for candidate in "${candidates[@]}"; do
    [[ -d "$candidate" ]] || continue
    if [[ -f "$candidate/application.ini" || -x "$candidate/librewolf" || -x "$candidate/librewolf-bin" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  # Last-resort bounded search for native-package layouts.
  candidate="$(find /usr/lib /usr/lib64 /opt /usr/local/lib /usr/local/lib64 \
    -maxdepth 3 -type f -name application.ini -path '*librewolf*' -printf '%h\n' 2>/dev/null | head -n1 || true)"
  [[ -n "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  return 1
}

install_librewolf_extension() {
  [[ $INSTALL_BROWSER -eq 1 ]] || return 0
  [[ -f "$XPI_SRC" ]] || { warn "XPI missing from package: $XPI_SRC"; return 1; }

  local root extdir
  if ! root="$(find_librewolf_root)"; then
    warn "Native LibreWolf installation root was not found; daemon is installed, but XPI deployment was skipped."
    warn "Flatpak LibreWolf is intentionally not modified by this native installer."
    return 0
  fi
  extdir="$root/distribution/extensions"
  mkdir -p "$extdir"
  install -m 0644 "$XPI_SRC" "$extdir/$EXTENSION_ID.xpi"
  printf '%s\n' "$extdir/$EXTENSION_ID.xpi" > "$ETCDIR/librewolf-extension-path.txt"
  chmod 600 "$ETCDIR/librewolf-extension-path.txt"
  log "Deployed extension: $extdir/$EXTENSION_ID.xpi"
}

select_source
validate_xpi
SOURCE="$(readlink -f "$SOURCE")"
[[ -e "$SOURCE" ]] || { echo "Config source not found: $SOURCE" >&2; exit 1; }
install_deps

# Validate and sanitize the replacement configuration before stopping or deleting
# the currently working bridge runtime.
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/configs"
python3 "$SELF_DIR/native/sanitize_configs.py" "$SOURCE" "$STAGE/configs" > "$STAGE/import-report.json"

backup_existing_config
snapshot_existing_runtime
remove_existing_bridge_runtime
mkdir -p "$LIBDIR" "$SHAREDIR" "$ETCDIR"
install -m 0755 "$SELF_DIR/native/routerd.py" "$LIBDIR/routerd.py"
install -m 0755 "$SELF_DIR/native/native_host.py" "$LIBDIR/native_host.py"
install -m 0755 "$SELF_DIR/native/sanitize_configs.py" "$LIBDIR/sanitize_configs.py"
install -m 0755 "$SELF_DIR/native/routerctl.py" /usr/local/bin/persona-mullvad-router
if [[ $INSTALL_BROWSER -eq 1 ]]; then
  install -m 0644 "$XPI_SRC" "$SHAREDIR/$EXTENSION_ID.xpi"
fi

rm -rf "$CONFDIR"
mkdir -p "$CONFDIR"
cp -a "$STAGE/configs/." "$CONFDIR/"
cp "$STAGE/entries.json" "$ETCDIR/entries.json"
chmod 700 "$ETCDIR" "$CONFDIR"
chmod 600 "$CONFDIR"/*.conf "$ETCDIR/entries.json"

mapfile -t ENTRY_IDS < <(find "$CONFDIR" -maxdepth 1 -type f -name '*.conf' -printf '%f\n' | sed 's/\.conf$//' | sort)
[[ ${#ENTRY_IDS[@]} -gt 0 ]] || { echo "No valid configs imported." >&2; exit 1; }

# Prefer Warsaw as the entry when it exists; the extension can switch entry at
# any time.
if [[ -z "$ENTRY_PATTERN" ]]; then
  for idv in "${ENTRY_IDS[@]}"; do
    if [[ "$idv" == pl-waw-* ]]; then
      ENTRY_PATTERN="pl-waw"
      break
    fi
  done
fi

SELECTED="${ENTRY_IDS[0]}"
if [[ -n "$ENTRY_PATTERN" ]]; then
  for idv in "${ENTRY_IDS[@]}"; do
    if [[ "$idv" == "$ENTRY_PATTERN" ]]; then
      SELECTED="$idv"
      break
    fi
  done
  if [[ "$SELECTED" != "$ENTRY_PATTERN" ]]; then
    for idv in "${ENTRY_IDS[@]}"; do
      if [[ "${idv,,}" == *"${ENTRY_PATTERN,,}"* ]]; then
        SELECTED="$idv"
        break
      fi
    done
  fi
fi

cp "$CONFDIR/$SELECTED.conf" "$ETCDIR/prm-mv.conf"
chmod 600 "$ETCDIR/prm-mv.conf"
printf '{"selected_entry":"%s"}\n' "$SELECTED" > "$ETCDIR/state.json"
chmod 600 "$ETCDIR/state.json"

# Native Messaging host manifest: Mozilla plus common native LibreWolf paths.
MANIFEST_SRC="$SELF_DIR/native/com.persona.mullvad_router.json"
for d in \
  /usr/lib/mozilla/native-messaging-hosts \
  /usr/lib64/mozilla/native-messaging-hosts \
  /usr/lib/librewolf/native-messaging-hosts \
  /usr/lib64/librewolf/native-messaging-hosts; do
  mkdir -p "$d"
  install -m 0644 "$MANIFEST_SRC" "$d/com.persona.mullvad_router.json"
done

SERVICE_TMP="$(mktemp)"
sed -e "s/@UID@/$TARGET_UID/g" -e "s/@GID@/$TARGET_GID/g" \
  "$SELF_DIR/native/persona-mullvad-router.service.in" > "$SERVICE_TMP"
install -m 0644 "$SERVICE_TMP" /etc/systemd/system/persona-mullvad-router.service
rm -f "$SERVICE_TMP"
systemctl daemon-reload
systemctl enable --now persona-mullvad-router.service
wait_for_router_daemon

configure_librewolf_xdg
install_librewolf_extension

disconnect_mullvad_app
if [[ $START_NOW -eq 1 ]]; then
  log "Starting Mullvad WireGuard entry tunnel..."
  if ! /usr/local/bin/persona-mullvad-router up; then
    echo "Bridge daemon is healthy, but the Mullvad tunnel did not become ready." >&2
    /usr/local/bin/persona-mullvad-router status >&2 || true
    journalctl -u persona-mullvad-router.service -n 30 --no-pager >&2 || true
    exit 1
  fi
fi

ROLLBACK_ARMED=0
cleanup_temporary_files
STAGE=""
XPI_PIN_DIR=""
ROLLBACK_DIR=""
trap - EXIT

cat <<EOF2

PersonaMonkey Mullvad Router ${VERSION} installed.

  Desktop user:      $TARGET_USER
  WireGuard entries: ${#ENTRY_IDS[@]}
  Selected entry:    $SELECTED
  Extension ID:      $EXTENSION_ID
$(if [[ -n "$BACKUP_PATH" ]]; then printf '  Private backup:    %s\n' "$BACKUP_PATH"; fi)

Next action: fully restart LibreWolf once.
After restart, open PersonaMonkey Route Manager, load Mullvad exits, and assign an
independent exit to each container. Several container exit countries can run
simultaneously over this one local Mullvad WireGuard entry.

Useful commands:
  persona-mullvad-router status
  persona-mullvad-router entries
  sudo $SELF_DIR/diagnose.sh

IMPORTANT: keep the supplied Mullvad WireGuard configuration and any private
backup ZIP private. They contain the WireGuard private key and must not be
committed or added to a public release.
EOF2
