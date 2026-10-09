# P101 Firefox / PersonaMonkey baseline

The accepted Alpha pin is Firefox Developer Edition **154.0b10**, linux-x86_64,
en-US. Its Mozilla archive SHA-256 is
`681913108bba655d7ec6fadfac2731141b23e48dca88d1988a4d95a6bdaff164`.
The Alpha installer reuses the donor downloader and extraction, then checks exact
version output and attests every extracted file, mode and symlink. Each browser
run rechecks the archive, extraction digest and running Developer Edition build.
A divergent donor/Alpha pin requires an authorized amendment; there is no latest
channel, system-browser fallback or automatic update.

From the repository root on Linux with Firefox libraries, Node 24, tar, zip and unzip:

```sh
node --test tests/alpha/browser-baseline/*.test.mjs
FIREFOX_INSTALL_ROOT=/tmp/alpha-p101-firefox node tools/alpha/firefox/install-pinned.mjs
export FIREFOX_BIN=/tmp/alpha-p101-firefox/versions/154.0b10/firefox/firefox
export FIREFOX_INSTALL_MANIFEST=/tmp/alpha-p101-firefox/alpha-install-manifest.json
node tools/alpha/firefox/smoke.mjs
node tests/alpha/browser-baseline/packaged.mjs
```

Both suites use fresh disposable profiles, a startup rejecting proxy and a
parent HTTP observer allowing only the explicit loopback fixture origin. The
observer is reinstalled after a full restart. Smoke checks the actual DOM and
proves another origin cannot reach the fixture server. The packaged suite builds
twice and compares hashes; installs the unmodified unsigned XPI once; checks
Persona UID/container persistence, correlated create replay, Block routing,
Direct denial, invalid fields, stale revision/boot fences, sender restrictions,
event-page unload/wake and persistent installation after browser restart.
It uses PersonaMonkey's preserved management page and typed broker/Firefox
transport. It grants no integration policy flags and uses no raw state writes,
native RPC, userscript automation or Perchance operations.

AP101-01 maps to preserved donor regressions, isolated smoke, unchanged broker
bytes and packaged startup. AP101-02 maps to packaged install/unload/restart and
Persona/routing/broker faults. AP101-03 maps to exact archive/extraction/build
identity, two-build XPI hash, committed provenance and independent Actions.

Some container runtimes deny the user namespaces required by Firefox's content
sandbox. A supplementary local run may explicitly set
`MOZ_DISABLE_CONTENT_SANDBOX=1`; the report records that limitation, and CI
rejects it. Hosted `alpha-firefox` keeps the OS content sandbox enabled, runs the
current-main claim guard before and after the suite, and uploads only bounded
reports (no profile, storage dump, page source, console or screenshot).
The inherited `firefox-developer-edition` workflow remains required and intact.
Individual green checks do not establish GATE-R1 or operator-live acceptance.
