> **Historical record.** Preserved for release history; it is not current product authority.

# Specification — PCMS Integration Readiness

**Change name:** `pcms-integration-readiness`  
**Repository:** `Neb963/persona-router`  
**Planning baseline:** `main` at `c24e789097d7b799fb813d6a8d7f4684f4ad106e` (2026-09-23)  
**Status:** implementation plan; no runtime behavior is changed by this document.

> Re-read `main`, `git status`, recent commits, repository instructions, and the affected contracts before starting each stage. The baseline above is provenance, not permission to ignore newer commits.

## 1. Objective

Make PersonaMonkey a safe, stable browser-side platform that a separate **Perchance Central Management System (PCMS)** can consume without depending on Firefox container IDs, raw extension state, privileged browser APIs, or the Mullvad native host.

The implementation must establish:

1. one authoritative product/integration contract;
2. a durable logical Persona identity independent of `cookieStoreId`;
3. crash-recoverable container rotation/full wipe;
4. boot-scoped optimistic concurrency;
5. a least-privilege extension-to-extension PCMS integration boundary;
6. the minimum typed workflow/userscript management operations needed by PCMS;
7. contract, migration, security, browser, and release regression coverage.

The implementation must preserve the existing v0.8 compatibility surface unless an explicit migration is documented and tested.

## 2. Current facts that constrain the design

At the planning baseline:

- PersonaMonkey Management protocol v1 exists and is intentionally internal.
- The legacy wire literals `PCMS_REQUEST`, `PCMS_EVENTS`, `PCMS_PROTOCOL_VERSION=1`, `PCMS_*` errors, and `pcms.batch.completed` are already used by the bundled management console and tests.
- `background.js` accepts management requests and the event Port only from same-extension pages.
- Persisted Personas are keyed by Firefox `cookieStoreId`; the public Persona `id` and v1 `profileId` mean the current container ID.
- `StorageManager.fullWipe` rotates to a new Firefox contextual identity, so the current public ID changes.
- The state manager already serializes mutations and supports both `expectedRevision` and `expectedBootId` internally, but management protocol v1 exposes only the revision precondition.
- Existing full-wipe code can persist an intermediate state and then fail during tab/container side effects, making retry by the old ID unreliable.
- Current workflow and userscript definitions bind to container IDs.
- Current GM values are shared by userscript ID across Personas; cookies and page storage remain container-scoped.
- The management command registry can run/read existing workflows, but it cannot author workflows or manage userscript assignment.
- No separate PCMS implementation exists in this repository.
- The current native Mullvad bridge is deliberately narrow and must not become a generic PCMS RPC service.
- PR #12 intentionally left durable Persona identity and external PCMS transport for a later milestone.

## 3. Naming and compatibility decisions

### 3.1 Canonical product terms

Use these terms in current documentation and new source:

- **PersonaMonkey** — Firefox/LibreWolf extension and Persona OS owner.
- **PersonaMonkey Management API** — PersonaMonkey's internal management facade/protocol/console.
- **management protocol v1** — the existing internal protocol whose wire identifiers still begin with `PCMS_`.
- **PCMS** — **Perchance Central Management System**, a separate product.
- **PersonaMonkey Integration API** — the new restricted cross-product boundary exposed to PCMS.
- **Persona OS** — the internal domain facade below the management/integration layers.

### 3.2 Frozen compatibility identifiers

Do not silently rename or reinterpret:

- `PCMS_REQUEST`
- `PCMS_EVENTS`
- `PCMS_PROTOCOL_VERSION=1`
- existing `PCMS_*` error literals
- `pcms.batch.completed`
- v1 `profileId` / batch `personaId` meaning **current Firefox container ID**
- Gecko ID `persona-route-manager@local`
- native host/install identifiers
- existing package and backup format identifiers

Source filenames such as `pcms-*.js` are naming debt, not wire contracts. Renaming them is not part of the critical path.

## 4. Security and behavior invariants

Every stage must preserve these invariants:

