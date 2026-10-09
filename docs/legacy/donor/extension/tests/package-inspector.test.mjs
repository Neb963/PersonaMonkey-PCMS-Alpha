import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPackageInspector } from "../lib/package-inspector-client.js";

const unavailable = createPackageInspector({ WorkerCtor: null, runtime: null });
await assert.rejects(
  unavailable.inspectPersonaPackage(new Uint8Array()),
  /Package inspection worker is unavailable/
);

const preview = { identity: { name: "Example" } };
let workerOptions;
let postedMessage;
let transferList;
let terminateCount = 0;
class TestWorker {
  constructor(url, options) {
    this.url = url;
    workerOptions = options;
  }
  postMessage(message, transfer) {
    postedMessage = message;
    transferList = transfer;
    queueMicrotask(() => this.onmessage({ data: { ok: true, preview } }));
  }
  terminate() { terminateCount += 1; }
}

const inputBacking = Uint8Array.of(9, 1, 2, 8);
const input = inputBacking.subarray(1, 3);
const inspector = createPackageInspector({
  WorkerCtor: TestWorker,
  runtime: { getURL: (path) => `moz-extension://test/${path}` }
});
assert.deepEqual(await inspector.inspectPersonaPackage(input), preview);
assert.equal(workerOptions.type, "module");
assert.equal(postedMessage.type, "inspect-persona-package");
assert.equal(postedMessage.buffer instanceof ArrayBuffer, true);
assert.deepEqual([...new Uint8Array(postedMessage.buffer)], [1, 2]);
assert.deepEqual(transferList, [postedMessage.buffer]);
assert.deepEqual([...input], [1, 2], "transfer must not detach a caller-owned buffer");
assert.equal(terminateCount, 1);

const [background, options, worker] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../options/personas-v07.js", import.meta.url), "utf8"),
  readFile(new URL("../workers/package-inspector.js", import.meta.url), "utf8")
]);
assert.match(background, /createPackageInspector/);
assert.doesNotMatch(background, /\b(?:readZip|DecompressionStream)\b/);
assert.match(options, /createPackageInspector/);
assert.match(options, /packageInspector\.inspectPersonaPackage\(importBytes\)/);
assert.doesNotMatch(options, /inspectPersonaPackage\s*[,}]\s*from\s*["'][^"']*persona-package\.js/);
assert.match(worker, /inspectPersonaPackage/);

console.log("package inspection worker isolation tests passed");
