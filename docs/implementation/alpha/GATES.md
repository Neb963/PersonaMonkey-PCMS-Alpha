# Alpha integration gates and acceptance procedure

## Bootstrap gate G0 (serialized)

Before R1: latest donor main pinned and attributed, Alpha normative files committed, `AGENTS.md` authoritative, phase plan and contract hashes valid, claim validator rejects overlaps/stale epochs, basic build/CI established, no parallel claims active. Record verified SHA, CI run, any unresolved feasibility risks. **No phase may start on an empty Alpha repository.**

## Every GATE-Rn (after its five phase agents)

1. Fetch live `main`, open PRs, claims and current plan. Confirm exactly the planned phase IDs and all five agent reports; do not infer completion from messages.
2. For each phase check valid claim epoch/base SHA, no overlapping path/contracts/resources/migration slot, approved scope, exact acceptance IDs, evidence file on branch with actual command/CI run and commit SHA, no redacted secrets in artifacts.
3. Validate PR state; independently inspect diff and workflow conclusions. Merge only with GitHub merge queue when available, or serialized current-main ref preconditions plus post-merge CI against current main, rerun required checks after every relevant merge. The checker must not use `force` or mark a PR accepted solely from CI on stale head.
4. Run or inspect combined acceptance suite against **merged main**: static contracts, schema, unit/integration, emulator fixtures, packaging/startup/pinned Firefox, security, fault tests as applicable for this round. Verify no second background authority, invalid cross-feature imports or stale claimant.
5. Inspect failures deeply; do not waive required tests, fabricate evidence or assume provider-live. Isolate bug, file a bounded repair claim or return it to originating phase agent. Integration checker may edit only gate-owned files and generated status/plan state unless separately assigned a repair claim. Block next round until repaired and rerun combined gate.
6. Regenerate views from authoritative machine-readable plan; update phase states only to supported level. Update independent round evidence with merged SHA, exact runs, accepted acceptance IDs and unresolved risks. Commit/push and verify that evidence itself does not break CI.
7. Only when all five phase acceptance IDs and combined integration criteria pass, mark round GATE_VERIFIED/ACCEPTED and unlock subsequent READY phases. **Stop**; do not implement next round.

## Specific round checks

- **R1:** PersonaMonkey regression baseline still installs; architecture boundaries and frozen contracts; Perchance emulator and Github template security; UI static shell; no PII in tests; exact Firefox pin.
- **R2:** one logical Core authority, browser background unload/restart, timers, account binding epoch and Perchance ownership, READY parsing, 1k inventory read, backup schema and fail-closed import preview.
- **R3:** reservation atomic intention + dual remote reconciliation, sleep-only source mutation, Perchance AI concurrency and transient tab fencing, operational-time schedule, listing pin/filter fixtures, no endless rapid retries.
- **R4:** actual cross-feature supply→deploy→AI approval→commit→public→refresh flow under deterministic provider; failure rollback unlisted/sleep; attention and bounded tabs; complete backup/restore, download retention limitations; no global workflow engine.
- **R5:** UI uses Core projections, no direct provider mutation, bulk-first navigation, 1k-list performance, keyboard/focus, multi-dashboard consistency, action-required desktop notices and backup/restore UX.
- **R6:** packaged XPI boots cleanly without dormant duplicate PCMS authority, complete regression+fault+security suite, reproductions of failed provider behaviors, recover on browser shutdown/unload, readback and GitHub conflict, source-drift detection and deletion confirmation, reproducible artifact and human live-test checklist. No premature LIVE PASS.

## Final operator-live acceptance (after R6; not counted as an implementation round)

Use a disposable clean Firefox profile, 2 real accounts initially, actual Persona route(s), operator-driven login, Cloudflare manual intervention, GitHub test branches/folders and reversible/disposable generators. Confirm human-approved deployment, sleep-only updates, source readback, native AI helper and overlay, listing observation/correct detection of filtered entries, recovery and backup/restore in the operator environment. Never automate CAPTCHA bypass. Expand through staged scale exercises only after small live acceptance. Record observed failures as fixtures before patching. Operator explicitly signs off the final acceptance state. Green CI alone is insufficient.