- Managed protected Personas fail closed when their protected route is unavailable.
- Block remains safe/default for newly created or transitional browser identities.
- Direct routing is explicit; the external integration cannot gain Direct authority merely because it can create or route a Persona.
- The external integration cannot disable the kill switch or change unmanaged-network policy.
- Cookie reads/writes remain scoped to the exact current `cookieStoreId`, including Firefox FPI and partition selectors.
- Userscript assignment and privileged GM grants are revalidated at the point of use.
- Management/integration status, errors, events, and command catalogs never expose credentials, cookies, auth headers, WireGuard private material, or private logs.
- The external integration never forwards `SAVE_STATE`, `PERSONA_API`, raw browser APIs, or native Mullvad commands.
- A full wipe remains contextual-identity rotation; it must never degrade into broad browsing-data deletion.
- Historical package/state compatibility remains readable unless an explicit versioned migration says otherwise.
- Events are advisory. After reconnect, boot change, sequence gap, or ambiguous failure, clients requery authoritative state.

## 5. Scope and non-goals

### In scope

- documentation/source-of-truth cleanup needed to make the new boundary unambiguous;
- root `AGENTS.md` engineering contract;
- durable `personaUid`;
- persisted migration and identity collision rules;
- recoverable full-wipe/container rotation;
- explicit rotation events;
- boot-scoped mutation preconditions;
- a new external integration protocol and extension-to-extension transport;
- explicit authorization/policy for the external caller;
- secret-safe capability/command discovery;
- existing-userscript inventory/assignment;
- validated workflow create/update/delete;
- end-to-end and release-gate coverage.

### Explicitly out of scope for this change

These audit findings remain separate work unless a stage uncovers a direct blocker:

- automatic userscript update/download engine;
- changing GM values from shared-per-script to per-Persona scope;
- generic userscript source upload/install from PCMS;
- whole-state import/export over the external integration;
- raw cookie-jar editing over the external integration;
- generic native/local HTTP/WebSocket RPC;
- cosmetic renaming of all `pcms-*.js` source files;
- version-labelled UI filename cleanup (`v062.css`, `personas-v07.js`);
- hidden legacy DOM removal;
- destructive branch deletion/tag rewriting.

The plan documents those items so they are not mistaken for completed work.

## 6. Target architecture

```text
PCMS extension
    |
    | PersonaMonkey Integration API v1
    | runtime.onMessageExternal / onConnectExternal
    | exact sender.id authorization + explicit local policy
    v
Integration adapter
    |
    | durable personaUid resolution
    | capability filter / safety policy
    | boot+revision preconditions
    v
PersonaMonkey Management / Persona OS facades
    |
    v
state manager + persona platform + routing + storage + userscripts + workflows
    |
    +--> Firefox APIs
    |
    +--> narrow Mullvad native bridge
```

Dependency rule:

`PCMS -> Integration API -> typed PersonaMonkey facade -> platform services -> Firefox/native primitives`

No new consumer may skip a layer merely because the legacy same-extension UI has older compatibility messages.

## 7. Durable Persona identity contract

### 7.1 Identifier meanings

After this change:

- `personaUid` — stable opaque logical Persona identity.
- `cookieStoreId` — current Firefox contextual-identity/container ID.
- legacy v1 `profileId` / batch `personaId` — remains the current `cookieStoreId`.
- external Integration API commands identify Personas by `personaUid`, never by legacy `profileId`.

Public Persona projections should expose both names explicitly:

```json
{
  "personaUid": "4bf2d43e-...",
  "cookieStoreId": "firefox-container-12",
  "name": "Account 12"
}
```

Do not publish a generic `id` in the new Integration API because it would reintroduce the ambiguity this change is removing. The internal v1 projection may retain `id` for compatibility.

### 7.2 Lifecycle semantics

