# P025 — live acceptance 1 preparation

This directory covers the deterministic release-wiring prerequisites for the final manual LIVE acceptance phase.

The focused test proves that:

- the browser-only transport wraps the accepted Persona Broker Integration-v1 envelope in a same-extension PCMS message;
- only PCMS extension pages can reach the built-in background bridge;
- the built-in PCMS principal preserves PersonaMonkey operation-level policy flags;
- the production PCMS app no longer mounts an empty projection;
- the XPI builder includes the accepted top-level `pcms-modules/` sources;
- the toolbar exposes the real Perchance Central Management System entry.

These checks do **not** satisfy A025-01, A025-02, or A025-03. Those acceptance IDs require manual evidence from the installed XPI in real Firefox Developer Edition with PersonaMonkey, Mullvad and Perchance.
