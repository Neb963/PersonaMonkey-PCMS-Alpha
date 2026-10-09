# P009 — Persona Broker implementation

Status: **ACCEPTED**

Source/test checkpoint: `88591963b3366f9572c2cf615074f9c8ee440aeb`.

## Scope

P009 implements the PCMS Persona Broker adapter defined by the accepted P003 contract. The adapter remains transport-neutral and preserves PersonaMonkey Integration API v1 semantics without importing PersonaMonkey implementation services.

P009 does not create mutation operation identities, durable RemoteOperations, ProviderGate decisions, browser execution, routing authority, userscript authority, raw WebExtension access, native RPC, or PersonaMonkey persistence access. Durable mutation correctness remains P010 responsibility.

## A009-01 — Integration-semantic facade

Added `extension/pcms/core/persona-broker.js`.

The adapter:

- accepts the P003 transport-neutral broker request contract;
- revalidates requests through `createPersonaBrokerRequest()`;
- maps requests to the exact `PERSONAMONKEY_INTEGRATION_REQUEST` version-1 wire envelope;
- preserves request/operation/precondition correlation rather than synthesizing any of those values;
- sends only through an injected `send()` transport function;
- validates and bounds every Integration response before returning it;
- maps the Integration event port name exactly to `PERSONAMONKEY_INTEGRATION_EVENTS`;
- validates and bounds every event;
- rejects duplicate/regressing event sequence numbers and a boot-ID change on an active event stream;
- freezes returned boundary data;
- collapses transport exceptions into fixed secret-safe adapter errors.

The request/response bounds remain aligned with Integration v1: 4 MiB request/response and 32 KiB event payloads.

The PCMS namespace metadata now reports `integration-v1-adapter` instead of the P003 `pending-P009` placeholder. The existing P003 bootstrap regression was updated only for that expected implementation marker.

## A009-02 — capability / lease / execution mapping

The adapter derives capability membership directly from the accepted `PERSONA_BROKER_COMMANDS` contract.

It exports immutable:

- capability -> command mappings;
- the `persona.control.*` command family;
- the `execution.*` command family.

Every command is mapped exactly once to its accepted Integration capability. Control and execution families remain under `external-automation`. Artifact-install authority remains separately described by the accepted contract.

The broker preserves durable `personaUid` inputs exactly. Lease/execution calls are not translated into container IDs and do not expose `cookieStoreId` as logical authority.

Mutation and side-effect requests still require caller-supplied `operationId` and exact `{bootId, revision}` preconditions through the P003 contract. P009 deliberately does not auto-create these values.

## A009-03 — parity and failure behavior

Added:

- `tests/pcms/p009-broker.test.mjs`;
- `tests/pcms/p009-capability.test.mjs`;
- `tests/pcms/p009-boundary.test.mjs`;
- `tests/pcms/p009-parity.test.mjs`.

Coverage includes:

- exact Integration request/event wire names and protocol limits;
- command-capability parity;
- durable Persona UID preservation;
- lease request operation/precondition preservation;
- prototype-inherited capability-name rejection;
- malformed response rejection;
- transport failure normalization without raw error leakage;
- accessor/exotic request rejection before transport dispatch;
- event sequence/boot fencing;
- consumer-listener failure isolation;
- raw browser/native/PersonaMonkey boundary checks;
- explicit proof that P009 does not generate mutation operation IDs or preconditions.

## Focused verification actually run

The exact P009 product/test blobs at the checkpoint are:

- `extension/pcms/core/persona-broker.js` — `e4100b8f28ccc13055c7bb3bbb58fe04314b7e17`;
- `extension/pcms/core/bootstrap.js` — `aff9008ceea6b5733948380a7200ed3e097f35dd`;
- `tests/pcms/p003-bootstrap.test.mjs` — `348a50465a374917a12218d62d545a175b326df7`;
- `tests/pcms/p009-broker.test.mjs` — `6d236b4bb71ced7ff72c7abd6a514958a528b228`;
- `tests/pcms/p009-capability.test.mjs` — `697866b81ac9edfe522c28872b0659640a08ad26`;
- `tests/pcms/p009-boundary.test.mjs` — `d0c1de57200ffc443f5269198bacef841597495b`;
- `tests/pcms/p009-parity.test.mjs` — `9caaac2084cbd6c9360b5d9f3a89b66ebf59139a`.

Commands actually run with Node **v22.16.0**:

```text
node --check extension/pcms/core/persona-broker.js
node --check extension/pcms/core/bootstrap.js
node --test tests/pcms/p003-bootstrap.test.mjs tests/pcms/p009-*.test.mjs
```

Result: **14 tests passed, 0 failed**.

The local focused harness used byte-identical P009 source/test files and narrow dependency stubs for the already-accepted P003 broker contract and Integration-v1 protocol constants. Those dependency semantics were independently proven in P003; the stubs exist only because the available local harness does not contain the full repository checkout.

The current root Actions workflows do not discover `tests/pcms/**`; P009 does not own `.github/**` or `package.json`, so this phase does not widen CI wiring outside its claim.

## Independent branch CI

Exact source/test checkpoint `88591963b3366f9572c2cf615074f9c8ee440aeb` passed:

- repository verification push run **37249840273** — success;
- pinned Firefox Developer Edition push run **37249840277** — success.

These are repository regression/FDE smoke checks, not substitutes for the focused P009 U/I/C suite above.

## Scope review

Compared with claim-governance base `e26a699ce817f49ec63ec095a60cc1e4746778ed`, source/test checkpoint `88591963b3366f9572c2cf615074f9c8ee440aeb` is seven commits ahead, zero behind, and changes exactly:

- `extension/pcms/core/persona-broker.js`;
- one implementation-marker line in `extension/pcms/core/bootstrap.js`;
- one expected-marker line in `tests/pcms/p003-bootstrap.test.mjs`;
- four P009 test files under `tests/pcms/**`.

No PersonaMonkey-owned source, native code, manifest, storage migration, provider adapter, root workflow/package script, or successor-phase implementation was changed.

No Firefox DevTools MCP or P025/P026 live acceptance is claimed.

## Pull request / merged integration

Final PR head `81b94bcbbb77e758e3de8db2224323bcccee613e` passed:

- push repository verification run **37250011795** — success;
- push pinned Firefox Developer Edition run **37250011814** — success;
- PR repository verification run **37250024938** — success;
- PR pinned Firefox Developer Edition run **37250025041** — success.

Pull request #9 merged as `c03d37a6f2c3d216ae00950ce802994c11b9990e`.

The exact merged source passed:

- repository verification run **37250128021** — success;
- pinned Firefox Developer Edition run **37250127926** — success.

The root workflows are repository regression/FDE smoke checks. The focused U/I/C suite remains the direct P009 behavior evidence.

## Acceptance decision

The MERGED governance checkpoint `268e76c76e7573d93695f8c6080e532f682af40d` passed:

- repository verification run **37250248257** — success;
- pinned Firefox Developer Edition run **37250248255** — success.

Together with the exact-source focused suite, Integration-v1 parity checks, PR-head CI, and merged-source CI, this satisfies **A009-01**, **A009-02**, and **A009-03**. P009 is **ACCEPTED**.
