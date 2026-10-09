import assert from "node:assert/strict";
import test from "node:test";

import { AUDIT_ERROR_CODES } from "../../extension/pcms/audit/errors.js";
import { createIndexedDbAuditBackend } from "../../extension/pcms/audit/indexeddb-journal.js";
import { createPcmsAuditJournal } from "../../extension/pcms/audit/journal.js";
import {
  AUDIT_META_KEY,
  AUDIT_NAMESPACE,
  auditEventKey,
  createAuditEvent
} from "../../extension/pcms/audit/schema.js";
import { PCMS_NAMESPACE_INDEX, PCMS_RECORD_STORE } from "../../extension/pcms/storage/migrations.js";

function id(namespace, key) {
  return namespace + "\u0000" + key;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function makeTransactionalDb(shared = { records: new Map(), failNextEventAdd: false }) {
  return {
    shared,
    closed: false,
    onversionchange: null,
    close() { this.closed = true; },
    transaction(storeName, mode) {
      assert.equal(storeName, PCMS_RECORD_STORE);
      assert.ok(mode === "readwrite" || mode === "readonly");
      let pending = 0;
      let completed = false;
      let aborted = false;
      let completionQueued = false;
      const staged = new Map([...shared.records].map(([key, value]) => [key, clone(value)]));

      const transaction = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        abort() {
          if (aborted || completed) return;
          aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore() { return store; }
      };

      function maybeComplete() {
        if (aborted || completed || pending !== 0 || completionQueued) return;
        completionQueued = true;
        queueMicrotask(() => {
          completionQueued = false;
          if (aborted || completed || pending !== 0) return;
          completed = true;
          if (mode === "readwrite") {
            shared.records.clear();
            for (const [key, value] of staged) shared.records.set(key, clone(value));
          }
          transaction.oncomplete?.();
        });
      }

      function makeRequest(operation) {
        pending += 1;
        const request = { result: undefined, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (aborted) {
            pending -= 1;
            return;
          }
          try {
            operation(request);
            request.onsuccess?.();
          } catch (error) {
            request.error = error;
            request.onerror?.();
          } finally {
            pending -= 1;
            maybeComplete();
          }
        });
        return request;
      }

      function openCursor() {
        pending += 1;
        const values = [...staged.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(clone);
        let index = 0;
        const request = { result: undefined, error: null, onsuccess: null, onerror: null };

        function emit() {
          queueMicrotask(() => {
            if (aborted) {
              pending -= 1;
              return;
            }
            if (index >= values.length) {
              request.result = null;
              request.onsuccess?.();
              pending -= 1;
              maybeComplete();
              return;
            }
            request.result = {
              value: clone(values[index++]),
              continue: emit
            };
            request.onsuccess?.();
          });
        }
        emit();
        return request;
      }

      const store = {
        get(key) {
          return makeRequest((request) => {
            request.result = clone(staged.get(key));
          });
        },
        put(record) {
          assert.equal(mode, "readwrite");
          return makeRequest((request) => {
            staged.set(record.id, clone(record));
            request.result = record.id;
          });
        },
        add(record) {
          assert.equal(mode, "readwrite");
          return makeRequest((request) => {
            if (shared.failNextEventAdd && record.namespace === AUDIT_NAMESPACE) {
              shared.failNextEventAdd = false;
              throw new Error("injected audit event write failure");
            }
            if (staged.has(record.id)) throw new Error("constraint");
            staged.set(record.id, clone(record));
            request.result = record.id;
          });
        },
        index(indexName) {
          assert.equal(indexName, PCMS_NAMESPACE_INDEX);
          return { openCursor };
        }
      };

      queueMicrotask(maybeComplete);
      return transaction;
    }
  };
}

function makeMemoryBackend(shared = { events: [], states: new Map(), opens: 0 }) {
  return {
    shared,
    async open() { shared.opens += 1; },
    close() {},
    async append({ draft, timestamp }) {
      const event = createAuditEvent({ sequence: shared.events.length + 1, timestamp, draft });
      shared.events.push(clone(event));
      return clone(event);
    },
    async transitionAndAppend({ transition, draft, timestamp }) {
      const stateId = id(transition.namespace, transition.key);
      const current = shared.states.get(stateId) || null;
      const currentRevision = current?.revision || 0;
      if (currentRevision !== transition.expectedRevision) {
        const error = new Error("conflict");
        error.code = AUDIT_ERROR_CODES.CONFLICT;
        error.currentRevision = currentRevision;
        throw error;
      }
      const event = createAuditEvent({ sequence: shared.events.length + 1, timestamp, draft });
      const state = {
        id: stateId,
        namespace: transition.namespace,
        key: transition.key,
        revision: currentRevision + 1,
        value: clone(transition.value),
        updatedAt: event.timestamp
      };
      shared.states.set(stateId, clone(state));
      shared.events.push(clone(event));
      return { state: clone(state), event: clone(event) };
    },
    async read({ afterSequence, limit }) {
      const remaining = shared.events.filter((event) => event.sequence > afterSequence);
      return {
        events: clone(remaining.slice(0, limit)),
        lastSequence: shared.events.length,
        hasMore: remaining.length > limit
      };
    }
  };
}

test("A007-01 event schema is bounded, data-only, and journal-owned identity is monotonic", async () => {
  const backend = makeMemoryBackend();
  let tick = 0;
  const journal = createPcmsAuditJournal({
    backend,
    clock: () => "2026-10-05T01:30:0" + (++tick) + "Z"
  });

  const first = await journal.append({
    type: "account.created",
    subject: { kind: "account", id: "acct-1" },
    data: { source: "manual", secretRef: { id: "opaque-1" } }
  });
  const second = await journal.append({ type: "account.bound", data: { personaUid: "persona-1" } });

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.sequence, 1);
  assert.equal(first.eventId, "audit-0000000000000001");
  assert.equal(second.sequence, 2);
  assert.equal(Object.isFrozen(first), true);

  await assert.rejects(
    journal.append({ type: "Bad Type", data: null }),
    (error) => error?.code === AUDIT_ERROR_CODES.INVALID_EVENT
  );
  await assert.rejects(
    journal.append({ type: "safe.event", data: { get secret() { return "must-not-run"; } } }),
    (error) => error?.code === AUDIT_ERROR_CODES.INVALID_EVENT
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    journal.append({ type: "safe.event", data: cyclic }),
    (error) => error?.code === AUDIT_ERROR_CODES.INVALID_EVENT
  );
});

