# E. Deployer ↔ generator repository specification, and F. Perchance listing model

> **The generator repository does not exist yet.** This document fixes no URL, owner, branch, token arrangement,
> webhook or schema version beyond what PCMS itself defines. `perchance_generators_github_repo` is only the earlier
> working name. Items that depend on the future repository are marked **[REPO]**. Items that depend on live Perchance
> behaviour are marked **[LIVE]**: they ship capability-gated and fail-closed, are proven on emulator/FDE fixtures, and
> are confirmed only in the final live phases (P043/P044). Each live observation is encoded as a deterministic fixture
> before any resulting fix is accepted.

## E.1 Three state layers (never conflated)

```
 ┌─────────────────────────┐   scan (read-only)   ┌──────────────────────────────┐  apply / reconcile  ┌──────────────────────────┐
 │ 1. REPOSITORY DESIRED   │ ───────────────────▶ │ 2. PCMS DURABLE DEPLOYMENT   │ ──────────────────▶ │ 3. PERCHANCE OBSERVED    │
 │ commit-pinned snapshot  │                      │ Deployment record (Deployer) │  ProviderGate +     │ Observation records      │
 │ of generator releases   │                      │ desired · confirmed · op     │  RemoteOps          │ (provider read or        │
 │ "what should exist"     │                      │ "what PCMS intends and last  │ ◀────────────────── │  operator confirmation)  │
 └─────────────────────────┘                      │  confirmed"                  │  observe / verify   │ "what Perchance appears  │
                                                  └──────────────────────────────┘                     │  to contain now"         │
                                                                                                       └──────────────────────────┘
```

| Layer | Authority for | Written by | Never written by |
|---|---|---|---|
| Repository desired | Intended release, content and listing per generator | Humans, via git | PCMS (PCMS never writes to the repository) |
| PCMS durable deployment | Desired revision PCMS adopted, last *confirmed* applied state, operation status | Deployer (CAS), RemoteOps | Repository scan directly. Scans go through Deployer commands. |
| Perchance observed | What the provider currently shows | Perchance adapter reads; operator confirmations | Repository data |

The rule that matters most: **a repository scan can change what PCMS *wants*. It can never change what PCMS
*believes Perchance contains*.**

## E.2 Repository identity and configuration

Deployer setting `repository`, edited in Deployer → Settings and stored in the Deployer settings namespace:

```js
{
  provider: "github",                 // only implementation in v1
  owner: "<owner>",  repo: "<name>",  // [REPO]
  ref: "main",                        // branch or tag name; resolved to a commit per scan [REPO]
  root: "",                           // optional subfolder inside the repo
  access: { kind: "public" } | { kind: "token", secretRef: "pcms-secret:v1:<uuid>" },
  network: "default"                  // see Q5; "default" = Firefox default network, disclosed in UI
}
```

- A connection test (`READ`) resolves the ref and reads the root marker. It reports one of: "Connected · commit
  9f3c2a1", "Repository not found or no access", "Not a PCMS generator repository (missing marker)", "Rate limited
  until 12:40".
- For a private repository, a token is added in Settings → Connections through the secret host and referenced by
  SecretRef. The recommended token is a fine-grained, read-only "Contents: read" token for that single repository
  **[REPO]**. The token value never enters PCMS DB rows, audit, logs, backups or diagnostics. It is resolved only at
  request time inside the repository provider.
- Changing the repository identity (owner, repo or root) is `LOCAL` with a warning. It invalidates the cached
  snapshot and release ledger, and makes all repository-origin targets show "Repository changed — re-check". It
  never deletes deployments.

## E.3 Repository format v1

### E.3.1 Review of the earlier concept

| Earlier concept | Keep | Change | Reason |
|---|---|---|---|
| `account_name/generator_url_name/` grouping | ✓ | — | Human organisation by account and generator is useful. |
| `development/{UI,src,roadmap.md}` | ✓ | Deployer ignores it entirely | Development source stays free-form. |
| `zips/generator_url_name_<version>.zip` | — | **Plain-file release folders** `releases/<version>/` | Zips are opaque in review and diffs. Zip bytes vary with timestamps and tooling, which causes spurious redeploys. The extension would need a zip parser. Plain files can be read per blob, and their content hash is stable. |
| Version in file name, "latest" implied | — | **Explicit pointer** `generator.json → "release"` | Choosing "latest" by parsing version strings is fragile. An explicit pointer makes rollback a one-line change and makes intent unambiguous. |
| `thumbnail.jpeg`, `pjs`, `html`, `changelog.md` in the package | ✓ | Fixed file names per release folder (below) | One name per role. No aliases. |
| Filename/version as change signal | — | **Content SHA-256 of the canonical payload** | Required by the brief and by determinism. |

