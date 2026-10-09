# P103 — Perchance capability adapter and deterministic emulator

`createPerchanceAdapter({ executor, journal, pageSize, now })` implements exactly
revision-2 `PerchanceAdapter` (`alpha.contracts.v1`), and does not own browser,
network, Persona, routes or native integration. The caller supplies a trusted,
PersonaMonkey-owned, typed `executor` with `inspect` and `execute` methods. This is
an interface boundary, **not** a direct Perchance HTTP client or an installed
Firefox provider bridge. A production executor may be added by a later assigned
phase only after its browser/Persona control lease and readback are established.

## Executor contract (local, not a new broker command)

- `inspect({context})` returns exactly the bound `context`,
  `origin:'ACCOUNT_PERSONA'`, `session:'VERIFIED'` (or another state), a
  nonnegative `revision`, and explicitly observed `capabilities`. Each method
  fails closed without the relevant capability. An edit key or public-feed
  appearance does not establish account ownership.
- `execute({action:'inventory',context})` returns an account-scoped, authenticated
  inventory. The preferred observed shape is
  `{context,status:'success',source:'DISCOVERY_V3_GET_GENERATORS_BY_USER',
  generators:[{name,isPrivate,...}],asOf}` based on `POST /api/getGeneratorsByUser`.
  The alternative normalized `ACCOUNT_INVENTORY` shape has `items` instead of
  `generators`. Never substitute `/api/getGeneratorList` recent public feed.
- `execute({action:'read',context,targetKey})` returns a current authoritative
  `ProviderReadback`, or `status:'generator-does-not-exist'`. A readback must
  assert confirmed ownership and exact source/version truth. Local drafts,
  collaborator keys or the AI transcript are not durable source readback.
- `execute` mutations are `create`, `save`, `setListing`, `delete`. They must
  represent provider-confirmed outcomes from the account Persona, *not* promise
  atomicity from a temporary fork, rename, privacy toggle and save. Known success
  statuses are respectively `created`, `saved`, `privacy-set`, `deleted`; after
  any success the adapter independently re-reads current account inventory and
  target/source. `save` confirms exact PJS, HTML and JPEG bytes. Unknown statuses
  or transport/readback ambiguity return `UNCERTAIN` with no replay.
- `journal.read`, `.dispatch`, `.complete` are **durable** external-operation
  methods supplied by caller. The ledger must have an existing PREPARED operation
  for the exact target/binding/source revision, durably transition to DISPATCHING
  before first network mutation and remain on reconciliation hold if completing
  or observing the outcome fails. The emulator has in-memory copies only for
  deterministic tests; it is not production durable storage.

List paging is **local paging** over a freshly fetched full account inventory,
not an invented Perchance server cursor. Cursor `v1.<offset>.<SHA-256>` is bound
to the account Persona identity and inventory contents/order. A changed snapshot,
invalid/noncanonical/missing/duplicate slug, malformed privacy or incomplete page
fails closed. `collectAccountGenerators` consumes all pages and rejects duplicate
keys across pages and repeated cursor tokens; never classify partial discovery as
absence. `hub` is an observed exceptional short name; no assumption about the
complete reserved-name list is made. Candidate availability is never established
solely from an account inventory negative.

`classifyListingObservation` retains feed and rendered positions separately,
including pinned/filtered uncertainty. `classifyAiSource` distinguishes saved
source from local unsaved workspace and never treats chat history as save proof.

## Evidence and constraints

The source discovery-v3 archive SHA-256 is
`65c52533702bc210556acadd2f39f9d848e302644f6c17652e5bc9066e7a9080`.
The observation provenance is **Brave/CDP**, not Firefox live acceptance. The
sanitized fixture cites the observed inventory API, `isPrivate` semantics, save
status, `srcManifest` and AI history while avoiding credentials and source code
from real accounts. The actual existing Perchance editor and AI helper are not
reimplemented or bypassed; no CAPTCHA bypass, HTTP client, or tab execution
occurs in this phase. Deterministic CI cannot establish real Perchance session,
route, Cloudflare or Firefox-browser compatibility.

Run `node --test tests/alpha/providers/perchance/*.test.mjs` locally, or
`node tools/alpha/run-tests.mjs` for all non-governance Alpha suites.
