# Alpha contracts v1 — frozen shared surfaces

Contracts here are normative for all Pxxx work. The bootstrap step must materialize type declarations/interfaces and tests from these before parallel claims. Any change of contract hash requires gate review, version increment and consumer revalidation. Never let five agents independently invent incompatible APIs.

## Identity and authority

- `AccountId`: opaque stable local ID; `personaUid` is durable PersonaMonkey-owned ID; Account↔Persona binding includes monotone epoch. One active account per dedicated Persona. No `cookieStoreId` as durable identity.
- `GeneratorKey`: normalized Perchance slug (provider target), unique across fleet. `GeneratorRecord`: `accountId`, `personaUid`, `fleetIntent` (`MANAGED|EXCLUDED`), `listingObserved` (`PUBLIC|UNLISTED|UNKNOWN`), `deployState`, `refreshState`, `sourceBinding`, source hashes, revisions, timestamps and attention refs. Do not mix intent with observation.
- `SourceBinding`: GitHub repo/ref/root, folder path, explicit slug mapping, observed immutable commit and blobs, `DEPLOYMENT.md` strict status, canonical deployable-content hash. No checkout of development branches.
- `ReleaseId`: SHA-256 of normalized exact deployable files (PJS, HTML, JPEG), excluding Refresher's tracked ephemeral comment. Image bytes are hashed; source readback uses exact byte/UTF-8 equality where possible. Changes to documentation alone do not produce release.

## Background and UI

- A single logical background Alpha Core. Validated `{v:1, requestId, command, params, expectedRevision?}` UI request and safe `{ok, result?|error:{code,message}, revision}` response; optimistic staleness rejects mutating commands. Any number of clients. UI has no direct provider or storage mutation authority.
- Feature service methods are fixed at bootstrap: Accounts, Inventory, SourceCatalog, Reservation, Deployer, AiReview, Refresher, Visibility, Attention, Backup. UI receives stable projections with timestamps and errors; no arbitrary dynamic `moduleId` or user-code evaluation.
- `Operation` durable before dispatch: `{opId,kind,targetKey,sourceRevision,accountBindingEpoch,phase,startedAt,result?,remoteEvidence?}`. Status `PREPARED|DISPATCHING|APPLIED|NOT_APPLIED|UNCERTAIN|FAILED|HELD`, with reconciliation before retry if ambiguous. Provider failure codes are typed; no exceptions silently swallowed.
- Alarms wake durably scheduled short passes; bounded tabs and operation concurrency. DOM timers and in-memory queues cannot be sole authority. `HealthyActiveClock` persisted checkpoint + startup/shutdown/outage evidence; do not advance activity across unobserved downtime.

## Perchance and AI

- Perchance adapter owns `generator.create`, `generator.read/observe`, `generator.save`, `generator.setListing`, `generator.delete`, `account.listGenerators`, listing poll and stats. Provider operation is scoped to Persona and route, subject to ownership/session capability probes; apply with readback and source revision preconditions. Unknown capability blocks mutation.
- Perchance AI helper is **existing native helper**, controlled through PersonaMonkey browser execution and documented page surfaces. Controller tracks `READY|ACTIVE|WAITING_HUMAN|COMPLETED|FAILED|RECOVERING`, per-account concurrency, transient tabs, chat history/provenance, saved source hash and approval. Never assume a browser tab staying open is durable authority.
- Listing observer separately records recent-feed API position and **rendered-page position** after pinning/filtering, `asOf`, visibility status, and uncertainty; absence is not proof of ban. No guarantee of perpetual visibility.
- `RefresherCommentLedger` records precise ephemeral insertion bytes/position, expected source before/after, save receipt and revision; removal/edit only if exact previous mutation matches to avoid damaging unrelated edits.

## GitHub

