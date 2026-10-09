import { AUDIT_ERROR_CODES } from "../audit/errors.js";
import { CORE_SERVICE_ERROR_CODES, coreServiceError } from "./errors.js";

export const HUMAN_TASK_NAMESPACE = "core.human-tasks";
export const HUMAN_TASK_SCHEMA_VERSION = 1;
export const HUMAN_TASK_STATES = Object.freeze({ OPEN:"OPEN", RESOLVED:"RESOLVED", CANCELLED:"CANCELLED" });
export const HUMAN_TASK_PRIORITIES = Object.freeze({ LOW:"LOW", NORMAL:"NORMAL", HIGH:"HIGH", CRITICAL:"CRITICAL" });

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const RESOLUTION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const STATE_SET = new Set(Object.values(HUMAN_TASK_STATES));
const PRIORITY_ORDER = Object.freeze({ CRITICAL:0, HIGH:1, NORMAL:2, LOW:3 });

function fail(code, options = {}) { throw coreServiceError(code, options); }
function assertText(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length < 1) || value.includes("\u0000")) {
    fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  }
  return value;
}
function assertTaskId(value) {
  if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  return value;
}
function assertKind(value) {
  if (typeof value !== "string" || value.length > 96 || !KIND_PATTERN.test(value)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  return value;
}
function assertRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT);
  return value;
}
function normalizeSubjectRef(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value,"kind") || !Object.hasOwn(value,"id")) {
    fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  }
  return Object.freeze({ kind:assertText(value.kind,64), id:assertText(value.id,256) });
}
function normalizeValue(value, taskId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  const expected=["schemaVersion","kind","taskId","taskKind","title","instructions","priority","subjectRef","state","resolutionCode","createdAt","completedAt"];
  const keys=Object.keys(value);
  if (keys.length!==expected.length || !expected.every(k=>Object.hasOwn(value,k))
      || value.schemaVersion!==HUMAN_TASK_SCHEMA_VERSION || value.kind!=="human-task" || value.taskId!==taskId
      || !STATE_SET.has(value.state) || !Object.hasOwn(PRIORITY_ORDER,value.priority)) fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  try {
    assertTaskId(value.taskId); assertKind(value.taskKind); assertText(value.title,160); assertText(value.instructions,2000,{allowEmpty:true});
    normalizeSubjectRef(value.subjectRef);
    if (!Number.isFinite(Date.parse(value.createdAt))) throw new Error();
    if (value.completedAt !== null && !Number.isFinite(Date.parse(value.completedAt))) throw new Error();
    if (value.resolutionCode !== null && (typeof value.resolutionCode !== "string" || !RESOLUTION_PATTERN.test(value.resolutionCode))) throw new Error();
  } catch { fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE); }
  if (value.state === HUMAN_TASK_STATES.OPEN && (value.completedAt !== null || value.resolutionCode !== null)) fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  if (value.state !== HUMAN_TASK_STATES.OPEN && value.completedAt === null) fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({ ...value, subjectRef:value.subjectRef ? Object.freeze({ ...value.subjectRef }) : null });
}
function publicRecord(record, taskId) {
  if (!record) return null;
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({ key:record.key, revision:record.revision, updatedAt:record.updatedAt, value:normalizeValue(record.value,taskId) });
}

export function createHumanTaskService({ storageBroker, auditJournal, clock = () => new Date().toISOString() } = {}) {
  if (!storageBroker || typeof storageBroker.namespace !== "function") throw new TypeError("HumanTask service requires the PCMS storage broker");
  if (!auditJournal || typeof auditJournal.transitionAndAppend !== "function") throw new TypeError("HumanTask service requires the PCMS audit journal");
  if (typeof clock !== "function") throw new TypeError("HumanTask service clock is invalid");
  const store=storageBroker.namespace(HUMAN_TASK_NAMESPACE);

  async function get(taskId) { const id=assertTaskId(taskId); return publicRecord(await store.get(id),id); }

  async function write(taskId, expectedRevision, value, eventType, eventData) {
    try {
      const result=await auditJournal.transitionAndAppend(
        { namespace:HUMAN_TASK_NAMESPACE, key:taskId, expectedRevision, value },
        { type:eventType, subject:{kind:"human-task",id:taskId}, data:eventData }
      );
      return publicRecord(result.state,taskId);
    } catch (error) {
      if (error?.code===AUDIT_ERROR_CODES.CONFLICT) fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:error.currentRevision});
      throw error;
    }
  }

  async function open({ taskId, taskKind, title, instructions = "", priority = HUMAN_TASK_PRIORITIES.NORMAL, subjectRef = null } = {}) {
    const id=assertTaskId(taskId); const kind=assertKind(taskKind); const safeTitle=assertText(title,160); const safeInstructions=assertText(instructions,2000,{allowEmpty:true});
    if (!Object.hasOwn(PRIORITY_ORDER,priority)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
    const subject=normalizeSubjectRef(subjectRef); const existing=await get(id);
    if (existing) fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:existing.revision});
    const createdAt=new Date(clock()).toISOString();
    return write(id,0,{schemaVersion:1,kind:"human-task",taskId:id,taskKind:kind,title:safeTitle,instructions:safeInstructions,priority,subjectRef:subject,state:HUMAN_TASK_STATES.OPEN,resolutionCode:null,createdAt,completedAt:null},"human-task.opened",{taskKind:kind,priority});
  }

  async function finish(taskId,{expectedRevision,resolutionCode,state}) {
    const id=assertTaskId(taskId); const expected=assertRevision(expectedRevision); const current=await get(id);
    if(!current) fail(CORE_SERVICE_ERROR_CODES.NOT_FOUND);
    if(current.revision!==expected) fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.state!==HUMAN_TASK_STATES.OPEN) fail(CORE_SERVICE_ERROR_CODES.INVALID_TRANSITION);
    const code=resolutionCode===null?null:(typeof resolutionCode==="string"&&RESOLUTION_PATTERN.test(resolutionCode)?resolutionCode:fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT));
    const completedAt=new Date(clock()).toISOString();
    return write(id,current.revision,{...current.value,state,resolutionCode:code,completedAt},state===HUMAN_TASK_STATES.RESOLVED?"human-task.resolved":"human-task.cancelled",{resolutionCode:code});
  }

  function resolve(taskId,{expectedRevision,resolutionCode="completed"}={}) { return finish(taskId,{expectedRevision,resolutionCode,state:HUMAN_TASK_STATES.RESOLVED}); }
  function cancel(taskId,{expectedRevision,resolutionCode="cancelled"}={}) { return finish(taskId,{expectedRevision,resolutionCode,state:HUMAN_TASK_STATES.CANCELLED}); }

  async function listAttention({ limit = 100 } = {}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>500) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
    const rows=await store.list(); const out=[];
    for(const row of rows){
      const task=publicRecord(row,row.key); if(task.value.state===HUMAN_TASK_STATES.OPEN) out.push(task);
    }
    out.sort((a,b)=>PRIORITY_ORDER[a.value.priority]-PRIORITY_ORDER[b.value.priority]
      || a.value.createdAt.localeCompare(b.value.createdAt) || a.value.taskId.localeCompare(b.value.taskId));
    return Object.freeze(out.slice(0,limit));
  }

  return Object.freeze({ open, get, resolve, cancel, listAttention });
}