- Existing managed Persona on first schema-3 load: generate exactly one `personaUid`, persist it, and never regenerate it on normal reload.
- New Persona: generate a fresh UID unless a trusted integration create request supplies an unused validated UID for retry-safe creation.
- Clone: always receives a different UID.
- Update identity/name/color/icon: UID unchanged.
- Archive/unarchive: UID unchanged.
- Full wipe/container rotation: UID unchanged; `cookieStoreId` changes.
- Destroy: UID is retired with the Persona.
- Portable `.personamonkey` Persona import: creates a new logical Persona and therefore a new UID.
- Full encrypted backup **replace/restore**: preserve UIDs.
- Backup **merge**: preserve an imported UID only when it does not collide; otherwise allocate a new UID and return/record the remap.
- Legacy schema-2 data remains readable and is upgraded automatically.
- Internal workflow steps and userscript `profileIds` remain container IDs for this milestone; rotation must remap them atomically/recoverably. Do not silently change their persisted meaning.

### 7.3 Persisted schema

Bump persisted state to **schema 3** because durable identity and rotation recovery are semantic persistence changes, not a transport-only field.

Add:

```js
profile.personaUid: string | null

state.personaRotations: {
  [operationId]: {
    operationId,
    correlationOperationId,   // optional bounded higher-layer correlation ID
    personaUid,
    sourceCookieStoreId,
    targetCookieStoreId,       // null until known
    temporaryContainerName,
    stage,
    startedAt,
    updatedAt,
    error                     // bounded, secret-safe string/null
  }
}
```

Required properties:

- managed current Personas have a non-empty unique UID;
- unmanaged compatibility records do not acquire a new logical identity merely by normalization;
- duplicate UIDs are repaired deterministically/safely during migration, with tests;
- rotation records are bounded and only exist while repair is required;
- normalization is idempotent;
- UID generation is test-injectable so migration tests are deterministic.

### 7.4 Downgrade/rollback rule

A pre-identity PersonaMonkey build does not understand `personaUid` and can drop it when rewriting state. Therefore:

- take/export a pre-migration backup before upgrading in release procedure;
- once PCMS stores account-to-`personaUid` mappings, downgrade to a pre-schema-3 build is unsupported without restoring the pre-upgrade backup or rebinding PCMS mappings;
- document this plainly in release/operations notes;
- forward migration must itself be automatic and non-destructive.

## 8. Boot-scoped optimistic concurrency

The state manager already has boot-aware conflict support. Surface it additively:

- management protocol v1 mutating commands may accept optional `expectedBootId` in addition to `expectedRevision`;
- old v1 clients that send only revision continue to work;
- the new Integration API requires both `bootId` and `revision` for state mutations once the caller has completed discovery;
- a boot mismatch is always a conflict even if the numeric revision matches;
- batch mutations use one explicit precondition and must not permit nested per-item preconditions;
- error responses remain stable and secret-safe.

A client receiving a conflict must requery rather than incrementing or guessing a revision.

## 9. Recoverable container rotation design

The current full-wipe sequence must be replaced by an explicit persisted state machine.

### 9.1 Required safety properties

Rotation must be:

- **UID-preserving**;
- **idempotently repairable** after restart;
- safe if failure occurs after any Firefox side effect or persistence step;
- bounded so repeated retry cannot create unbounded containers;
- route-safe: no old live tab becomes unmanaged and Direct by accident;
- reference-safe: workflow steps, userscript assignments, jobs/history, and route policy point at the current container when complete;
- observable through one explicit rotation event.

### 9.2 Rotation state machine

Use these logical stages; exact helper names may differ:

1. **prepared**
   - validate source Persona and expected boot/revision;
   - persist a rotation journal entry before creating a new container;
   - derive a unique temporary container name from `operationId`.
2. **target-created**
   - find an existing matching temporary container if recovering, otherwise create it;
   - persist its `cookieStoreId` immediately;
   - create a managed target profile with Block or the validated protected route, but do not open tabs.
3. **cutover**
   - move the stable `personaUid` to the target profile;
   - remap userscript `profileIds` and workflow step `profileId` references;
   - keep the source container route-managed until its tabs are closed; do **not** create an unmanaged Direct-fallback window.
4. **history-remapped**
   - idempotently remap persisted automation jobs/tasks/step progress from source to target.