If zips are still wanted for humans, the future repository can publish them as CI release assets. Deployer does not
read them (Q2).

### E.3.2 Layout

```
<root>/
  pcms-generators.json                     # repository marker
  <account-folder>/                        # human name, e.g. "alice"; linked to a PCMS Account in the UI
    <slug>/                                # Perchance URL name (perchance.org/<slug>)
      generator.json                       # identity + desired release + policy
      development/ …                       # ignored by Deployer
      releases/
        <version>/                         # immutable once published
          code.perchance                   # Perchance code panel ("lists"); required; UTF-8
          page.html                        # Perchance HTML panel; required (may be empty); UTF-8
          thumbnail.jpeg                   # optional
          changelog.md                     # optional; displayed in PCMS, not deployed
```

The file names `code.perchance` and `page.html` are proposals **[REPO]**. Whatever names are chosen, Deployer
accepts exactly one name per role.

`pcms-generators.json`:

```json
{ "format": "pcms.generator-repository/v1" }
```

`generator.json`:

```json
{
  "format": "pcms.generator/v1",
  "slug": "tavern-names",
  "title": "Tavern Names",
  "release": "1.1.0",
  "listing": "PUBLICLY_LISTED",
  "deploy": "auto"
}
```

| Field | Rule |
|---|---|
| `format` | Exactly `pcms.generator/v1`. Unknown future formats → that generator is BLOCKED ("Needs a newer PCMS"). |
| `slug` | Must equal the folder name. Bounded pattern `^[a-z0-9][a-z0-9_-]{0,99}$`. The adapter may reject further per Perchance rules **[LIVE]**. |
| `title` | Optional, ≤ 120 chars, display only. |
| `release` | Must name an existing `releases/<release>/` folder. Version text ≤ 64 chars, `[0-9A-Za-z.+-]`. |
| `listing` | Optional: `PUBLICLY_LISTED` or `UNLISTED`. If absent → Deployer `defaultListing`. |
| `deploy` | Optional: `auto` (default), `manual` (never automatic), `hold` (do not deploy at all; shows "Held in repository"). |

There is **no account ID in the repository**. The account is the parent folder. Each folder is linked once to a PCMS
Account through Deployer → Repository → "Link to account…", a Deployer-owned mapping chosen with the Account picker
(Q3). An unlinked folder blocks only its own generators.

### E.3.3 Validation (per generator, independent)

| Check | Failure code | UI wording |
|---|---|---|
| `generator.json` parses, exact keys, bounded | `GEN_MANIFEST_INVALID` | "generator.json is invalid: <field>" |
| folder name == `slug` | `GEN_SLUG_MISMATCH` | "Folder name and slug differ" |
| same slug in two account folders | `GEN_DUPLICATE_SLUG` | "Same generator in folders alice and bob" (both blocked) |
| account folder linked | `GEN_ACCOUNT_UNLINKED` | "Folder frank isn't linked to a PCMS account" |
| linked account differs from existing deployment's account | `GEN_ACCOUNT_CHANGED` | "Moved from Alice to Bob in the repository — moving generators between accounts isn't automatic" |
| `releases/<release>/` exists with required files | `GEN_RELEASE_MISSING` / `GEN_FILE_MISSING` | "Release 1.1.0: page.html missing" |
| UTF-8 without NUL; code+html ≤ 4 MiB total (`PERCHANCE_MAX_SOURCE_BYTES`) | `GEN_TEXT_INVALID` / `GEN_TOO_LARGE` | "Release 1.1.0 is larger than 4 MiB" |
| thumbnail: JPEG magic bytes, ≤ 1 MiB | `GEN_THUMBNAIL_INVALID` | "thumbnail.jpeg isn't a valid JPEG (≤ 1 MiB)" |
| changelog ≤ 256 KiB UTF-8 | `GEN_CHANGELOG_INVALID` | warning only; release still valid |
| release immutability (§E.4.3) | `GEN_RELEASE_MODIFIED` | "Release 2.0.0 changed after it was first published — publish it as a new version" |
| existing manual deployment for slug | `GEN_MANAGED_MANUALLY` | "Managed manually — **Adopt into repository…**" |

