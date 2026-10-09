import importlib.util
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = ROOT / "native" / "backup_configs.py"
SPEC = importlib.util.spec_from_file_location("backup_configs", HELPER_PATH)
backup_configs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup_configs)


class BridgeBackupTests(unittest.TestCase):
    def test_backup_contains_private_wireguard_material_and_only_expected_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "etc"
            configs = root / "configs"
            configs.mkdir(parents=True)
            private_key = "private-key-material-for-regression-test"
            (configs / "pl-waw-test.conf").write_text(
                "[Interface]\nPrivateKey = " + private_key + "\n",
                encoding="utf-8",
            )
            (root / "prm-mv.conf").write_text(
                "[Interface]\nPrivateKey = " + private_key + "\n",
                encoding="utf-8",
            )
            (root / "entries.json").write_text('{"entries":[]}', encoding="utf-8")
            (root / "state.json").write_text('{"selected_entry":"pl-waw-test"}', encoding="utf-8")
            (root / "librewolf-extension-path.txt").write_text("/should/not/archive", encoding="utf-8")
            (root / "other-secret.txt").write_text("not part of bridge backup", encoding="utf-8")

            destination = base / "backup.zip"
            result = backup_configs.create_backup(root, destination)

            self.assertEqual(result, destination)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(
                    set(archive.namelist()),
                    {
                        "configs/pl-waw-test.conf",
                        "prm-mv.conf",
                        "entries.json",
                        "state.json",
                    },
                )
                self.assertIn(
                    private_key,
                    archive.read("configs/pl-waw-test.conf").decode("utf-8"),
                )
                for info in archive.infolist():
                    self.assertEqual((info.external_attr >> 16) & 0o777, 0o600)

    def test_backup_requires_wireguard_config(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "etc"
            root.mkdir()
            with self.assertRaisesRegex(ValueError, "no WireGuard configuration"):
                backup_configs.create_backup(root, base / "backup.zip")

    def test_backup_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "etc"
            root.mkdir()
            (root / "prm-mv.conf").write_text(
                "[Interface]\nPrivateKey = test\n",
                encoding="utf-8",
            )
            destination = base / "backup.zip"
            destination.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                backup_configs.create_backup(root, destination)
            self.assertEqual(destination.read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
