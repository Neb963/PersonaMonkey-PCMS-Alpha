# P011 — Module runtime / capability RPC / generation fencing

Phase state: **ACCEPTED**.

## Implemented scope

- durable per-module runtime state in the PCMS storage broker under `core.module-runtime`;
- admitted immutable package/controller activation through the accepted P004 sandbox host;
- bounded FIFO runtime mailbox;
- exact P008 authority-derived capability exposure;
- durable generation/package fencing before and after privileged capability work;
- graceful DRAINING semantics: already-started privileged work may finish, already-accepted mailbox work drains, and new mailbox/capability calls are denied;
- update/disable generation advancement before subsequent replacement activation;
- restart recovery that advances persisted ACTIVE/DRAINING generations and fences stale runtimes;
- RECOVERY_HOLD activation gating;
- no raw WebExtension, native, PersonaMonkey-internal, IndexedDB, migration, scheduler, or second automation authority.

Implementation files:

- `extension/pcms/runtime/errors.js`
- `extension/pcms/runtime/module-runtime.js`

Focused regression files:

- `tests/pcms/p011-harness.mjs`
- `tests/pcms/p011-runtime.test.mjs`
- `tests/pcms/p011-boundary.test.mjs`

The P011 test harness explicitly disposes its sandbox hosts/child runtimes so Node exits cleanly after verification instead of leaving MessagePorts referenced.

## Acceptance mapping

### A011-01 — runtime broker / mailbox

Verified admitted controller activation, durable runtime state, bounded FIFO invocation/serialization, and boundary isolation.

### A011-02 — capability RPC

Verified exact manifest-authority capability exposure, denial of ungranted capabilities, generation-fenced privileged context, and the approved sandbox-host boundary.

### A011-03 — generation fencing / drain / recovery

Verified graceful drain, rejection of new work during drain, generation advancement, stale-context rejection, replacement activation, restart recovery, and RECOVERY_HOLD activation blocking.

## Focused verification actually run

Node: **v22.16.0**

Command:

`node --test tests/pcms/p011-runtime.test.mjs tests/pcms/p011-boundary.test.mjs`

Result: **6 tests passed, 0 failed, exit 0**.

The local verification tree was reconstructed from GitHub and checked by Git blob hash before execution. The hashes matched the P011 branch / accepted dependencies:

- `extension/pcms/modules/errors.js` — `c362dcf4d72a8fa68d54772bc6358b6e78a2e67a`
- `extension/pcms/modules/authority.js` — `ea5b9dce5c818c6eb9e4c2a2e23c97eccb55074e`
- `extension/pcms/modules/package.js` — `e4708bcef607d63a23e704bdffa194334c51d453`
- `extension/pcms/modules/registry.js` — `c188146a65ad597968817b821f3b1e5fb4bd4459`
- `extension/pcms/sandbox/protocol.js` — `af59387bc18913ec010f9625848751b662f45e55`
- `extension/pcms/sandbox/controller-runtime.js` — `bc8bc701adcc7e43d64e9c5bc7f9d2e3753c20a7`
- `extension/pcms/runtime/sandbox-host.js` — `e781d4f1f881415926a461e0415b65069ce2b817`
- `extension/pcms/runtime/errors.js` — `88fe53b21658106a0a75369872bc65fc049a95bc`
- `extension/pcms/runtime/module-runtime.js` — `9d8489da268763999cf4435a36a2d99b13a410b5`
- `tests/pcms/p011-harness.mjs` — `b77ff4964e46b21b63e3ec4374559bf29365fad7`
- `tests/pcms/p011-runtime.test.mjs` — `3f03809ea63058c57f6b077f239f84acc75c2e77`
- `tests/pcms/p011-boundary.test.mjs` — `6e7b8111574dd5c1b4957fb33dab2e552de09159`

## Independent GitHub CI

P011 branch checkpoint `3ef7ccc526db3f01301b8d1c73427acdc559ca6f`:

- GitHub Actions `verify`, run **300** / run id **37256090667** — **success**;
- GitHub Actions `firefox-developer-edition`, run **295** / run id **37256090762** — **success**.

The standard workflows do not discover `tests/pcms/**`; the focused suite above was therefore executed independently against the byte-verified branch tree.

Merged main commit `de4410938f77ad386c382be0f697057ecbca06fb`:

- GitHub Actions `verify`, run **306** / run id **37256572170** — **success**;
- GitHub Actions `firefox-developer-edition`, run **301** / run id **37256572168** — **success**.

PR #11 is merged. These results, together with the focused acceptance suite above, provide deterministic evidence for A011-01, A011-02, and A011-03.

## Acceptance decision

The MERGED governance checkpoint `019f1d8243333e9472df2c788555915deaabe253` passed:

- repository verification run **311** / run id **37256714092** — **success**;
- pinned Firefox Developer Edition run **306** / run id **37256714032** — **success**.

Together with the byte-verified focused 6-test suite, branch/PR CI, exact merged-main CI, and the successful MERGED governance checkpoint, this satisfies **A011-01**, **A011-02**, and **A011-03**. P011 is **ACCEPTED**.