Repository-level failures (missing or invalid marker, truncated tree, auth, not found) fail the **whole scan** and
keep the previous snapshot (§E.6.4).

## E.4 Identity

### E.4.1 Canonical deployable payload

```
payload  = "pcms.perchance.generator-payload/v1\n"
         + "code " + byteLength(code) + "\n" + code + "\n"
         + "html " + byteLength(html) + "\n" + html + "\n"          (UTF-8 bytes, exactly as stored in git)
payloadHash   = SHA-256(payload)            (lower-case hex)
thumbnailHash = SHA-256(thumbnail bytes) | null
```

- The input is byte-exact, with no whitespace or line-ending normalisation. Provider-side normalisation is handled
  through the *observed baseline* (§E.8), not by weakening identity.
- Length prefixes make the encoding unambiguous: no concatenation collision between code and HTML.
- Git blob SHAs are used **only as a cache key** to avoid refetching unchanged blobs. They are never used as identity.

### E.4.2 Release identity and deployment intent

```
ReleaseIdentity  = { slug, version, payloadHash, thumbnailHash }
DeploymentIntent = { payloadHash, thumbnailHash, listing }
intentFingerprint (RemoteOperation) =
   "perchance:generator-release:v2:" + SHA-256(payloadHash + ":" + (thumbnailHash ?? "-") + ":" + listing)
```

This fits the existing RemoteOps fingerprint pattern. The v1 fingerprint (`perchance:generator-source:v1:<sha>`)
remains valid for legacy single-source deployments.

### E.4.3 Release ledger (immutability enforcement)

Deployer keeps a ledger keyed by generator: `(slug, version) → {payloadHash, thumbnailHash, firstSeenCommit,
firstSeenAt}`, bounded to the last 20 versions per generator.

- When a version is seen for the first time, it is recorded.
- When a version reappears with a different hash, the generator is set to `GEN_RELEASE_MODIFIED` and is BLOCKED.
  Nothing is deployed.
- Operator override: "Accept changed release" (`LOCAL`, audited). It re-pins the ledger entry, and the normal update
  flow then applies.
- **[REPO]** The future repository can enforce the same rule in its own CI. Deployer does not depend on that.

## E.5 Discovery: the scan algorithm

A scan is a **pure read of one commit**. It produces one immutable *RepositorySnapshot* and then calls Deployer
commands. It is not a queue of mutations.

```
scan():
  0. single-flight: if a durable scan record is RUNNING and not stale → return "already running"
     (scans run in the background Core as bounded steps; each step commits a checkpoint — ADR-002 §7)
  1. ref → commitId                               (RepositoryProvider.resolveRef)
  2. if commitId == lastSnapshot.commitId and config unchanged and validatorVersion unchanged:
        record "Checked — no changes" (lastCheckedAt), done
  3. tree = listTree(commitId); if !tree.complete → FAIL(REPO_TREE_TRUNCATED)
  4. read + validate pcms-generators.json         → FAIL(REPO_FORMAT_INVALID) on error
  5. for each <folder>/<slug>/generator.json:
        fetch changed blobs only (cache by blobId), validate (§E.3.3),
        compute ReleaseIdentity, check ledger
  6. persist RepositorySnapshot {scanId, commitId, scannedAt, items[], problems[]} as ONE record
        (bounded ≤ 4096 items, no file content stored)
  7. if recovery hold: stop here (snapshot only; Deployer not updated until release)
  8. apply snapshot to Deployer (§E.7.2), one Deployer command per changed item
  9. audit "deployer.repository.scanned" only when commit or problem set changed
 10. if mode == Automatic: run the bounded auto-deploy pass (§E.9)
```

- **Partially changed repository:** the scan is pinned to one commit, so every scan is self-consistent. Generators
  are validated independently, so one bad generator never blocks others.
- **Repeated identical state:** step 2 avoids all blob fetches and audit noise.
- **Content at deploy time:** file content is not stored in the PCMS DB. At deploy time Deployer re-reads the blobs
  at `desired.origin.commitId`, recomputes `payloadHash`, and aborts (`CONTENT_MISMATCH`, fail closed) if it differs.

## E.6 Scan cadence, timers and restart (§14)

### E.6.1 Mechanism (no new scheduler)

