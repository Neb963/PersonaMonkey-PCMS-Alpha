import assert from "node:assert/strict";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this.isConnected = true;
  }
  append(...items) { this.children.push(...items); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  focus() { globalThis.document.activeElement = this; }
  contains(element) { return this.children.includes(element) || this.children.some((child) => child.contains?.(element)); }
  remove() { this.isConnected = false; }
  showModal() {
    this.open = true;
    queueMicrotask(() => this.children[0].children[2].children[1].click());
  }
  close(value) {
    this.returnValue = value;
    this.open = false;
    this.listeners.get("close")?.();
  }
  click() { this.listeners.get("click")?.(); }
}

const messages = [];
let activeLeases = [];
globalThis.browser = {
  runtime: {
    async sendMessage(message) {
      messages.push(message);
      return { leases: structuredClone(activeLeases) };
    }
  }
};
globalThis.document = {
  activeElement: new FakeElement("button"),
  body: { append(element) { element.parent = this; } },
  createElement(tagName) { return new FakeElement(tagName); }
};

const { confirmWorkflowControlOverride } = await import(`../options/workflow-control.js?test=${Date.now()}`);
const state = {
  profiles: {
    p1: { containerId: "p1", personaUid: "70000000-0000-4000-8000-000000000001", managed: true, name: "One" },
    p2: { containerId: "p2", personaUid: "70000000-0000-4000-8000-000000000002", managed: true, name: "Two" },
    p3: { containerId: "p3", personaUid: "70000000-0000-4000-8000-000000000003", managed: false, name: "Unmanaged" }
  }
};
const workflow = { steps: [{ profileId: "p2" }, { profileId: "p1" }, { profileId: "p3" }] };

activeLeases = [];
assert.deepEqual(await confirmWorkflowControlOverride(workflow, state), {
  expectedPersonaUids: [
    "70000000-0000-4000-8000-000000000001",
    "70000000-0000-4000-8000-000000000002"
  ],
  leases: [],
  takeControl: false
}, "no-lease confirmations still bind the full managed workflow target set");

activeLeases = [{
  status: "active",
  leaseId: "lease-approved",
  personaUid: "70000000-0000-4000-8000-000000000002"
}];
assert.deepEqual(await confirmWorkflowControlOverride(workflow, state), {
  expectedPersonaUids: [
    "70000000-0000-4000-8000-000000000001",
    "70000000-0000-4000-8000-000000000002"
  ],
  leases: [{ personaUid: "70000000-0000-4000-8000-000000000002", leaseId: "lease-approved" }],
  takeControl: true
}, "an accepted confirmation binds the exact lease ID and target UID set");

activeLeases = [{ status: "active", personaUid: "70000000-0000-4000-8000-000000000002" }];
await assert.rejects(confirmWorkflowControlOverride(workflow, state), /verify the active Persona control lease/,
  "the options page refuses an incomplete lease identity");
assert.ok(messages.every((message) => message.type === "GET_EXTERNAL_AUTOMATION_CONTROL_LEASES"));

console.log("workflow control confirmation tests passed");
