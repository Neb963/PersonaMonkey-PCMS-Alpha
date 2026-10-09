# P026 — Live acceptance 2

Phase state: **ACCEPTED**.

Final pre-merge implementation checkpoint: `edd699e89d82b9344b4abc05208aeee458d36086`.

Operator LIVE evidence satisfies A026-01, A026-02, and A026-03. PR integration, merged-main verification, and the final governance transition have also completed.

## Implemented scope

P026 exposes representative live PCMS operations through the existing accepted module services:

- Accounts bind/rebind and Explorer discovery/reservation controls;
- Deployer and Refresher provider mutations;
- Account Provisioning progression with explicit HumanTask handling;
- backup/restore controls and RECOVERY_HOLD reconciliation/release.

Provider mutations remain behind ProviderGate and durable RemoteOperation identity. Live provider context durably binds the operation to the Account/Persona target. Ambiguous outcomes enter or remain UNCERTAIN and must reconcile before any retry; the UI does not blindly replay them.

Perchance provider effects are intentionally operator-assisted. PCMS opens the target through Persona Broker / Integration v1, displays the desired source/hash where applicable, and requires an explicit operator outcome. CAPTCHA and provider verification remain manual; no CAPTCHA bypass or second browser-automation authority is introduced.

Startup recovery enters durable RECOVERY_HOLD when unresolved RemoteOperations exist before module recovery. Interrupted DISPATCHING operations become UNCERTAIN; recovery may reconcile/cancel but never blindly redispatch them.

## Focused deterministic verification

The exact P026 production blobs and exact P026 test blobs were materialized from the implementation branch and verified against their Git blob identities before execution.

Command actually run with Node **v22.16.0**:

```text
node --test tests/pcms/p026/*.test.mjs
```

Result: **11 tests passed, 0 failed**.

Coverage includes:

- fresh Persona Broker boot/revision preconditions immediately before side effects;
- durable operation-context identity fencing;
- ambiguous generator update -> UNCERTAIN -> explicit reconciliation, with no replay;
- representative provisioning mutation through explicit operator confirmation;
- restart entering RECOVERY_HOLD before module recovery;
- recovery hold blocking new dispatch;
- reconciliation/cancellation without redispatch;
- clean restart remaining NORMAL;
- static authority-boundary checks prohibiting raw browser/native/provider authority;
- backup/restore/recovery controls.
- Firefox ESR popup sizing regression: the toolbar popup body has a stable intrinsic width and no viewport-dependent `min()`/`100vw` sizing.

## Independent branch CI

Exact implementation/test checkpoint `8606eca5d08d1441465ae8f879aa1b01e283af9a` passed:

- repository verification run **37500830402** — success;
- pinned Firefox Developer Edition run **37500830471** — success.

The root workflows are independent regression/FDE evidence. They do not substitute for P026 LIVE acceptance.

A live Firefox ESR operator report then exposed a toolbar-popup sizing defect: the popup collapsed to a narrow vertical strip while Firefox Developer Edition rendered it normally. The corrective implementation checkpoint `645b872ce595c94a6f058639025994e288b13600` replaces the circular viewport-relative body sizing with a fixed 370px preferred body width while retaining the existing narrow-layout media rules. The frozen upstream popup CSS is preserved under `docs/upstream/source/`, and the derivative is explicitly recorded in the import manifest.

Corrective checkpoint CI:

- pinned Firefox Developer Edition run **37612345475** — success;
- repository verification run **37612345507** — success.

The operator still needs to retest the corrected candidate in Firefox ESR; the deterministic FDE run does not substitute for that live ESR observation.


A later live Firefox ESR operator pass exposed an Accounts binding usability defect. The original P026 controls rendered mutation feedback inside the Overview view, so an Accounts failure could appear as a dead button. The correction at branch checkpoint `a8eae5776214958c7dc630b93b3f654171f47667` keeps live-action feedback visible across routes and replaces manual account-binding `personaUid` entry with a bounded read-only `persona.list` selector showing the managed Persona name and current container projection. A first local test build also exposed a duplicate DOM id between Provisioning and Accounts; the published checkpoint regression requires the Accounts selector ids to be unique and keeps Provisioning's separate Persona UID field unchanged.

Corrective checkpoint CI:

- pinned Firefox Developer Edition run **37643918042** — success;
- repository verification run **37643918045** — success.

The account binding interaction still requires operator retest in the normal non-Marionette Firefox ESR session before it counts as LIVE acceptance.

Live operator follow-up in normal Firefox ESR confirmed:

- Accounts binding now works with the managed-Persona selector; a bound account is created and projected in PCMS.
- A representative Deployer mutation completed end-to-end on real Perchance: PCMS targeted the bound account/Persona, the operator performed the provider save, reloaded Perchance to prove the server-side change persisted, and only then marked the operation APPLIED.
- Current usability debt: several live controls still require manually typing durable identifiers such as Account ID rather than selecting from existing PCMS projections. This is acceptable for P026 acceptance testing but should be addressed in the next UI/modules/workflow refinement milestone.

This is positive A026-01 live evidence, but the gate remains pending until the remaining representative account-B/uncertain-path checks are completed.

