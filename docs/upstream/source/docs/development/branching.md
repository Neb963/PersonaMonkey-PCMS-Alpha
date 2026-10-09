# Branching and change policy

`main` is the canonical source branch. Use short-lived topic branches based on current `main`, then merge them through the repository's normal review process. Tags identify released source commits; release branches and copied source trees are not alternate current sources.

Before editing, inspect the current branch, working-tree status, recent history, repository instructions, and relevant contracts. Keep unrelated user work intact. Separate independent behavior, documentation, and release-metadata changes when that makes review clearer. Do not reset, rebase, force-push, or rewrite shared branch/tag history without explicit authorization.

Use focused commits with conventional messages, for example `fix: preserve persona route on rotation` or `docs: clarify release candidate checks`. Before each commit, review the staged diff and run the relevant checks. Do not commit credentials, cookies, browser exports, private backups, WireGuard/private configuration, generated release archives, logs, or temporary debugging files.

## Compatibility-sensitive changes

Before changing persisted data, package formats, browser/native IDs, or documented API behavior:

1. identify the canonical contract in [`docs/README.md`](../README.md) and [`docs/reference/compatibility.md`](../reference/compatibility.md);
2. describe any required versioning or migration;
3. add regression coverage for both supported old data and the new behavior;
4. update the canonical documentation in the same change.

Keep the Management API's legacy `PCMS_*` wire identifiers stable unless a deliberate compatibility decision authorizes a migration. Do not infer external Integration API behavior from internal protocol names.

## Security-sensitive changes

Changes to routing, isolation, external authorization, secret projection, backup/import, userscript privileges, or native messaging require focused security review and tests. Follow [`SECURITY.md`](../../SECURITY.md) for vulnerability and private-data handling. A cleanup commit cannot remove secrets from earlier Git history; if private material is exposed, rotate it and follow the incident guidance there.

See [`Testing`](testing.md) for local gates and [`Release`](release.md) for freezing and publishing a candidate.
