// pcms.ui-client/v1 — the only way extension pages talk to the background PCMS Core (ADR-002 §8).
// Pure data and validation; shared by the background dispatcher and the dashboard client.

export const PCMS_UI_CLIENT_CONTRACT="pcms.ui-client/v1";
export const PCMS_UI_REQUEST_TYPE="PCMS_UI_REQUEST";
export const PCMS_UI_RESPONSE_TYPE="PCMS_UI_RESPONSE";
export const PCMS_UI_PROTOCOL_VERSION=1;

// storage.session keys (ADR-002 §4).
export const PCMS_CORE_SESSION_KEY="pcms.core.session";
export const PCMS_UI_REVISION_KEY="pcms.ui.revision";
export const PCMS_STATUS_KEY="pcms.status.v1";

export const PCMS_UI_TOPICS=Object.freeze(["core","attention","accounts","modules","recovery"]);
export const PCMS_UI_MAX_RECEIPT_LIST=20; // Bounded, secret-safe dashboard projections

export const PCMS_UI_ERROR_CODES=Object.freeze({
  INVALID_REQUEST:"PCMS_UI_INVALID_REQUEST",
  SENDER_REJECTED:"PCMS_UI_SENDER_REJECTED",
  UNKNOWN_OPERATION:"PCMS_UI_UNKNOWN_OPERATION",
  CORE_UNAVAILABLE:"PCMS_CORE_UNAVAILABLE",
  IDEMPOTENCY_CONFLICT:"PCMS_UI_IDEMPOTENCY_CONFLICT",
  OUTCOME_UNKNOWN:"PCMS_UI_COMMAND_OUTCOME_UNKNOWN",
  RESULT_NOT_RETAINED:"PCMS_UI_RESULT_NOT_RETAINED",
  FAILED:"PCMS_UI_OPERATION_FAILED"
});

function query(arity){return Object.freeze({kind:"query",arity,topics:Object.freeze([]),retainResult:true});}
function command(arity,topics,{retainResult=true}={}){
  return Object.freeze({kind:"command",arity,topics:Object.freeze([...topics]),retainResult});
}

