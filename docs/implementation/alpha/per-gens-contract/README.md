# per-gens — minimal integration agreement

This is a **design-only** contract; do not restructure generator development prematurely. Alpha reads the configured single private `Neb963/per-gens` repository `main` branch at a commit-pinned snapshot. The operator can adjust literal templates for folder and filename layout. `DEPLOYMENT.md` must have exactly one status line: `Status: BLOCKED`, `Status: IN_DEVELOPMENT`, or `Status: READY`; absent/unknown/multiple values block deployment. A new reserved generator folder is initially created with only a BLOCKED status file.

Alpha ignores all files except status, `main.pjs`, `index.html`, and `thumbnail.jpeg` (mapped names configurable). READY persists after deployment; new deployable-content hashes on main are queued for the generator's next sleep period. Developer works on `generator/<slug>` branch, tests and merges independently; PCMS commits reviewed AI fixes directly to main only after verifying main/head and deployed source unchanged. Concurrent main changes block writeback; do not force push. PCMS may create a folder for a pre-existing READY generator after resolving its desired slug and confirmed Perchance ownership.

No fixed generator development docs, agents, lint tools, framework, or release manifest is imposed beyond this interface. Secrets remain outside the repository.