5. **source-quiesced**
   - close source-container tabs while the source is still protected by managed policy.
6. **source-removed**
   - remove the old Firefox contextual identity; if it is already absent during recovery, treat that as completed.
7. **finalized**
   - remove the source compatibility profile/journal;
   - restore the final container name/identity;
   - emit the rotation event only after authoritative state is consistent.

Boot initialization must call a reconciliation routine before normal destructive Persona operations are accepted.

### 9.3 Rotation result/event

Successful operation result and event must include:

```json
{
  "personaUid": "...",
  "oldCookieStoreId": "...",
  "newCookieStoreId": "...",
  "operationId": "...",
  "revision": 42,
  "bootId": "..."
}
```

Add a dedicated event such as `persona.container.rotated`. Do not encode rotation as a generic `persona.changed` against the obsolete container ID.

The bundled management client may still receive the ordinary refresh hint for compatibility, but the new event is authoritative enough to correlate old/new browser identities.

## 10. PersonaMonkey Integration API v1

This is a **new** external boundary. It must not reuse the ambiguous legacy `PCMS_REQUEST` message type.

### 10.1 Transport

Preferred browser-resident transport:

- `browser.runtime.onMessageExternal` for request/response;
- `browser.runtime.onConnectExternal` for advisory events;
- exact `sender.id` authorization;
- no website-origin direct messaging;
- no forwarding to the native Mullvad host.

### 10.2 Envelope

Use explicit new wire identifiers, for example:

```json
{
  "type": "PERSONAMONKEY_INTEGRATION_REQUEST",
  "version": 1,
  "requestId": "req-...",
  "operationId": "op-...",
  "command": "persona.get",
  "precondition": {
    "bootId": "boot-...",
    "revision": 42
  },
  "params": {}
}
```

Rules:

- `requestId` is required for every request.
- `operationId` is required for mutating or side-effecting requests where retry correlation matters.
- request/operation IDs are length-bounded and treated as opaque.
- unknown fields are rejected rather than ignored at the trust boundary.
- responses always include current `bootId` and `revision`.
- no stack traces cross the boundary.

### 10.3 Authorization configuration

Integration is **disabled by default**.

Add bounded local configuration, controlled only by trusted PersonaMonkey UI/internal code:

```js
global.integration = {
  enabled: false,
  trustedExtensionIds: [],
  allowDestructive: false,
  allowDirect: false
}
```

Constraints:

- external callers cannot add themselves to `trustedExtensionIds`;
- maximum count/length is bounded;
- exact sender ID match is required;
- destructive commands require both request confirmation and `allowDestructive=true`;
- Direct assignment requires both request opt-in and `allowDirect=true`;
- external commands never accept `killSwitch:false` or unmanaged-policy changes;
- unknown/disabled capabilities are denied before calling the internal facade.

A small Advanced/Integration settings UI may configure this policy. Do not expose secrets or make a webpage origin an authentication factor.

### 10.4 Identity resolution

External Persona commands use `personaUid`.

The adapter resolves UID -> current managed profile -> current `cookieStoreId`, then calls existing typed services. The external caller never needs to rewrite its account mapping after a full wipe.

For retry-safe create, the integration may accept a caller-supplied UUID-format `personaUid`. If that UID already exists, creation must resolve as a retry or a deterministic conflict; it must never create a second Persona with the same UID.

### 10.5 Initial command policy

Stage 4 exposes only commands already supported safely by the current facades, translated to UID semantics:

- `system.describe`
- `system.status`
- `persona.list`
- `persona.get`
- `persona.create`
- `persona.open`
- `persona.updateIdentity`
- `persona.archive`
- `persona.destroy` when destructive policy permits
- `storage.inspect`
- `storage.clearCookies` when destructive policy permits
- `storage.clearSiteData` when destructive policy permits
- `storage.fullWipe` when destructive policy permits
- `route.list`
- `route.get`
- `route.assign`
- `route.test`
- `workflow.list`
- `workflow.get`
- `workflow.run`
- workflow job list/get/stop/clear according to destructive policy