// Each name is `<service>.<method>` on the background Core, mirroring the methods the
// accepted P021/P026 views call. Arity bounds the positional argument list; the Core
// services validate the values themselves.
export const PCMS_UI_OPERATIONS=Object.freeze({
  "core.status":query(0),
  "uiReceipts.list":query(0), // Read-only Core-owned receipt summaries
  "broker.request":query(1),
  "uiProjection.snapshot":query(1),

  "accounts.listAccounts":query(0),
  "accounts.getAccount":query(1),
  "accounts.createAccount":command(2,["accounts","attention"]),
  "accounts.rebindPersona":command(2,["accounts","attention"]),

  "explorer.listCandidates":query(0),
  "explorer.listReservations":query(0),
  "explorer.recordDiscovery":command(2,["modules"]),
  "explorer.claimCandidate":command(3,["modules"]),

  "deployer.listDeployments":query(0),
  "deployer.listDeploymentViews":query(0),
  "deployer.getDeployment":query(1),
  "deployer.createDeployment":command(2,["modules"]),
  "deployer.setDesired":command(2,["modules"]),
  "deployer.prepareRetry":command(2,["modules"]),
  "deployer.deploy":command(2,["modules","attention","recovery"]),
  "deployer.reconcileDeployment":command(2,["modules","attention","recovery"]),
  "deployer.setPaused":command(2,["modules"]),
  // P039 content comparisons are read-only, ephemeral queries: never receipt results.
  "observations.get":query(1),
  "observations.compare":query(1),
  "observations.verifyNow":command(1,["modules","attention"]),
  "observations.keep":command(2,["modules"]),
  "observations.overwrite":command(2,["modules","attention","recovery"]),
  "observations.configure":command(1,["modules"]),

  // P036 pcms.generator-index/v1: the rebuildable Core view behind the Generators pages.
  "generators.list":query(1),
  "generators.get":query(1),
  "generators.search":query(2),

  "refresher.listCohorts":query(0),
  "refresher.listCohortViews":query(0),
  "refresher.createCohort":command(2,["modules"]),
  "refresher.setMemberSourceHash":command(3,["modules"]),
  "refresher.prepareRefresh":command(3,["modules"]),
  "refresher.dispatchRefresh":command(3,["modules","attention","recovery"]),
  "refresher.reconcileRefresh":command(3,["modules","attention","recovery"]),

  "statistics.snapshot":query(0),

  "provisioning.listAttempts":query(0),
  "provisioning.getAttempt":query(1),
  "provisioning.createAttempt":command(2,["modules","attention"]),
  "provisioning.acquireSession":command(2,["modules","attention"]),
  "provisioning.reconcileAttempt":command(2,["modules","attention","recovery"]),
  "provisioning.advance":command(2,["modules","attention","recovery"]),

  "humanTasks.get":query(1),
  "humanTasks.listAttention":query(1),
  "humanTasks.resolve":command(2,["attention","modules"]),

  "providerHandoff.describe":query(1),
  "providerHandoff.answer":command(2,["attention","modules","recovery"]),

  // P031 runtime-module lifecycle, executed live by the background module supervisor.
  // Install/update take the canonical pcms.module.archive/v1 text (at most 1 MiB).
  "modules.list":query(0),
  "modules.get":query(1),
  "modules.install":command(1,["modules","attention"]),
  "modules.approve":command(2,["modules","attention"]),
  "modules.reject":command(2,["modules","attention"]),
  "modules.disable":command(1,["modules"]),
  "modules.enable":command(1,["modules","attention"]),
  "modules.rollback":command(2,["modules","attention"]),
  "modules.remove":command(1,["modules","attention"]),
  "modules.purge":command(1,["modules"]),
  "modules.call":command(3,["modules","attention"]),

  // P033 pcms.ui-contribution/v1 merge points, served by the background contribution host.
  // Reads never wake a runtime module except for on-demand pulls (facets, rows, details).
  "ui.snapshot":query(0),
  "ui.search":query(2),
  "ui.facets":query(1),
  "ui.listRows":query(3),
  "ui.getDetail":query(3),
  "ui.preview":query(4),
  "ui.frame":query(1),
  "ui.activity":query(1),
  "ui.getSettings":query(1),
  "ui.invoke":command(5,["modules","attention","recovery"]),
  "ui.setSetting":command(3,["modules"]),

  "recoveryHold.getStatus":query(0),
  "remoteOps.listUnresolved":query(0),

  "backupRestore.stageRestore":query(1),
  "backupRestore.createBackup":command(1,["recovery"],{retainResult:false}),
  "backupRestore.applyStagedRestore":command(1,PCMS_UI_TOPICS),
  "backupRestore.reconcileAndRelease":command(0,["recovery","modules"]),
  // P041 Settings → Backup & restore: the recovery checklist and per-item reconciliation.
  // stageRestore returns the preview; applyStagedRestore needs its typed confirmation.
  "backupRestore.recoveryChecklist":query(0),
  "backupRestore.reconcileOperation":command(1,["recovery","attention","modules"])
});

// Read-only Persona Broker commands a dashboard may proxy through Core.
export const PCMS_UI_BROKER_READ_COMMANDS=Object.freeze(["persona.list","system.status"]);

const REQUEST_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const PCMS_UI_MAX_PARAMS_BYTES=16*1024*1024;
const MAX_DEPTH=40;

export class PcmsUiProtocolError extends Error {
  constructor(code,message){
    super(message||code);
    this.name="PcmsUiProtocolError";
    this.code=code;
  }
}

function fail(message){throw new PcmsUiProtocolError(PCMS_UI_ERROR_CODES.INVALID_REQUEST,message);}

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function assertJsonData(value,depth=0){
  if(depth>MAX_DEPTH) fail("PCMS UI request params are too deep");
  if(value===null||typeof value==="string"||typeof value==="boolean") return;
  if(typeof value==="number"){if(!Number.isFinite(value)) fail("PCMS UI request params must be finite"); return;}
  if(Array.isArray(value)){for(const item of value) assertJsonData(item,depth+1); return;}
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) fail("PCMS UI request params must be plain data");
  for(const [key,item] of Object.entries(value)){
    if(key==="__proto__"||key==="constructor"||key==="prototype") fail("PCMS UI request params contain an unsafe key");
    assertJsonData(item,depth+1);
  }
}

