#!/usr/bin/env python3
"""Manage only PersonaMonkey's marked LibreWolf preference block."""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path


START = b"// BEGIN PersonaMonkey Mullvad Router managed preferences"
END = b"// END PersonaMonkey Mullvad Router managed preferences"
MANAGED_BLOCK = (
    START
    + b'\npref("extensions.installDistroAddons", true);\n'
    + END
)
LEGACY_MARKER = b"// Persona Mullvad Router - local personal extension installation"
PREF_KEY = re.compile(
    rb'^[ \t]*(?:defaultPref|pref)[ \t]*\([ \t]*"([^"]+)"', re.MULTILINE
)
LEGACY_SIGNATURE = b'pref("xpinstall.signatures.required", false);'
LEGACY_DISTRO = b'pref("extensions.installDistroAddons", true);'
STATE_NAME = "librewolf-overrides-state.json"


def _write_atomic(path, contents, mode=0o600, owner=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        if owner is not None:
            os.chown(temporary, *owner)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _parse_owner(value):
    if value is None:
        return None
    uid, gid = value.split(":", 1)
    return int(uid), int(gid)


def _load_state(state_dir):
    state_path = state_dir / STATE_NAME
    if state_path.exists() or state_path.is_symlink():
        if state_path.is_symlink() or not state_path.is_file():
            raise ValueError(f"invalid LibreWolf preference state file: {state_path}")
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"cannot read LibreWolf preference state: {error}") from error
        config_path = state.get("config_path") if isinstance(state, dict) else None
        if (
            not isinstance(config_path, str)
            or not config_path
            or not Path(config_path).is_absolute()
        ):
            raise ValueError("LibreWolf preference state needs a non-empty absolute configuration path")
        return state

    # Read paths written by previous installer versions for targeted legacy
    # cleanup. Do not infer ownership from a matching preference name alone.
    legacy_path = state_dir / "librewolf-overrides-path.txt"
    if legacy_path.exists() or legacy_path.is_symlink():
        if legacy_path.is_symlink() or not legacy_path.is_file():
            raise ValueError(f"invalid legacy LibreWolf preference state file: {legacy_path}")
        try:
            lines = legacy_path.read_text(encoding="utf-8").splitlines()
            if not lines or not lines[0] or not Path(lines[0]).is_absolute():
                raise ValueError("legacy LibreWolf preference state needs an absolute configuration path")
            state = {"config_path": lines[0]}
            created_path = state_dir / "librewolf-overrides-created.txt"
            if created_path.is_file():
                state["created_by_installer"] = (
                    created_path.read_text(encoding="utf-8").splitlines()[0] == "1"
                )
            return state
        except OSError as error:
            raise ValueError(f"cannot read legacy LibreWolf preference state: {error}") from error
    return None


def _line_key(line):
    match = PREF_KEY.match(line.rstrip(b"\r\n"))
    return match.group(1) if match else None


def _migrate_legacy_managed_lines(contents, state_dir):
    """Remove exact old installer blocks, restoring only settings they replaced."""
    lines = contents.splitlines(keepends=True)
    backup_path = state_dir / "librewolf-pref-backup.txt"
    if backup_path.exists() or backup_path.is_symlink():
        if backup_path.is_symlink() or not backup_path.is_file():
            raise ValueError(f"invalid LibreWolf preference backup file: {backup_path}")
        try:
            backup_lines = backup_path.read_bytes().splitlines(keepends=True)
        except OSError as error:
            raise ValueError(f"cannot read LibreWolf preference backup: {error}") from error
    else:
        backup_lines = []

    backup_by_key = {}
    for line in backup_lines:
        key = _line_key(line)
        if key in (b"xpinstall.signatures.required", b"extensions.installDistroAddons"):
            backup_by_key.setdefault(key, []).append(line)

    output = []
    i = 0
    changed = False
    preserve_user_distro = False
    while i < len(lines):
        block = None
        removed_keys = set()
        if lines[i].rstrip(b"\r\n") == LEGACY_MARKER:
            if i + 2 < len(lines) and tuple(
                line.rstrip(b"\r\n") for line in lines[i + 1 : i + 3]
            ) == (LEGACY_SIGNATURE, LEGACY_DISTRO):
                block = 3
                removed_keys = {
                    b"xpinstall.signatures.required",
                    b"extensions.installDistroAddons",
                }
            elif i + 1 < len(lines) and lines[i + 1].rstrip(b"\r\n") == LEGACY_DISTRO:
                block = 2
                removed_keys = {b"extensions.installDistroAddons"}

        if block is None:
            output.append(lines[i])
            i += 1
            continue

        changed = True
        outside_keys = set()
        for line in lines[:i] + lines[i + block :]:
            key = _line_key(line)
            if key is not None:
                outside_keys.add(key)
        if b"extensions.installDistroAddons" in outside_keys:
            preserve_user_distro = True
        restore = [
            line
            for key in removed_keys
            if key not in outside_keys
            for line in backup_by_key.get(key, [])
        ]
        output.extend(restore)
        i += block

    return b"".join(output), changed, preserve_user_distro


