> **Historical record.** Preserved for release history; it is not current product authority.

# Implementation prompts — PCMS Integration Readiness

These prompts implement `specification-pcms-integration-readiness.md` in **five sequential stages**.

Use them one at a time. Each stage assumes the prior stage has been merged into `main` or is present in the current working branch. Do not jump ahead to later-stage functionality merely because adjacent code is convenient to edit.

## Shared rules for every stage

- Repository: `Neb963/persona-router`.
- Read `specification-pcms-integration-readiness.md` completely before changing code.
- Before work, inspect:
  - `git status --short --branch`
  - `git branch --show-current`
  - `git log --oneline --decorate -20`
  - `git diff --stat`
- Read the relevant current architecture/API/security docs and all callers of code you change.
- Preserve uncommitted user work. Never reset, rebase, force-push, delete branches/tags, or overwrite unrelated changes.
- Work in small coherent increments. **Commit every meaningful working checkpoint** after reviewing its diff.
- Use conventional commit messages.
- Run focused tests while developing, then the stage's broader gates.
- Do not claim a test passed unless it actually ran and passed.
- Never commit credentials, cookies, browser exports/backups, WireGuard/private configs, build artifacts, logs, or temporary debugging files.
- Preserve:
  - Gecko ID `persona-route-manager@local`;
  - legacy management v1 wire bytes (`PCMS_REQUEST`, `PCMS_EVENTS`, protocol version 1, existing error/event literals);
  - v1 `profileId` / batch `personaId` meaning current Firefox container ID;
  - existing package/backup readers unless a tested versioned migration is introduced;
  - fail-closed routing, cookie/FPI isolation, userscript grant checks, and narrow native Mullvad boundary.
- Do not expose raw `SAVE_STATE`, `PERSONA_API`, browser APIs, whole-state mutation, or generic native RPC to an external consumer.
- Keep changes focused on the active stage.
- At completion, report:
  - what changed;
  - tests actually run and results;
  - commit SHAs/messages;
  - remaining risks or unverified environment-specific gates;
  - clean/dirty `git status`.

---

# Stage 1 prompt — Contract authority and repository guardrails

```text
@GitHub

Implement Stage 1 of specification-pcms-integration-readiness.md: CONTRACT AUTHORITY AND REPOSITORY GUARDRAILS.

Goal:
Remove naming/source-of-truth ambiguity and create enforceable repository guidance before any persistence, identity, or external-trust change.

Important constraints:
- This stage must not intentionally change runtime behavior or manifest permissions.
- Do not rename legacy PCMS_* wire literals.
- Do not rename all pcms-*.js modules/directories in this stage.
- Do not rewrite historical documents so they falsely use modern terminology.
- Do not delete branches, tags, historical docs, or active compatibility modules.

Required work:

1. Preflight
   - Inspect git status/current branch/recent history/diff.
   - Ensure you are based on current main containing the specification.
   - Read README.md, DEVELOPMENT.md, SECURITY.md, docs/BRANCHING.md, docs/PCMS_API.md, docs/PERSONA_OS_API.md, docs/V0.8.0_CURRENT_RELEASE_GATES.md, relevant v0.8 historical docs, package.json, scripts/test-repository.mjs, and the management protocol/control-plane source.

2. Add root AGENTS.md
   Keep it concise and enforceable.
   It must define:
   - PersonaMonkey vs PCMS product ownership.
   - Dependency boundary:
     PCMS -> documented PersonaMonkey Integration API -> typed PersonaMonkey/Persona OS services -> Firefox/native primitives.
   - preflight/commit discipline;
   - security invariants;
   - compatibility register;
   - documentation/test authority;
   - no raw external SAVE_STATE/PERSONA_API/native RPC;
   - comments next to non-obvious invariants/race/destructive sequencing.

3. Establish current documentation authority
   Create/update the minimum current docs needed by the spec, including:
   - docs/architecture/OVERVIEW.md
   - docs/architecture/PERSONA_MODEL.md
   - docs/pcms/INTEGRATION.md
   - current management-protocol documentation using “PersonaMonkey Management API”.
   Preserve old docs as historical records or compatibility stubs where needed.
   Correct README.md and DEVELOPMENT.md so:
   - main is the source of truth, not an “active v0.8 branch”;
   - PCMS means Perchance Central Management System;
   - PersonaMonkey Management is the internal shipped console/protocol;
   - external PCMS integration is not yet implemented at the end of this stage.

4. Add a compatibility register
   Clearly freeze:
   - PCMS_REQUEST
   - PCMS_EVENTS
   - PCMS_PROTOCOL_VERSION=1
   - existing PCMS_* errors and pcms.batch.completed
   - v1 profileId/personaId = current cookieStoreId
   - extension/native installed IDs
   - persisted/package/backup format compatibility expectations.

5. Prepare one source of truth for command metadata
   Inspect pcms-control-plane.js commandFields/requiredFields/registry metadata.
   Refactor only if it can be done behavior-preservingly.
   The result should give later stages a single reusable descriptor/extraction path for command name, parameter shape, mutating/destructive/batchable/capability metadata.
   Do not add an external listener or new privileged command in this stage.

6. Harden repository checks
   Extend scripts/test-repository.mjs or add a focused repository-contract test to verify:
   - AGENTS.md exists;
   - canonical current doc entry points exist;
   - local Markdown links resolve;
   - current docs use PCMS for the separate product and explicitly mark legacy PCMS_* wire identifiers as compatibility names;
   - compatibility register exists.
   Avoid:
   - blanket string bans that would fail historical documents;
   - hard-coded global test/file counts;
   - checks tied to transient branch names.

7. Tests
   Run at minimum:
   - npm run test:repository
   - npm run test:extension if management registry/schema code moved
   - npm run validate if source/module structure changed

8. Review and commits
   Inspect diffs before commits.
   Prefer checkpoints such as:
   - docs: define PersonaMonkey integration boundary
   - docs: add repository agent contract
   - test: validate current documentation contracts

Stop after Stage 1. Do not implement personaUid, schema migration, full-wipe recovery, onMessageExternal, workflow authoring, or userscript assignment APIs yet.
```