- Only configured `per-gens` repo; strict literal templates with `{folder}` and `{slug}`, disallow traversal/absolute paths; one explicit mapping per generator. `Status: BLOCKED|IN_DEVELOPMENT|READY` parsed from `DEPLOYMENT.md` on main. Missing/invalid blocks.
- One GitHub credential with repository-specific Contents read/write rights, stored as SecretRef. All mutation paths pre-record durable operation. Conditional branch ref update with expected HEAD, atomic tree commit for source edits, no force push; unexpected HEAD or blob mismatch is CONFLICT awaiting re-read/manual disposition.
- Release is eligible only when READY, exact expected files present, source content hash differs from last adopted confirmed revision, generator sleeping or never-active, no source drift or recovery hold. Committing AI live fixes must not retrigger identical deployment.

## Backup

- `BackupBundle v1`: one local **unencrypted** structured archive, versioned manifest/integrity hashes, selected PersonaMonkey export, Alpha DB/journal, authorized credentials/session data **when actually exportable**; explicit absent-items ledger. Export never includes generated CI evidence or developer secrets. Verify before restore; preview; backup data/sessions reconciled after restore under RECOVERY_HOLD.
- Downloads retention uses stable filename under `Downloads/PersonaMonkey-PCMS-Alpha-backups/`, manifest of tracked IDs, bounded successful archives, best-effort removal of known files and warning if untracked inaccessible old archives remain.

## per-gens READY parser

`DEPLOYMENT.md` consists of Markdown plus exactly one standalone status line matching `^Status: (BLOCKED|IN_DEVELOPMENT|READY)$`. Only that exact syntax is machine authority; anything else blocks deployment. Do not read assumptions from body text. `main.pjs`, `index.html`, `thumbnail.jpeg` are default literal names and can be remapped via safe templates. Extra files/docs are ignored. A folder with only DEPLOYMENT.md is valid reserved source, not a deployable release.

## G0 materialized surfaces

`extension/alpha/contracts/index.d.ts` supplies declarations only;
`surface.json` at that directory enumerates the fixed services, records, enums
and allowed existing Persona Broker commands. There is no Alpha runtime here.
The existing broker implementation remains authoritative for command validation,
boot/revision fencing and secret-safe responses. Read operations do not acquire
mutation authority merely because they share an interface with writes.

`contracts.lock.json` hashes these two files and this document with path and byte
length framing. Claims pin `alpha.contracts.v1` to that SHA-256. Any surface
change requires an explicitly assigned gate amendment, versioning and consumer
revalidation; a phase may not widen its own read assumptions or write scope.
Feature implementations must use typed projections and reject unknown fields and
commands at their runtime boundary. A declaration is not acceptance evidence for
any provider operation. The original proposed text is preserved under
`docs/provenance/alpha-design/`.

## Authorized P103 account-discovery amendment (AMEND-P103-LIST-001, revision 2)

`PerchanceAdapter.listGenerators({ context, cursor? })` returns `Result<Page<AccountGeneratorEntry>>`, where each item is `{ key: GeneratorKey, readback: ProviderReadback }`. The `key` is the nonempty canonical Perchance generator slug, not a source revision, feed position, account identifier, or inferred array index. `readback` retains its original schema. `read` / `observe` / mutation readbacks remain `Result<ProviderReadback>`; no generator key is added to those methods.

Pages retain the existing `items`, `cursor` (opaque continuation token or `null`), and `asOf` fields. Account ownership must be observed through the account-bound Persona context. An implementation must reject missing, invalid/noncanonical, or duplicate generator identities; duplicates across successive pages must not silently overwrite prior observations. The consumer must treat pagination failure and conflicting identities as incomplete discovery, not proof of absent generators or ownership. No public-feed API is an account-inventory substitute. These are interface requirements, not a claim that a Perchance runtime adapter exists or has been live-tested.

Revision 2 changes only the account-list element type, introduces `AccountGeneratorEntry`, and updates its surface metadata. It does not change `ProviderReadback`, `Page<T>`, Persona Broker commands, other provider methods, persistence records, or service methods. The contract family remains `alpha.contracts.v1` and its byte-framed lock hash is changed; active R1 claims require explicit read-hash revalidation without ownership or epoch reassignment.