- Scans run in the **background Core** (ADR-002). Whether any dashboard tab is open makes no difference.
- Deployer registers a service `deployer.repository-sync` and, on every Core start, **declares** its schedule
  idempotently: `timers.ensure("deployer.repo-scan", dueAt)`. `dueAt` is computed from durable Deployer state
  (`lastSuccessfulScanAt + I`, or the backoff/reset time). At most one scan schedule exists.
- Wakeups come only from the Core alarm mechanism (ADR-002 §6):
  - `pcms.timers.next`, set to the earliest due timer;
  - `pcms.core.heartbeat`, as a safety net.
  On wake the due pass claims the timer by CAS, so duplicate wakes are harmless.
- A scan is a sequence of **bounded steps**, each ≤ ~10 s:
  1. resolve ref;
  2. list tree;
  3. validate N generators per step;
  4. persist the snapshot;
  5. apply it to Deployer.

  Each step writes a durable checkpoint `{scanId, commitId, step, cursor}` and ensures an immediate continuation
  timer. If the event page unloads mid-step, the next wake resumes from the last checkpoint. Steps 1–4 are
  read-only; step 5 uses idempotent Deployer commands.
- Dashboard focus, visibility, `online` events and UI timers never trigger scans. They may only refresh projections.

### E.6.2 Cadence

| Situation | Next scan |
|---|---|
| Success | `now + I`, with I = setting (default 30 min, min 15, max 240), ±10 % jitter |
| Failure (unavailable / timeout) | `now + min(I·2^k, 4 h)`, where k counts consecutive failures |
| Rate limited | provider-reported reset time (+ jitter), never earlier |
| Offline (`navigator.onLine === false` at step start, or network error) | treated as unavailable: backoff schedule. No event-driven retry; the next alarm wake retries. |
| "Check now" | immediate (single-flight). The schedule restarts from completion. |
| Paused mode | no timer. Manual "Check now" still allowed. |

### E.6.3 Startup, sleep and missed polls

- The existing timer service marks overdue (> 24 h) or interrupted timers `MISSED`. Deployer then schedules **one**
  scan: in 60 s if the last successful scan is older than I, otherwise at `lastScan + I`. It never schedules one
  scan per missed interval. **No backlog replay.**
- A scan record left `RUNNING` by an event-page unload, crash or browser exit is marked `INTERRUPTED` at the next Core start. Because scans are
  read-only plus idempotent Deployer commands, a fresh scan is always safe.
- After the computer sleeps, the first alarm or heartbeat wake sees the schedule due and runs **one** scan.
- After a browser restart (alarms are not persisted), the cold-start path recreates alarms from durable timers. The
  declared schedule then yields at most one catch-up scan.
- After a Deployer `INTERRUPTED` checkpoint, the scan resumes or restarts from the checkpoint. It never re-runs
  completed Deployer application commands with different inputs, because every command is keyed by
  `(scanId, slug)`.

### E.6.4 Failure behaviour

| Failure | Scope | Effect on snapshot | UI |
|---|---|---|---|
| GitHub unreachable / 5xx / timeout | scan | keep previous | "Last successful check 2 h ago — GitHub unreachable · Retrying at 13:10" |
| Rate limited | scan | keep previous | "GitHub rate limit — next check 12:40. Add a token to raise the limit." |
| Auth failed / not found | scan | keep previous | ERROR condition "Repository access failed" → Settings |
| Marker missing / invalid | scan | keep previous | ERROR "Not a PCMS generator repository" |
| Tree truncated | scan | keep previous | ERROR "Repository too large to read in one pass" |
| Generator invalid | generator | item recorded as BLOCKED | per-generator problem row |
| Perchance unavailable / incompatible | deployment | — | Targets show "Update ready — waiting for Perchance". One aggregate Core condition, not one per generator. |
| Perchance challenge (Cloudflare) detected | deployment/observe | — | One HumanTask "Open Perchance in <Persona> and complete the check". Automatic passes stop until it is resolved. |

**A failed scan never removes desired state.** "No longer in repository" is inferred only from a *successful* scan
that lacks the generator.

## E.7 PCMS durable deployment state (Deployer schema v2)

### E.7.1 Record

This extends the accepted v1 record (`pcms-modules/p015/schema.js`). It needs one allocated migration (`MIG-P036-deployer-state-v2` in `plan.json`).