---

# Stage 2 prompt — Durable Persona identity and boot-scoped concurrency

```text
@GitHub

Implement Stage 2 of specification-pcms-integration-readiness.md: DURABLE PERSONA IDENTITY AND BOOT-SCOPED CONCURRENCY.

Prerequisite:
Stage 1 is merged/present. Read its current docs and AGENTS.md first.

Goal:
Add stable logical personaUid while preserving all legacy v1 container-ID semantics, and surface the state manager's existing boot-aware optimistic concurrency additively.

Do not implement the external PCMS listener yet.
Do not redesign full wipe into the Stage 3 recovery state machine yet, except for the minimum changes required to preserve UID uniqueness/semantics on the existing successful path.

Required work:

1. Preflight and tracing
   Inspect current state/history/diff.
   Trace:
   - constants.js schema version;
   - storage.js normalization;
   - state-manager.js initialization/mutation metadata;
   - personas.js create/clone/archive/fullWipe/remove;
   - persona-platform.js and persona-intelligence.js projections;
   - persona-package.js;
   - backup-package/import paths;
   - workflow/script bindings;
   - pcms-control-plane.js mutation preconditions;
   - tests covering state/personas/packages/backups/management.

2. Persisted schema 3
   Bump the persisted state schema because logical identity and rotation-recovery metadata are semantic persistence changes.
   Add a bounded/validated personaUid field to profile records.
   Design UID generation so tests can be deterministic/injectable.

   Invariants:
   - every current managed Persona has exactly one non-empty unique personaUid;
   - schema-2 managed Personas get one UID on migration and it is persisted;
   - repeated load/normalize does not regenerate it;
   - unmanaged compatibility records do not acquire a new logical identity merely from normalization;
   - duplicate/corrupt UIDs are repaired safely and covered by tests.

3. Lifecycle semantics
   - create -> fresh UID unless an internal tested path explicitly supplies an unused UID;
   - clone -> always fresh UID;
   - ordinary identity/settings/archive updates -> preserve UID;
   - destroy -> removes that logical Persona;
   - current successful fullWipe path -> preserve source UID on replacement and clear it from any temporary/old compatibility profile so uniqueness is not violated;
   - portable .personamonkey export/import -> do not clone source UID; imported Persona gets a new UID;
   - full encrypted backup replace/restore -> preserve UIDs;
   - backup merge -> preserve only non-colliding UIDs, otherwise remap and expose the mapping to the import result/diagnostics as appropriate.

   Do not change existing workflow step profileId or userscript profileIds persisted meaning in this stage. They remain container IDs.

4. UID lookup/projection
   Add a focused resolver/helper that can:
   - find a current managed profile by personaUid;
   - return current cookieStoreId;
   - detect missing/duplicate/corrupt identity.
   Project explicit personaUid and cookieStoreId in the new/current internal model while preserving legacy v1 id/profileId behavior.

5. Boot-scoped management preconditions
   The state manager already understands expectedBootId.
   Add optional expectedBootId validation/plumbing to legacy management v1 mutating commands without breaking clients that only send expectedRevision.
   Mutations with a supplied stale bootId must conflict even if the numeric revision matches.
   Batch must keep one explicit precondition and reject nested per-item revision/boot preconditions.

6. Migration/rollback docs
   Update PERSONA_MODEL/current integration docs:
   - schema-2 -> schema-3 is automatic;
   - old builds can drop UID metadata if they rewrite state;
   - once external mappings depend on UIDs, downgrading to a pre-schema-3 build requires restoring a pre-upgrade backup or rebinding.

7. Regression tests
   Add focused coverage for:
   - schema-2 fixture migration;
   - repeated load identity stability;
   - UID uniqueness/collision repair;
   - create/clone/import UID semantics;
   - portable package excludes logical identity;
   - backup replace/merge behavior;
   - legacy v1 profileId still targets same container;
   - stale expectedBootId with matching revision conflicts;
   - existing expectedRevision-only client remains valid.

8. Gates
   Run focused tests as you work, then:
   - npm test
   - npm run validate
   - npm run build

9. Review/commit
   Review complete diff.
   Use coherent commits, e.g.:
   - feat: add durable persona identifiers
   - feat: add boot-scoped management preconditions
   - test: cover persona identity migration and collisions

Stop after Stage 2. Do not add runtime.onMessageExternal/onConnectExternal or the full rotation journal yet.
```