function exactKeys(value,required,optional=[]){
  const keys=Object.keys(value);
  for(const key of required) if(!Object.hasOwn(value,key)) fail("PCMS UI request is missing "+key);
  for(const key of keys) if(!required.includes(key)&&!optional.includes(key)) fail("PCMS UI request has unexpected key "+key);
}

export function getPcmsUiOperation(name){
  return typeof name==="string"&&Object.hasOwn(PCMS_UI_OPERATIONS,name)?PCMS_UI_OPERATIONS[name]:null;
}

export function validatePcmsUiRequest(message){
  if(!plain(message)) fail("PCMS UI request must be an object");
  exactKeys(message,["type","version","requestId","kind","name","params"],["idempotencyKey"]);
  if(message.type!==PCMS_UI_REQUEST_TYPE) fail("PCMS UI request type is invalid");
  if(message.version!==PCMS_UI_PROTOCOL_VERSION) fail("PCMS UI request version is unsupported");
  if(typeof message.requestId!=="string"||!REQUEST_ID_PATTERN.test(message.requestId)) fail("PCMS UI requestId is invalid");
  if(message.kind!=="query"&&message.kind!=="command") fail("PCMS UI request kind is invalid");
  const operation=getPcmsUiOperation(message.name);
  if(!operation) throw new PcmsUiProtocolError(PCMS_UI_ERROR_CODES.UNKNOWN_OPERATION,"PCMS UI operation is unknown");
  if(operation.kind!==message.kind) fail("PCMS UI request kind does not match the operation");
  if(message.kind==="command"){
    if(typeof message.idempotencyKey!=="string"||!IDEMPOTENCY_KEY_PATTERN.test(message.idempotencyKey)) fail("PCMS UI command idempotencyKey is invalid");
  } else if(Object.hasOwn(message,"idempotencyKey")) {
    fail("PCMS UI queries do not take an idempotencyKey");
  }
  if(!plain(message.params)) fail("PCMS UI request params must be an object");
  exactKeys(message.params,["args"]);
  const args=message.params.args;
  if(!Array.isArray(args)||args.length>operation.arity) fail("PCMS UI request args are invalid");
  assertJsonData(args);
  let size;
  try{size=JSON.stringify(args).length;}catch{fail("PCMS UI request params are not serializable");}
  if(size>PCMS_UI_MAX_PARAMS_BYTES) fail("PCMS UI request params are too large");
  if(message.name==="broker.request"){
    const envelope=args[0];
    if(!plain(envelope)||!PCMS_UI_BROKER_READ_COMMANDS.includes(envelope.command)) fail("Only read-only Persona Broker commands may be proxied");
    if(Object.hasOwn(envelope,"operationId")||Object.hasOwn(envelope,"precondition")) fail("Proxied Persona Broker reads take no operation");
  }
  return Object.freeze({
    requestId:message.requestId,
    kind:message.kind,
    name:message.name,
    args:Object.freeze([...args]),
    idempotencyKey:message.kind==="command"?message.idempotencyKey:null,
    operation
  });
}

// Same rule as PersonaMonkey's isPcmsExtensionPageSender: this extension, an extension page, under /pcms/.
export function isPcmsUiSender(sender,{runtimeId,extensionBaseUrl}={}){
  if(typeof runtimeId!=="string"||!runtimeId||typeof extensionBaseUrl!=="string"||!extensionBaseUrl) return false;
  if(!sender||sender.id!==runtimeId) return false;
  const url=String(sender.url||"");
  if(!url.startsWith(extensionBaseUrl)) return false;
  try{return new URL(url).pathname.startsWith("/pcms/");}
  catch{return false;}
}

export function serializePcmsUiError(error){
  const code=typeof error?.code==="string"&&error.code.length<=96?error.code:PCMS_UI_ERROR_CODES.FAILED;
  const message=typeof error?.message==="string"?error.message.slice(0,512):"PCMS operation failed";
  const out={code,message};
  if(Number.isSafeInteger(error?.currentRevision)) out.currentRevision=error.currentRevision;
  return Object.freeze(out);
}