Do not expose raw whole-state import/export or private route credentials.

Stage 5 adds authoring/assignment commands after their validation layer exists.

### 10.6 Discovery

`system.describe` must return a machine-usable command/capability catalog or a stable versioned descriptor reference containing:

- integration protocol version;
- product version;
- management protocol version;
- Persona API version;
- persisted schema version;
- current boot/revision;
- authorized capabilities;
- command name;
- mutating/destructive/batchable flags;
- required capability;
- parameter schema;
- identifier semantics.

Keep one source of truth for command metadata and derive validation/discovery/tests from it. Do not maintain a second hand-written command table that can drift.

### 10.7 Events

External event stream:

- is authorized with the same exact sender ID;
- is secret-safe and UID-first;
- includes `version`, `bootId`, sequence, revision, timestamp, event type, entity UID, and bounded data;
- has no replay guarantee;
- requires full requery on reconnect, boot change, or sequence gap.

At minimum project:

- state changed;
- Persona changed/removed;
- Persona container rotated;
- route assignment/test;
- workflow job changed/finished.

## 11. Minimum workflow/userscript authoring surface

The first PCMS integration should manage **existing trusted userscripts**, not upload arbitrary executable code.

### 11.1 Userscript commands

Add typed facade/control-plane/integration operations:

- `userscript.list`
- `userscript.get`
- `userscript.assign`
- `userscript.unassign`

Public userscript projection may include:

- ID, name, namespace, version, enabled state;
- run-at/world;
- matches/includes/excludes;
- declared grants/connects;
- compatibility status;
- assigned `personaUid` values.

Do not expose source code, GM values, cookies, cached dependencies, or update credentials through this external projection.

Assignment validation must ensure:

- Persona exists and is managed;
- script exists and is enabled/compatible as required;
- mutation is revision/boot guarded;
- container-ID storage is correctly resolved from UID;
- assignment remains enforced by the runtime.

### 11.2 Workflow commands

Add:

- `workflow.create`
- `workflow.update`
- `workflow.delete`

Requirements:

- use existing `normalizeWorkflow` and `collectWorkflowValidationIssues` / equivalent shared validation;
- external payloads use `personaUid` references and are converted to current internal `profileId` only inside the integration/facade layer;
- referenced scripts must already exist and be assigned/allowed;
- reject MAIN-world signal workflows exactly as run-time validation does;
- bound steps, URLs, concurrency, retries, timeouts, and total tasks;
- update/delete use boot+revision preconditions;
- no raw `SAVE_STATE`;
- no arbitrary workflow package containing new executable userscript code in this milestone.

### 11.3 PCMS vs PersonaMonkey workflow ownership

PersonaMonkey workflow remains a generic browser execution plan. PCMS owns account/business workflows and may map/compile them to PersonaMonkey workflows. PCMS must not use PersonaMonkey `workflowId` or `stepId` as its global business identifier without an explicit mapping.

## 12. GM value decision for this milestone

Keep current GM value behavior unchanged:

- GM values remain shared by userscript ID across assigned Personas.
- Cookies and `GM_cookie` remain scoped to the active container.
- PCMS account credentials/domain state belong in PCMS storage keyed by its account ID and PersonaMonkey `personaUid`.

Add a regression test documenting the current shared-value behavior. Per-Persona GM storage, if later desired, must be an explicit opt-in scope with migration; do not silently change the default.

## 13. Five implementation stages

## Stage 1 — Contract authority and repository guardrails

**Goal:** remove ambiguity before changing persistence or trust boundaries.

### Work

- Add root `AGENTS.md` using the repository engineering/security rules from the audit.
- Create/currentize:
  - `docs/architecture/OVERVIEW.md`
  - `docs/architecture/PERSONA_MODEL.md` with identifier glossary and planned schema-3 semantics
  - `docs/pcms/INTEGRATION.md`
  - a current management protocol doc using “PersonaMonkey Management API”; preserve legacy wire identifiers explicitly.
