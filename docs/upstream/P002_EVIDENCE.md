# P002 — Import and preserve PersonaMonkey baseline

Status: **ACCEPTED**

Implementation checkpoint: `6387a376d66dfba790f1c86040823cba09a10f92`.

Frozen upstream:
- repository: `Neb963/persona-router`;
- commit: `9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`;
- source tree: `9d59d800c3a687b2e7360c64d9dd859d701d6ba5`;
- product version: `1.2.0`.

## A002-01 — exact upstream tree preservation

P002 preserves all **223** blobs from the frozen upstream tree.

- **166** blobs are retained byte-for-byte at their original root paths under P002 ownership:
  `extension/`, `native/`, `scripts/`, `tests/`, `CHANGELOG.md`, and `LICENSE`.
- **57** blobs that would overwrite PCMS governance or fall outside P002 root ownership are retained byte-for-byte at matching paths under `docs/upstream/source/`.
- `docs/upstream/import-manifest.json` records source path, destination path, Git blob SHA, mode and size for every upstream blob.
- `tests/upstream/import-integrity.test.mjs` recomputes Git blob IDs from checked-out bytes. Branch CI run `37232337968` verified all 223 entries as byte-identical.

The two binary extension icons were copied through base64 and verified against the original Git blob SHAs; all text blobs were likewise verified before each durable import checkpoint.

## A002-02 — public-repository provenance reconciliation

This repository is public while the frozen PersonaMonkey source repository is private, so GitHub cannot express the relationship as a native public fork.

The repository therefore preserves explicit provenance through:
- `docs/provenance/PERSONAMONKEY_BASELINE.md`;
- `docs/upstream/README.md`;
- `docs/upstream/import-manifest.json`;
- the exact upstream governance/source snapshot under `docs/upstream/source/`.

The exact upstream `package.json` is preserved at `docs/upstream/source/package.json`. The root `package.json` is intentionally composed rather than silently replacing PCMS/P001 commands: it uses PersonaMonkey version `1.2.0`, retains repository/Firefox verification, and adds the P002 upstream-integrity/baseline gates.

No PersonaMonkey runtime behavior was modified during the import.

## A002-03 — inherited release baseline

Frozen upstream Actions run `36412342425`, job `108895260160`, succeeded at the exact frozen commit. That run recorded:
- repository layout and installer metadata validated for v1.2.0;
- cross-timezone XPI reproducibility passing;
- **62 extension test files** passing;
- **63 native tests** passing;
- all four upstream deterministic browser smokes passing in the upstream pinned Chrome fixture;
- extension validation over **137 source files**;
- XPI SHA-256 `928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1`;
- workflow artifact `10966145159`, digest `sha256:18481aba740245f057772001e96d4a1f65ce1c7c5d227134afa886616a0fcf91`.

PCMS branch CI run `37232337968` reconstructed the **exact original upstream tree** in a temporary Git workspace from the import manifest and reran:
- upstream `npm test` (repository gate, cross-timezone reproducibility, 62 extension test files, 63 native tests);
- upstream `npm run validate`;
- upstream `npm run build`.

The derived build produced the exact same v1.2.0 XPI SHA-256:
`928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1`.

PCMS does not use the upstream Chrome fixture as evidence of Firefox behavior. The independent repository-pinned Firefox Developer Edition workflow also passed on the same implementation checkpoint in run `37232337972`. This preserves the repository's Firefox-only browser-authority policy.

## Verification summary

Implementation checkpoint `6387a376d66dfba790f1c86040823cba09a10f92`:
- repository/P002 verification: run `37232337968` — **success**;
- pinned Firefox Developer Edition regression: run `37232337972` — **success**;
- final diff against claimed `main`: **227 files**, **0 paths outside P002 ownership**.

No live provider, Mullvad, Perchance, or Firefox DevTools MCP testing is claimed for P002.

## Pull request and merged-main verification

Pull request #2 final head `2059b3c6fccb16c61344d1138cbecb17f826692d` passed:
- PR repository/P002 verification run `37232596230`;
- PR pinned Firefox Developer Edition run `37232596185`.

PR #2 merged as `765f9bcfc74d7ade6f70986318ef6eef17f76140`.

The exact merged `main` commit passed:
- repository/P002 verification run `37232707025`;
- pinned Firefox Developer Edition run `37232707046`;
- Firefox smoke artifact `11314273381`, digest `sha256:a70d24c377fabeb7533fd4d629c0e0bda4c65e2e6d68ec44e62ee0e2e6872c85`.

This establishes integration evidence for the exact merged source. P002 is not marked ACCEPTED until this MERGED governance checkpoint itself is repository-verified.

## Acceptance decision

The durable MERGED governance checkpoint `fc89e8a03115bf383fc1f155f92b3850cbab0ce2` passed:
- repository/P002 verification run `37232825265`;
- pinned Firefox Developer Edition run `37232825300`;
- Firefox smoke artifact `11314333651`, digest `sha256:3f96da40ebf7befe4e82ad55bd1e3de3e0c4288770e264588d0798e88524937d`.

The repository verification reconstructed the exact frozen upstream tree again, ran the inherited non-browser release gates, and rebuilt XPI SHA-256
`928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1`.

A002-01, A002-02 and A002-03 are therefore accepted. P002 is ACCEPTED.
P003, P004, P005 and P006 become READY by dependency resolution only; none is implemented in this session.
