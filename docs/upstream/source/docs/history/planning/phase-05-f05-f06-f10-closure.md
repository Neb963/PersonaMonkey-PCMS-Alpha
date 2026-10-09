# Phase 05 — F-05, F-06, F-10 closure

Date: 2026-09-25  
Audit baseline: main at e33272a7d4ff49623d613d11fbb65da806d7f869  
Phase 05 base: 818eab71ec4e98a9520c76502ed4ae5c595038e1  
Phase 05 source head before this closure record: 3b665b8923b737ae77ec94de617ca43f5b4376f0

This record closes the Phase 05 scope only: F-05 userscript privilege scope, F-06 Firefox Sync recovery lifecycle/privacy, and F-10 Integration API hardening. It does not claim that the v1.1.0 release or later phases are complete.

## F-05 — Userscript privilege scope

- **Status:** Fixed and verified for script host and container checks, import defaults, grant disclosure, and explicit bridge grants.
- **Root cause:** Cookie calls used the active container but accepted script-supplied cookie URLs outside the script’s declared site scope. Imported scripts could inherit assignment to all managed Personas, and the import review did not clearly expose high-impact capabilities.
- **Remediation:** Every GM cookie list, set, and delete checks the requested host against that script’s match/include host scope. The check does not treat @connect as cookie authority. The browser call is forced to the calling tab’s exact cookieStoreId; authorized results retain httpOnly, partition, and first-party-isolation behavior. Tab-data and automation-facing bridge methods require explicit grants. Imports start unassigned; assigning future imports to every Persona requires an explicit saved confirmation. The review lists grants and flags GM_cookie, broad network access, unsafeWindow, and other high-impact capabilities.
- **Regression coverage:** gm-scope.test.mjs exercises cross-host list/set/delete denial, authorized same-host operations, exact container enforcement, httpOnly passthrough, @connect not extending cookie authority, and partition/FPI escape attempts. The full extension suite also covers userscript parsing, grants, and runtime bridges.
- **Firefox evidence:** In Firefox Developer Edition 157.0, the temporary v1.0.0 add-on was active in the isolated Firefox Dev MCP profile. The all-Personas import preference was unchecked. A review probe declaring GM_cookie, unsafeWindow, and @connect was shown with its grants, high-impact disclosure, and unassigned state; Cancel was used and the probe was not imported. This run used the XPI with SHA-256 d2bd89b774309ff119efa1632d6f94bb632438f86b011a6079e377994aeb1af1, built from source head 26ab968c14b92ec1c110f0d86f24462935d8ca46. Later Phase 05 commits only added regression coverage and corrected a comment; no runtime logic changed.
- **Compatibility impact:** Existing imported scripts remain assigned according to their saved profileIds. The future-import default now resolves to false unless the explicit all-Personas confirmation is recorded. GM cookie requests outside match/include authority now fail closed; @connect remains available for its separate network purpose.
- **Residual uncertainty:** Cookie mutation behavior is covered by deterministic tests and the reviewed Firefox import flow; no live third-party cookie mutation was performed in the Firefox acceptance session.

## F-06 — Firefox Sync recovery lifecycle and privacy

- **Status:** Fixed and verified for explicit opt-in, durable disable/clear, deterministic generation handling, migration, large deletions, and snapshot content.
- **Root cause:** Recovery wrote automatically, lacked a durable opt-out, could be repopulated after clear, and inventory-drop protection could preserve intentionally deleted state. Snapshots contained identity, route, script, and workflow metadata that needed clearer disclosure.
- **Remediation:** Recovery requires affirmative consent. A missing control stays off at startup. Disable/clear records a local disabled tombstone and a new disabled Sync epoch, then removes snapshot metadata and chunks. Writers check both local consent and the current Sync epoch before publishing and after publication. Chunks use unique generations, so stale data cannot become readable under a later epoch. User-confirmed deletions are allowed into the next snapshot without an inventory-retention heuristic. Restoring a recovered route remains disabled pending local review.
- **Snapshot disclosure:** The UI and data portability guide identify included global settings; Persona names, descriptions, notes and policies; route endpoint hosts and ports; userscript source and metadata; and workflow definitions, including URLs. Route credentials and private keys, cookies, GM values, Integration authority, and automation history are excluded. The snapshot is not described as non-sensitive.
- **Regression coverage:** recovery-sync.test.mjs and related bootstrap/storage tests cover startup while disabled, clear followed by state changes while disabled, explicit re-enable, a large confirmed deletion, deterministic migration, snapshot inclusion/exclusion, and stale generation/epoch behavior.
- **Firefox evidence:** In Firefox 157.0, recovery was off by default and manual save was unavailable. Enabling displayed the consent review with the exact inclusion and exclusion categories above. Cancel was used; consent remained off and no snapshot was written.
- **Compatibility impact:** Upgraded state without a previously recorded affirmative recovery choice remains disabled and requires opt-in. A legacy imported-script all-Personas preference is also not carried forward as affirmative consent unless its confirmation marker exists.
- **Residual uncertainty:** Unit tests cover stale writers and generation behavior. No two-device Firefox Sync account was available for an end-to-end offline-device race test. An offline device may re-upload orphaned chunks, but its old epoch cannot authorize their use.

