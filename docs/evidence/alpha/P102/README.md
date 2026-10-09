# P102 — Generator/domain persistence and durability

Claim `CLM-P102-001`, owner `codex-r1-a2`, epoch `1`, branch
`agent/codex-r1-a2/p102`. The acquired base is
`45c00cf9673f5382fa5e7987211005e5d4557948`; G0 was ACCEPTED before acquisition.
The frozen contract read hash is
`9b379980e16fdd557e0ea8a7f8273421f4a581c1c1563fe7661308038e29ee12`.
Claim acquisition was merged separately in PR #5 before product edits.

The implementation checkpoint is `6898991a9d811149dfc2fbb39731a9fc27cdc85d`.
It incorporates current R1 main, including P101's harness and P104/P105's work.
See `acceptance.json` for the achieved state and independent CI coordinates.
COMMITTED, CI_VERIFIED, MERGED, GATE_VERIFIED and ACCEPTED are separate states;
the R1 integration checker alone controls gate verification and acceptance.
No provider-live acceptance is claimed.

## Domain and storage handoff

`extension/alpha/domain/records.js` normalizes the frozen Account, Generator,
SourceBinding, Release and Operation fields. Unknown fields, accessors, symbols,
exotic objects, malformed timestamps, unsafe paths and noncanonical slugs fail
closed. Intent, listing observation, deployment and refresh facts stay separate.
Account identities use `personaUid` and a monotone binding epoch. Releases retain
exact PJS/HTML line endings and detached thumbnail bytes. Their content-addressed
identity is supplied by the future P203 interpreter; storage SHA-256 checksums
are integrity checks, not a second ReleaseId algorithm.

`createAlphaStorage()` in `extension/alpha/storage/store.js` is a background-only
service; this phase does not wire Core, UI or provider actions. It opens only
`persona-monkey-pcms-alpha`, schema version 1. Test overrides are restricted to
`persona-monkey-pcms-alpha-test-*`. It never opens, migrates or clears donor PCMS
or PersonaMonkey databases. Versioned migrations must be contiguous and
synchronous; failed upgrades roll back. Unknown versions and malformed existing
schemas enter RECOVERY_HOLD without creating replacement data.

| API | Result or precondition |
| --- | --- |
| `open()` / `close()` | Validate schema, records and bounded journal; fence pending opens and version changes. |
| `read(kind, key)` | `{revision, item: {revision, record} \| null}` with a detached, verified record. |
| `list(kind)` | `{revision, items}` through the kind index. |
| `snapshot()` | Detached versioned records, journal and global revision, all integrity checked. |
| `commit({expectedRevision, writes})` | Atomic batch of 1–64 `{kind, expectedRevision, record}` writes; returns `{revision, items}` only on transaction completion. |

The outer revision fences the whole store; each write also supplies that record's
current revision, or zero when creating it. Account/Generator `record.revision`
must match the supplied record precondition; storage increments it. Release and
Operation revisions live in envelopes. Write transactions explicitly request
strict IndexedDB durability; Firefox's actual transaction durability is checked
by the fixture. A record request succeeding is not an acknowledgement.

Records, their checksums, journal entry and global revision share one transaction.
Verified preconditions are checked again inside that transaction, so asynchronous
hashing cannot permit a stale write. Unique Persona bindings, projected Generator
account epochs, duplicate writes and revision overflow are fenced. No physical
record deletion is exposed, avoiding revision reset/ABA. Journal retention is
explicitly bounded to 1024 transactions without resetting revisions; unresolved
Operation records are retained. Future feature services own record retention and
deletion policy rather than receiving a generic workflow engine here.
On reopen/snapshot, each target's latest retained journal receipt must match its
current record and checksum. Missing records and replayed older rows enter hold
even if the older row still has a valid checksum.

Operations start PREPARED with immutable target/source/epoch identity. UNCERTAIN
cannot transition back to DISPATCHING. Terminal reconciliation from an ambiguous
state requires recorded remote evidence. A DISPATCHING record survives restart;
the separately assigned P201 Core owns interpreting interruption, scoped holds
and provider reconciliation. This phase never performs dispatch or readback.

## Reproducible acceptance slices

| ID | Actual cases |
| --- | --- |
| AP102-01 | Frozen fields/enums and donor slug grammar; explicit commit-pinned bindings; exact detached release bytes; isolated schema; atomic four-record strict-durability commit. |
| AP102-02 | Global/per-record CAS collision and two-connection race; Persona uniqueness/epoch collision; immutable releases/operations; quota-style failure and abort after journal request success; interrupted/async/blocked migrations; malformed/future schemas; pending-open close; record/journal/metadata corruption and missing/replayed-row holds; 1027 writes compact to 1024 journal entries; actual Firefox process restart. |
| AP102-03 | All normal records reject credential/container fields; nested evidence rejects credential-shaped keys and recognizable token material; only opaque secret references survive; rejected data is absent from errors and produces no persisted record or journal. |

`tests/alpha/domain/records.test.mjs` contains 14 Node cases. The isolated fixture
in `firefox.test.mjs` copies and hashes the exact four implementation files into
an XPI, installs it in a disposable profile, executes 20 real IndexedDB cases and
then verifies durable records across a Firefox process restart. External traffic
is blocked by the fixture profile's closed proxy. The donor packaged-XPI harness
and exact Firefox installer are reused unchanged. The normal Alpha test discovery
command runs this fixture automatically in GitHub Actions rather than skipping it.

Executed local commands (exact source SHA/results are in `acceptance.json`):

```sh
MOZ_DISABLE_CONTENT_SANDBOX=1 FIREFOX_BIN=/tmp/p101-firefox/versions/154.0b10/firefox/firefox node tools/alpha/run-tests.mjs
npm run verify
node scripts/build-extension.mjs
node tools/alpha/ci.mjs
git diff --check
```

The combined test command passed 45 Node entries, including all 15 P102 entries
and the 20 IndexedDB cases plus restart. `local-firefox.json` records the exact
source hashes, Firefox 154.0b10 archive checksum and restart result. Local Firefox
requires `MOZ_DISABLE_CONTENT_SANDBOX=1` because this container rejects the content
sandbox's user-namespace mapping. This is a diagnostic storage result, not local
sandbox/security acceptance. Hosted CI is required to use the normal sandbox;
the P102 test rejects that disabling flag in GitHub Actions.

Credential screening is not a universal detector for arbitrary secrets hidden
in prose or source. Callers remain responsible for placing credentials in the
approved secret backend. Fixtures are synthetic and contain no live credentials,
sessions, account data or provider traffic. Recovery checks detect accidental
corruption; unkeyed checksums are not protection against a malicious DB writer.