- Correct `README.md` and `DEVELOPMENT.md` source-of-truth/branch terminology.
- Mark old v0.8 design/gate/handoff documents as historical evidence where needed rather than rewriting history.
- Add lightweight repository checks:
  - root AGENTS exists;
  - canonical current-doc entry points exist;
  - local Markdown links resolve;
  - current docs define PCMS as the separate product;
  - compatibility register names the frozen legacy wire values.
- Establish a single command metadata descriptor or extraction path that later stages can reuse for machine discovery; behavior must remain unchanged in this stage.

### Acceptance

- `npm run test:repository`
- `npm run test:extension` if command-registry refactoring occurred
- link check added by this stage passes
- no runtime/manifest permission change
- no legacy wire literal change

### Suggested commits

- `docs: define PersonaMonkey integration boundary`
- `docs: add repository agent contract`
- `test: validate current documentation contracts`

---

## Stage 2 — Durable Persona identity and boot-scoped concurrency

**Goal:** introduce stable logical identity without yet changing full-wipe side-effect ordering.

### Work

- bump state schema to 3;
- add validated `personaUid`;
- migrate schema-2 managed Personas exactly once;
- enforce uniqueness;
- generate new UID on create/clone/import;
- preserve UID through normal edits/archive;
- preserve/remap UIDs under full-backup replace/merge rules;
- add UID lookup/resolution helpers;
- add UID to Persona projections while preserving v1 `id/profileId`;
- add optional `expectedBootId` to existing management v1 mutation validation and plumbing;
- add tests for migration, collisions, repeated normalization/load, backup rules, and stale-boot conflict.

Do **not** yet expose an external listener.

### Acceptance

- old schema-2 fixtures upgrade and remain functionally equivalent;
- repeated loads do not regenerate UIDs;
- clone and portable import cannot duplicate a UID;
- v1 container-ID commands still work unchanged;
- same revision from an old boot is rejected when `expectedBootId` is supplied;
- `npm test`, `npm run validate`, `npm run build`.

### Suggested commits

- `feat: add durable persona identifiers`
- `feat: add boot-scoped management preconditions`
- `test: cover persona identity migration and collisions`

---

## Stage 3 — Recoverable full wipe and rotation events

**Goal:** make container rotation safe under partial failure and preserve logical identity.

### Work

- add persisted rotation journal/state machine;
- reconcile pending rotations during initialization;
- replace current full-wipe implementation with staged idempotent rotation;
- ensure source tabs stay on managed protected policy until closed;
- remap scripts, workflows, jobs/history idempotently;
- preserve `personaUid`;
- produce dedicated old/new container rotation result/event;
- add bounded cleanup for abandoned temporary containers that can be proven to belong to a journaled operation;
- do not delete unrelated containers.

### Failure matrix tests

Inject failure/restart at least after:

- journal prepare;
- contextual identity create;
- target-ID journal persistence;
- state cutover;
- script/workflow remap;
- automation-history remap;
- source tab close;
- source container remove;
- final profile/journal cleanup.

Verify retry/restart converges to one current Persona, one UID, one target container, no unrelated data deletion, and no unbounded extra containers.

### Acceptance

- rotation is retryable by UID after any tested interruption;
- no period exists where live source tabs silently become unmanaged Direct fallback;
- old/new container IDs are correlated explicitly;
- bundled management UI continues to refresh correctly;
- `npm test`, browser data-management/management smokes, validate, build.

### Suggested commits

- `fix: make persona rotation recoverable`
- `feat: publish persona container rotation events`
- `test: cover rotation failure recovery`

---

## Stage 4 — Restricted external PCMS integration transport

**Goal:** expose a separate, least-privilege cross-extension boundary using UID semantics.

### Work

- add Integration API protocol module and validator;
- add exact sender-ID authorization and disabled-by-default local policy;
- add `onMessageExternal` request handling and `onConnectExternal` advisory events;
- map external UID commands to typed internal services;
- require boot+revision preconditions for state mutations;
- enforce destructive and Direct policy gates;
- reject kill-switch weakening/global safety policy changes;
- add machine-readable discovery from one command catalog;
- add request/operation correlation adequate to make create/rotation retries deterministic;
- add bounded secret-safe error projection;
- add Advanced/Integration configuration UI if needed to authorize the PCMS extension ID;
- never route external traffic to raw legacy messages or native Mullvad RPC.