## F-10 — Integration API hardening

- **Status:** Fixed and verified for safe lookup, resource bounds, disconnect cleanup, and destructive capability enforcement.
- **Root cause:** Command descriptors were accessed through inherited properties, pending work shared a global-only capacity, event subscribers were unbounded, and caller-provided confirm:true could be mistaken for user approval.
- **Remediation:** Descriptor lookup uses own-property checks and returns stable UNKNOWN_COMMAND for unknown or inherited names. Pending operations are limited per authenticated sender (16) and globally (64). Event ports are limited to 4 per sender and 32 total, with cleanup on disconnect. Destructive actions require durable local capability enforced by the service. confirm:true remains a caller intent field and is not treated as user confirmation. Sender authorization and event re-authorization remain in place.
- **Regression coverage:** management-integration.test.mjs covers constructor, toString, __proto__, inherited names, sender isolation, pending capacity, per-sender and global event caps, disconnect cleanup, caller-forged confirmation, required local capability, and preserved secret projection. integration-contract-parity.test.mjs and integration-lifecycle.test.mjs also pass.
- **Firefox evidence:** The Integration settings showed external access and destructive authorization off. The local authority explanation explicitly said confirm:true is caller intent, not user confirmation. No destructive Integration action was submitted.
- **Compatibility impact:** The Integration wire contract remains version 1. Callers may continue sending confirm:true as intent, but it cannot grant authority. Reserved or inherited property names now return UNKNOWN_COMMAND. Per-sender and global capacity limits can reject excess concurrent requests.
- **Residual uncertainty:** Deterministic tests cover multi-sender quotas and subscriber cleanup. No external extension sender flood was run in Firefox.

## Phase 05 commits

| Commit | Purpose |
| --- | --- |
| bbb3ddeba6959cb9b04e28eca550c2472bfb51f5 | Harden userscript scopes and explicit opt-ins. |
| 4847f38fc1936a165bc33ce0b8c9e5e80ce49ffd | Gate Firefox Sync recovery behind consent. |
| 26ab968c14b92ec1c110f0d86f24462935d8ca46 | Bound Integration command and event access. |
| c7fb9084f7fd913676b019f62b02e962323f6d1d | Add GM cookie mutation, httpOnly, and @connect scope regressions. |
| 3b665b8923b737ae77ec94de617ca43f5b4376f0 | Clarify the recovery consent invariant in a stale code comment. |

The compare from the Phase 05 base to source head reports five commits ahead and zero behind. Main was not modified. The closure record is committed separately.

## Deterministic verification

Passed on the final Phase 05 source, including the test and comment follow-ups:

- npm run test:repository — passed.
- npm run test:extension — passed; all 56 extension test files.
- npm run test:native — passed; 22 tests.
- npm run validate — passed; 128 source files.
- npm run build — passed. Final XPI SHA-256: 42c6774a600fb197762af7403d0ca49550c5247725a6f04b0c35bd4c14e5d0f4. Workflow example ZIP SHA-256: c8a85b9698b71d4e330e0909ccf8d0f9cce1ded7701028c90d949fc73e602901.

The final rebuilt XPI passed the native release artifact checks. After the earlier Firefox test add-on was cleanly uninstalled, a reinstall attempt for this final rebuild returned a generic Firefox Dev MCP BiDi “unknown error.” No Firefox restart or session close was used. The final rebuild differs from the Firefox-tested XPI only by a comment correction; the separate test addition is not packaged into the XPI.

Chromium tests and npm run test:browser were not run. npm run release:check was deferred because it includes the excluded browser suite. No GitHub Actions run was dispatched or rerun.

## Documentation and release boundary

Updated documentation covers the Integration v1 contract, recovery contents and consent, userscript capabilities, and workflow example permissions in README.md, docs/api/integration-v1.md, docs/api/persona-os.md, docs/guides/data-portability.md, docs/guides/workflow-packages.md, and the Mullvad workflow example.

The product remains version 1.0.0 on this branch; this Phase 05 closure is not a v1.1.0 release. Phase 08 still owns final Firefox lifecycle acceptance and the overall release gate. F-13 and findings outside this phase are not closed here.

## Repository state

The remote Phase 05 branch contains the five commits above and this closure record; main remains at the audit baseline. The local verification directory was assembled from GitHub file APIs rather than cloned with Git, so its synthetic git status is not a valid repository working-tree status. The generated dist directory is ignored.
