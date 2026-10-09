# PersonaMonkey Integration API v1

**PCMS** means **Perchance Central Management System**, a separate product. PersonaMonkey exposes a restricted browser-resident Integration API for an explicitly authorized PCMS extension; the bundled PersonaMonkey Management API remains a separate same-extension compatibility surface.

## Boundary and threat model

The dependency direction is fixed:

```text
PCMS extension
  -> PersonaMonkey Integration API v1
  -> typed PersonaMonkey / Persona OS services
  -> platform services
  -> Firefox/native primitives
```

The external caller is not trusted merely because it is installed locally. PersonaMonkey requires all of the following:

- `global.integration.enabled === true`;
- an exact `sender.id` match against the bounded local `trustedExtensionIds` list;
- a valid `PERSONAMONKEY_INTEGRATION_REQUEST` version-1 envelope;
- the command to exist in the Integration API allowlist;
- a matching boot/revision precondition before new mutating or side-effecting work (see the bounded retry exceptions below);
- durable local destructive/Direct authority in addition to explicit caller intent in each request. The `confirm: true` field is not a user approval prompt.

Website origin is not an authentication factor. External requests are handled only by the dedicated external runtime listeners and are never forwarded to the same-extension legacy dispatcher or the Mullvad native host.

The integration policy is disabled by default:

```js
global.integration = {
  enabled: false,
  trustedExtensionIds: [],
  allowDestructive: false,
  allowDirect: false,
  allowExternalAutomation: false,
  allowExecutableInstall: false
}
```

Only trusted PersonaMonkey extension pages can edit this policy through the Advanced/PCMS integration settings surface. External callers cannot authorize themselves.

## Compatibility separation

The existing internal management protocol remains unchanged:

- `PCMS_REQUEST`
- `PCMS_EVENTS`
- `PCMS_PROTOCOL_VERSION = 1`
- existing `PCMS_*` errors
- legacy management-v1 Persona IDs remain current Firefox container IDs.

The external Integration API instead uses:

- request type `PERSONAMONKEY_INTEGRATION_REQUEST`;
- protocol version `1`;
- event port `PERSONAMONKEY_INTEGRATION_EVENTS`;
- durable `personaUid` as the Persona input identity;
- explicit `cookieStoreId` only as the current browser-container projection.

A full wipe therefore changes `cookieStoreId` without requiring PCMS to rewrite its account-to-Persona mapping.

## Request contract

A side-effecting request has this shape:

```json
{
  "type": "PERSONAMONKEY_INTEGRATION_REQUEST",
  "version": 1,
  "requestId": "req-123",
  "operationId": "op-123",
  "command": "route.assign",
  "precondition": {
    "bootId": "current-boot-id",
    "revision": 42
  },
  "params": {
    "personaUid": "4bf2d43e-0000-4000-8000-000000000001",
    "routeId": "__block__"
  }
}
```

Unknown envelope fields, unknown parameter fields, non-JSON values, unsupported versions, and unknown commands are rejected. `requestId` is always required and is limited to 256 characters. Mutating or side-effecting commands also require `operationId` (up to 256 characters) and the complete `{bootId, revision}` precondition. A conflict requires authoritative requery; clients must not guess the next revision.

Responses always contain protocol version, request correlation, current `bootId`, current `revision`, and either a secret-safe result or a structured error. Stack traces never cross the boundary. Error details are code-specific rather than arbitrary service payloads: protocol-version errors may expose only the supported version, state conflicts may expose only expected/actual boot and revision metadata, and `INTEGRATION_VALIDATION_FAILED` may expose only bounded shared-validator issues. Stable domain failures include `PERSONA_NOT_FOUND`, `PERSONA_UID_CONFLICT`, `ROUTE_NOT_FOUND`, `ROUTE_DISABLED`, `USERSCRIPT_NOT_FOUND`, `USERSCRIPT_DISABLED`, `USERSCRIPT_INCOMPATIBLE`, `WORKFLOW_NOT_FOUND`, and `JOB_NOT_FOUND`; clients should branch on codes rather than free-form service messages.

### Stable Integration API error codes

`error.code` is the stable machine-readable identifier. Error messages are safe display text, not control-flow values. `retryable` is advisory: clients still requery state and follow the command’s advertised retry semantics.