test("A007-01 authoritative state transition and audit append commit atomically in one P005 store transaction", async () => {
  const shared = { records: new Map(), failNextEventAdd: false };
  const db = makeTransactionalDb(shared);
  const backend = createIndexedDbAuditBackend({ openDatabase: async () => db });
  let tick = 0;
  const journal = createPcmsAuditJournal({
    backend,
    clock: () => "2026-10-05T01:31:0" + (++tick) + "Z"
  });

  const first = await journal.append({ type: "core.started", data: { generation: 1 } });
  assert.equal(first.sequence, 1);

  const committed = await journal.transitionAndAppend(
    {
      namespace: "core.accounts",
      key: "acct-1",
      expectedRevision: 0,
      value: { state: "ACTIVE" }
    },
    {
      type: "account.state.changed",
      subject: { kind: "account", id: "acct-1" },
      data: { to: "ACTIVE" }
    }
  );
  assert.equal(committed.state.revision, 1);
  assert.equal(committed.event.sequence, 2);

  const persistedPage = await journal.read({ afterSequence: 0, limit: 10 });
  assert.deepEqual(persistedPage.events.map((event) => event.sequence), [1, 2]);
  assert.equal(persistedPage.lastSequence, 2);
  assert.equal(persistedPage.hasMore, false);

  const persistedProjection = await journal.project({
    initialState: { count: 0 },
    reducer(state) {
      state.count += 1;
      return state;
    }
  });
  assert.equal(persistedProjection.sequence, 2);
  assert.equal(persistedProjection.state.count, 2);

  const stateBeforeFailure = clone(shared.records.get(id("core.accounts", "acct-1")));
  const metaBeforeFailure = clone(shared.records.get(id(AUDIT_NAMESPACE, AUDIT_META_KEY)));
  assert.equal(metaBeforeFailure.value.lastSequence, 2);
  assert.ok(shared.records.has(id(AUDIT_NAMESPACE, auditEventKey(1))));
  assert.ok(shared.records.has(id(AUDIT_NAMESPACE, auditEventKey(2))));

  shared.failNextEventAdd = true;
  await assert.rejects(
    journal.transitionAndAppend(
      {
        namespace: "core.accounts",
        key: "acct-1",
        expectedRevision: 1,
        value: { state: "SUSPENDED" }
      },
      {
        type: "account.state.changed",
        subject: { kind: "account", id: "acct-1" },
        data: { to: "SUSPENDED" }
      }
    ),
    (error) => error?.code === AUDIT_ERROR_CODES.UNAVAILABLE
  );

  assert.deepEqual(shared.records.get(id("core.accounts", "acct-1")), stateBeforeFailure);
  assert.deepEqual(shared.records.get(id(AUDIT_NAMESPACE, AUDIT_META_KEY)), metaBeforeFailure);
  assert.equal(shared.records.has(id(AUDIT_NAMESPACE, auditEventKey(3))), false);

  shared.records.delete(id(AUDIT_NAMESPACE, auditEventKey(2)));
  await assert.rejects(
    journal.read({ afterSequence: 0, limit: 10 }),
    (error) => error?.code === AUDIT_ERROR_CODES.CORRUPT && error.lastSequence === 2
  );
});

