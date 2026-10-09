# Phase 04 — F-09 package/ZIP safety closure

Date: 2026-09-25. Audit baseline: `main` at `e33272a7d4ff49623d613d11fbb65da806d7f869`. Phase 03 starting SHA: `7ce842f2259e1a8e12a924a28c9dc4f7e98fcb71`. Final Phase 04 source SHA: `0b5c988a868356d03874032dd8e693ea384fe034` (tree `24754497840635702f1ff030e56dea5307cdb0ac`). Scope is Phase 04 F-09 only; Phase 05 was not started. The checkout had no separate Phase 04 `spec.md`; this closure follows the supplied Phase 04 handoff scope.

## F-09 — unbounded ZIP/package processing

- **Status:** Fixed and verified for bounded decompression, package-specific limits, parse-failure atomicity, and the real Options-to-Worker inspection path. Full v1.1.0 acceptance remains Phase 08 work.
- **Root cause:** DEFLATE output could be accumulated without enforcing a runtime byte bound while reading. Declared ZIP sizes alone do not constrain actual output. Package limits were also spread across call sites, and package parsing was reachable from routing-critical code.
- **Remediation:** `readZip` now streams raw DEFLATE output and checks each received chunk against the smaller of the per-entry ceiling and remaining aggregate allowance before retaining it. Stored entries are checked before copying. Central metadata is checked against actual output size and CRC. Shared immutable limit sets are used for Workflow and Persona packages. Options inspection and background import reinspection use a module Worker; the background registers the inspector without requiring Worker availability until an inspection operation is requested.
- **Configured limits:**

  | Package | Compressed input | Entries | Per-entry output | Aggregate output | Path limits |
  | --- | ---: | ---: | ---: | ---: | --- |
  | Workflow / default ZIP | 12 MiB | 128 | 4 MiB | 10 MiB | 500 JS characters; 2,048 UTF-8 bytes |
  | Persona | 32 MiB | 500 | 32 MiB | 32 MiB | 500 JS characters; 2,048 UTF-8 bytes |

- **Declared and actual sizes:** A declared uncompressed size above the configured per-entry limit is rejected before inflation. A smaller declared value is not treated as the safety boundary: actual DEFLATE chunks are counted and the reader is canceled as soon as a per-entry or remaining aggregate limit is crossed. On completion, actual length must equal the central-directory declaration.
- **Integrity and authorization:** CRC-32 is checked against the central-directory entry after successful inflation. Local and central names, flags, and methods must match; when general-purpose bit 3 is clear, local CRC and size fields must also match. Package import reparses the original bytes at the mutation boundary, so a caller-supplied preview is not authority. Parse and Worker failures occur before Persona creation or persisted-state mutation. Imported Personas always receive kill-switch and LAN-blocking enabled; package Direct intent remains blocked unless a separate explicit `allowDirect: true` is supplied. The Options Direct consent control was observed unchecked by default.
- **Path handling:** Empty names, NUL, backslash, absolute paths, drive prefixes, and empty, `.` or `..` segments are rejected. Duplicate normalized paths are rejected. Directory entries are structural and must not contain data. Filename UTF-8 decoding is fatal.

### Phase 04 commits

| Commit | Purpose |
| --- | --- |
| `08a4e26716329dcf43916a339bb04e402a7e5fa5` | Bound ZIP DEFLATE output while streaming. |
| `faa4b19794c8336cd4133f3de3bbf71f098e71b7` | Centralize Workflow and Persona package limits. |
| `1c17765b616119dcac8ef89d48a7752551b0a64d` | Move untrusted package inspection into a module Worker. |
| `4ef54419737bd4782f55bb7142157176e3232f23` | Keep Worker unavailability local to inspection; use the Worker in Options. |
| `5e5e29b3af96341aa0dc62881159917885906a81` | Reinspect archive bytes before import mutation. |
| `7d514446b0a28a84b9880277378f0d4eac4a4dda` | Cover bounded ZIP failures and package-size limits. |
| `0b5c988a868356d03874032dd8e693ea384fe034` | Validate local ZIP metadata against central metadata. |

The GitHub compare from the Phase 03 SHA reports seven commits ahead, zero behind, with Phase 03 as the merge base and 14 changed source/test paths. The closure report is committed separately.

### Deterministic verification

The following gates passed on final source SHA `0b5c988a868356d03874032dd8e693ea384fe034`:

- `npm run test:repository` — passed.
- `npm run test:extension` — passed; 56 extension test files.
- `npm run test:native` — passed; 22 tests.
- `npm run validate` — passed; 128 source files validated.
- `npm run build` — passed.