```js
{
  schemaVersion: 2, kind: "deployment",
  deploymentId, providerId: "perchance", accountId, targetRef: {kind:"generator", id:<slug>},
  desired: {
    revision,                                   // as v1
    payloadKind: "v1-source" | "v2-release",
    payloadHash,                                // v1: sha256(source); v2: §E.4.1
    thumbnailHash: null | sha256,
    listing: null | "PUBLICLY_LISTED" | "UNLISTED",     // null only for v1-source
    origin: { kind: "MANUAL" } | { kind: "REPOSITORY", commitId, path, version }
  },
  confirmed: {                                  // renamed from v1 "observed" (it always meant confirmed)
    payloadHash: null | sha256, thumbnailHash, listing,
    confirmedAt, operationId,
    baselineHash: null | sha256                 // provider-observed hash right after confirmed apply (§E.8)
  },
  operation: { sequence, operationId, status }, // unchanged semantics
  policy: { paused: false, pauseReason: null | "OPERATOR" | "DRIFT" | "REPEATED_FAILURE" },
  createdAt, updatedAt
}
```

Migration v1 → v2 is mechanical:

- `desired.payloadKind = "v1-source"`, `payloadHash = sourceHash`, `origin = MANUAL`, `listing = null`.
- `confirmed = observed` (+ `baselineHash: null`).
- `policy.paused = false`.
- `operationId` derivation is unchanged, so existing RemoteOperations stay linked.

The v1 projection fields (`syncState`, `actions`) are retired in favour of §E.8, after P036 updates every consumer.

Observations are stored **outside** the singleton document, in keyed store `module.deployer.observations`. Key is the
slug, holding the latest and previous observation only:

```js
{ observedAt, method: "PROVIDER_READ" | "OPERATOR_CONFIRMED" | "APPLY_CONFIRMED",
  exists: true | false | null, payloadHash: null | sha256, thumbnailHash, listing: "PUBLICLY_LISTED"|"UNLISTED"|"UNKNOWN",
  challenge: boolean }
```

### E.7.2 Applying a snapshot to Deployer (scan step 8)

| Snapshot item vs Deployer | Deployer command | Note |
|---|---|---|
| valid, no deployment for slug | `createDeployment({deploymentId:"gen:"+slug, …, origin: REPOSITORY})` | Records intent only. No dispatch. |
| valid, deployment origin REPOSITORY, intent differs | `setDesired(…)` | If `OPERATION_BUSY` (ACTIVE/RECONCILE/RETRYABLE) it is skipped. The snapshot keeps the newer desired, and the UI shows "Repository has 1.5.0 queued after the current check". |
| valid, deployment origin MANUAL | none | Condition "Managed manually — Adopt?". **Adopt** (`LOCAL`) switches origin and keeps `deploymentId`. |
| missing from successful snapshot, origin REPOSITORY | none | State "No longer in repository". Nothing on Perchance changes. "Stop managing" (`LOCAL`) archives the record. |
| invalid | none | BLOCKED with problem code |

## E.8 Perchance observed state and drift (§11)

### E.8.1 How observations happen

1. **After every confirmed apply (verification):** observe immediately. Store `baselineHash = observed.payloadHash`.
   - If the observed hash differs from `desired.payloadHash` but the content is equal after the adapter's documented
     normalisation **[LIVE]**, record the baseline. Equality to desired is shown as "Applied (Perchance normalised
     whitespace)".
   - If it differs materially → `UNCERTAIN` (the save may not have applied). Normal reconciliation follows.
2. **Verification sweep:** each scan cycle observes up to N generators (setting, default 20), oldest-verified
   first, spaced ≥ 10 s apart. For 400 generators at 30-min cycles, each generator is checked about every 10 h.
   "Verify now" on one or a few is always available.
3. **Operator confirmation:** the answer to the durable `provider.confirm-apply` HumanTask (ADR-002 §9) records an
   `OPERATOR_CONFIRMED` observation without a hash.

Until `generator.observe` is enabled (P039 capability, live-confirmed in P043), steps 1–2 are unavailable. Status then reads "In sync · not verified" with
the time of the last confirmed apply. PCMS never claims verified sync without an observation.

### E.8.2 Drift definition

```
drift  ⇔  latest observation is PROVIDER_READ
       ∧  observation.observedAt > confirmed.confirmedAt
       ∧  observation.payloadHash ≠ confirmed.baselineHash      (content drift)
       ∨  observation.listing ∉ {UNKNOWN, confirmed.listing}     (listing drift)
       ∨  observation.exists == false                            (generator gone)
```