| Code | Meaning |
| --- | --- |
| `INTEGRATION_DISABLED` | Local Integration API policy is disabled. |
| `INTEGRATION_UNAUTHORIZED` | Sender is not authorized or must use the internal API. |
| `INTEGRATION_PROTOCOL_UNSUPPORTED` | Integration protocol version is unsupported. |
| `INTEGRATION_BAD_REQUEST` | Envelope, JSON structure, or parameter shape is invalid or exceeds a limit. |
| `INTEGRATION_VALIDATION_FAILED` | Shared semantic validation rejected input. |
| `INTEGRATION_UNKNOWN_COMMAND` | Command is not in Integration API v1. |
| `INTEGRATION_CAPABILITY_UNAVAILABLE` | Required PersonaMonkey service capability is unavailable. |
| `STATE_CONFLICT` | Boot/revision precondition conflicts with current state. |
| `PERSONA_NOT_FOUND` | Managed Persona UID was not found. |
| `PERSONA_UID_CONFLICT` | Caller-supplied UID is already assigned incompatibly. |
| `ROUTE_NOT_FOUND` | Route was not found. |
| `ROUTE_DISABLED` | Route is disabled. |
| `USERSCRIPT_NOT_FOUND` | Userscript was not found. |
| `USERSCRIPT_DISABLED` | Userscript is disabled. |
| `USERSCRIPT_INCOMPATIBLE` | Userscript uses unsupported grants. |
| `WORKFLOW_NOT_FOUND` | Workflow was not found. |
| `JOB_NOT_FOUND` | Workflow job was not found. |
| `USERSCRIPT_ARTIFACT_NOT_FOUND` | An artifact is absent or not owned by this caller. |
| `USERSCRIPT_ARTIFACT_CONFLICT` | This caller already owns the artifact ID with different source bytes or provenance. |
| `USERSCRIPT_ARTIFACT_MISMATCH` | The supplied source/input digest or stored executable bytes fail verification. |
| `INTEGRATION_AUTOMATION_NOT_ALLOWED` | Local External Automation authority is disabled. |
| `INTEGRATION_EXECUTABLE_INSTALL_NOT_ALLOWED` | Local executable installation authority is disabled. |
| `PERSONA_CONTROL_BUSY` | Conflicting control of this Persona is active. |
| `PERSONA_CONTROL_LEASE_INVALID` | Lease is absent, expired, or belongs to another caller. |
| `PERSONA_CONTROL_LEASE_LOST` | Persona control was revoked or its route/identity changed. |
| `EXECUTION_NOT_FOUND` | The caller has no execution with this ID. |
| `EXECUTION_NOT_ACTIVE` | The execution is no longer active. |
| `INPUT_NOT_FOUND` | Transient input is absent, incomplete, or unavailable after restart. |
| `INPUT_EXPIRED` | An input request or transient value expired. |
| `INPUT_CAPACITY` | A transient input, secret, or wait limit was reached. |
| `INPUT_SCOPE_DENIED` | Input was used outside its sender/execution/step/artifact scope. |
| `INPUT_REQUEST_NOT_ACTIVE` | No matching live userscript input wait exists. |
| `RESULT_NOT_AVAILABLE` | Detailed execution result is unavailable. |
| `INTEGRATION_DIRECT_NOT_ALLOWED` | Direct routing lacks request intent or local authority. |
| `INTEGRATION_DESTRUCTIVE_NOT_ALLOWED` | Destructive operation lacks caller intent or durable local authority. |
| `INTEGRATION_OPERATION_CONFLICT` | `operationId` was reused with different command/params, or workflow-run status is ambiguous. |
| `INTEGRATION_OPERATION_CAPACITY` | Bounded operation correlation, lease, artifact, or active execution capacity is full; retry after requery or release. |
| `INTEGRATION_PAGE_INVALID` | Page cursor is malformed, mismatched, or outside the collection; restart pagination. |
| `INTEGRATION_PAGE_STALE` | Boot or state revision changed during pagination; restart from the first page. |
| `INTEGRATION_RESPONSE_TOO_LARGE` | A projected response exceeds its byte/depth safety limit; request a smaller list page where available. |
| `INTEGRATION_INTERNAL_ERROR` | Unclassified internal failure. |

## Integration API v1 command set

Integration API v1 exposes the following typed operations:

- discovery/status: `system.describe`, `system.status`;
- Persona: `persona.list`, `persona.get`, `persona.create`, `persona.open`, `persona.updateIdentity`, `persona.archive`, and policy-gated `persona.destroy`;
- storage: `storage.inspect`, plus policy-gated `storage.clearCookies`, `storage.clearSiteData`, `storage.fullWipe`;
- routes: `route.list`, `route.get`, `route.assign`, `route.test`;
- existing trusted userscripts: `userscript.list`, `userscript.get`, `userscript.assign`, `userscript.unassign`;
- externally managed artifacts: `userscript.artifact.install`, `userscript.artifact.list`, `userscript.artifact.get`, `userscript.artifact.assign`, `userscript.artifact.unassign`, `userscript.artifact.release`;
- control: `persona.control.acquire`, `persona.control.renew`, `persona.control.release`, `persona.control.get`;
- transient data: `execution.input.begin`, `execution.input.append`, `execution.input.commit`, `execution.input.discard`, `execution.secret.stage`, `execution.secret.discard`, `execution.input.submit`;
- ephemeral execution: `execution.start`, `execution.list`, `execution.get`, `execution.result.get`, `execution.result.ack`, `execution.cancel`, `execution.focus`;
- workflows/jobs: `workflow.list`, `workflow.get`, `workflow.create`, `workflow.update`, policy-gated `workflow.delete`, `workflow.run`, `workflow.jobs.list`, `workflow.jobs.get`, and policy-gated `workflow.jobs.stop` / `workflow.jobs.clearFinished`.

The original `userscript.*` surface remains metadata/assignment only. It never accepts new userscript source or exposes externally managed artifacts. Public ordinary userscript projections may expose ID/name/namespace/version/enabled state, match/include/exclude metadata, run-at/world, declared grants/connect rules, compatibility, and assigned `personaUid` values. They do not expose source code, GM values, cookies/auth data, cached dependency bodies, or private route data. Executable source enters only through the separately authorized immutable `userscript.artifact.install` command described below.