The regressions cover a false 1 KiB declaration with 5 MiB actual DEFLATE output, aggregate runtime overflow, entry-count overflow, compressed Workflow and Persona limits, CRC and declared-size mismatches, local-header inconsistency, normal Persona and Workflow package round-trips, failed inspection with zero mutation, explicit Direct authorization, enforced safety defaults, and parser isolation from `background.js`. `package-inspector.test.mjs` also constructs the inspector with Worker/runtime unavailable and verifies that unavailability is returned by the inspection operation.

Chromium tests and `npm run test:browser` were not run. `npm run release:check` was intentionally deferred because it includes the excluded browser suite. No GitHub Actions run was triggered.

### Firefox 157 evidence

- **Candidate:** source SHA `0b5c988a868356d03874032dd8e693ea384fe034`; `/workspace/scratch/65dabae29688/phase04-checkout/dist/persona-route-manager-v1.0.0.xpi`; SHA-256 `a192bdd0f4fe92548bac4938a2a54b66cdc3f2cebecc7dbc29c21177658a1621`. Firefox Dev MCP reported Firefox `157.0`. The exact candidate was installed temporarily as `persona-route-manager@local`, Manifest V3, and remained active in the existing session.
- **Normal package:** A seven-entry Persona package from the candidate code was converted to DEFLATE and supplied through the Options file-input change handler. The preview displayed `Phase 04 Probe`, `Route: direct`, package inventory and warnings, and the notice that new Personas start with kill switch and LAN blocking enabled. Direct consent was unchecked. The preview showed Cancel and Import persona actions; Cancel was used and no import was submitted.
- **Worker observation:** Instrumentation on the Options page observed the `inspect-persona-package` Worker request (1,398 bytes) and its successful response containing the expected identity and Direct route. A page-realm `DecompressionStream` counter remained at zero. The Worker response to the adversarial request below contained the runtime-size error. The shipped client constructs `workers/package-inspector.js`; source and deterministic tests show that `background.js` contains no `readZip` or `DecompressionStream` path and passes mutation-time inspection through the Worker. This is direct evidence of the real UI request/Worker response and an inference from the shipped Worker wiring about where inflation ran; Firefox instrumentation did not expose individual worker chunks or memory use.
- **Adversarial expansion:** The DEFLATE ZIP was 65,357 bytes total; `manifest.json` declared 1,024 output bytes while its stream represented 67,108,865 bytes (64 MiB + 1). Firefox returned `ZIP entry exceeds the allowed runtime size: manifest.json`. The preview did not open, the Options dashboard remained responsive, and no main-page decompression call was observed. No 100 MiB archive was created.
- **Additional failures:** A malformed 1,398-byte archive returned `Invalid local ZIP header for manifest.json`; a 1,398-byte CRC fixture returned `ZIP CRC mismatch for manifest.json`; and a 1,398-byte declared-size fixture returned `ZIP size mismatch for manifest.json`. Each produced an error toast, no preview modal, and a failed Worker response. An in-memory synthetic file of 33,554,433 bytes (Persona compressed-input limit + 1) returned `Persona package is too large` before the Worker request count increased.
- **State and background health:** After cancel and all failures, Options still showed exactly one Persona, `Personal` (`firefox-container-1`); `Phase 04 Probe` was absent. Management refreshed successfully as `Connected`, `Protection: Active`, with the same `Personal` Persona and its existing `Mullvad Albania / Tirana` route. Firefox listed the extension active and reported no console errors. No saved route or Persona was changed. The existing route was shown as untested and route health as 0/1 healthy; this acceptance did not test exit traffic or claim route verification. Worker unavailability was verified by deterministic tests rather than by disabling Worker or restarting Firefox.

### Compatibility and format limits

The reader supports stored ZIP entries (method 0) and raw DEFLATE (method 8). Encrypted entries and multi-disk ZIP archives are rejected. Parsing uses classic ZIP32 EOCD/central-directory fields; ZIP64 is unsupported. Local and central names, flags, and methods must agree. Local CRC and sizes must agree with central metadata unless bit 3 indicates deferred local values, in which case central metadata controls parsing. Paths follow the restrictions above. All package ceilings in the table remain intentional.

### Residual uncertainty

Phase 08 still owns broader release and lifecycle acceptance, including suspend/wake behavior and the final release/CI gate. Firefox Dev MCP exposed the bounded runtime error but not worker chunk traces or peak memory/RSS, so no memory-peak claim is made. The existing route remained untested; this was a background-health regression check rather than routing-exit verification. ZIP64, encryption, and multi-disk archives remain unsupported by design.
