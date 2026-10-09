# P004 — Firefox sandbox dynamic-controller capability spike

Status: **ACCEPTED**

Implementation checkpoint: `5898be93e2304433bc3d57ae5e6b16e9e08a4161`.

## Platform contract reviewed

P004 is based on the current Firefox WebExtension sandbox contract, not Chromium inference.

Reviewed on 2026-10-04:

- MDN `manifest.json / sandbox`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sandbox
- MDN `content_security_policy`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy
- Mozilla's current `test_ext_sandbox_csp.js`, which independently verifies that sandboxed extension pages have opaque `"null"` origin, do not expose `browser` or `chrome`, and may use a sandbox CSP that admits `unsafe-eval`.

The current MDN contract states that a sandboxed page may validate an incoming extension message with
`event.origin === location.origin`, while an extension parent cannot authenticate a sandbox response by
origin because the sandbox serializes as `"null"`. P004 therefore uses the window channel only for a
one-time parent-to-child bootstrap and transfers a private `MessagePort`; all controller RPC then uses the
private port.

## A004-01 — sandbox runtime probe

Added:

- `extension/pcms/sandbox/manifest-fragment.json`;
- `extension/pcms/sandbox/controller.html`;
- `extension/pcms/sandbox/controller.js`;
- `extension/pcms/sandbox/controller-runtime.js`;
- `extension/pcms/sandbox/protocol.js`.

The manifest fragment declares the Firefox sandbox page and a closed sandbox CSP:

- `sandbox allow-scripts`;
- `script-src 'self' 'unsafe-eval'` for the approved dynamic-controller spike;
- no `allow-same-origin`;
- `connect-src 'none'`;
- image/style/font/media/object/frame/form/base surfaces disabled.

The child runtime rejects bootstrap from the wrong window source or origin and accepts exactly one transferred
port. Dynamic source is evaluated only after that private channel has been established.

P004 intentionally does **not** edit the production `extension/manifest.json`. That file is a frozen
PersonaMonkey/P002 path and is outside the P004 claim. The fragment is the bounded integration contract for
the later phase that owns production wiring.

## A004-02 — authenticated bounded capability RPC

Added `extension/pcms/runtime/sandbox-host.js`.

The host exposes only an explicit capability map. The dynamic controller receives a frozen API containing:

- protocol version;
- `call(capability, args)`.

It does not receive raw `browser.*`, `chrome.*`, IndexedDB, PersonaMonkey services, Mullvad/native RPC,
or a generic privileged dispatcher.

RPC is fenced by:

- one random session identifier per host;
- a transferred private `MessagePort`;
- exact protocol version and session checks;
- request/call correlation IDs;
- exact message shapes;
- data-only JSON cloning;
- 64 KiB normal-message and 256 KiB controller-source bounds;
- depth/node/string limits;
- bounded capability concurrency;
- operation timeouts;
- fixed, secret-safe public error codes;
- fail-closed handling for stale/unknown/malformed messages.

Unknown capability names return `PCMS_SANDBOX_CAPABILITY_DENIED`; capability implementation failures collapse
to `PCMS_SANDBOX_CAPABILITY_FAILED`.

The child captures security-relevant intrinsics before evaluating module code and freezes the returned
controller method table. A controller attempt to poison mutable globals such as `Number.isFinite` therefore
does not weaken the message validator.

## A004-03 — lifecycle and isolation acceptance

Lifecycle is explicit:

`idle -> booting -> active -> disposed`.

The host supports:

- one controller load;
- bounded method invocation;
- explicit controller disposal;
- rejection after disposal;
- fail-closed shutdown on protocol corruption, stale correlation, malformed controller shape, or bootstrap failure.

The child removes its ambient window-message bootstrap listener after accepting the private port. The
privileged host does not install an ambient window-message listener at all.

## Deterministic direct verification

Executed in the available Node 22 environment:

`node --check extension/pcms/sandbox/protocol.js`

`node --check extension/pcms/sandbox/controller-runtime.js`

`node --check extension/pcms/runtime/sandbox-host.js`

`node --test tests/pcms/p004-*.test.mjs`

Result: **10 tests passed, 0 failed**.

The direct suite covers:

- sandbox CSP/manifest contract;
- wrong source/origin bootstrap rejection;
- bounded JSON/exotic-object rejection;
- version/session/exact-envelope fencing;
- fixed public error vocabulary;
- allowed capability dispatch;
- denied capability dispatch;
- dynamic controller start/invoke/dispose;
- browser/chrome absence in the isolated test realm;
- intrinsic-poisoning attempt;
- malformed-controller fail-closed behavior;
- static raw-authority boundary checks.

The local harness was reconstructed from the committed P004 implementation. The committed phase tests live
under `tests/pcms/**`, which the current root Actions workflows do not discover. P004 does not own
`.github/**` or `package.json`, so this phase does not widen CI wiring outside its claim.

## Independent exact-checkpoint CI

Exact checkpoint `5898be93e2304433bc3d57ae5e6b16e9e08a4161` passed:

- `verify` push run **37238136967** — **success**;
- pinned Firefox Developer Edition push run **37238137071** — **success**.

The Firefox workflow proves the repository still runs successfully under the exact pinned Firefox Developer
Edition baseline. It is **not** represented as a P004 sandbox-page execution test.

## Scope review

Diff from claim checkpoint `2c47a64d5ed323b4cd33c62466bddf3672140111` to implementation checkpoint
`5898be93e2304433bc3d57ae5e6b16e9e08a4161` contains only:

- `extension/pcms/**`;
- `tests/pcms/**`.

No PersonaMonkey-owned frozen blob, root manifest, package script, workflow, native component, provider adapter,
or browser-automation authority was modified.

No Firefox DevTools MCP, Perchance live provider, Mullvad live route, or P025/P026 live acceptance is claimed.

## Pull request and merged-main verification

Pull request #4 final head `ba6a18164aed8d8cd1e79db288ede1613d9d41b2` passed:

- PR repository verification run **37238358744**;
- PR pinned Firefox Developer Edition run **37238358712**.

PR #4 merged as `3abfe06f61829eaa7485224508daaf35dd751521`.

The exact merged `main` commit passed:

- repository verification run **37238440353**;
- pinned Firefox Developer Edition run **37238440377**;
- Firefox smoke artifact **11316323424**, digest `sha256:b066a526d0bb80ffd5e3a2776c7202e47bbf517efc7f4a777f3413661b922da1`.

This establishes integration evidence for the exact merged source. P004 is not marked ACCEPTED until this MERGED governance checkpoint itself passes repository verification.

## Acceptance decision

The durable MERGED governance checkpoint `432532cb25122b7df308876fa5857db7a75cf424` passed:

- repository verification run **37238577144**;
- pinned Firefox Developer Edition run **37238577170**;
- Firefox smoke artifact **11315699258**, digest `sha256:84c1a026b0e9660ecd0d7750a2d84bcd4578e628e287a27b5729c34c8bed5801`.

Together with the direct P004 protocol/runtime/boundary suite and the platform-contract evidence recorded above,
this satisfies **A004-01**, **A004-02**, and **A004-03**. P004 is ACCEPTED.

No successor phase is claimed or implemented by this session.
