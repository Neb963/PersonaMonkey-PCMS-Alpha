# P202 — Accounts and Persona enrollment

This background Accounts service implements the frozen six-method Accounts
contract, composed with P102 storage, PersonaMonkey's typed Persona Broker,
and P103 Perchance adapter. It has no raw browser, native, routing,
cookie, HTTP or credential authority. No production UI/bootstrap integration
is claimed in this phase.

## Operator flow

1. Enrollment durably records PREPARED then DISPATCHING for a dedicated
   Persona creation using PersonaMonkey-compatible UUID identities. Only the typed Broker creates a Persona, with Direct
   disabled and a boot/revision precondition. Its durable personaUid is bound
   to the new account. The opened login tab is also a correlated, journalled
   Broker operation. The tabId is recorded so its owner can later retire only
   its own attempt; this service does not close arbitrary operator tabs.
2. The operator completes normal Perchance login and any challenges manually.
   Verification requires explicit operator acknowledgment, a trusted
   Persona-scoped provider context with matching UID and epoch, a P103
   verified-session probe, and complete authenticated account-owned generator
   discovery. A public feed, edit key, manual checkbox alone or route test
   never establishes ownership or a confirmed session.
3. A manual challenge or failed route keeps the account WAITING_HUMAN. Typed,
   durable route assignment and route test precede every route retry. No
   Direct fallback or challenge bypass exists. An unhealthy route cannot
   trigger a new login tab.
4. Authenticated existing generators are imported EXCLUDED, with neither
   source binding nor release intent. Repeat import preserves a pre-existing
   MANAGED intent. P102's 64-write batches are used, but VERIFIED is committed
   only after all discovered items are durable. Interrupted imports remain
   resumable by an explicit new verification.

Account list/get expose only the P102 AccountRecord (name, session state,
personaUid, epoch, revision and observation time) and bounded revision-fenced
pagination. The frozen records do not contain an authenticated Perchance
account subject/email field. The user-entered account label must never be
mistaken for externally verified account identity; subject-specific
production acceptance still requires operator-authorized observation.

## Rebinding

Rebinding previews every affected generator and unresolved operation. It
requires explicit operator confirmation, an existing Persona verified by
the typed Broker, current CAS revision and binding epoch, no uncertain
operations and a unique new UID. Account and generators update atomically
to epoch+1 and WAITING_HUMAN. Existing Persona cookies, route assignments
and running executions are not moved. With more than 63 generators, the
service fails RECOVERY_HOLD rather than performing an unsafe partial rebind;
a later governed large-fleet migration is outside P202.

External dispatch is durably fenced by operationId. Lost or ambiguous
responses remain DISPATCHING/UNCERTAIN and block subsequent account actions,
including manual session verification, until reconciliation. They are never
blindly replayed.
No production reconciliation or live Perchance/Mullvad/Firefox acceptance
is inferred from synthetic fixtures.

## Verification

Run node --test tests/alpha/accounts/service.test.mjs, or
node tools/alpha/run-tests.mjs for the whole non-governance Alpha suite.

- AP202-01: epoch, rotation and dedicated UID binding
- AP202-02: challenge/route retry without bypass
- AP202-03: EXCLUDED import of authenticated account-owned generators