---

# Stage 3 prompt — Recoverable full wipe and rotation events

```text
@GitHub

Implement Stage 3 of specification-pcms-integration-readiness.md: RECOVERABLE FULL WIPE AND ROTATION EVENTS.

Prerequisite:
Stage 2 is merged/present and schema-3 personaUid tests pass.

Goal:
Replace the current late-failure-prone full-wipe flow with an explicit persisted, restart-repairable container-rotation state machine that preserves personaUid and never exposes live old tabs to an unmanaged Direct-fallback window.

This is a high-risk correctness/security stage. Keep it focused. Do not add the external PCMS transport yet.

Required work:

1. Trace the entire destructive path
   Read and map:
   - personas.js fullWipe plus helpers;
   - state-manager mutation queue and initialization;
   - background initialization/listeners;
   - persona-platform StorageManager.fullWipe mapping;
   - userscript profile assignments;
   - workflow step bindings;
   - automationJobs persistence/history writes;
   - contextualIdentities/tabs failure handling;
   - current events/control plane and relevant tests.

2. Add persisted rotation journal/state
   Implement the schema-3 rotation model from the specification, or an equivalent model with the same invariants:
   - operationId
   - personaUid
   - sourceCookieStoreId
   - targetCookieStoreId when known
   - unique temporary target identity marker/name
   - explicit stage
   - timestamps
   - bounded secret-safe error/status

   Journal the intent before the first destructive/external side effect.

3. Implement idempotent reconciliation
   Add a focused recovery service/helper called during initialization before new destructive Persona mutations are accepted.
   It must safely continue or finalize interrupted rotations.
   It must never delete a container unless it can prove that container belongs to the recorded operation.

4. Rotation ordering
   Preserve these safety rules:
   - source remains managed/protected while its live tabs exist;
   - do NOT mark the source unmanaged before closing its tabs;
   - target is never used for navigation before it is represented as a managed safe profile;
   - personaUid moves to the target exactly once;
   - workflow/script references are remapped to target;
   - automation job/history references are remapped idempotently;
   - old tabs are closed while old route policy is still protected;
   - old contextual identity removal is retry-safe/already-absent-safe;
   - final cleanup leaves one current managed Persona with the original UID and no rotation journal.

5. Avoid unbounded orphan creation
   A crash after contextualIdentities.create but before target-ID persistence must still be recoverable.
   Use the persisted unique operation marker/temporary identity name (or another proven discoverable mechanism) so recovery can find the already-created target rather than creating unlimited replacements.
   Do not use a heuristic that could match/delete an unrelated user container.

6. Event/result contract
   Add an explicit event such as persona.container.rotated carrying:
   - personaUid
   - oldCookieStoreId
   - newCookieStoreId
   - operationId
   - bootId/revision via envelope
   Ensure the legacy management console still receives enough refresh/change signaling to remain compatible.

7. Failure-injection matrix
   Add tests that fail/restart after at least:
   - journal prepare;
   - new contextual identity creation;
   - target-ID journal persistence;
   - state cutover;
   - script/workflow remap;
   - automation-history remap;
   - source tabs.remove;
   - source contextualIdentities.remove;
   - final profile/journal cleanup.

   For every case verify:
   - restart/retry converges;
   - same personaUid survives;
   - only one target/current managed Persona remains;
   - retries do not create unbounded containers;
   - unrelated profiles/containers/cookies are untouched;
   - source tabs are never exposed to unmanaged Direct fallback.

8. Integration with existing mutation/revision model
   Expected revision/boot must be checked before beginning a new rotation.
   Recovery of an already-journaled operation must use operation identity rather than requiring the stale original revision to match again.
   Keep errors structured/secret-safe.

9. Gates
   Run focused rotation/persona/state tests, then:
   - npm test
   - npm run test:browser if browser prerequisite is available; at minimum run management/data-management smokes directly if supported
   - npm run validate
   - npm run build

10. Review/commit
   Inspect diffs carefully.
   Prefer coherent checkpoints:
   - fix: make persona rotation recoverable
   - feat: publish persona container rotation events
   - test: cover rotation failure recovery

Stop after Stage 3. Do not add external messaging or workflow/userscript authoring yet.
```

