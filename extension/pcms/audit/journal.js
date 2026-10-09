import { AUDIT_ERROR_CODES, PcmsAuditError, auditError } from "./errors.js";
import { createIndexedDbAuditBackend } from "./indexeddb-journal.js";
import {
  cloneAuditValue,
  normalizeAuditDraft,
  normalizeAuditTimestamp,
  normalizeReadRequest,
  normalizeTransition
} from "./schema.js";

function asProjectionError(error) {
  if (error instanceof PcmsAuditError && error.code === AUDIT_ERROR_CODES.PROJECTION_FAILED) return error;
  return auditError(AUDIT_ERROR_CODES.PROJECTION_FAILED, "Audit projection failed", { cause: error });
}

function publicStateRecord(record) {
  return Object.freeze({
    key: record.key,
    revision: record.revision,
    updatedAt: record.updatedAt,
    value: cloneAuditValue(record.value)
  });
}

function publicEvent(event) {
  return Object.freeze({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    subject: event.subject ? Object.freeze({ ...event.subject }) : null,
    data: cloneAuditValue(event.data)
  });
}

export function createPcmsAuditJournal({
  backend = createIndexedDbAuditBackend(),
  clock = () => new Date().toISOString()
} = {}) {
  let open = false;

  async function ensureOpen() {
    if (!open) {
      await backend.open();
      open = true;
    }
  }

  async function append(rawDraft) {
    const draft = normalizeAuditDraft(rawDraft);
    const timestamp = normalizeAuditTimestamp(clock());
    await ensureOpen();
    return publicEvent(await backend.append({ draft, timestamp }));
  }

  async function transitionAndAppend(rawTransition, rawDraft) {
    const transition = normalizeTransition(rawTransition);
    const draft = normalizeAuditDraft(rawDraft);
    const timestamp = normalizeAuditTimestamp(clock());
    await ensureOpen();
    const result = await backend.transitionAndAppend({ transition, draft, timestamp });
    return Object.freeze({
      state: publicStateRecord(result.state),
      event: publicEvent(result.event)
    });
  }

  async function read(rawRequest = {}) {
    const request = normalizeReadRequest(rawRequest);
    await ensureOpen();
    const page = await backend.read(request);
    return Object.freeze({
      events: Object.freeze(page.events.map(publicEvent)),
      lastSequence: page.lastSequence,
      hasMore: page.hasMore
    });
  }

  async function project({
    reducer,
    initialState = null,
    afterSequence = 0,
    pageSize = 100
  } = {}) {
    if (typeof reducer !== "function") {
      throw auditError(AUDIT_ERROR_CODES.PROJECTION_FAILED, "Audit projection reducer is required");
    }
    const request = normalizeReadRequest({ afterSequence, limit: pageSize });
    let cursor = request.afterSequence;
    let state;
    try {
      state = cloneAuditValue(initialState);
    } catch (error) {
      throw asProjectionError(error);
    }

    while (true) {
      const page = await read({ afterSequence: cursor, limit: request.limit });
      for (const event of page.events) {
        try {
          const next = reducer(cloneAuditValue(state), event);
          if (next && typeof next.then === "function") {
            throw auditError(AUDIT_ERROR_CODES.PROJECTION_FAILED, "Audit projection reducer must be synchronous");
          }
          state = cloneAuditValue(next);
          cursor = event.sequence;
        } catch (error) {
          throw asProjectionError(error);
        }
      }
      if (!page.hasMore) {
        return Object.freeze({ sequence: cursor, state: cloneAuditValue(state) });
      }
      if (page.events.length === 0) {
        throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit projection cannot advance its cursor");
      }
    }
  }

  return Object.freeze({
    async open() { await ensureOpen(); },
    close() {
      backend.close();
      open = false;
    },
    append,
    transitionAndAppend,
    read,
    project
  });
}