Drift is compared against the **baseline PCMS last confirmed**, not against the repository. A repository update is
not drift, and drift is not a repository update. Both can be true at once. Drift then wins the status and the
update is shown as secondary information.

### E.8.3 Drift handling (never automatic overwrite)

When drift is detected:

- `policy.paused = true`, `pauseReason = "DRIFT"` for that target.
- A WARNING condition is raised.
- Automatic mode skips the target.

Operator choices on the generator page:

| Action | Risk | Effect |
|---|---|---|
| **Compare changes** | READ | Diff: repository release vs current Perchance content (code, HTML, thumbnail, listing). In memory only. |
| **Overwrite with repository version…** | EXTERNAL_MUTATION | New desired revision (same release), deployment, verify. Confirmation names what will be lost on Perchance. |
| **Keep Perchance version…** | LOCAL | Records the observation as the new baseline and marks "Diverged from repository". Auto stays paused until the repository releases a newer version or the operator resumes. Offers "Download Perchance version" so the operator can commit it to the repository by hand. |
| **Resume automatic deployment** | LOCAL | Clears the pause (only when not drifted). |

No policy setting enables automatic drift overwrite in v2. Adding one would require an explicit new decision.

## E.9 Deployment triggers and modes

| Mode | Scan | Prepare (desired update) | Dispatch | Availability |
|---|---|---|---|---|
| **Paused** | manual only | manual only | manual only | always |
| **Assisted** (default) | background timer (tabs irrelevant) | automatic | operator clicks Deploy / Deploy all ready; each apply is a durable handoff HumanTask reconciled from any tab (ADR-002 §9) | P037 |
| **Automatic** | background timer | automatic | automatic for eligible targets, in the background with zero tabs | gated (below; P042) |

Automatic-mode gates. All must hold, and the Deployer Settings page lists any that are unmet:

1. The unattended Perchance driver (`generator.update` v2 as a PersonaMonkey execution artifact under a control
   lease, P042) reports `capabilities.unattended = true` from its compatibility probe.
2. `generator.observe` is enabled (P039), for post-apply verification and drift guard.
3. Recovery state is NORMAL, the provider is compatible, and there is no unresolved challenge HumanTask.
4. The operator has turned Automatic on.

How the gate is proven:

- Gates 1–2 are proven on the emulator and FDE fixture pages (A039, A042).
- For *real* Perchance, both capabilities ship **disabled** and are enabled only after the final live phase confirms
  the probe (P043 captures the observation as a fixture; P044 exercises unattended deployment).
- An open or closed dashboard is never a gate.

Per-target eligibility in an automatic pass:

- state `Update ready` / `Not yet deployed`;
- `deploy: auto`;
- not paused, drifted, uncertain or failed for this desired revision;
- account healthy;
- snapshot fresh (< 2·I);
- for "Not yet deployed", generator exists or `generator.create` is supported.

Pass bounds: serial, ≤ 10 dispatches per cycle, ≥ 20 s spacing. Two consecutive NOT_APPLIED for the same desired
revision set `pauseReason = "REPEATED_FAILURE"`. Nothing is blind-retried: `UNCERTAIN` always requires
reconciliation (unchanged RemoteOps rule).

**New generators:** if the target does not exist on Perchance (observation `exists:false`, or the assisted operator
answers "doesn't exist"), Assisted mode opens a durable "Create & deploy" HumanTask that instructs the operator to create
`<slug>` in the bound Persona, then continues with the deploy. Automatic requires a `generator.create` provider
capability **[LIVE]** (Q7).

## E.10 Reconciliation

Unchanged from accepted P010/P015/P026 semantics. These are executed by the background Core (ADR-002):

- the durable RemoteOperation exists before dispatch;
- ambiguous dispatch → `UNCERTAIN`;
- reconcile before any retry;
- recovery hold blocks dispatch;
- restart turns interrupted `DISPATCHING` into `UNCERTAIN`.

v2 changes only presentation and evidence:

- the reconcile dialog shows human-checkable evidence (version line, changelog head, sizes) and, when available,
  an automatic comparison;
- the answer maps to `APPLIED`, `NOT_APPLIED` or `UNKNOWN` exactly as today;
- `UNKNOWN` keeps the target `UNCERTAIN` and nothing is retried.