## Final live correction — startup ordering

An earlier operator run had exposed a startup-order race: opening PCMS very early during Firefox startup could leave Live Integration v1 as Unavailable until a manual reload. The final production correction adds a bounded retry helper and keeps every failed attempt self-contained because `startPcmsLiveRuntime()` closes its failed Core instance before retry.

Final production checkpoint `edd699e89d82b9344b4abc05208aeee458d36086` is rebased/merged onto current main governance and passed:

- repository verification run **37654386707** — success;
- pinned Firefox Developer Edition run **37654386457** — success.

The exact new startup regression was also executed locally against the exact helper blob and passed **2/2** cases: transient Integration unavailability recovers, and terminal failure remains bounded/preserved.

## P026 final candidate

The live-tested account-binding candidate was:

- version: **1.2.0**;
- Gecko ID: `persona-route-manager@local`;
- SHA-256: `c92e3bf0a30250b3bef7482ee6b9020f8890e9d9bcdc5239c0dcc273c9ff21d5`.

The final closeout candidate adds only the bounded startup-order correction to that live-tested package:

- modified: `pcms/app/app.js`;
- added: `pcms/app/startup-retry.js`;
- exact repository Git blobs: app `6c646a03d9ccfba785f0eb8d46bda9804c38b609`, retry helper `8e063d211c096b9775df3cef544ac3300c065941`;
- final SHA-256: `b8aa1dcc12bda4e0329a4436169d78bb061d05024baf6fe663def0952e533755`.

Packaging verification actually performed for the final candidate:

- two independent deterministic archive builds produced the same SHA-256;
- ZIP integrity passed;
- manifest version is **1.2.0** and Gecko ID is `persona-route-manager@local`;
- all packaged `pcms/**` and `pcms-modules/**` JavaScript imports resolve;
- zero bare module specifiers were found;
- Node syntax checks passed for the changed startup files;
- archive comparison against the live-tested binding candidate found exactly the two startup-order changes above.

Earlier candidate hashes in this evidence are historical/superseded and are not the final closeout artifact.

## LIVE acceptance

Operator acceptance was completed manually in normal Firefox ESR without Marionette/Firefox DevTools MCP. Direct Personas were intentionally used for the P026 provider checks because browser automation/Marionette triggered Cloudflare; protected Persona/Mullvad routing continuity had already passed and been accepted in P025.

### A026-01 — PASS — representative feature mutations

- Two real Perchance sessions were kept isolated in two dedicated Direct Personas.
- PCMS account binding was exercised live. The first binding UI defect and duplicate-selector-id regression were found during acceptance, corrected, and re-tested successfully.
- Representative Deployer mutations were completed against real Perchance on both account/Persona bindings.
- The operator reloaded Perchance after saving to independently verify server persistence before selecting APPLIED in PCMS.
- An intentionally uncertain deployment was re-submitted and PCMS entered the reconciliation dialog instead of blindly replaying the mutation. The known-unsaved outcome was resolved as NOT APPLIED.
- Current ergonomics debt is explicitly accepted for this milestone: several module controls still require typing durable Account/generator identifiers rather than selecting projected objects.

### A026-02 — PASS — restore/recovery/no-replay

The operator completed the requested recovery sequence and reported it working:

- create PCMS backup;
- make disposable state change;
- apply restore and enter `RECOVERY_HOLD`;
- verify a new provider mutation is blocked while held;
- reconcile and release the hold back to `NORMAL`;
- fully restart Firefox ESR using the same test profile and confirm the PCMS state/modules/accounts remain available and recovery returns cleanly.

Deterministic recovery coverage additionally proves interrupted DISPATCHING operations become UNCERTAIN on restart and reconciliation/cancellation never redispatches a possibly successful provider mutation.

### A026-03 — PASS — final human acceptance

The operator confirmed the combined product is working and requested professional P026 closeout. The live pass established usable PCMS Accounts + real Perchance mutations + reconciliation + recovery in Firefox ESR. P025 remains the accepted evidence for standard/Mullvad Persona routing continuity and Perchance session compatibility; P026 deliberately used Direct routing to keep Cloudflare/VPN behavior out of the PCMS functional acceptance.

No plaintext credential was required by the PCMS controls used for this acceptance. Provisioning remains SecretRef-only and CAPTCHA/provider verification remains explicit/manual. Known non-blocking UI debt (typed identifiers, module/workflow ergonomics) is deferred to the next refinement milestone rather than treated as a P026 correctness failure.

## Current disposition

**A026-01 PASS · A026-02 PASS · A026-03 PASS.**

PR #34 merged as `072e11083622bfbe47c3c8853df3ebbc00f38df6`. Merged-main verification passed: repository verify run **37654994485** and pinned Firefox Developer Edition run **37654994495** both succeeded.

The merged-state governance checkpoint `ae032f3eb457d9d07a9092d5ff2611e87a97649b` also passed repository verify run **37655414399** and pinned Firefox Developer Edition run **37655414371**.

All implementation, CI, merged-main verification, recovery evidence, and operator LIVE gates are satisfied. **P026 is ACCEPTED.**