test("A007-01 stale state revision aborts without consuming an audit sequence", async () => {
  const shared = { records: new Map(), failNextEventAdd: false };
  const db = makeTransactionalDb(shared);
  const journal = createPcmsAuditJournal({
    backend: createIndexedDbAuditBackend({ openDatabase: async () => db }),
    clock: () => "2026-10-05T01:32:00Z"
  });

  await journal.transitionAndAppend(
    { namespace: "core.test", key: "item", expectedRevision: 0, value: { n: 1 } },
    { type: "test.created", data: null }
  );

  await assert.rejects(
    journal.transitionAndAppend(
      { namespace: "core.test", key: "item", expectedRevision: 0, value: { n: 2 } },
      { type: "test.updated", data: null }
    ),
    (error) => error?.code === AUDIT_ERROR_CODES.CONFLICT && error.currentRevision === 1
  );

  const meta = shared.records.get(id(AUDIT_NAMESPACE, AUDIT_META_KEY));
  assert.equal(meta.value.lastSequence, 1);
  assert.equal(shared.records.get(id("core.test", "item")).revision, 1);
});

test("A007-02 paged reads and synchronous projections are deterministic", async () => {
  const shared = { events: [], states: new Map(), opens: 0 };
  const journal = createPcmsAuditJournal({
    backend: makeMemoryBackend(shared),
    clock: () => "2026-10-05T01:33:00Z"
  });

  await journal.append({ type: "job.started", data: { job: "a" } });
  await journal.append({ type: "job.finished", data: { job: "a" } });
  await journal.append({ type: "job.started", data: { job: "b" } });

  const firstPage = await journal.read({ afterSequence: 0, limit: 2 });
  assert.deepEqual(firstPage.events.map((event) => event.sequence), [1, 2]);
  assert.equal(firstPage.lastSequence, 3);
  assert.equal(firstPage.hasMore, true);

  const secondPage = await journal.read({ afterSequence: 2, limit: 2 });
  assert.deepEqual(secondPage.events.map((event) => event.sequence), [3]);
  assert.equal(secondPage.hasMore, false);

  const projection = await journal.project({
    initialState: { started: 0, finished: 0 },
    pageSize: 1,
    reducer(state, event) {
      if (event.type === "job.started") state.started += 1;
      if (event.type === "job.finished") state.finished += 1;
      return state;
    }
  });
  assert.equal(projection.sequence, 3);
  assert.deepEqual({ ...projection.state }, { started: 2, finished: 1 });

  await assert.rejects(
    journal.project({
      initialState: {},
      reducer: async (state) => state
    }),
    (error) => error?.code === AUDIT_ERROR_CODES.PROJECTION_FAILED
  );

  await assert.rejects(
    journal.project({
      initialState: {},
      reducer: () => new Date()
    }),
    (error) => error?.code === AUDIT_ERROR_CODES.PROJECTION_FAILED
  );
});

test("A007-03 restart replay reconstructs the same projection without using the journal as domain state", async () => {
  const shared = { events: [], states: new Map(), opens: 0 };
  const first = createPcmsAuditJournal({
    backend: makeMemoryBackend(shared),
    clock: () => "2026-10-05T01:34:00Z"
  });

  await first.append({ type: "deployment.created", data: { deploymentId: "d1" } });
  await first.append({ type: "deployment.online", data: { deploymentId: "d1" } });
  first.close();

  const second = createPcmsAuditJournal({ backend: makeMemoryBackend(shared) });
  const replay = await second.project({
    initialState: { events: [] },
    reducer(state, event) {
      state.events.push(event.type);
      return state;
    }
  });

  assert.equal(replay.sequence, 2);
  assert.deepEqual(replay.state.events, ["deployment.created", "deployment.online"]);
  assert.equal(shared.opens, 2);

  const authoritative = shared.states.get(id("core.deployments", "d1"));
  assert.equal(authoritative, undefined);
});
