import { inspectPersonaPackage } from "../lib/persona-package.js";

self.onmessage = async (event) => {
  if (event?.data?.type !== "inspect-persona-package") return;
  try {
    const preview = await inspectPersonaPackage(event.data.buffer);
    self.postMessage({ ok: true, preview });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: String(error?.message || error || "Persona package inspection failed").slice(0, 1000)
    });
  }
};
