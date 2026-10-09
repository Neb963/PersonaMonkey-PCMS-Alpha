#!/usr/bin/env python3
import argparse
import os
import stat
import tempfile
import zipfile
from pathlib import Path

PRIVATE_MODE = 0o600


def _files_to_backup(root: Path):
    files = []
    configs = root / "configs"
    if configs.is_dir():
        for source in sorted(configs.glob("*.conf")):
            if source.is_file() and not source.is_symlink():
                files.append((source, Path("configs") / source.name))

    for name in ("prm-mv.conf", "entries.json", "state.json"):
        source = root / name
        if source.is_file() and not source.is_symlink():
            files.append((source, Path(name)))

    return files


def create_backup(root: Path, destination: Path):
    files = _files_to_backup(root)
    if not any(str(archive).endswith(".conf") for _, archive in files):
        raise ValueError(f"no WireGuard configuration found under {root}")

    destination = destination.expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(f"refusing to overwrite existing backup: {destination}")

    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    os.close(fd)
    temporary = Path(temporary_name)
    os.chmod(temporary, PRIVATE_MODE)

    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for source, archive_name in files:
                info = zipfile.ZipInfo.from_file(source, arcname=str(archive_name))
                info.external_attr = (stat.S_IFREG | PRIVATE_MODE) << 16
                with source.open("rb") as handle:
                    archive.writestr(
                        info,
                        handle.read(),
                        compress_type=zipfile.ZIP_DEFLATED,
                        compresslevel=9,
                    )

        os.replace(temporary, destination)
        os.chmod(destination, PRIVATE_MODE)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

    return destination


def main():
    parser = argparse.ArgumentParser(
        description="Create a private backup ZIP of installed PersonaMonkey WireGuard configuration."
    )
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(create_backup(args.root, args.destination))


if __name__ == "__main__":
    main()
