# P301 reservation service

This is the P301 feature boundary, not a second browser runner or general workflow engine.
It implements the frozen `Reservation.preview/reserve/reconcile` methods for **new**
Perchance reservations, using injected P102 storage, P103 Perchance, P104 GitHub and
P202 Persona account-context services. P401 later owns supply-flow composition.

`preview({key: pastedText})` parses and validates slugs without external requests.
`reserve({key, opId, expectedRevision, accountBindingEpoch, options?: {folder}})`
reserves one candidate per call. The caller may schedule any number of bounded
calls; no provider quota or synthetic 200-item maximum is asserted. All verified
accounts are checked through complete account-scoped Perchance inventory.
Balancing uses the number of P301 create intentions per eligible account,
**not** imported generator population. An explicit source folder may differ
from the slug and is validated by the configured literal GitHub path templates.

The caller must construct P103's Perchance adapter with
`createReservationJournal(storage)`. Its create operation is written to P102
*before* P103 dispatch, and readback confirms the unlisted generator. The GitHub
stage has a **separate** durable operation and commits only a single
`DEPLOYMENT.md` with `Status: BLOCKED`, under the authorized folder.
It uses P104 branch-head and blob preconditions and an operation-specific
non-secret marker. An unlisted, excluded P102 GeneratorRecord is recorded;
no deployable release is inferred from the initial status document.

`reconcile({key, opId, expectedRevision, accountBindingEpoch})` always refers to
the original Perchance create operation ID. It re-observes its bound account,
never replays a possible create, and then checks GitHub main and exact status
file. An absent GitHub status on explicit reconciliation can close a previous
uncertain **GitHub** attempt as NOT_APPLIED before a new conditional GitHub
write. An existing conflicting file is a collision, never overwritten. Stale
account epochs and uncertain ownership fail closed.

The P301 service expects exactly one caller-owned Core orchestration context
and uses its optional `assertMutationAllowed` hook at reservation admission.
It performs no raw browser automation, does not open tabs, and has no direct
Perchance network implementation. Perchance/Cloudflare behavior is not
operator-live verified by deterministic unit tests.

Regression command: `node --test tests/alpha/reservation/*.test.mjs`.
