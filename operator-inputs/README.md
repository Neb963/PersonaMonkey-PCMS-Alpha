# Operator inputs

This directory is intentionally ignored by Git except for this file.

Local/live test inputs may be placed here by the repository owner, including disposable account fixtures or Mullvad WireGuard material.

Rules:
- never commit these files;
- never print their contents;
- never copy them into test fixtures or reports;
- never upload them as GitHub Actions artifacts;
- use explicit filenames/paths rather than broad globs;
- remove/revoke disposable inputs after the live acceptance work that needed them.

Normal deterministic GitHub Actions must not require these inputs.
