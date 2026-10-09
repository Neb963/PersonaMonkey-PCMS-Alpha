// Operator-assisted generator.update v2 (04 §E.13, ADR-002 §9). Dispatch opens the target in
// the bound Persona (through the caller's `openTarget`, which goes through the Persona Broker)
// and records a durable handoff with code and HTML kept separate, the optional thumbnail and
// the listing instruction. The operator answers later from any dashboard tab; until then the
// outcome is unknown, so ProviderGate records the operation UNCERTAIN. Nothing is replayed.
import { describeGeneratorListing, parseGeneratorListing } from "./listing.js";

// Assisted capability set: nothing unattended, no provider reads, and listing/thumbnail are set
// by the operator from the handoff instructions rather than by PCMS.
export const PERCHANCE_ASSISTED_CAPABILITIES = Object.freeze({
  unattended:false, observe:false, listing:false, thumbnail:false, create:false
});

export function createPerchanceAssistedReleaseMethods({ openTarget, operator } = {}) {
  if (typeof openTarget !== "function") throw new TypeError("Assisted Perchance driver requires openTarget");
  if (!operator || typeof operator.choose !== "function") throw new TypeError("Assisted Perchance driver requires an operator bridge");

  async function updateGeneratorRelease({ operationId, generatorId, payloadHash, code, html, thumbnail, settings } = {}) {
    const context = await openTarget({ operationId, generatorId, phase:"open" });
    const listing = parseGeneratorListing(settings);
    if (listing === "UNKNOWN") throw new Error("Generator listing could not be prepared");
    const listingWords = describeGeneratorListing(listing);
    const choice = await operator.choose({
      operationId,
      phase:"dispatch",
      subjectRef:context.targetRef,
      title:"Deploy generator " + generatorId,
      instructions:"PCMS opened " + generatorId + " in its bound Persona. Paste the code panel and the HTML panel shown on the generator page into the Perchance editor"
        + (thumbnail ? ", upload the thumbnail" : "")
        + ", set the generator to " + listingWords + " and save. Choose Applied only after Perchance confirms the save.",
      source:null,
      sourceHash:payloadHash,
      payload:{ code, html, thumbnail: thumbnail ?? null, listing: listingWords, payloadHash, label:null },
      choices:["APPLIED","NOT_APPLIED"]
    });
    if (choice !== "APPLIED" && choice !== "NOT_APPLIED") throw new Error("Generator deployment outcome is uncertain");
    return Object.freeze({ status: choice });
  }

  async function reconcileGeneratorRelease({ operationId, generatorId } = {}) {
    const context = await openTarget({ operationId, generatorId, phase:"verify" });
    const choice = await operator.choose({
      operationId,
      phase:"reconcile",
      subjectRef:context.targetRef,
      title:"Check generator " + generatorId + " on Perchance",
      instructions:"Inspect the saved generator in the bound Persona and compare it with the code and HTML on the generator page. Choose Applied only if Perchance shows that content; choose Not applied only if you can see the save did not happen; otherwise keep it Unknown. Nothing is retried until you answer.",
      source:null,
      sourceHash:null,
      choices:["APPLIED","NOT_APPLIED","UNKNOWN"]
    });
    return Object.freeze({ status: ["APPLIED","NOT_APPLIED","UNKNOWN"].includes(choice) ? choice : "UNKNOWN" });
  }

  return Object.freeze({ updateGeneratorRelease, reconcileGeneratorRelease });
}
