import assert from "node:assert/strict";
import { captureFocusReturnId, restoreFocusById } from "../options/focus-return.js";

const originalOpener = { id: "saveRouteEditor" };
const returnId = captureFocusReturnId(originalOpener);
assert.equal(returnId, "saveRouteEditor");

// Options reload replaces the editor control; restore focus to the new node.
let focused = false;
const replacement = {
  id: "saveRouteEditor",
  isConnected: true,
  disabled: false,
  focus() { focused = true; }
};
const documentRef = { getElementById(id) { return id === "saveRouteEditor" ? replacement : null; } };
assert.equal(restoreFocusById(documentRef, returnId), true);
assert.equal(focused, true);
assert.equal(restoreFocusById(documentRef, "missing"), false);
assert.equal(restoreFocusById({ getElementById: () => ({ ...replacement, disabled: true }) }, returnId), false);

console.log("security review focus return tests passed");
