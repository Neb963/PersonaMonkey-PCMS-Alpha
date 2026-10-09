// Perchance listing compatibility (04 §F.2). This file is the only place in PCMS that knows
// how Perchance serialises a generator's listing. Domain records, UI, audit text and module
// contracts use GeneratorListing ("PUBLICLY_LISTED" | "UNLISTED") and ObservedListing (+ "UNKNOWN").
import { normalizeGeneratorListing } from "./contract.js";
// Reviewed fixture-page wire mapping, embedded in the immutable read artifact.
// Keep provider field knowledge here, including code sent to PersonaMonkey.
export const OBSERVE_FIXTURE_LISTING_SOURCE = `const setting = page.dataset.isPrivate;
  const settings = setting === "true" ? { isPrivate:true } : setting === "false" ? { isPrivate:false } : {};`;

// desired → provider
export function serializeGeneratorListing(listing) {
  return normalizeGeneratorListing(listing) === "UNLISTED"
    ? Object.freeze({ isPrivate: true })
    : Object.freeze({ isPrivate: false });
}

// provider → observed. Anything but an exact boolean (missing, non-boolean, a new field shape)
// is UNKNOWN, and the caller turns listing capability off (fail closed for listing changes).
export function parseGeneratorListing(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "UNKNOWN";
  const descriptor = Object.getOwnPropertyDescriptor(raw, "isPrivate");
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return "UNKNOWN";
  if (descriptor.value === false) return "PUBLICLY_LISTED";
  if (descriptor.value === true) return "UNLISTED";
  return "UNKNOWN";
}

// Operator wording for the assisted handoff (never the provider field name).
export function describeGeneratorListing(listing) {
  return normalizeGeneratorListing(listing) === "UNLISTED" ? "Unlisted" : "Publicly listed";
}

// Reviewed fixture-editor wire mapping for the unattended deployment artifact (P042):
// desired listing → the fixture editor's isPrivate checkbox. Real Perchance stays gated.
export const DEPLOY_FIXTURE_LISTING_SOURCE = `const listingControl = page.querySelector('[data-setting="isPrivate"]');
  if (!listingControl || typeof input.settings?.isPrivate !== "boolean") fail();
  listingControl.checked = input.settings.isPrivate;
  listingControl.dispatchEvent(new Event("change", { bubbles:true }));`;
