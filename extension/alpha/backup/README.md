# P205 backup framing (no restore mutations)

`bundle.js` prepares exactly one **unencrypted** local archive as a `Uint8Array`, explicitly requiring the operator's `EXPORT UNENCRYPTED BACKUP` consent. The caller is responsible for an actual local download; no browser download, retention, secret-host, or restore mutation is performed here (P405 owns that integration). The archive uses a versioned manifest with SHA-256 per byte section and a manifest checksum; these hashes detect corruption, **not malicious rewriting/authenticity**.

The P102 `alphaStorage.snapshot()` is the only always-available source. It produces a verified, consistent Alpha records+journal snapshot; binary `Uint8Array` values are preserved. The typed PersonaMonkey Broker exposes no bulk backup export command. PersonaMonkey data can therefore only be included via a separately validated, explicitly authorized `personaMonkeyExport()` read-only callback returning `{ bytes, includedItems }`; **do not read private PersonaMonkey internals from Alpha**. An absent callback records unavailable components. Opt-in `sensitiveExports` are narrow per-key authoritative callbacks, not general credential discovery. Failed attempted exports abort the entire build before any archive is returned. A provider read is never substituted for a backup export.

| Component | P205 availability | Recovery limitation |
| --- | --- | --- |
| Alpha records and operation journal | Exported using P102 snapshot (mandatory) | Restored state must enter recovery hold and reconcile operations |
| PersonaMonkey Personas, routes, userscripts, workflows | Only if a vetted PersonaMonkey export source actually supplies each item | Persona mappings / route revalidation needed |
| PersonaMonkey cookies, GM values, route credentials | Only if an authorized named sensitive source actually provides bytes *and* user opts in | Reuse / session validity never guaranteed |
| Alpha GitHub credential | Only if an approved secret backend exposes export and user opts in | Authority must be verified again after restore |
| Browser live session, PersonaMonkey native credentials, Perchance passwords | Unavailable unless an approved future schema/source explicitly supports it (this P205 schema does not) | Manual login / reconfiguration required |

`stageRestore()` performs strictly read-only parsing, version/schema validation and section checksum verification, producing counts, the absent-items ledger, and the required proposed `RECOVERY_HOLD`. It **does not apply** any restore or mutate storage/providers. P405 must independently implement staged apply, durable hold, session/binding/provider reconciliation, and download retention.

Never send archive contents, credentials, fixture bytes, base64 sections, or export exceptions to logs, GitHub, CI artifacts or screenshots. Tests report only success/failure and fixed error codes. Backup data must remain on the operator's machine.
