#!/usr/bin/env python3
"""Check XPI metadata, structural signature markers, and a trusted digest."""

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


MOZILLA_SIGNATURE_FILES = {
    "meta-inf/manifest.mf",
    "meta-inf/mozilla.sf",
    "meta-inf/mozilla.rsa",
}


def validate_xpi(path, expected_version, expected_extension_id, expected_sha256):
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256 or ""):
        raise ValueError("a trusted expected SHA-256 digest is required")

    try:
        contents = Path(path).read_bytes()
    except OSError as error:
        raise ValueError(f"cannot read XPI: {error}") from error

    actual_sha256 = hashlib.sha256(contents).hexdigest()
    if actual_sha256.lower() != expected_sha256.lower():
        raise ValueError("XPI SHA-256 does not match the trusted expected digest")

    try:
        with zipfile.ZipFile(io.BytesIO(contents)) as archive:
            names = {name.lower() for name in archive.namelist()}
            missing_signature_files = MOZILLA_SIGNATURE_FILES - names
            if missing_signature_files:
                raise ValueError(
                    "XPI is missing required Mozilla signature-container members: "
                    + ", ".join(sorted(missing_signature_files))
                )
            manifest = json.loads(archive.read("manifest.json"))
    except (
        FileNotFoundError,
        KeyError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        RuntimeError,
        zipfile.BadZipFile,
    ) as error:
        raise ValueError(f"invalid XPI: {error}") from error

    if not isinstance(manifest, dict):
        raise ValueError("invalid XPI manifest: expected a JSON object")
    if manifest.get("manifest_version") != 3:
        raise ValueError("XPI manifest_version must be 3")

    version = manifest.get("version")
    if version != expected_version:
        raise ValueError(
            f"XPI version {version or 'missing'} does not match source version {expected_version}"
        )

    extension_id = (
        manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
    )
    if extension_id != expected_extension_id:
        raise ValueError(
            f"XPI extension ID {extension_id or 'missing'} does not match {expected_extension_id}"
        )
    return contents


def pin_verified_xpi(contents):
    """Write the exact validated bytes to a private temporary directory."""
    directory = Path(tempfile.mkdtemp(prefix="persona-router-xpi-"))
    try:
        path = directory / "verified.xpi"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        return directory, path
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xpi", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument(
        "--sha256",
        required=True,
        help="trusted SHA-256 digest for the signed XPI (obtained independently of the XPI file)",
    )
    parser.add_argument(
        "--pin-verified",
        action="store_true",
        help="write the exact validated bytes to a private temporary directory and print its path",
    )
    args = parser.parse_args()

    try:
        contents = validate_xpi(args.xpi, args.version, args.extension_id, args.sha256)
    except ValueError as error:
        print(f"XPI validation failed: {error}", file=sys.stderr)
        return 1

    if args.pin_verified:
        try:
            _directory, path = pin_verified_xpi(contents)
        except OSError as error:
            print(f"XPI validation failed: cannot pin validated XPI: {error}", file=sys.stderr)
            return 1
        print(path)
    else:
        print(f"Validated XPI metadata and SHA-256 for version {args.version}: {args.xpi}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
