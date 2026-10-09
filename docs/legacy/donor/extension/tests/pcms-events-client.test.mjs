import assert from "node:assert/strict";
import { createPcmsEventHub } from "../lib/pcms-events.js";
import { createPcmsClient } from "../lib/pcms-client.js";

const hub = createPcmsEventHub({ bootId: "event-boot", getRevision: () => 12 });
const received = [];
const unsubscribe = hub.subscribe((event) => received.push(event));
hub.subscribe(() => { throw new Error("broken subscriber"); });
hub.emit({ type: "persona.changed", entity: "persona", entityId: "p1", data: { token: "not-visible", name: "P1" } });
hub.emit({ type: "persona.changed", entity: "persona", entityId: "p2", data: { password: "not-visible" } });
assert.deepEqual(received.map((event) => event.sequence), [1, 2]);
assert.deepEqual(received.map((event) => event.revision), [12, 12]);
assert.equal(received[0].bootId, "event-boot");
assert.equal(received[0].data.token, "[redacted]");
unsubscribe();
assert.equal(hub.subscriberCount(), 1);

const portMessages = [];
const listeners = { message: null, disconnect: null };
const port = {
  postMessage: (message) => portMessages.push(message),
  onDisconnect: { addListener: (fn) => { listeners.disconnect = fn; } }
};
hub.attachPort(port);
hub.emit({ type: "route.test.completed", entity: "persona", entityId: "p1", data: {} });
assert.equal(portMessages.length, 1);
listeners.disconnect();
hub.emit({ type: "route.test.completed", entity: "persona", entityId: "p1", data: {} });
assert.equal(portMessages.length, 1);

let request;
let responseFactory = (message) => ({
  version: 1,
  requestId: message.requestId,
  ok: true,
  bootId: "client-boot",
  revision: 3,
  result: { described: true }
});
const clientPort = {
  onMessage: { addListener: (fn) => { listeners.message = fn; }, removeListener() {} },
  onDisconnect: { addListener: (fn) => { listeners.disconnect = fn; }, removeListener() {} },
  disconnect() { listeners.disconnect?.(); }
};
const runtime = {
  async sendMessage(message) { request = message; return responseFactory(message); },
  connect({ name }) { assert.equal(name, "PCMS_EVENTS"); return clientPort; }
};
const client = createPcmsClient({ runtime, requestIdFactory: () => "request-1" });
const reply = await client.describe();
assert.equal(reply.ok, true);
assert.deepEqual(reply.result, { described: true });
assert.deepEqual(request, { type: "PCMS_REQUEST", version: 1, requestId: "request-1", command: "system.describe", params: {} });

const pageRequests = [];
responseFactory = (message) => {
  pageRequests.push(message.params.page);
  const offset = message.params.page.cursor ? Number(message.params.page.cursor) : 0;
  const end = Math.min(offset + message.params.page.size, 150);
  return { version: 1, requestId: message.requestId, ok: true, bootId: "client-boot", revision: 3,
    result: { items: Array.from({ length: end - offset }, (_, index) => ({ id: offset + index })),
      hasMore: end < 150, nextCursor: end < 150 ? String(end) : null } };
};
const completeList = await client.listAll("persona.list", {}, { size: 40 });
assert.equal(completeList.length, 150);
assert.equal(completeList[149].id, 149);
assert.equal(pageRequests.length, 4);
assert.equal(pageRequests[1].cursor, "40");

responseFactory = (message) => ({ version: 1, requestId: message.requestId, ok: false, bootId: "client-boot", revision: 4, error: { code: "PERSONA_NOT_FOUND", message: "Managed persona not found", retryable: false, details: null } });
await assert.rejects(client.request("persona.get", { profileId: "missing" }), (error) => error?.code === "PERSONA_NOT_FOUND" && /Managed persona not found/.test(error.message));

for (const malformed of [
  null,
  {},
  { version: 1, requestId: "wrong", ok: true, bootId: "client-boot", revision: 4, result: {} },
  { version: 1, requestId: "request-1", ok: true, bootId: "client-boot", revision: 4 },
  { version: 2, requestId: "request-1", ok: true, bootId: "client-boot", revision: 4, result: {} },
  { version: 1, requestId: "request-1", ok: false, bootId: "client-boot", revision: 4, error: null }
]) {
  responseFactory = () => malformed;
  await assert.rejects(client.request("system.describe"), (error) => error?.code === "PCMS_MALFORMED_RESPONSE");
}
responseFactory = () => { throw new Error("background unavailable"); };
await assert.rejects(client.request("system.describe"), (error) => error?.code === "PCMS_TRANSPORT_UNAVAILABLE");

const stream = [];
const statuses = [];
const connection = client.connectEvents((event) => stream.push(event), { onStatus: (status) => statuses.push(status) });
listeners.message({ version: 1, bootId: "event-boot", sequence: 1, type: "persona.changed" });
listeners.message({ version: 2, bootId: "event-boot", sequence: 2, type: "persona.changed" });
listeners.message({ version: 1, bootId: "", sequence: 2, type: "persona.changed" });
listeners.message({ version: 1, bootId: "event-boot", sequence: 0, type: "persona.changed" });
assert.equal(stream.length, 1, "malformed/wrong-version events are ignored");
assert.equal(statuses[0].connected, true);
connection.disconnect();
assert.equal(connection.connected, false);
assert.equal(statuses.at(-1).connected, false);
console.log("pcms events/client tests passed");