### Security tests

Deny:

- unknown extension ID;
- same-extension content/page spoof where external listener is expected;
- malformed/unsupported protocol;
- unknown command/field;
- forbidden `SAVE_STATE`, `PERSONA_API`, native commands;
- destructive command without both request confirmation and local authority;
- Direct assignment without local authority;
- stale boot/revision;
- duplicate UID creation;
- event connection from untrusted sender.

Verify authorized caller can discover, list/get/create/open/route/test/run using UID semantics and survives a full-wipe UID-preserving rotation.

### Acceptance

- integration disabled by default;
- authorized transport is usable without exposing credentials/raw state;
- same-extension management console remains compatible;
- external events recover through requery on gaps/reconnect;
- `npm test`, relevant browser smoke, validate, build.

### Suggested commits

- `docs: specify PCMS integration threat model`
- `feat: add PersonaMonkey integration protocol`
- `feat: add restricted external PCMS channel`
- `test: harden external management authorization`

---

## Stage 5 — Minimum authoring surface and release hardening

**Goal:** give PCMS the minimum typed lifecycle operations it needs without turning the bridge into a generic code/state editor.

### Work

- add public userscript metadata projection;
- add list/get/assign/unassign for existing userscripts;
- add validated workflow create/update/delete using UID references externally;
- add contract/catalog parity tests;
- document unchanged GM sharing behavior and test it;
- add end-to-end integration fixtures covering create -> assign route -> assign script -> create workflow -> run -> rotate -> requery -> run again;
- update current docs and release procedure;
- run all practical release gates and record unavailable environment-specific gates honestly.

### Acceptance

- no external arbitrary userscript source install;
- no raw state mutation;
- authoring uses shared validation and respects script/world/grant/routing invariants;
- workflow remains valid across container rotation because the adapter/remap keeps current references consistent;
- contract discovery matches actual validator/handlers;
- `npm test`
- `npm run test:browser` where browser prerequisite exists
- `npm run validate`
- `npm run build`
- `npm run release:check` in an environment with its prerequisites
- installed Firefox/LibreWolf security/rotation and native egress checks recorded separately when available.

### Suggested commits

- `feat: expose userscript assignment management`
- `feat: add validated workflow authoring`
- `test: verify integration contract parity`
- `docs: record PCMS integration release gates`

## 14. Stage dependency graph

```text
Stage 1
  |
  v
Stage 2
  |
  v
Stage 3
  |
  v
Stage 4
  |
  v
Stage 5
```

Do not implement Stage 4 production transport before Stage 2 identity semantics are stable. Do not expose full-wipe externally before Stage 3 recovery tests pass. Do not expose workflow/userscript authoring before Stage 4 authorization is proven.

## 15. Traceability to audit issues

| Audit issue | Disposition |
|---|---|
| I01 external transport gap | Stage 4 |
| I02 durable identity gap | Stages 2–3 |
| I03 GM values shared across Personas | Explicitly preserve/document/test in Stage 5; per-Persona scope deferred |
| I04 workflow/userscript API gap | Stage 5 |
| I05 rotation event/reconnect model | Stages 3–4 |
| I06 boot/revision concurrency gap | Stage 2; required by Stage 4 |
| I07 userscript updater gap | Deferred separate security/product milestone |
| I08 naming debt | Stage 1 current prose; source filename cleanup deferred |
| I09 documentation authority | Stage 1 |
| I10 machine-contract gap | Stage 1 foundation, completed for external discovery in Stages 4–5 |
| I11 incomplete release evidence | Stage 5 |
| I12 missing AGENTS.md | Stage 1 |
| I13 branch/history hygiene | No destructive action in this change; produce/read branch report only if needed |
| I14 version-labelled source names | Deferred cleanup |
| I15 hidden legacy UI debt | Deferred cleanup after caller audit |
| I16 duplicate entry/history docs | Stage 1 authority; deeper archive moves may be deferred |
| I17 repository checks gap | Stage 1 |
| I18 external safety-policy authority | Stage 4 |
| I19 non-recoverable full wipe | Stage 3 |