---

# Stage 4 prompt — Restricted external PCMS integration transport

```text
@GitHub

Implement Stage 4 of specification-pcms-integration-readiness.md: RESTRICTED EXTERNAL PCMS INTEGRATION TRANSPORT.

Prerequisite:
Stages 1–3 are merged/present. personaUid is durable and full-wipe rotation is recoverable.

Goal:
Add a NEW cross-extension PersonaMonkey Integration API v1 for the separate PCMS product. It must use durable UID semantics, exact sender authorization, explicit local policy, boot-scoped concurrency, and secret-safe projections.

Do not reuse PCMS_REQUEST as the external envelope.
Do not expose raw SAVE_STATE/PERSONA_API/browser/native calls.
Do not add arbitrary userscript source installation or workflow authoring yet.

Required work:

1. Preflight/threat-model review
   Read:
   - current integration specification/docs;
   - background.js sender gates;
   - pcms-protocol/control-plane/events/client;
   - persona API/platform and UID resolver;
   - routing/direct/kill-switch policy;
   - manifest;
   - security/secret-projection tests;
   - Firefox external messaging semantics relevant to onMessageExternal/onConnectExternal.

2. New Integration API protocol
   Add a separately named/versioned module, e.g. management-integration-protocol.js or personamonkey-integration.js.
   Use a distinct wire type such as PERSONAMONKEY_INTEGRATION_REQUEST with protocol version 1.
   Validate strictly:
   - type/version
   - requestId
   - operationId for mutating/side-effecting operations where specified
   - command
   - precondition { bootId, revision }
   - params
   Reject unknown fields/types and unsupported versions.
   Return structured, secret-safe errors with no stack traces.

3. Authorization policy
   Integration is disabled by default.
   Implement bounded trusted local configuration:
     global.integration = {
       enabled: false,
       trustedExtensionIds: [],
       allowDestructive: false,
       allowDirect: false
     }

   Only trusted same-extension PersonaMonkey UI/internal code may edit this policy.
   External callers cannot self-authorize.
   Enforce exact sender.id match.
   Bound list length/string lengths.
   Add a minimal Advanced/Integration UI for configuring this if no existing safe configuration path exists.

4. External transport
   Add:
   - browser.runtime.onMessageExternal for request/response;
   - browser.runtime.onConnectExternal for advisory events.
   Keep same-extension onMessage/onConnect behavior unchanged.
   Do not rely on website origin as authentication.
   Do not route the request through a generic legacy dispatcher.

5. UID-first adapter
   External Persona inputs/outputs use personaUid.
   Resolve to the current cookieStoreId only inside PersonaMonkey.
   New external projections use explicit personaUid and cookieStoreId field names; do not expose ambiguous id as the primary identity.
   A successful full wipe must require no PCMS account mapping rewrite.

6. Safety authority
   Enforce two layers:
   - request-level explicit confirmation/allowDirect intent;
   - locally configured allowDestructive / allowDirect authority.
   Reject external killSwitch:false and unmanagedPolicy changes entirely in this milestone.
   Keep private route credentials redacted.

7. Initial allowlisted commands
   Expose only the existing typed operations listed in the specification:
   discovery/status, Persona lifecycle, storage inspect/allowed destructive operations, route list/get/assign/test, existing workflow run/read/job controls.
   Translate to UID semantics.
   Do not expose state import/export, raw cookie editor, route credentials, userscript code, workflow authoring, or native Mullvad administration.

8. Deterministic retry/correlation
   Implement bounded request/operation correlation sufficient to make create and rotation retry behavior deterministic.
   Prefer an approach that survives the failure modes relevant to the operation rather than a cosmetic in-memory cache.
   The integration may accept a validated caller-supplied unused UUID personaUid for retry-safe create.
   Duplicate same-UID create must resolve deterministically; never create a second logical Persona with the same UID.
   Document commands that are not exactly-once and require requery.

9. Machine discovery
   Use one command metadata source for:
   - validation;
   - capability discovery;
   - mutating/destructive flags;
   - parameter schema/identifier semantics.
   system.describe must expose authorized capabilities and relevant versions without leaking secrets.

10. External event stream
   Authorize with the same sender ID policy.
   Project only secret-safe UID-first events.
   Include bootId/sequence/revision/time/type/entity/data.
   Include persona.container.rotated.
   No replay guarantee; client contract is requery on reconnect, boot change, or sequence gap.

11. Security/regression tests
   Cover:
   - integration disabled;
   - wrong/unknown extension ID;
   - malformed/unsupported envelope;
   - unknown command/field;
   - forbidden legacy/raw/native messages;
   - destructive denial without both authorities;
   - Direct denial without both authorities;
   - kill-switch weakening rejected;
   - stale boot/revision;
   - duplicate UID create;
   - event connection authorization;
   - secret projection;
   - authorized end-to-end list/get/create/open/route/test/workflow-run path;
   - full-wipe rotation followed by UID requery;
   - old bundled management console still works.

12. Gates
   Run focused tests, then:
   - npm test
   - npm run test:browser where prerequisite exists
   - npm run validate
   - npm run build

13. Review/commit
   Inspect diff before each commit.
   Prefer:
   - docs: specify PCMS integration threat model
   - feat: add PersonaMonkey integration protocol
   - feat: add restricted external PCMS channel
   - test: harden external management authorization

Stop after Stage 4. Do not yet add userscript assignment or workflow create/update/delete.
```

