# P006 — PCMS SecretStore host + SecretRef abstraction

Status: **ACCEPTED**

Initial implementation checkpoint: `a0d8dc0662fcdadda22b99c1e3bf25bb434c5a76`.

Final hardened code checkpoint: `3bcf614e50b03cb212c16f6e56c124becb60e1a9`.

## Scope

P006 implements the PCMS-side SecretRef and dedicated secret-host boundary without modifying PersonaMonkey persistence or the Mullvad routing host.

Implemented under `extension/pcms/secrets/**`:

- opaque versioned `SecretRef` values backed by UUID identity only;
- fixed safe secret-store error vocabulary;
- a bounded dedicated-host protocol using host ID `com.persona.pcms_secret_store`;
- a Firefox native-messaging transport that refuses every host except that dedicated secret host;
- a native secret backend with request/version correlation, strict response shapes and timeouts;
- a privileged SecretStore facade for create/replace/resolve/delete;
- explicit `PCMS_SECRET_UNCERTAIN` mutation outcomes carrying only the opaque ref and operation when a native reply is ambiguous;
- diagnostics that expose no backend-provided text and no secret values.

P006 owns no `native/**` write path. Accordingly this phase does not alter, extend, package or install the existing `com.persona.mullvad_router` host, and it does not claim a real OS secret-host executable was exercised. The accepted architecture and phase ownership are preserved by defining the dedicated host protocol/Firefox transport adapter entirely inside PCMS. A006 requires U/I/C evidence; real installed-host/provider acceptance remains outside this deterministic phase.

## A006-01 — SecretRef contract

A SecretRef is a string of the form `pcms-secret:v1:<uuid>`.

The reference contains no secret value, account label, provider name, URL, credential field or backend path. Validation normalizes the UUID representation and rejects malformed references. Diagnostics collapse valid refs to `pcms-secret:v1:[opaque]`.

Ordinary PCMS persistence is not imported or used by the secret subsystem.

## A006-02 — narrow native host/backend

The protocol fixes:

- protocol version 1;
- host identity `com.persona.pcms_secret_store`;
- operations `probe`, `put`, `get`, and `delete`;
- maximum UTF-8 secret size of 256 KiB;
- exact request/response correlation IDs;
- exact response object shapes;
- a bounded fixed host error vocabulary.

`createFirefoxNativeSecretTransport()` accepts the privileged Firefox runtime but can address only the dedicated secret host. An attempt to use `com.persona.mullvad_router` fails before native dispatch.

`createNativeSecretBackend()` receives only the narrow send function, not raw PersonaMonkey state/services or routing authority. The public SecretStore facade likewise receives no `browser.*`, raw native RPC object, IndexedDB handle or PersonaMonkey service.

## A006-03 — redaction/failure behavior

Secret backend exceptions are normalized to fixed safe errors; raw native exception text is never propagated. Host error responses containing unexpected fields or hostile secret-bearing messages fail as a fixed protocol error.

Mutation failures that may have occurred after dispatch are not presented as ordinary retryable failure. Create/replace/delete map timeout, unavailable or protocol ambiguity to `PCMS_SECRET_UNCERTAIN`, retaining only:

- the opaque SecretRef;
- the operation name.

This lets a higher layer reconcile before retry without serializing secret material.

Cross-request responses, malformed responses, invalid refs, oversize values, closed stores and read timeouts fail closed. Public probe/diagnostic results expose no backend-provided text.

## Focused verification

The focused harness was reconstructed from the exact branch contents and checked against Git blob identities.

Exact tested blobs:

- `extension/pcms/secrets/errors.js` — `be2584b5447ddc59bb04ebb1d488549bfb65bebb`;
- `extension/pcms/secrets/secret-ref.js` — `f5c3009d1745d23c047285fbacaa4aacb942a2c5`;
- `extension/pcms/secrets/protocol.js` — `2c1df200d391e7c7491082e3e350a03af809bcb7`;
- `extension/pcms/secrets/native-secret-backend.js` — `046116819f537ba105d552faa8231a77d9518e6d`;
- `extension/pcms/secrets/secret-store.js` — `a913708cb9e8656aa4fcb4a1ce57c661b0387475`;
- `tests/pcms/p006-secret-store.test.mjs` — `928c221bf407e3e62135d1760f36e2c0b76ed5be`;
- `tests/pcms/p006-boundary.test.mjs` — `cb647e15ad62570f8d82c7c41824bae399a51d89`.

Commands actually run:

```text
node --check extension/pcms/secrets/errors.js
node --check extension/pcms/secrets/secret-ref.js
node --check extension/pcms/secrets/protocol.js
node --check extension/pcms/secrets/native-secret-backend.js
node --check extension/pcms/secrets/secret-store.js
node --test tests/pcms/p006-*.test.mjs
```

Result: **11 tests passed, 0 failed**.

The current root workflows do not discover `tests/pcms/**`; P006 does not own `.github/**` or `package.json`, so this phase does not widen CI wiring outside its claim. The focused suite above is the direct U/I/C evidence.

## Independent CI

Initial implementation checkpoint `a0d8dc0662fcdadda22b99c1e3bf25bb434c5a76` passed:

- repository verification push run **37241774883** — success;
- pinned Firefox Developer Edition push run **37241774800** — success.

The final hardening additionally contains synchronous backend-construction/close failure containment; raw backend getter/close exception text cannot escape the SecretStore boundary.

The FDE run is a repository regression smoke on the exact pinned browser build. It is not represented as an installed native secret-host test.

## Scope review

Compared with durable claim checkpoint `fceac82370df0a35223c65e39cd0c23cc13b9403`, the final hardened code checkpoint changes exactly seven product/test files; subsequent branch commits are P006 evidence/governance only:

- five files under `extension/pcms/secrets/**`;
- two files under `tests/pcms/**`.

All product/test paths are within the active P006 claim. No successor phase is implemented.

## Final PR and merged-source integration verification

Final PR head `6133998e47505988693f161262115cd108065b2f` passed:

- repository verification push run **37242066829** — success;
- pinned Firefox Developer Edition push run **37242066825** — success;
- repository verification PR run **37242069361** — success;
- pinned Firefox Developer Edition PR run **37242069357** — success.

PR #6 merged as `976eaef41a06b1ddd4abeb6021f46fa9161a870a`. The exact merged source passed:

- repository verification run **37242212905** — success;
- pinned Firefox Developer Edition run **37242212890** — success.

A fresh exact-blob focused reconstruction of hardened checkpoint `3bcf614e50b03cb212c16f6e56c124becb60e1a9` also passed **11 tests, 0 failed**, with all seven Git blob hashes matching the evidence above.

P006 remains MERGED until this governance checkpoint itself passes repository verification.

## Acceptance decision

The MERGED governance checkpoint `d4a3d836f17245010d9342cd4f8599b4cf3d6a13` passed:

- repository verification run **37243421554** — success;
- pinned Firefox Developer Edition run **37243421501** — success.

A006-01, A006-02 and A006-03 are satisfied by the exact-blob focused U/I/C evidence, final PR-head CI, merged-source CI and the green MERGED governance checkpoint. P006 is therefore **ACCEPTED**.

No successor phase is claimed or started by this session. P007, P008 and P009 remain READY; P019 remains dependency-blocked.
