import json
import hashlib
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_xpi.py"
PREFS_HELPER = ROOT / "scripts" / "librewolf_prefs.py"
PREFS_SPEC = importlib.util.spec_from_file_location("prm_librewolf_prefs_test", PREFS_HELPER)
PREFS_MODULE = importlib.util.module_from_spec(PREFS_SPEC)
PREFS_SPEC.loader.exec_module(PREFS_MODULE)
SOURCE_MANIFEST = json.loads((ROOT / "extension" / "manifest.json").read_text())
PACKAGE = json.loads((ROOT / "package.json").read_text())
VERSION = SOURCE_MANIFEST["version"]
EXTENSION_ID = SOURCE_MANIFEST["browser_specific_settings"]["gecko"]["id"]


class ReleaseArtifactTests(unittest.TestCase):
    def test_product_version_matches_package(self):
        self.assertEqual(VERSION, PACKAGE["version"])

    def make_xpi(self, manifest):
        temporary = tempfile.NamedTemporaryFile(suffix=".xpi", delete=False)
        temporary.close()
        path = Path(temporary.name)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            # Synthetic structural members for validator tests. These bytes
            # are not a cryptographic Mozilla signature.
            archive.writestr("META-INF/manifest.mf", b"fixture")
            archive.writestr("META-INF/mozilla.sf", b"fixture")
            archive.writestr("META-INF/mozilla.rsa", b"fixture")
        self.addCleanup(path.unlink, missing_ok=True)
        return path

    def run_validator(self, path, expected_sha256=None):
        expected_sha256 = expected_sha256 or hashlib.sha256(path.read_bytes()).hexdigest()
        return subprocess.run(
            [
                "python3",
                str(VALIDATOR),
                str(path),
                "--version",
                VERSION,
                "--extension-id",
                EXTENSION_ID,
                "--sha256",
                expected_sha256,
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def valid_manifest(self):
        return {
            "manifest_version": 3,
            "version": VERSION,
            "browser_specific_settings": {"gecko": {"id": EXTENSION_ID}},
        }

    def test_accepts_matching_metadata_markers_and_digest(self):
        self.assertEqual(self.run_validator(self.make_xpi(self.valid_manifest())).returncode, 0)

    def test_rejects_missing_signature_container_members(self):
        temporary = tempfile.NamedTemporaryFile(suffix=".xpi", delete=False)
        temporary.close()
        path = Path(temporary.name)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("manifest.json", json.dumps(self.valid_manifest()))
        self.addCleanup(path.unlink, missing_ok=True)
        result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature-container members", result.stderr)

    def test_rejects_wrong_trusted_digest(self):
        path = self.make_xpi(self.valid_manifest())
        result = self.run_validator(path, "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the trusted expected digest", result.stderr)

    def test_pin_uses_exact_validated_bytes_in_private_file(self):
        path = self.make_xpi(self.valid_manifest())
        result = subprocess.run(
            [
                "python3",
                str(VALIDATOR),
                str(path),
                "--version",
                VERSION,
                "--extension-id",
                EXTENSION_ID,
                "--sha256",
                hashlib.sha256(path.read_bytes()).hexdigest(),
                "--pin-verified",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        pinned = Path(result.stdout.strip())
        self.addCleanup(shutil.rmtree, pinned.parent, ignore_errors=True)
        self.assertEqual(pinned.read_bytes(), path.read_bytes())
        self.assertEqual(pinned.stat().st_mode & 0o777, 0o600)

    def test_rejects_wrong_extension_id(self):
        manifest = self.valid_manifest()
        manifest["browser_specific_settings"]["gecko"]["id"] = "other@example.test"
        result = self.run_validator(self.make_xpi(manifest))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("extension ID", result.stderr)

    def test_rejects_wrong_version(self):
        manifest = self.valid_manifest()
        manifest["version"] = "0.3.0"
        result = self.run_validator(self.make_xpi(manifest))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match source version", result.stderr)

    def test_rejects_wrong_manifest_version(self):
        manifest = self.valid_manifest()
        manifest["manifest_version"] = 2
        result = self.run_validator(self.make_xpi(manifest))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest_version must be 3", result.stderr)

    def test_rejects_malformed_xpi(self):
        temporary = tempfile.NamedTemporaryFile(suffix=".xpi", delete=False)
        temporary.write(b"not a zip")
        temporary.close()
        path = Path(temporary.name)
        self.addCleanup(path.unlink, missing_ok=True)
        result = self.run_validator(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid XPI", result.stderr)


class InstallerIntegrityTests(unittest.TestCase):
    def run_prefs(self, command, config_path, state_dir, *options):
        return subprocess.run(
            ["python3", str(PREFS_HELPER), command, str(config_path), str(state_dir), *options]
            if command == "configure"
            else ["python3", str(PREFS_HELPER), command, str(state_dir)],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_pref_round_trip_preserves_signature_and_existing_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "librewolf.overrides.cfg"
            state = root / "state"
            original = (
                b'// existing user prefs\n'
                b'pref("xpinstall.signatures.required", true);\n'
                b'pref("extensions.installDistroAddons", false);\n'
                b'pref("some.user.setting", 5);\n'
            )
            config.write_bytes(original)
            result = self.run_prefs(
                "configure", config, state, "--install-browser", "1", "--configure-librewolf", "1"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            configured = config.read_bytes()
            self.assertIn(b'pref("xpinstall.signatures.required", true);', configured)
            self.assertIn(b'pref("extensions.installDistroAddons", false);', configured)
            self.assertIn(b"BEGIN PersonaMonkey Mullvad Router managed preferences", configured)

            result = self.run_prefs("uninstall", config, state)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(config.read_bytes(), original)

    def test_state_write_failure_leaves_preferences_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "librewolf.overrides.cfg"
            state = root / "state"
            original = b'pref("xpinstall.signatures.required", true);\n'
            config.write_bytes(original)
            real_write = PREFS_MODULE._write_atomic

            def fail_state_write(path, *args, **kwargs):
                if Path(path).name == PREFS_MODULE.STATE_NAME:
                    raise OSError("injected state write failure")
                return real_write(path, *args, **kwargs)

            with patch.object(PREFS_MODULE, "_write_atomic", side_effect=fail_state_write):
                with self.assertRaisesRegex(OSError, "injected state write failure"):
                    PREFS_MODULE.configure(config, state, "1", "1")

            self.assertEqual(config.read_bytes(), original)
            self.assertFalse((state / PREFS_MODULE.STATE_NAME).exists())

    def test_uninstall_preserves_post_install_user_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "librewolf.overrides.cfg"
            state = root / "state"
            original = b'pref("xpinstall.signatures.required", true);\n'
            config.write_bytes(original)
            result = self.run_prefs(
                "configure", config, state, "--install-browser", "1", "--configure-librewolf", "1"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            with config.open("ab") as output:
                output.write(b'pref("extensions.installDistroAddons", false); // user edit\n')
                output.write(b'// preserve this comment\n')

            result = self.run_prefs("uninstall", config, state)
            self.assertEqual(result.returncode, 0, result.stderr)
            final = config.read_bytes()
            self.assertIn(b'pref("xpinstall.signatures.required", true);', final)
            self.assertIn(b'pref("extensions.installDistroAddons", false); // user edit', final)
            self.assertIn(b"// preserve this comment", final)
            self.assertNotIn(b"BEGIN PersonaMonkey Mullvad Router managed preferences", final)

    def test_created_config_is_removed_only_when_no_user_content_remains(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "created.cfg"
            state = root / "state"
            result = self.run_prefs(
                "configure", config, state, "--install-browser", "1", "--configure-librewolf", "1"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_prefs("uninstall", config, state)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(config.exists())

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "created.cfg"
            state = root / "state"
            result = self.run_prefs(
                "configure", config, state, "--install-browser", "1", "--configure-librewolf", "1"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            with config.open("ab") as output:
                output.write(b'pref("extensions.installDistroAddons", false);\n')
            result = self.run_prefs("uninstall", config, state)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(config.exists())
            self.assertIn(b'pref("extensions.installDistroAddons", false);', config.read_bytes())

    def test_no_browser_install_is_a_preference_no_op(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "must-not-exist.cfg"
            state = root / "state"
            result = self.run_prefs(
                "configure", config, state, "--install-browser", "0", "--configure-librewolf", "1"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(config.exists())
            self.assertFalse(state.exists())

    def test_uninstall_removes_only_exact_legacy_signature_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "librewolf.overrides.cfg"
            state = root / "state"
            state.mkdir()
            config.write_bytes(
                b'// user content\n'
                b'// Persona Mullvad Router - local personal extension installation\n'
                b'pref("xpinstall.signatures.required", false);\n'
                b'pref("extensions.installDistroAddons", true);\n'
                b'pref("extensions.installDistroAddons", false); // later user edit\n'
            )
            (state / "librewolf-overrides-path.txt").write_text(str(config) + "\n")
            (state / "librewolf-overrides-created.txt").write_text("0\n")
            (state / "librewolf-pref-backup.txt").write_text(
                'pref("xpinstall.signatures.required", true);\n'
                'pref("extensions.installDistroAddons", false);\n'
            )

            result = self.run_prefs("uninstall", config, state)
            self.assertEqual(result.returncode, 0, result.stderr)
            final = config.read_bytes()
            self.assertIn(b'pref("xpinstall.signatures.required", true);', final)
            self.assertIn(b'pref("extensions.installDistroAddons", false); // later user edit', final)
            self.assertNotIn(b'pref("xpinstall.signatures.required", false);', final)

    def test_extension_id_is_consistent_across_installer_and_native_allowlist(self):
        native = json.loads((ROOT / "native" / "com.persona.mullvad_router.json").read_text())
        installer = (ROOT / "install.sh").read_text()
        uninstaller = (ROOT / "uninstall.sh").read_text()
        install_id = re.search(r'^EXTENSION_ID="([^"]+)"$', installer, re.MULTILINE)
        uninstall_id = re.search(r'^EXTENSION_ID="([^"]+)"$', uninstaller, re.MULTILINE)
        self.assertIsNotNone(install_id)
        self.assertIsNotNone(uninstall_id)
        self.assertEqual(install_id.group(1), EXTENSION_ID)
        self.assertEqual(uninstall_id.group(1), EXTENSION_ID)
        self.assertEqual(native["allowed_extensions"], [EXTENSION_ID])

    def test_xpi_preflight_precedes_dependency_or_service_mutation(self):
        installer = (ROOT / "install.sh").read_text()

        # Inspect only the top-level execution phase. Helper function bodies
        # intentionally contain service/runtime operations before this point,
        # but they are definitions and do not execute during preflight.
        execution = installer[installer.index("\nselect_source\n"):]

        preflight = execution.index("\nvalidate_xpi\n")
        source_check = execution.index('SOURCE="$(readlink -f "$SOURCE")"')
        dependency_install = execution.index("\ninstall_deps\n")
        config_staging = execution.index('STAGE="$(mktemp -d)"')
        backup = execution.index("\nbackup_existing_config\n")
        runtime_removal = execution.index("\nremove_existing_bridge_runtime\n")
        service_enable = execution.index(
            "\nsystemctl enable --now persona-mullvad-router.service\n"
        )

        self.assertLess(preflight, source_check)
        for mutation in (
            dependency_install,
            config_staging,
            backup,
            runtime_removal,
            service_enable,
        ):
            self.assertLess(preflight, mutation)

        self.assertLess(source_check, dependency_install)
        self.assertLess(config_staging, backup)
        self.assertLess(backup, runtime_removal)
        self.assertLess(runtime_removal, service_enable)
        self.assertNotIn('xpinstall.signatures.required", false', installer)

    def test_uninstaller_runs_preference_cleanup_before_destructive_steps(self):
        uninstaller = (ROOT / "uninstall.sh").read_text()
        preference_cleanup = uninstaller.index(
            'python3 "$SELF_DIR/scripts/librewolf_prefs.py" uninstall "$ETCDIR"'
        )
        service_stop = uninstaller.index("systemctl disable --now")
        remove_system_files = uninstaller.index('rm -rf "$ETCDIR"')
        self.assertLess(preference_cleanup, service_stop)
        self.assertLess(preference_cleanup, remove_system_files)
        self.assertIn("if ! python3 \"$SELF_DIR/scripts/librewolf_prefs.py\" uninstall", uninstaller)
        self.assertIn("uninstall aborted before system changes", uninstaller)

    def test_uninstall_rejects_empty_restore_path_without_changing_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            state.mkdir()
            state_file = state / PREFS_MODULE.STATE_NAME
            state_file.write_text('{"config_path": ""}\n')
            original = state_file.read_bytes()

            result = self.run_prefs("uninstall", Path("unused"), state)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("non-empty absolute configuration path", result.stderr)
            self.assertEqual(state_file.read_bytes(), original)

    @unittest.skipUnless(os.geteuid() == 0, "runs a guarded uninstall subprocess as root")
    def test_uninstaller_empty_state_path_preserves_state_and_stops_before_system_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            state.mkdir()
            sentinel = state / "restore-metadata.txt"
            sentinel.write_text("preserve for retry\n")
            malformed_state = state / PREFS_MODULE.STATE_NAME
            malformed_state.write_text('{"config_path": ""}\n')
            malformed_state_bytes = malformed_state.read_bytes()
            repo_copy = root / "repo"
            (repo_copy / "scripts").mkdir(parents=True)
            (repo_copy / "scripts" / "librewolf_prefs.py").write_text(PREFS_HELPER.read_text())
            script = (ROOT / "uninstall.sh").read_text().replace(
                "ETCDIR=/etc/persona-mullvad-router", f'ETCDIR="{state}"'
            )
            script = script.replace(
                "if [[ -S /run/persona-mullvad-router/control.sock && -x /usr/local/bin/persona-mullvad-router ]]; then",
                "if false; then",
            )
            self.assertNotEqual(script, (ROOT / "uninstall.sh").read_text())
            uninstaller = repo_copy / "uninstall.sh"
            uninstaller.write_text(script)
            uninstaller.chmod(0o755)

            fake_bin = root / "bin"
            fake_bin.mkdir()
            trace = root / "calls.log"
            python = fake_bin / "python3"
            python.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' 'python3' >> \"$TRACE_FILE\"\n"
                "exec \"$REAL_PYTHON\" \"$@\"\n"
            )
            python.chmod(0o755)
            for name in ("rm", "ip", "systemctl"):
                command = fake_bin / name
                command.write_text(
                    "#!/bin/sh\n"
                    f"printf '%s\\n' '{name}' >> \"$TRACE_FILE\"\n"
                    "exit 0\n"
                )
                command.chmod(0o755)

            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:/usr/bin:/bin"
            environment["TRACE_FILE"] = str(trace)
            environment["REAL_PYTHON"] = sys.executable
            result = subprocess.run(
                [str(uninstaller)], text=True, capture_output=True, env=environment, check=False
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("uninstall aborted before system changes", result.stderr)
            self.assertIn("non-empty absolute configuration path", result.stderr)
            self.assertEqual(trace.read_text().splitlines(), ["python3"])
            self.assertEqual(sentinel.read_text(), "preserve for retry\n")
            self.assertEqual(malformed_state.read_bytes(), malformed_state_bytes)


if __name__ == "__main__":
    unittest.main()
