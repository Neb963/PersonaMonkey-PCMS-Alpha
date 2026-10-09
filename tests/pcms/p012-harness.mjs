import { AUDIT_ERROR_CODES } from "../../extension/pcms/audit/errors.js";
import { createPcmsAuditJournal } from "../../extension/pcms/audit/journal.js";
import { createAuditEvent } from "../../extension/pcms/audit/schema.js";

export function makeP012Harness(shared = { rows:new Map(), events:[], now:"2026-10-05T03:00:00.000Z" }) {
  const clone=(value)=>structuredClone(value);
  const rowId=(namespace,key)=>namespace+"\0"+key;
  const storageBroker={
    namespace(namespace){
      return Object.freeze({
        namespace,
        async get(key){const row=shared.rows.get(rowId(namespace,key));return row?clone(row):null;},
        async list(){return [...shared.rows.entries()].filter(([id])=>id.startsWith(namespace+"\0")).map(([,row])=>clone(row)).sort((a,b)=>a.key.localeCompare(b.key));}
      });
    }
  };
  const auditBackend={
    async open(){},close(){},
    async transitionAndAppend({transition,draft,timestamp}){
      const id=rowId(transition.namespace,transition.key);const current=shared.rows.get(id)||null;const revision=current?.revision||0;
      if(revision!==transition.expectedRevision){const error=new Error("conflict");error.code=AUDIT_ERROR_CODES.CONFLICT;error.currentRevision=revision;throw error;}
      const event=createAuditEvent({sequence:shared.events.length+1,timestamp,draft});
      const state={key:transition.key,revision:revision+1,updatedAt:timestamp,value:clone(transition.value)};
      shared.rows.set(id,clone(state));shared.events.push(clone(event));return {state:clone(state),event:clone(event)};
    }
  };
  const auditJournal=createPcmsAuditJournal({backend:auditBackend,clock:()=>shared.now});
  return {
    shared,storageBroker,auditJournal,
    clock:()=>shared.now,
    setNow(value){shared.now=new Date(value).toISOString();},
    row(namespace,key){const value=shared.rows.get(rowId(namespace,key));return value?clone(value):null;},
    put(namespace,key,row){shared.rows.set(rowId(namespace,key),clone(row));}
  };
}
