import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install.sh"
ROUTERCTL = ROOT / "native" / "routerctl.py"


class InstallerUpgradeTests(unittest.TestCase):
    def test_shell_entrypoints_parse(self):
        for name in ("install.sh", "uninstall.sh", "diagnose.sh"):
            result = subprocess.run(
                ["bash", "-n", str(ROOT / name)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, f"{name}: {result.stderr}")

    def test_upgrade_validates_and_backs_up_before_runtime_removal(self):
        installer = INSTALLER.read_text(encoding="utf-8")
        sanitize = installer.index(
            'python3 "$SELF_DIR/native/sanitize_configs.py" "$SOURCE" "$STAGE/configs"'
        )
        backup = installer.index("backup_existing_config\nsnapshot_existing_runtime")
        snapshot = installer.index("snapshot_existing_runtime\nremove_existing_bridge_runtime")
        remove = installer.index("remove_existing_bridge_runtime\nmkdir -p")
        self.assertLess(sanitize, backup)
        self.assertLess(backup, snapshot)
        self.assertLess(snapshot, remove)

    def test_no_argument_upgrade_reuses_installed_private_config(self):
        installer = INSTALLER.read_text(encoding="utf-8")
        self.assertIn('SOURCE="$CONFDIR"', installer)
        self.assertIn('SOURCE="$ETCDIR/prm-mv.conf"', installer)
        self.assertIn("persona-mullvad-router-private-backup-", installer)

    def test_service_readiness_requires_live_desktop_user_ping(self):
        installer = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("systemctl is-active --quiet persona-mullvad-router.service", installer)
        self.assertIn("[[ -S /run/persona-mullvad-router/control.sock ]]", installer)
        self.assertIn(
            'runuser -u "$TARGET_USER" -- /usr/local/bin/persona-mullvad-router ping',
            installer,
        )
        self.assertIn("stable=$((stable + 1))", installer)
        self.assertIn("[[ $stable -ge 2 ]]", installer)
        self.assertNotIn(
            '[[ -S /run/persona-mullvad-router/control.sock ]] && { ready=1; break; }',
            installer,
        )

    def test_daemon_is_verified_before_browser_or_tunnel_steps(self):
        installer = INSTALLER.read_text(encoding="utf-8")
        enable = installer.index("systemctl enable --now persona-mullvad-router.service")
        health = installer.index("wait_for_router_daemon", enable)
        browser = installer.index("configure_librewolf_xdg", enable)
        tunnel = installer.index('log "Starting Mullvad WireGuard entry tunnel..."', enable)
        self.assertLess(enable, health)
        self.assertLess(health, browser)
        self.assertLess(health, tunnel)

    def test_failed_upgrade_restores_previous_runtime(self):
        installer = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("snapshot_existing_runtime()", installer)
        self.assertIn("restore_previous_runtime()", installer)
        self.assertIn("trap on_exit EXIT", installer)
        self.assertIn("ROLLBACK_ARMED=1", installer)
        self.assertIn('if [[ $status -ne 0 && $ROLLBACK_ARMED -eq 1 ]]', installer)
        self.assertIn('cp -a "$ROLLBACK_DIR/etc" "$ETCDIR"', installer)
        self.assertIn('cp -a "$ROLLBACK_DIR/lib" "$LIBDIR"', installer)
        self.assertIn("ROLLBACK_SERVICE_ENABLED", installer)
        self.assertIn("ROLLBACK_SERVICE_ACTIVE", installer)
        self.assertIn("ROLLBACK_TUNNEL_UP", installer)
        self.assertIn("ROLLBACK_ARMED=0\ncleanup_temporary_files", installer)

    def test_routerctl_exposes_ping(self):
        source = ROUTERCTL.read_text(encoding="utf-8")
        self.assertIn('sub.add_parser("ping")', source)
        self.assertIn('"ping":"ping"', source)


if __name__ == "__main__":
    unittest.main()