def configure(config_path, state_dir, install_browser, configure_librewolf, owner=None):
    if str(install_browser) != "1" or str(configure_librewolf) != "1":
        return False

    config_path = Path(config_path)
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    state_path = state_dir / STATE_NAME

    if config_path.is_symlink():
        raise ValueError(f"refusing to replace symlinked preferences file: {config_path}")
    existed = config_path.is_file()
    original = config_path.read_bytes() if existed else b""
    migrated, _, preserve_user_distro = _migrate_legacy_managed_lines(
        original, state_dir
    )

    # An existing or edited marked block belongs to this installer/user. Leave
    # it alone on upgrades so a user edit inside the block is never overwritten.
    has_managed_marker = START in migrated or END in migrated
    contents = migrated
    if not has_managed_marker and not preserve_user_distro:
        separator = b"\n" if contents and not contents.endswith((b"\n", b"\r")) else b""
        contents += separator + MANAGED_BLOCK + b"\n"

    if state_path.exists():
        state = _load_state(state_dir)
        if state is None or state.get("config_path") != str(config_path):
            raise ValueError("existing LibreWolf preference state refers to another configuration file")
    else:
        state = {
            "config_path": str(config_path),
            "created_by_installer": not existed,
            "original_sha256": hashlib.sha256(original).hexdigest(),
            "original_size": len(original),
        }
        # Persist the restore record before changing the user's preferences.
        _write_atomic(state_path, (json.dumps(state, sort_keys=True) + "\n").encode(), mode=0o600)

    if contents != original or not existed:
        _write_atomic(config_path, contents, mode=0o600, owner=owner)
    return True


def uninstall(state_dir):
    state_dir = Path(state_dir)
    state = _load_state(state_dir)
    if not state:
        return False
    config_path = Path(state["config_path"])
    if config_path.is_symlink():
        raise ValueError(f"refusing to replace symlinked preferences file: {config_path}")
    if not config_path.is_file():
        return False

    contents = config_path.read_bytes()
    original = contents
    if MANAGED_BLOCK in contents:
        block_at = contents.find(MANAGED_BLOCK)
        before = contents[:block_at]
        after = contents[block_at + len(MANAGED_BLOCK) :]
        contents = before + after

        # Remove our own delimiter bytes only when the resulting file matches
        # the pre-install fingerprint. If the user changed anything outside
        # the marked block, retain those bytes and their surrounding newlines.
        candidates = [contents]
        if after.startswith(b"\r\n"):
            candidates.append(before + after[2:])
        elif after.startswith(b"\n"):
            candidates.append(before + after[1:])
        for candidate in tuple(candidates):
            if block_at and candidate[:block_at].endswith(b"\r\n"):
                candidates.append(candidate[:block_at - 2] + candidate[block_at:])
            elif block_at and candidate[:block_at].endswith(b"\n"):
                candidates.append(candidate[:block_at - 1] + candidate[block_at:])
        expected_hash = state.get("original_sha256")
        expected_size = state.get("original_size")
        for candidate in candidates:
            if (
                expected_hash
                and len(candidate) == expected_size
                and hashlib.sha256(candidate).hexdigest() == expected_hash
            ):
                contents = candidate
                break

    contents, migrated, _ = _migrate_legacy_managed_lines(contents, state_dir)
    changed = contents != original or migrated
    if not changed:
        return False

    created = state.get("created_by_installer") is True
    # A file made by the installer is removed only if no non-whitespace user
    # content remains after our exact marked block has been removed.
    if created and not contents.strip():
        try:
            config_path.unlink()
        except FileNotFoundError:
            pass
    else:
        file_stat = config_path.stat()
        mode = stat.S_IMODE(file_stat.st_mode)
        _write_atomic(config_path, contents, mode=mode, owner=(file_stat.st_uid, file_stat.st_gid))

    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    configure_parser = subparsers.add_parser("configure")
    configure_parser.add_argument("config_path", type=Path)
    configure_parser.add_argument("state_dir", type=Path)
    configure_parser.add_argument("--install-browser", default="0")
    configure_parser.add_argument("--configure-librewolf", default="0")
    configure_parser.add_argument("--owner")
    uninstall_parser = subparsers.add_parser("uninstall")
    uninstall_parser.add_argument("state_dir", type=Path)
    args = parser.parse_args()

    try:
        if args.command == "configure":
            configure(
                args.config_path,
                args.state_dir,
                args.install_browser,
                args.configure_librewolf,
                _parse_owner(args.owner),
            )
        else:
            uninstall(args.state_dir)
    except (OSError, TypeError, ValueError) as error:
        print(f"LibreWolf preference update failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