Workflow authoring accepts a bounded definition using `personaUid` per step. PersonaMonkey resolves each UID to the current container identity when applying the workflow. The same `validateWorkflowForRun` validator used by execution enforces managed Personas, usable routes, HTTP(S) URLs, script existence/assignment, MAIN-world signal rejection, concurrency/retry/timeout bounds, enabled state, and the total `MAX_WORKFLOW_TASKS` limit. No workflow package/import path is exposed through Integration API v1.

Not exposed: `SAVE_STATE`, `PERSONA_API`, state import/export, raw cookie editing, route credentials, generic userscript source installation/upload, arbitrary package import containing executable source, arbitrary browser APIs, native Mullvad administration, or global safety-policy mutation.

External Persona projections do not publish ambiguous `id` as the logical identity. Workflow-definition projections translate current internal container references into explicit `personaUid` and `cookieStoreId` fields and include the bounded authoring fields needed for read/update round-trips; HTTP(S) URL userinfo/query/fragment are stripped by the external sanitizer. Workflow job/task projections remain separate and omit task URLs/results.

A workflow definition returned by `workflow.get` may be submitted unchanged in `workflow.update`: projected identity and count fields are accepted and ignored for authoring, and an unchanged public URL at the same step ID and URL index retains its existing hidden URL components. Changing that URL replaces it with the new HTTP(S) URL. This preserves a read/update round-trip without exposing credentials, query values, or fragments. Workflow definitions support 200 steps, up to 500 URLs per step and 500 distinct URL tasks per workflow under the shared validator.

## External Automation extension to v1

The following commands add browser execution for a trusted extension while retaining protocol version `1`. The local `allowExternalAutomation` and `allowExecutableInstall` switches are independent and disabled by default. The former permits lease, input, and execution commands; the latter permits owner-scoped artifact install, list/get, assignment, unassignment, and release. An exact repeat of `install` supports reconciliation. Both still require the exact trusted extension ID, enabled Integration policy, request validation, and mutating request preconditions. Neither grants `allowDirect` or `allowDestructive`. `userscript.artifact.release` requires `confirm: true` as explicit caller intent; this flag does not grant general destructive authority.

### Immutable artifacts

`userscript.artifact.install` accepts `artifactId`, a lowercase SHA-256 `sha256` digest, `source` (up to 2,097,152 characters; the total request is also byte-bounded), and `provenance: {packageId, packageVersion, component}`. PersonaMonkey hashes the exact UTF-8 source bytes before installation. Artifact identity is scoped by authenticated sender: repeating the same ID, digest, provenance, and owner reuses the caller's artifact; the same caller cannot reuse an ID for different bytes/provenance, while another trusted sender may independently use the same public artifact ID without seeing or mutating the first sender's copy. A version upgrade needs a new artifact ID within that owner scope. Artifact records carry an internal owner marker derived from the authenticated sender; caller-supplied ownership is never accepted or projected. List/get and lifecycle operations are scoped to that owner and do not return source. The projection includes ID, digest, provenance, installation time, script metadata, `enabled`, `autoRun: false`, and assigned Persona UIDs.

The installer rejects `@require`, remote `@resource`, `@updateURL`, and `@downloadURL`; bundle dependencies into the exact source. It also applies userscript grant compatibility checks. Externally managed scripts are installed enabled with auto-run disabled, require explicit assignment to each Persona, and are checked again against their stored digest at admission and injection. A digest establishes byte identity, not publisher authenticity. The local editor marks their source read-only and offers a local clone for edits. Artifact release requires no assignments or saved-workflow references and refuses active execution references. Normal saved workflows cannot run an external artifact without the trusted external execution path. Portable backup metadata preserves the opaque owner claim for reconciliation, but an imported claim is marked unverified and cannot be listed, selected, or executed as an external artifact. The authenticated sender reclaims it by issuing an exact `userscript.artifact.install` for the same ID, source digest, source bytes, and provenance; PersonaMonkey verifies the stored bytes/metadata before marking ownership verified. Backup/import never grants Integration authority from imported settings.

### Persona control

`persona.control.acquire` takes `personaUid`, a purpose (up to 256 characters), and `ttlMs` from 10 seconds through five minutes. It returns an opaque `leaseId`, `personaUid`, `owner: "self"`, operation/purpose, and acquisition/expiration timestamps. The lease owner is the authenticated `sender.id`; neither the sender ID nor route internals are returned. `renew` takes `leaseId` and `ttlMs`; `release` takes `leaseId`; `get` takes `personaUid` and reports whether it is controlled, with `owner: "self"` or `"another-integration"` and only the caller's own lease ID. Acquire refuses conflicting leases and an active ordinary job for the Persona. The lease follows durable `personaUid` across container rotation, but route changes, archive, expiration, release, local override, or authorization revocation end control and stop associated executions. Local Options shows active leases and lets the user explicitly override them.

For a direct local override, Options names the Persona in its confirmation and submits that Persona's durable UID together with the exact lease ID captured for the selected row. The override succeeds only if that same lease is still active; if it expired or was replaced, the action fails and the user must refresh the lease list. When a local user runs a saved workflow that targets leased Personas, Options confirms the affected Personas by durable Persona UID and binds the confirmation to the exact active lease IDs. The workflow admission path rechecks both the workflow's target UID set and those lease IDs before taking local control. If a target or lease changed after confirmation, the run is rejected and the user must refresh and confirm again. A confirmed override stops the affected external work before the local workflow starts. Requery status after a lease loss and expect `PERSONA_CONTROL_LEASE_LOST` in execution status; leases are memory-only and must be reacquired after a background restart.