## E.11 Status derivation (single source for UI)

`deriveGeneratorStatus(input) → { status: {token,label}, next: {kind, text, at?}, notes[] }` is a pure function
owned by Deployer. It is exhaustively unit-tested with a table. Rules are evaluated in order and the first match
wins:

| # | Condition | Token / label | Next action text |
|---|---|---|---|
| 1 | op RECONCILE, or ACTIVE without a live dispatch in this host | UNCERTAIN "Outcome unknown — check needed" | "Check Perchance. Nothing is retried until you answer." |
| 2 | op ACTIVE awaiting operator | WAITING_HUMAN "Waiting for you in Perchance" | "Finish the save in the Perchance tab, then confirm." |
| 3 | op ACTIVE (automated) | ACTIVE "Deploying 1.4.0" | — |
| 4 | confirmed set, observe available, baseline not yet recorded | ACTIVE "Verifying" | — |
| 5 | drift (§E.8.2) | WARNING "Changed on Perchance" / "Listing differs" / "Missing on Perchance" | "Nothing happens automatically. Compare and choose." |
| 6 | repository item BLOCKED | ERROR "Repository problem" (+ code wording) | "Fix the repository, then check again." |
| 7 | account unhealthy | UNAVAILABLE "Account unavailable" | "Fix the account's Persona binding." |
| 8 | op FAILED for current desired | ERROR "Deployment failed — not applied" | "Deploy again" |
| 9 | origin REPOSITORY, absent from last successful snapshot | INFO "No longer in repository" | "Nothing changes on Perchance." |
| 10 | `deploy:hold` or policy paused (operator) | INFO "Paused" | "Resume to deploy updates." |
| 11 | confirmed empty | WARNING "Not yet deployed" (+ "needs creation" if known missing) | mode-dependent (below) |
| 12 | desired intent ≠ confirmed intent | WARNING "Update ready" (or "Listing change ready") | mode-dependent |
| 13 | otherwise | OK "In sync" | "Nothing to do." + freshness note "verified 3 h ago" / "not verified" |

Mode-dependent next text: Automatic → "Deploys automatically at the next check (≈12:34)". Assisted → "Ready —
deploy when you choose". Paused → "Automatic checks paused".

Global overlays, applied after rule selection:

- `RECOVERY_HOLD` → any next action that mutates becomes "On hold until recovery checks finish".
- Provider unavailable → "Waiting for Perchance".

## E.12 Repository provider boundary

The domain (Deployer) depends on this interface only. GitHub types never cross it.

```js
RepositoryProvider = {
  describe(config)                       → { kind:"github", label:"github · owner/repo@main", webUrl(path, commitId) }
  resolveRef(config)                     → { commitId, committedAt, message }          // message ≤ 200 chars
  listTree(config, commitId)             → { complete:boolean, entries:[{ path, type:"file"|"dir", size, blobId }] }
  readBlob(config, commitId, path, blobId, { maxBytes }) → Uint8Array
}
errors: REPO_UNAVAILABLE | REPO_RATE_LIMITED{resetAt} | REPO_AUTH_FAILED | REPO_NOT_FOUND | REPO_TOO_LARGE | REPO_PROTOCOL
```

- **Location:** Core provider `extension/pcms/providers/repository/` (contract plus GitHub implementation, like the
  Perchance provider), injected into Deployer as `repositoryProvider`. It runs in the background Core. Deployer is
  built-in. A runtime module that needs repository data would get a new bounded capability (`repository.read`),
  added only for a concrete need, because sandbox frames have no network access.
- **GitHub implementation:** uses the public REST API:
  - `GET /repos/{owner}/{repo}/commits/{ref}`;
  - `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` (honours `truncated`);
  - `GET /repos/{owner}/{repo}/git/blobs/{sha}`, decoding base64 under byte bounds;
  - conditional `If-None-Match` on the ref lookup where possible;
  - `Retry-After` / `x-ratelimit-reset` mapped to `REPO_RATE_LIMITED`.
- **No git CLI, no clones, no writes.**
- **Test double:** `createFixtureRepositoryProvider({commits:{…}})` for deterministic tests. It covers truncation,
  rate limiting, auth failure, mutation of a published release, duplicate slugs, large files and ref movement.
