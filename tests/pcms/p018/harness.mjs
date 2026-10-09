import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createAuditEvent } from "../../../extension/pcms/audit/schema.js";

export function auditEvent(sequence, {
  timestamp = "2026-10-05T10:00:00.000Z",
  type = "test.event",
  subject = null,
  data = null
} = {}) {
  return createAuditEvent({ sequence, timestamp, draft: { type, subject, data } });
}

export function makeAuditHarness(timestamps = []) {
  const events = [];
  let clockIndex = 0;
  const backend = Object.freeze({
    async open() {},
    close() {},
    async append({ draft, timestamp }) {
      const event = createAuditEvent({ sequence: events.length + 1, timestamp, draft });
      events.push(event);
      return event;
    },
    async read({ afterSequence, limit }) {
      const remaining = events.filter((event) => event.sequence > afterSequence);
      const page = remaining.slice(0, limit);
      return {
        events: page,
        lastSequence: events.length,
        hasMore: remaining.length > page.length
      };
    }
  });
  const journal = createPcmsAuditJournal({
    backend,
    clock: () => {
      const value = timestamps[clockIndex];
      clockIndex += 1;
      if (!value) throw new Error("test clock exhausted");
      return value;
    }
  });
  return Object.freeze({
    journal,
    events,
    append: (draft) => journal.append(draft)
  });
}