Automated route assignment, archive/destruction, storage clearing/full wipe, and workflow runs are checked against active control. Passive reads remain available. The human's trusted local UI retains control.

### Staging input and secrets

`execution.input.begin` declares `name`, `mediaType`, exact `byteLength`, SHA-256 `sha256`, nonempty `stepIds[]` and `artifactIds[]`, and `ttlMs`. It returns an opaque `inputRef` and expiry. Append base64 chunks at the exact next `offset`; `commit` verifies completeness and digest before the input may be used; `discard` frees it. `execution.secret.stage` takes `name`, `value`, matching step/artifact scopes and TTL, returning an opaque `secretRef`; `execution.secret.discard` frees it. Secrets do not have a persisted digest. The current limits are advertised in `system.describe.externalAutomation.limits`; clients should use discovery rather than assume the values below.

| Limit | Current value |
| --- | ---: |
| External executions per caller | 8 active |
| Normal input | 4 MiB per item, 256 KiB per chunk, 8 MiB staged per sender |
| Pending normal inputs and secrets | 8 each |
| Normal input TTL | 10 minutes maximum |
| Secret | 16 KiB per value, 64 KiB staged per sender, 5 minutes maximum |
| Human continuation value | 8 KiB normal input, 16 KiB secret input |
| Active userscript input waits | 32 |
| Control lease TTL | 5 minutes maximum |
| Control leases | 128 total, 16 per caller |
| External artifact registry | 128 artifacts total, 16 per caller; 128 MiB source bytes total, 16 MiB per caller |
| Detailed execution result | 64 KiB total |
| Combined userscript completion signals for a task | 64 KiB |
| Structured `Persona.fail` object | 16 KiB |

Refs can be bound only to an execution from the same sender whose plan contains a matching step and artifact. At script read time the execution, step, artifact, and declared `Persona.input` grant must all match. Staged input and secret bytes remain in the background's transient memory, outside durable Persona state, Sync, backups, ordinary history, operation correlation, events, and diagnostics. Scripts must not return secrets in `Persona.complete` or `Persona.fail`: explicit result/failure payloads can persist in the owner-scoped external job until acknowledged. Secrets are consumed once and discarded on termination, expiry, or authority revocation. JavaScript does not guarantee cryptographic memory zeroization; PersonaMonkey minimizes lifetime and clears held buffers/values on a best-effort basis. PCMS must retain canonical input and secret material on its side as appropriate. A background restart loses staged refs; restage and use a new operation ID if a pending start returns `INPUT_NOT_FOUND`.

An artifact declaring `// @grant Persona.input` can call `await Persona.input.read(name, {offset, length})` for a bounded binary chunk (`data` is a `Uint8Array`, with `nextOffset`/`done`), `text(name)`, `json(name)`, and one-time `secret(name)`. `await Persona.input.wait(name, {sensitivity: "normal" | "secret", timeoutMs})` requests a human continuation. `execution.get` reports `state: "waiting-for-input"` and `waitingForInput[]` entries with `waitId`, `name`, `sensitivity`, `stepId`, `taskId`, `artifactId`, and `deadline`. The owning caller responds with `execution.input.submit({executionId, waitId, stepId, taskId, artifactId, name, value, secret})`; `waitId` and `taskId` must identify the selected live wait, and the artifact ID is also required so waits from different scripts cannot receive each other's continuation. The response must match a live wait and its sensitivity. Waits are bounded and expire, and values are not copied into normal job/event projections. This helper uses the existing userscript bridge; scripts cannot call Integration API directly.

### Ephemeral executions and results

`execution.start` accepts a required `plan: {name, steps[]}` and optional `inputRefs[]` and `secretRefs[]` at the top level. Each step requires `id`, `personaUid`, nonempty HTTP(S) `urls[]`, and `artifacts[]`; it may set `concurrency`, `completion`, `retries`, `retryDelayMs`, `closeTabs`, and `stopOnError`. If omitted, the implementation uses signal completion with a two-minute timeout, concurrency 1, no retries, closes tabs, and stops on error. Each step needs the caller's live control lease, an owned enabled artifact assigned to that Persona, valid grants, and ready Firefox runtime support. The plan uses existing workflow validation and execution machinery, but is not inserted into persistent `state.workflows`.

For example, the `params` of an `execution.start` request can be:

```json
{
  "plan": {
    "name": "Save deployment",
    "steps": [{
      "id": "save",
      "personaUid": "4bf2d43e-0000-4000-8000-000000000001",
      "urls": ["https://example.com/editor"],
      "artifacts": ["provider.example/1.7.0/save"],
      "completion": { "mode": "signal", "timeoutMs": 120000 }
    }]
  },
  "inputRefs": ["input-opaque-reference"],
  "secretRefs": []
}
```

The request envelope also needs a unique `operationId` and current boot/revision precondition. Acquire the Persona lease and install/assign the artifact under their separate authority first. The staged `inputRef` must declare step `save` and artifact `provider.example/1.7.0/save` in its scope.