- **Untrusted content:** repository files are untrusted text. PCMS never executes them, renders them only with
  `textContent` (changelog shown as plain text in v1, diff text-only), and only forwards them to Perchance in the
  bound Persona.

## E.13 Perchance provider contract v2 (adapter-level)

| Operation | Kind | RemoteOperation | Notes |
|---|---|---|---|
| `generator.update` v2 | mutation | yes | Input `{code, html, thumbnail?, listing}` + intent fingerprint v2. The adapter verifies `payloadHash` before dispatch (as v1 does for `source`). |
| `generator.update` v1 | mutation | yes | Retained for legacy `v1-source` deployments and Refresher until migrated. |
| `generator.observe` | read | no | Returns `{exists, code?, html?, thumbnailHash?, listing, challenge}`. The adapter computes `payloadHash` with the same canonical encoding. **[LIVE]** read path. |
| `generator.create` | mutation | yes | Optional capability **[LIVE]**. |

- The compatibility probe returns `{contractVersion:2, operations:[…], capabilities:{unattended, observe, listing,
  thumbnail, create}}`. Any unknown or absent capability → fail closed for that capability only.
- The operator-assisted driver implements v2 as a **durable handoff** (ADR-002 §9):
  - it opens the target in the bound Persona;
  - it records `UNCERTAIN` with a handoff marker;
  - it opens a `provider.confirm-apply` HumanTask whose page shows code and HTML separately with copy buttons, the
    thumbnail for download, and the listing instruction.

  It sets `unattended:false`. The operator answers from any dashboard tab, at any later time.
- An unattended driver must be a PersonaMonkey execution artifact started through `execution.start` in the bound
  Persona, under a control lease. PCMS does not create a `userScripts` authority.

## F. Perchance listing compatibility model

### F.1 PCMS domain

```js
GeneratorListing  = "PUBLICLY_LISTED" | "UNLISTED"
ObservedListing   = GeneratorListing | "UNKNOWN"
```

UI wording is **"Publicly listed"** and **"Unlisted"**. The words "private" and `isPrivate` never appear in PCMS
domain records, UI, audit text, repository format or module contracts.

### F.2 Adapter mapping (inside `extension/pcms/providers/perchance/` only)

```js
// serialize (desired → provider)
PUBLICLY_LISTED → { isPrivate: false }
UNLISTED        → { isPrivate: true  }

// parse (provider → observed)
raw.isPrivate === false → "PUBLICLY_LISTED"
raw.isPrivate === true  → "UNLISTED"
anything else (missing, non-boolean, new field shape) → "UNKNOWN"
   and compatibility.capabilities.listing = false   (fail closed for listing changes)
```

- If Perchance changes its serialisation again, only this adapter and its fixtures change.
- A deterministic test fixes the mapping and the UNKNOWN fallback (the regression rule from AGENTS §10).

### F.3 Policy

| Rule | Behaviour |
|---|---|
| Default listing | Deployer setting `defaultListing`, default **PUBLICLY_LISTED**. It applies when `generator.json` omits `listing`. This keeps the earlier requirement explicit instead of hidden. |
| First deployment | Desired listing is part of the intent, so a new generator is published as Publicly listed unless the repository says otherwise. |
| Later managed deployments | Every deployment carries the desired listing, so the intended listing is preserved. |
| Listing-only change | Same payload, different listing → "Listing change ready" → a normal deployment with the same content. |
| Observed mismatch | Listing drift (§E.8.2). Never auto-corrected. Offers "Set Publicly listed…" (EXTERNAL_MUTATION). |
| Observed UNKNOWN | Not a mismatch. Shown as "Listing unknown". Listing changes are disabled while `capabilities.listing` is false. The assisted handoff HumanTask then asks the operator to set it, and the answer is recorded as `OPERATOR_CONFIRMED`. |
| Manual (`v1-source`) deployments | `listing:null` = "not managed by PCMS". Nothing is enforced. |

## E.14 What changes when the repository is created

Steps for later, with no redesign:

1. Create the repository with `pcms-generators.json` and the layout above, plus optional CI that enforces release
   immutability and runs the same validator. The validator can be a small published script; Deployer's validator is
   the authority.
2. Fill in owner, repo, ref and access in Deployer → Settings. Add a token in Connections if the repository is
   private.
3. "Check now". Link account folders to PCMS Accounts.
4. Adopt any manually managed generators that now appear in the repository.
5. Use Assisted mode. Consider Automatic once its gates are met.
