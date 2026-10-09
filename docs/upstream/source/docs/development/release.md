# Release procedure

This procedure produces a release from one frozen source commit. The tag, CI run, XPI, and published checksum must identify that same candidate. Do not publish an artifact built from one commit under a tag pointing to another.

The current workflow builds an unsigned XPI and checksum; it does not submit the add-on for Mozilla signing or verify the returned signature. A checksum beside that artifact is not independent provenance. Mozilla signing remains mandatory for **persistent browser installation through the supported installer**, but it is not inherently required to publish source and an explicitly labelled unsigned development XPI on GitHub. If the owner accepts signing or environment-specific acceptance as non-blocking for a release, record that decision explicitly, keep the unperformed checks marked unverified, and do not represent the unsigned artifact as persistently installable. Do not describe signature-marker presence as cryptographic verification.

## Prepare the candidate

1. Start from current `main` and confirm the working tree and branch state. Review [`docs/reference/compatibility.md`](../reference/compatibility.md), [`SECURITY.md`](../../SECURITY.md), and [`docs/development/testing.md`](testing.md).
2. Update the product version in `package.json` and `extension/manifest.json` together. The installer and XPI builder derive their version from the extension manifest; do not hand-edit generated filenames.
3. Update `CHANGELOG.md` with the release date and supported changes. Keep historical milestones out of the current engineering docs.
4. Run `npm run release:check` locally. This runs `npm test`, including the XPI cross-timezone reproducibility check, the stubbed browser smokes, extension validation, and artifact builds. Record actual results; do not claim unavailable installed-browser or native egress checks passed.
5. Inspect the full diff for unexplained runtime changes, version mismatch, generated output, and private material. Review the built artifacts as described below.

The versioned extension artifact is `dist/persona-route-manager-v<VERSION>.xpi`, accompanied by `dist/persona-route-manager-v<VERSION>.xpi.sha256`. The XPI builder normalizes source mtimes, archive ordering, timezone, and locale so equivalent Linux builds do not change merely because the developer and CI runners use different local time zones. The supported example builder emits `dist/mullvad-signal-check.personamonkey.zip` and `dist/mullvad-signal-check.personamonkey.zip.sha256`. These names are defined by `scripts/build-extension.mjs` and `scripts/build-workflow-examples.mjs`. `dist/` is generated output and must not be committed as source.

## Candidate acceptance and freeze

After local checks, commit the candidate on its topic branch and record the full commit SHA and source-tree SHA. Build the XPI from that clean commit, record its SHA-256, and install those exact bytes in Firefox or LibreWolf for the acceptance checks in [Testing](testing.md). Perform native egress acceptance against that artifact in the authorized private environment when available. Keep the results distinct: a green local gate or stubbed UI smoke is not evidence of installed Firefox behavior or live native routing. Any source change creates a new candidate and requires rebuilding and repeating affected acceptance.

Freeze the tested candidate and use the pull-request workflow for final branch verification only after the local checks and applicable acceptance evidence are reviewed. Merge it normally into `main`. If the merge creates a different commit SHA, confirm that its source tree matches the accepted candidate, rebuild from the exact `main` commit, and compare the XPI SHA-256 to the installed candidate. If the bytes differ, repeat installed acceptance against the new artifact. Record the full `main` commit SHA; that is the release source. Do not change it while final CI is running.

## Final CI, tag, and artifact identity

The workflow in `.github/workflows/extension-tests.yml` runs `npm run release:check` on pull requests, pushes to `main`, `v*` tags, and manual dispatch. After merge, wait for the run associated with the exact frozen `main` commit to pass. Record its commit SHA and workflow run URL. The workflow also runs on the eventual tag, providing a second check against the tag's resolved commit.

Create the `v<VERSION>` tag only after the frozen `main` candidate has passed CI. Confirm that the tag resolves to the exact frozen commit SHA; do not move an existing release tag. Wait for the tag-triggered workflow to pass before publishing. If CI fails, diagnose the failure, fix it on a new candidate commit, rerun relevant local checks, and repeat the final CI process.

For the release artifact, retrieve the XPI produced by the workflow run for the tag commit, or rebuild from that exact commit using `npm run build` and compare the result. The workflow artifact is named `persona-route-manager-extension` and contains `dist/*.xpi`, `dist/*.sha256`, and `dist/*.personamonkey.zip`. Verify:

- the XPI filename includes the release version;
- the manifest inside the XPI reports the release version and Gecko ID `persona-route-manager@local`;
- the XPI contents are expected and include no tests or private configuration;
- the SHA-256 in the sidecar matches the final XPI bytes;
- the example package and its checksum are the expected supported example outputs;
- the source SHA, tag SHA, workflow run SHA, and artifact provenance all refer to the same commit.

These checks establish byte identity and package metadata only. They do not establish Mozilla signing: the release process must obtain the signed XPI from the signing service and authenticate its digest through a separate trusted release record before it can be used with `install.sh --xpi ... --xpi-sha256 ...`.

Record the XPI SHA-256 in the release notes or checksum asset. Do not make a post-validation edit and imply the earlier artifact was built from that later commit.

## Publish

Publish the GitHub Release for the verified `v<VERSION>` tag with concise notes, the XPI, its SHA-256 checksum, and supported workflow example package/checksum where appropriate. Include the frozen source commit SHA and identify any environment-dependent gate that remains unverified. If the release XPI is unsigned by owner decision, label it clearly as an unsigned development artifact suitable for temporary loading only; do not advertise it as compatible with the persistent installer. Never describe unrun Firefox acceptance, native lifecycle acceptance, signing, or native egress validation as passed.

For the first stable release, unresolved verification of an advertised major capability is a release decision that must be surfaced and resolved before publishing without qualification. Never include WireGuard configuration, credentials, cookies, backups, private logs, or browser profile data in artifacts or release evidence.