The returned `executionId` identifies a persisted owned job. `execution.list/get` provide bounded status and progress only for executions admitted from this authenticated sender. An unknown or foreign ID is not exposed as a separate ownership disclosure. `execution.cancel` stops only an owned execution; `execution.focus` requires an active tab whose ownership can be verified. Ordinary `workflow.jobs.*`, events, diagnostics, automation history UI, exports, and cloned history exclude external jobs. The external result path is separate: `execution.result.get` returns execution/operation ID, terminal or current state, `acknowledged`, bounded task statuses and available structured `Persona.complete(result)` values. Because this is the authenticated owner-only result channel, legitimate JSON string contents are preserved exactly rather than passed through the ordinary privacy string rewriter; a dedicated structural validator instead enforces JSON-compatible plain data, bounded depth/nodes/keys/strings/bytes, finite numbers, no cycles/accessors/exotic prototypes, and no prototype-sensitive keys. Oversized task results are marked `resultOmitted` with `truncated: true`; task errors use safe labels rather than raw stack traces. `execution.result.ack` is accepted only when terminal and removes detailed task results while retaining a small status record; repeating an acknowledgement of a terminal execution is idempotent. A caller should fetch and store its result before acknowledging. `Persona.fail("message")` remains supported. A bounded JSON-safe object passed to `Persona.fail()` is available as `tasks[].failure` only from the owner's unacknowledged `execution.result.get`; ordinary status and job projections continue to expose generic failure labels. Structured failures are limited to 16 KiB, depth 6, 512 nodes, 4,096 characters per string, and 128 characters per key; cycles, accessors, non-finite numbers, non-plain objects, and prototype-sensitive keys are rejected. Status includes a safe `failureCategory`, including lease loss where applicable.

`execution.start` binds its `operationId` and a digest of the validated plan/ref contract to persisted job ownership. A retry with the same authenticated sender, operation ID, and contract finds the existing job even if the response or operation journal was interrupted; changing the contract fails with `INTEGRATION_OPERATION_CONFLICT`. If the journal was written before job admission and the transient refs survived, the same execution ID is reused. Input bytes and secret values never enter the fingerprint. On restart, running jobs follow existing interruption recovery; transient refs and leases are lost. PCMS must reconcile the job and use a fresh operation after restaging lost input. PCMS remains responsible for durable Runs, reconciliation, scheduling, and storing results before acknowledgement.

## List pagination

`persona.list`, `route.list`, `userscript.list`, `workflow.list`, and `workflow.jobs.list` sort by their stable public UID/ID (lexicographically); duplicate IDs retain source order. An omitted `page` preserves the legacy array result for collections of at most 100 items. A larger unpaged collection automatically returns the first 100 items in the paged object below. An explicit `page` always returns a paged object. Page size defaults to 50 when `page` is present and may be 1 through 100.

```json
{ "command": "persona.list", "params": { "page": { "size": 50, "cursor": "previous-nextCursor" } } }
```

```json
{ "items": [], "hasMore": false, "nextCursor": null }
```

Supply `nextCursor` with the same command and page size when `hasMore` is true. The cursor is bound to the boot, revision and ordered item identities. A malformed or altered cursor returns `INTEGRATION_PAGE_INVALID`; a cursor from an older boot/revision or changed inventory returns `INTEGRATION_PAGE_STALE`. Restart the list after either error. Very large individual projected items or pages return `INTEGRATION_RESPONSE_TOO_LARGE`; request a smaller page when possible. No successful result silently omits entries to satisfy a transport limit.

The virtual route IDs are `__block__` and `__direct__`; configured route IDs are supplied by PersonaMonkey. `route.list` is the authoritative current inventory, including virtual routes. Use IDs returned there rather than hard-coding configured route identifiers, and recheck the inventory after route errors. Direct still requires request intent and local authority.