---

# Stage 5 prompt — Minimum authoring surface and release hardening

```text
@GitHub

Implement Stage 5 of specification-pcms-integration-readiness.md: MINIMUM AUTHORING SURFACE AND RELEASE HARDENING.

Prerequisite:
Stages 1–4 are merged/present and the external integration boundary passes its authorization/security tests.

Goal:
Expose only the minimum typed userscript/workflow lifecycle operations PCMS needs, then close the milestone with contract parity, end-to-end coverage, current documentation, and verified release evidence.

Do not turn the integration into a generic script uploader or whole-state editor.
Do not implement the automatic userscript updater in this stage.

Required work:

1. Existing-userscript public management
   Add typed facade/control-plane/integration operations:
   - userscript.list
   - userscript.get
   - userscript.assign
   - userscript.unassign

   Public projection may expose:
   - script ID/name/namespace/version/enabled;
   - match/include/exclude metadata;
   - run-at/world;
   - declared grants/connect rules;
   - compatibility status;
   - assigned personaUid values.

   It must not expose:
   - source code;
   - GM values;
   - cookies/auth data;
   - cached dependency bodies;
   - private route data.

   Assignment/unassignment must:
   - resolve personaUid -> current container internally;
   - use boot+revision preconditions;
   - validate managed Persona and script existence/status;
   - keep runtime assignment/grant enforcement intact.

2. Validated workflow authoring
   Add:
   - workflow.create
   - workflow.update
   - workflow.delete

   Reuse existing normalization and validation; do not create a weaker second validator.
   External workflow payload uses personaUid.
   Convert to internal profileId only at the trusted adapter/facade boundary.
   Validate:
   - Persona exists/managed;
   - route is usable according to current run validation;
   - referenced script exists and is assigned;
   - signal completion cannot use MAIN-world script;
   - URL protocols;
   - per-step concurrency/retries/timeouts;
   - total MAX_WORKFLOW_TASKS;
   - enabled state and bounds;
   - stale boot/revision conflict.

   No raw SAVE_STATE.
   No arbitrary package import containing new executable script source.

3. Correlation for workflow runs if PCMS needs retry safety
   Add a bounded run/correlation key only if required to prevent duplicate jobs after an ambiguous external response.
   Keep job IDs execution-local; PCMS business IDs remain external mappings.
   Do not over-generalize into a second workflow engine.

4. Contract/catalog parity
   Add tests that prove the published machine command descriptor agrees with:
   - registered handlers;
   - parameter validation;
   - required capability;
   - mutating/destructive/batchable flags;
   - stable error names.
   system.describe must advertise only commands actually usable under the caller's authorized capabilities.

5. Preserve/document GM behavior
   Add a regression proving current GM values remain shared per script ID across Personas while GM_cookie/page cookies remain container-scoped.
   Update docs to state this is intentional compatibility behavior for this milestone.
   Do not introduce per-Persona GM scope.

6. End-to-end integration scenario
   Build a deterministic automated fixture covering, as far as practical:
   - authorize external test extension/client;
   - create Persona by UID;
   - assign safe route;
   - inspect/list scripts;
   - assign existing script;
   - create validated workflow;
   - run workflow / observe job;
   - full wipe/rotate Persona;
   - reconnect/requery by same personaUid;
   - verify new cookieStoreId;
   - verify script/workflow bindings still target the new current container;
   - run again;
   - deny a forbidden capability/policy path.

7. Documentation
   Finalize current docs so they clearly describe:
   - internal management v1 vs external Integration API v1;
   - personaUid/cookieStoreId/profileId semantics;
   - schema-3 migration and downgrade limitation;
   - rotation recovery;
   - authorization/Direct/destructive controls;
   - event requery model;
   - userscript/workflow capabilities and deliberate exclusions;
   - PCMS ownership of account credentials/domain state;
   - userscript updater/per-Persona GM scope as deferred work.

8. Release evidence
   Run all practical gates:
   - npm test
   - npm run test:browser where Chrome/Chromium/browser prerequisites exist
   - npm run validate
   - npm run build
   - npm run release:check in an environment capable of completing it

   Also record, separately and honestly, installed Firefox/LibreWolf security/rotation tests and native Mullvad egress checks when those environments are available.
   An unavailable browser/native environment is “not run”, never “pass”.

9. Repository/history hygiene
   Do not delete divergent branches or create/rewrite release tags in this stage unless separately authorized.
   Do not mix cosmetic pcms-* source renames, v062/personas-v07 module renames, or hidden DOM deletion into this milestone unless they are strictly required for correctness.
   Leave them in the deferred backlog otherwise.

10. Final review
   - inspect complete diff against the specification;
   - verify no secrets/build artifacts/unrelated cleanup;
   - verify git status;
   - summarize actual tests and remaining environment gates.

Suggested commits:
- feat: expose userscript assignment management
- feat: add validated workflow authoring
- test: verify integration contract parity
- test: cover PCMS integration lifecycle
- docs: record PCMS integration release gates

Stop when Stage 5 acceptance criteria in specification-pcms-integration-readiness.md are satisfied. Do not silently begin the userscript updater, GM-scope migration, or repository cosmetic-cleanup backlog.
```