## 16. Testing strategy

Prefer focused tests first, then broad gates.

### Repository/contract

- canonical doc/link checks;
- compatibility-register checks;
- command metadata/validator/handler parity.

### Identity

- schema-2 -> schema-3 fixture migration;
- UID format/uniqueness;
- idempotent repeated load;
- create/clone/import/backup restore rules;
- legacy v1 container-ID compatibility;
- stale boot + coincident revision conflict.

### Rotation

- injected side-effect failure matrix;
- restart reconciliation;
- no Direct-fallback window for source tabs;
- workflow/script/job remap;
- one UID/one current target after retries;
- explicit rotation event.

### External boundary

- wrong sender/disabled integration;
- protocol/version/field validation;
- capability/policy denial;
- secret redaction;
- direct/destructive policy;
- event authorization/gap handling;
- UID resolution after rotation.

### Authoring

- userscript inventory redaction;
- assignment and unassignment;
- missing/archived Persona;
- incompatible/disabled script;
- workflow bounds and aggregate task limit;
- MAIN-world signal rejection;
- stale generation conflict;
- rotation followed by rerun.

## 17. Documentation deliverables

By the end of Stage 5, current docs should make these facts easy to find:

- PCMS and PersonaMonkey are separate products.
- Which API is internal management v1 vs external Integration API v1.
- Exact meanings of `personaUid`, `cookieStoreId`, legacy `profileId`, workflow ID, job ID, userscript ID.
- State schema/migration and downgrade limitation.
- Full-wipe rotation state machine and recovery behavior.
- External trust model and local authorization controls.
- Direct/destructive authority model.
- Event consistency model.
- Workflow/userscript capabilities and deliberate exclusions.
- Release/test evidence with dates and exact commit/artifact provenance.

Historical v0.x design/release records should remain historical records rather than being rewritten to use terminology that did not exist at the time.

## 18. Commit and branch discipline

For every stage:

1. inspect current branch/status/history/diff;
2. preserve user work;
3. make a short-lived branch from current `main` unless already on an approved working branch;
4. implement in coherent increments;
5. run the smallest relevant tests after each increment;
6. inspect the diff before every commit;
7. commit meaningful working checkpoints with conventional messages;
8. never reset/rebase/force-push/delete branches/tags without explicit authorization;
9. never commit private configs, cookies, backups, credentials, generated XPI/ZIP artifacts, logs, or unrelated cleanup;
10. finish with a clean status and a concise test/commit report.

## 19. Explicit deferred backlog after this change

These are intentionally not bundled into the PCMS integration milestone:

- consent-based userscript updater with metadata fetch/version/grant-diff/rollback;
- optional Persona-scoped GM values;
- remote/external userscript source installation;
- source-file `pcms-*` renames;
- active v0.6/v0.7-labelled UI module rename;
- hidden legacy cookie-panel deletion;
- complete historical-doc tree reshuffle beyond source-of-truth clarity;
- branch/tag cleanup after unique-history preservation review.

They should receive separate specifications because each has different compatibility or security risk.

## 20. Definition of done

The change is complete only when:

- a PCMS extension can be explicitly authorized and can operate Personas by `personaUid`;
- full wipe changes `cookieStoreId` without breaking the logical mapping;
- interrupted rotation repairs on restart/retry;
- stale boot/revision mutations are rejected;
- external callers cannot reach raw state/browser/native APIs;
- Direct/destructive powers require local explicit authority;
- PCMS can manage existing script assignment and validated workflows without arbitrary code upload;
- legacy PersonaMonkey Management v1 remains compatible;
- current documentation and machine discovery agree with implementation;
- automated tests and available browser/release gates pass, with unavailable real-environment checks recorded rather than implied.