The external `persona.open` operation accepts an omitted URL (Firefox's default new-tab behavior) or an explicit HTTP(S) URL only; privileged/local schemes such as `file:`, `data:`, `javascript:`, `about:`, and `moz-extension:` are outside the Integration API boundary. Temporary Persona creation accepts `ttlHours` from 1 through 720, and explicit `expiresAt` values must be RFC3339 timestamps.

## Direct and destructive authority

Destructive commands—including Persona destruction, storage clearing/full wipe, stopping a live workflow job, and clearing finished jobs—execute only when both conditions are true:

1. the caller sends `confirm: true`, recording its intent to request the action; and
2. the durable local `allowDestructive` capability is enabled.

`confirm` is retained as a v1 wire field for compatibility. It does not open a local confirmation dialog and does not prove a person reviewed the action. The local setting is the authoritative capability and is disabled by default. The Advanced settings label describes it as allowing trusted callers to request destructive operations.

Direct routing executes only when both conditions are true:

1. the request explicitly opts into Direct; and
2. local `allowDirect` is enabled.

This applies both when a command assigns Direct and when network activity inherits a Persona that is already Direct. In particular, `persona.open`, `route.test`, `workflow.run`, and `execution.start` require `allowDirect: true` when any affected Persona currently uses `__direct__`; the route is rechecked at the serialized side-effect boundary. Disabling local Direct authority revokes active externally controlled Direct Personas without revoking unrelated protected-route control.

The Integration API schema has no external fields for `killSwitch:false` or `unmanagedPolicy`; attempts to send them are rejected as unknown fields before a typed service is invoked. Block remains the safe/default route.

## Discovery

`system.describe` reports the Integration protocol version, product/API/schema version metadata, current boot/revision, commands usable through the present facade and local authority, available capabilities, Direct/destructive/Automation/install authority, command flags, required fields, parameter schema, identifier semantics, and retry semantics. Treat `integrationProtocolVersion`, the advertised command set, and capabilities as the external contract. `personaApiVersion` and `stateSchemaVersion` describe PersonaMonkey internals; PCMS must not gate Integration API compatibility on either value. Destructive commands requiring disabled authority may be omitted. `externalAutomation` reports `enabled`, `executableInstallEnabled`, `executionAvailable`, Firefox runtime readiness (`userScriptsPermission`, `userScriptsExecute`, `tabOwnership`), and current limits. A command may be listed with `available: false` or `authorized: false`. In particular, `execution.start` is not usable until Firefox's optional userscript permission/API, owned-tab support, and runner are ready. Check the command's advertised `authorized` flag before use.

## Result field reference

The result object varies by command. “Always” means the Integration projection emits that key; a value documented as nullable is present with `null` when the backing value is unavailable. Conditional keys are omitted when their corresponding source data is absent. Arrays may be empty and are bounded by domain validation or explicit byte errors. Clients should tolerate unknown additive fields and should not depend on PersonaMonkey-internal objects.

| Result family | Always projected | Conditional fields and nullability |
| --- | --- | --- |
| `system.describe` | `product`, `productVersion`, `integrationProtocolVersion`, `managementProtocolVersion`, `personaApiVersion`, `stateSchemaVersion`, `bootId`, `revision`, `capabilities[]`, `authority`, `externalAutomation`, `commands[]` | `authority` has boolean `allowDestructive`, `allowDirect`, `allowExternalAutomation`, and `allowExecutableInstall`. Each advertised command has `command`, `capability`, boolean `mutating`, `sideEffecting`, `destructive`, `externalAutomation`, `executableInstall`, `batchable`, `available`, `authorized`, `directAuthorized`, plus `required[]`, `identifiers`, `params`, and `retry`. `directAuthorized` is `null` for commands without Direct authority. Persona API/schema versions are informational. |
| Persona (`persona.list`, `persona.get`, create/update/archive, route assignment) | A Persona object has `personaUid` and `cookieStoreId`; both are `string \| null`. `persona.create` returns `{ persona, reused }` with nullable `persona` and boolean `reused`; `persona.destroy` returns `{ personaUid, cookieStoreId, removed: true }`; `persona.open` returns `{ tabId, personaUid, cookieStoreId }` with nullable `tabId`. | A Persona object may include `name`, `icon`, `iconUrl`, `color`, `managed`, `owned`, `description`, `createdAt`, `lastUsedAt`, `expiresAt`, `archivedAt`, `status`, `statistics`, `activeTabs`, and `protection`. `cookieSummary` appears when cookie data is available and contains numeric `count` and `bytes`. `health` appears when available; it has a controlled `reason` plus optional `status`, `routeId`, `routeName`, `protected`, `proxy`, `dns`, `exitIp`, `exitCountry`, `checkedAt`, and `ageMs` fields. `health.status` is `healthy` only when the selected route is verified, an exit result is present, and DNS has an explicit non-leaking result. Unknown or incomplete DNS evidence keeps the status at `warning`. Before a live test, `health.proxy` can be true to indicate that a configured, enabled route has browser protection ready and fail-closed behavior; after a test it is true only when route-use evidence passes strict proxy verification. This field is independent from DNS verification. `health.dns` is true only after an explicit clean DNS result; false means the route is not verified DNS-clean and does not, by itself, mean that a leak was observed. No ambiguous Persona `id` is exposed. `persona.get`, update, and archive return a Persona object; `persona.list` returns an array of them. |
| Route (`route.list`, `route.get`, `route.assign`) | `route.assign` returns `{ persona, route }`; both keys are present and either nested value may be `null`. `route.list` returns an array; `route.get` returns a route or an error. | Route objects do not default missing properties. When supplied, supported fields are `id`, `name`, `provider`, `type`, `host`, `port`, `proxyDNS`, `country`, `city`, `server`, `enabled`, and `createdAt`; absent source fields are omitted. Use `route.list` for current IDs. Credentials and private keys are excluded. |
| `storage.inspect` | Returns an object when the backing inventory is an object; otherwise the result is `null`. No individual field is emitted when its corresponding source data is absent. | When present, the projection maps source data to `cookieSummary { count, bytes, domainCount }`, `localStorage { items, bytes }`, `sessionStorage { items, bytes }`, `indexedDB { databases }`, `cacheStorage { caches }`, `estimated { usage, quota }`, `activeTabs`, `inspectedOriginCount`, and boolean `complete`. Values are aggregate counts/bytes; cookie-domain names and inspected-origin URLs are not returned. `complete: false` means site-storage figures cover only inspected open origins. |
| Workflow definition (`workflow.list/get/create/update`) | `id`, `name`, `enabled`, `createdAt`, `updatedAt`, `steps[]`. Each step has `id`, `personaUid`, `cookieStoreId`, `urls[]`, `urlCount`, `scriptIds[]`, `concurrency`, `completion`, `retries`, `retryDelayMs`, `closeTabs`, and `stopOnError`. | `createdAt`/`updatedAt`, `personaUid`, `cookieStoreId`, and `completion` may be `null`. `completion`, when non-null, has `mode`, `value`, and `timeoutMs`. `workflow.list` returns an array; get/create/update return one definition. Workflow URLs are returned after removing userinfo, query, and fragment. |
| Workflow job and task (`workflow.run`, `workflow.jobs.*`) | A job has `id`, `workflowId`, `workflowName`, `state`, `personaUid`, `cookieStoreId`, `createdAt`, `startedAt`, `finishedAt`, `currentStep`, `totalSteps`, `failed`, `error`, `stepProgress[]`, and `tasks[]`. A task has `id`, `stepIndex`, `personaUid`, `cookieStoreId`, `personaName`, `state`, `attempts`, `retryPolicy`, `completion`, `startedAt`, `finishedAt`, `nextRetryAt`, `error`, and `attemptHistory[]`. Each `stepProgress[]` item has `index`, `state`, `personaUid`, `cookieStoreId`, `personaName`, `total`, `completed`, `failed`, `stopped`, `retrying`, `active`, `startedAt`, and `finishedAt`. Each attempt-history item has `attempt`, `state`, `startedAt`, `finishedAt`, and `error`. | IDs, names, UIDs, container IDs, timestamps, and task state labels may be `null` when absent. `currentStep` is `-1` when unavailable. `retryPolicy` is `null` or contains `maxRetries`; task `completion` is `null` or contains `mode`. Errors are generic safe labels or `null`; attempt history errors are `"Attempt failed"` or `null`. Task URLs, results, and raw errors are not returned. |
| Route test (`route.test`) | For an object result, `ok`, `failed`, `error`, `connectionCheckFailed`, `checkedAt`, `exit`, `dns`, and `native`. `exit` has `ip`, `city`, `country`, `mullvadExit`; `dns` has `checked`, `leaking`, `serverCount`; `native` has `installed`, `ready`. | `error` and `checkedAt` may be `null`; `exit.ip`, `city`, and `country` may be `null`; `dns.leaking` may be `null` when unknown. A non-object backing result projects as `null`. Failure text is generic; DNS server details and native diagnostics are not returned. |
| `system.status` | The result is `null` if the diagnostics value is not an object; otherwise it may be an empty object if no recognized fields are supplied. | Available fields are `status`, `security`, `managedPersonaCount`, `routeHealth`, `runningWorkflowJobCount`, and `eventSequence`. `security` may include `ready`, `privacySafe`, `networkPredictionSafe`, `webRTCSafe`, `proxyControl`, and `initializedAt`; `routeHealth` contains numeric `healthy`, `blocked`, `degraded`, and `unknown` counts. Sections are omitted if the backing status has no corresponding data. |

The normal response envelope remains the same for every command: `version`, `requestId`, `operationId` (`null` when omitted), `ok`, `bootId`, and `revision`, plus `result` on success or `error` on failure. `operationId` echoes the accepted value or is `null` when omitted; read-only requests may also include an `operationId`.

## Retry and operation correlation

Integration API v1 provides bounded operation correlation for `persona.create`, `storage.fullWipe`, and `workflow.run`. Correlation is keyed to the trusted caller and `operationId`, and retained records can be evicted; it is not an unbounded distributed exactly-once guarantee. If capacity for unresolved work is exhausted, the request fails with retryable `INTEGRATION_OPERATION_CAPACITY`.

The store retains up to 64 operation records and allows at most 16 unresolved operations per trusted caller. Completed records may be evicted before pending records; unresolved work is never evicted to admit another pending operation. The advisory event stream accepts at most four live ports per trusted caller and 32 total. A connection that exceeds either limit is disconnected. Limits are released when a port disconnects, setup fails, authority is revoked, or the integration is disposed.

- `persona.create`: while correlation is retained, retrying the same operation resolves to its original logical Persona. PCMS should supply an unused UUID `personaUid` so intent remains identifiable if completed correlation has expired; an already-owned caller-supplied UID returns `PERSONA_UID_CONFLICT` and requires requery.
- `storage.fullWipe`: a retry with the same caller, operation ID, command, and params resumes or resolves the original rotation when a matching rotation is active or its result is retained. Recovery of a matching active rotation may proceed despite a stale supplied precondition. If there is no matching active rotation, new work requires a current precondition.
- `workflow.run`: while its completed correlation is retained, retry returns the recorded job rather than starting another run. If status is still ambiguous, PersonaMonkey returns retryable `INTEGRATION_OPERATION_CONFLICT`; PCMS must requery jobs before choosing a new operation ID.
- `execution.start`: a durable owner/operation/fingerprint stamp on its job supports recovery across a lost reply or operation-journal crash window. The same sender and operation ID with changed plan or refs conflicts; transient input needs restaging after a background restart, with a new operation ID when a pending admission fails `INPUT_NOT_FOUND`.

Discovery reports `retry: "bounded-operation-correlation"` for create/full-wipe/workflow-run. Other side-effecting commands report `retry: "requery-after-ambiguous-failure"`. After an ambiguous transport failure, PCMS should requery authoritative state and send the **current** `{bootId, revision}` precondition before new work or ordinary retries resume. For correlated operations it must also preserve the same `operationId`, command, and params. A `storage.fullWipe` retry that recovers a matching active rotation is the precondition exception described above. A retained **completed** correlation can be returned without repeating its side effect, including when the original precondition is stale or local Direct/destructive authority has since been disabled. Authorization and the enabled/trusted-caller checks still apply. Correlation retention is bounded, so clients must not rely on completed results being retained indefinitely.

## Advisory events

Authorized callers may connect to `PERSONAMONKEY_INTEGRATION_EVENTS`. Events contain:

- `version`
- `bootId`
- monotonically increasing runtime `sequence`
- `revision`
- `time`
- `type`
- `entity`
- durable UID-first `entityId` where the entity is a Persona
- bounded secret-safe `data`.

The event types emitted by this API include `state.changed`; `persona.changed` and `persona.removed` when a durable Persona identity can be correlated; `persona.container.rotated`; `route.assignment.changed`; `route.test.completed`; `userscript.assignment.changed`; `workflow.changed`; `workflow.removed`; `workflow.job.changed`; and `workflow.job.finished`. Userscript assignment events identify the script and Persona by ID/UID plus the current `cookieStoreId` and assignment state. Workflow change events carry the public workflow projection; removal events identify the removed workflow. Route-test and workflow-job events pass through the same explicit least-privilege projections as their request/response surfaces; internal management-event payloads are never forwarded wholesale.

For `persona.container.rotated`, `data.operationId` is the initiating **Integration API** `storage.fullWipe` operation ID when the rotation originated externally. It preserves the full accepted value, up to 256 characters. `data.rotationOperationId` is a separate opaque PersonaMonkey-internal rotation identifier; it is not an external request ID. Rotations initiated only by trusted internal PersonaMonkey surfaces have `data.operationId: null`.

There is no replay guarantee. On reconnect, boot change, sequence gap, or any ambiguous failure, the client must requery authoritative state. PersonaMonkey serializes both projection from the internal event hub and delivery within each authorized external port, so source order is preserved even across asynchronous state reads and sender authorization checks. If an internal projection fails, the external stream emits only a generic `state.changed` recovery hint with `data.requery: true`; the client must requery authoritative state.

## Secret projection

General Integration results/events/errors never intentionally expose route usernames/passwords, credentials, auth headers, cookie values, WireGuard private material, userscript source, GM values, cached dependency bodies, arbitrary private diagnostics, or stack traces. The explicitly owner-scoped `execution.result.get` is the sole path for bounded userscript completion values. Persona, health, storage, route inventory, route-test, workflow/job, and system-status surfaces use explicit least-privilege projections rather than forwarding whole internal objects. Health projections use controlled public reason labels; raw route/DNS/native verification errors remain internal diagnostics. Storage inspection exposes only aggregate counts/bytes/completeness, including cookie-domain and inspected-origin counts rather than domain/origin names or raw cookies. Route-test projection exposes only verification status, exit IP/city/country, Mullvad-exit status, DNS leak status/count, native readiness booleans, and check time; raw Mullvad/DNS/native payloads are omitted. Workflow/job projection omits task URLs, userscript return values, raw browser errors, and arbitrary job payloads, while preserving bounded state/progress metadata and UID/current-container references. Requests and general response projections are bounded to 4 MiB to support accepted 500 URL workflows; oversized requests return `INTEGRATION_BAD_REQUEST` and oversized results return `INTEGRATION_RESPONSE_TOO_LARGE` without an `ok: true` partial result. Advisory event data is bounded to 32 KiB; oversized events carry `{ "requery": true }` so clients fetch authoritative state. Structured error details remain bounded to 4 KiB.

## GM values, cookies, and PCMS-owned state

Current compatibility semantics include:

- persistent GM values are shared by userscript ID across all Personas assigned that script;
- `GM_cookie` is forced to the calling tab's exact `cookieStoreId`;
- ordinary page cookies remain Firefox contextual-identity/container data and therefore stay container-scoped;
- PCMS account credentials, account/business identifiers, and domain/account state belong in PCMS storage keyed by PCMS business IDs and the PersonaMonkey `personaUid`, not in PersonaMonkey GM values.

Per-Persona GM-value scope is deferred. If added later, it requires an explicit versioned opt-in/migration rather than silently changing existing userscript semantics. The automatic userscript updater is also deferred and is not part of Integration API v1.

## Browser transport note

PersonaMonkey uses Firefox `runtime.onMessageExternal` and `runtime.onConnectExternal` for extension-to-extension transport. The manifest intentionally does not enable website matches through `externally_connectable`; this boundary is extension-to-extension only. Firefox may allow other installed extensions to attempt a connection when no static extension allowlist is declared, so the runtime's exact `sender.id` match against the local policy is the authoritative authorization check. Website origin is deliberately not part of that decision.

## Authority

- [Architecture overview](../architecture/overview.md)
- [Persona model](../architecture/persona-model.md)
- [PersonaMonkey Management API](management-v1.md)
- [Compatibility register](../reference/compatibility.md)
- [Persona OS API](persona-os.md)
