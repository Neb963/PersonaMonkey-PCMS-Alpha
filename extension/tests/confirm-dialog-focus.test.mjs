import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this.isConnected = false;
    this.open = false;
    this.disabled = false;
    this.value = "";
    this.returnValue = "";
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
    }
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    Object.defineProperty(event, "target", { configurable: true, value: this });
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(new Event("click"));
  }

  focus() {
    if (!this.disabled) globalThis.document.activeElement = this;
  }

  contains(target) {
    return this === target || this.children.some((child) => child.contains(target));
  }

  remove() {
    this.isConnected = false;
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
  }

  showModal() {
    this.open = true;
    this.focus();
  }

  close(value = "") {
    this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }

  querySelector(selector) {
    const match = selector.match(/^button\[value="([^"]+)"\]$/);
    if (!match) return null;
    const visit = (node) => {
      if (node.tagName === "button" && node.value === match[1]) return node;
      for (const child of node.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this);
  }
}

const body = new FakeElement("body");
body.isConnected = true;
globalThis.document = {
  activeElement: body,
  body,
  createElement(tagName) { return new FakeElement(tagName); }
};

const { confirmAction } = await import("../options/confirm-dialog.js");
const pauseForFocusCleanup = () => new Promise((resolve) => setTimeout(resolve, 5));
const optionsSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../options/options.js"), "utf8");
const directConfirmation = optionsSource.slice(optionsSource.indexOf('if (nextRouteId === DIRECT_ROUTE_ID'));
assert.match(directConfirmation, /danger: true, opener: routeSelect/,
  "the Direct route confirmation must retain the initiating select as its explicit focus-return target");
assert.ok(directConfirmation.indexOf("opener: routeSelect") < directConfirmation.indexOf("routeSelect.disabled = true"),
  "the initiating select must be captured before the Direct route confirmation disables it");

async function verifyFocusReturn(outcome, { escape = false, failCaller = false } = {}) {
  const opener = new FakeElement("select");
  opener.isConnected = true;
  opener.focus();
  const request = confirmAction("Use Direct network?", { opener });
  opener.disabled = true;
  const settled = request
    .then((confirmed) => {
      if (failCaller && confirmed) throw new Error("caller-side update failed");
      return confirmed;
    })
    .catch(() => false)
    .finally(() => { opener.disabled = false; });

  const dialog = body.children.find((child) => child.tagName === "dialog");
  assert.ok(dialog?.open, "confirmation dialog should be open");
  if (escape) {
    const event = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, "Escape cancellation should be handled by the dialog");
  } else {
    dialog.querySelector(`button[value="${outcome ? "confirm" : "cancel"}"]`).click();
  }

  assert.equal(await settled, outcome && !failCaller);
  await pauseForFocusCleanup();
  assert.equal(opener.disabled, false, "the opener should be re-enabled before focus restoration");
  assert.equal(document.activeElement, opener, "focus should return to the initiating control");
}

await verifyFocusReturn(false);
await verifyFocusReturn(false, { escape: true });
await verifyFocusReturn(true);
await verifyFocusReturn(true, { failCaller: true });

console.log("confirmation dialog focus restoration tests passed for cancel, Escape, success, and caller error");
