import assert from "node:assert/strict";

const attributes = {};
const node = {
  textContent: "",
  className: "toast",
  addEventListener() {},
  setAttribute(name, value) { attributes[name] = value; },
  get offsetWidth() { return 0; }
};
const originalDocument = globalThis.document;
globalThis.document = { getElementById(id) { return id === "toast" ? node : null; } };

try {
  const { toast, clearToast } = await import("../options/toast.js");

  toast("first", false, 12);
  assert.equal(attributes["aria-live"], "polite");
  await new Promise((resolve) => setTimeout(resolve, 5));
  toast("second", true, 45);
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.equal(node.textContent, "second", "an older toast timer must not hide a newer message");
  assert.equal(node.className, "toast show error");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(node.className, "toast");
  assert.equal(node.textContent, "", "expired toast content must be cleared");

  toast("visible");
  toast("   ");
  assert.equal(node.className, "toast", "blank toast messages must not leave an empty visible toast");
  assert.equal(node.textContent, "");

  toast("clear me");
  clearToast();
  assert.equal(node.className, "toast");
  assert.equal(node.textContent, "");

  console.log("shared toast lifecycle tests passed");
} finally {
  globalThis.document = originalDocument;
}
