# PersonaMonkey workflow packages

This document is the authoring contract for portable PersonaMonkey workflow packages. It is intentionally suitable for humans and coding agents.

## File format

A distributable package is a standard ZIP archive containing:

```text
manifest.json
userscripts/
  <script>.user.js
  ...
```

`manifest.json` is UTF-8 JSON. Userscript files are UTF-8 JavaScript with normal userscript metadata blocks.

PersonaMonkey exports stored (uncompressed) ZIP entries for maximum compatibility. Import accepts stored entries and, when supported by the browser runtime, normal DEFLATE-compressed entries.

Recommended filename: `<workflow-name>.personamonkey.zip`.

## Manifest

```json
{
  "format": "personamonkey.workflow-package",
  "formatVersion": 1,
  "package": {
    "id": "example-signal-workflow",
    "name": "Example signal workflow",
    "description": "Demonstrates a userscript-driven completion signal",
    "author": "optional",
    "createdAt": "2026-09-14T00:00:00.000Z"
  },
  "personas": [
    {
      "key": "primary",
      "label": "Primary persona",
      "description": "Any managed persona with network access",
      "routeRequirement": "networked"
    }
  ],
  "scripts": [
    {
      "key": "complete-signal",
      "file": "userscripts/complete-signal.user.js",
      "name": "Complete signal",
      "sha256": "optional lowercase hexadecimal SHA-256"
    }
  ],
  "workflow": {
    "name": "Example signal workflow",
    "enabled": true,
    "steps": [
      {
        "id": "step-1",
        "personaKey": "primary",
        "urls": ["https://example.com/"],
        "concurrency": 1,
        "scriptKeys": ["complete-signal"],
        "completion": {
          "mode": "signal",
          "value": "",
          "timeoutMs": 30000
        },
        "retries": 1,
        "retryDelayMs": 1000,
        "closeTabs": true,
        "stopOnError": true
      }
    ]
  }
}
```

## Persona slots

Packages **must not depend on Firefox `cookieStoreId` values**. Every step refers to a portable `personaKey`. The user maps each package persona slot to one local managed persona during import.

Allowed `routeRequirement` values:

- `any` — any managed persona with a runnable route;
- `networked` — any managed persona using Direct or an enabled configured route;
- `protected` — a managed persona using an enabled configured proxy/VPN route rather than Direct or Block;
- `direct` — a managed persona explicitly using Direct.

The preview lists only currently runnable route mappings. Import validates the selected mapping against the Run rules, including disabled or missing routes. A workflow using Block cannot be exported. Route readiness can change after import, so Run checks it again.

## Userscripts

Every `scriptKey` referenced by a workflow step must have a matching entry in `scripts`, and every script entry must point to a file inside `userscripts/`.

On import PersonaMonkey:

1. reads the userscript metadata block;
2. checks supported `@grant` values;
3. verifies `sha256` when supplied;
4. reuses an identical already-installed script when possible;
5. otherwise imports a conflict-safe local copy;
6. automatically assigns the script to every mapped persona used by steps that reference it.

Packages never carry GM storage, route credentials, WireGuard keys, browser cookies, or other persona data.

## Workflow semantics

Steps run sequentially in manifest order. URLs within a single step may run concurrently up to the step's `concurrency` value and the extension's global limits.

Completion modes:

- `load` — complete after the page load event;
- `delay` — wait for page load, then `completion.value` milliseconds;
- `selector` — wait for page load, then wait for CSS selector `completion.value`;
- `signal` — wait for selected userscripts to call `Persona.complete(result)` or `Persona.fail(error)`. Each script must declare `// @grant Persona.signal` and run in the isolated `USER_SCRIPT` world. Signal mode does not require a later page-load event once a valid userscript signal arrives.

`retryDelayMs` is optional and defaults to 1000 ms. Retries are cancellation-aware.

Each step's `completion.timeoutMs` is an integer from 1,000 ms through **60 minutes (3,600,000 ms)**, inclusive; the default is 60,000 ms. The validator and runtime use this same maximum.

A workflow can create at most **500 URL tasks** across all steps. The same URL repeated within one step is one task; the same URL in another step is another task. Larger workflows fail validation before opening tabs. Each step may still declare at most 10,000 URLs in the manifest schema, but the aggregate limit also applies. `signal` completion requires selected userscripts to run in the isolated `USER_SCRIPT` world. For a script that otherwise runs in `MAIN`, use `@inject-into content` in its userscript metadata and verify that its page access still works. Existing MAIN-world signal packages receive a validation error during inspection.

The automation history setting is a **maximum of 10–500 jobs** (default 100), ordered by creation time. Both active jobs and completed/failed/stopped jobs count toward this maximum; older finished jobs are removed on the next history write. The 4 MiB aggregate storage ceiling can retain fewer jobs when records are large. Each persisted job is limited to 1 MiB, each signal result to 64 KiB, and at most three jobs may be active concurrently. When a previous setting exceeds 500, loading the saved state normalizes it to 500 and the next state save persists that setting. Loading state does not itself erase existing job records.

## Security limits

PersonaMonkey rejects packages with path traversal, encrypted ZIP entries, unsupported ZIP methods, duplicate archive paths, malformed manifests, unsupported grants, missing referenced scripts/personas, excessive entry counts, or excessive uncompressed size.

The published JSON Schema defines field types, required properties, allowed fields, lengths, and per-array limits. The importer additionally validates unique persona/script keys, references, HTTP(S) URLs, completion semantics, and the 500-task aggregate limit. These cross-field rules cannot be expressed by the published schema. Shared contract fixtures in `extension/tests/fixtures/workflow-package-contract.json` exercise both schema and importer validation.

Import never executes the workflow automatically. The user must review persona mappings and click Import, then explicitly Run the imported workflow.

## Agent authoring checklist

When an agent creates a package:

1. Create a valid `manifest.json` using `formatVersion: 1`.
2. Use stable package-local keys such as `primary`, `login`, `collector`, not local Firefox IDs.
3. Include every referenced userscript in `userscripts/`.
4. Ensure userscript `@match` rules cover the workflow URLs and grants are supported by PersonaMonkey.
5. For `signal` completion, every selected userscript must declare `Persona.signal` and call `Persona.complete(...)` or `Persona.fail(...)` on every terminal code path.
6. Prefer HTTPS workflow URLs.
7. Do not include secrets, cookies, route credentials, or VPN key material.
8. Package the files as ZIP. Stored entries are the most portable choice.
9. Optionally include SHA-256 hashes for userscript files; PersonaMonkey verifies them when present.

A machine-readable [JSON Schema](../reference/personamonkey-workflow-package.schema.json) is provided for the manifest structure.
