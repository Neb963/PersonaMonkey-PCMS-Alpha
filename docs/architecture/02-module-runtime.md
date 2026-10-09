# 02 — Module Runtime

A PCMS module is an immutable, hashed package admitted without rebuilding the extension.

Controller/UI JavaScript executes only in a declared Firefox sandbox page. The privileged parent exposes bounded typed RPC capabilities; it never passes raw WebExtension APIs.

Browser/page automation is delegated to PersonaMonkey external automation using exact artifact hashes, expected Persona identity and control-lease semantics.

Core owns runtime generation. Update/disable advances the generation before replacement admission; stale runtimes cannot write, call services or dispatch remote mutations.

Authority expansion on update requires explicit approval. The old active package remains last-known-good until the candidate is admitted.

Core supplies only shared correctness mechanisms. Feature queues, cohorts, schedules and domain policy remain module-owned.

## Production host and lifecycle (ADR-003)

- Controllers run in `pcms/sandbox/controller.html`, declared in the production manifest and framed inside the background page; one frame per module generation.
- Install/update/disable/enable/rollback/remove/purge execute in the background Core without extension reload; the old generation is fenced before the new one is admitted.
- After event-page unload or browser restart, `recoverAll()` fences previous generations and the module supervisor lazily re-activates desired-running modules before delivering timers, UI requests or events. Controllers re-declare schedules idempotently on `start()`.
- Runtime modules receive only the bounded, approved PCMS capability set (ADR-003 §4). Provider mutation goes through ProviderGate/RemoteOps; browser/page automation remains PersonaMonkey-owned.
- Runtime modules may contribute UI declaratively and through a sandboxed module-UI page; Core renders confirmation for risky actions.
