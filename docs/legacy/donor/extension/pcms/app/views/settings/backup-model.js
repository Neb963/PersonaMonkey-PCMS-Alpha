// Settings → Backup & restore view model (P041, design 02 §5.8). Pure functions only: the
// view renders these; Core enforces every rule again (preview digest, typed confirmation,
// recovery-hold release checks).
import { pcmsV2Href } from "../../router-v2.js";

export const PCMS_RESTORE_PHRASE="RESTORE";
// A backup file holds at most 10,000 records; the UI client accepts 16 MiB of params.
export const PCMS_BACKUP_FILE_MAX_BYTES=15*1024*1024;

function pad(value){return String(value).padStart(2,"0");}

function utcParts(date){
  const d=date instanceof Date?date:new Date(date);
  if(Number.isNaN(d.getTime())) throw new TypeError("Backup time is invalid");
  return {
    y:d.getUTCFullYear(),m:pad(d.getUTCMonth()+1),d:pad(d.getUTCDate()),
    h:pad(d.getUTCHours()),min:pad(d.getUTCMinutes()),s:pad(d.getUTCSeconds())
  };
}

// Auto-named; never the colliding P026 default "p026-manual-backup" (audit #33).
export function pcmsBackupFilename(date){
  const p=utcParts(date);
  return "pcms-backup-"+p.y+"-"+p.m+"-"+p.d+"-"+p.h+p.min+".json";
}

export function pcmsBackupId(date,suffix){
  const p=utcParts(date);
  const tail=typeof suffix==="string"&&/^[a-z0-9]{4,16}$/.test(suffix)?"-"+suffix:"";
  return "pcms-backup-"+p.y+p.m+p.d+"T"+p.h+p.min+p.s+"Z"+tail;
}

export function pcmsBackupFileText(backup){
  return JSON.stringify(backup,null,2)+"\n";
}

export class PcmsBackupFileError extends Error {
  constructor(message){super(message);this.name="PcmsBackupFileError";this.code="PCMS_BACKUP_FILE_INVALID";}
}

// Parses a chosen backup file. Shape and integrity are verified by Core (stageRestore).
export function parsePcmsBackupFile(text,{maxBytes=PCMS_BACKUP_FILE_MAX_BYTES}={}){
  if(typeof text!=="string"||!text.trim()) throw new PcmsBackupFileError("The chosen file is empty.");
  if(text.length>maxBytes) throw new PcmsBackupFileError("The chosen file is too large to be a PCMS backup.");
  let value;
  try{value=JSON.parse(text);}
  catch{throw new PcmsBackupFileError("The chosen file is not a PCMS backup (it is not JSON).");}
  if(!value||typeof value!=="object"||Array.isArray(value)||value.kind!=="pcms-backup") {
    throw new PcmsBackupFileError("The chosen file is not a PCMS backup.");
  }
  return value;
}

function plural(count,word){return count+" "+word+(count===1?"":"s");}

const NAMESPACE_LABELS=Object.freeze({
  "app.accounts":"accounts",
  "core.modules":"modules",
  "core.remoteops":"operations",
  "core.human-tasks":"attention items",
  "core.audit":"journal entries",
  "core.timers":"schedules"
});

export function presentPcmsRestorePreview(preview,{locale}={}){
  if(!preview||preview.kind!=="pcms-restore-preview") throw new TypeError("Restore preview is invalid");
  let created=preview.createdAt;
  try{created=new Date(preview.createdAt).toLocaleString(locale||undefined,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"})+" UTC";}catch{}
  const groups=preview.namespaces
    .filter((row)=>Object.hasOwn(NAMESPACE_LABELS,row.namespace))
    .map((row)=>NAMESPACE_LABELS[row.namespace]+" "+row.backup+(row.backup===row.current?"":" (now "+row.current+")"));
  const d=preview.differences;
  return Object.freeze({
    summary:"Created "+created+" · "+plural(preview.recordCount,"record")+" · backup "+preview.backupId,
    groups:Object.freeze(groups),
    differences:"Differences from now: "+d.added+" added back, "+d.changed+" changed, "+d.removed+" removed, "+d.unchanged+" unchanged",
    modules:preview.modules.inBackup.length
      ?"Runtime modules in backup: "+preview.modules.inBackup.join(", ")
        +(preview.modules.onlyNow.length?" · installed now but not in backup: "+preview.modules.onlyNow.join(", "):"")
      :preview.modules.onlyNow.length?"Installed now but not in backup: "+preview.modules.onlyNow.join(", "):"No runtime modules in backup",
    effects:Object.freeze([...preview.effects]),
    phrase:preview.confirmationPhrase||PCMS_RESTORE_PHRASE
  });
}

// The Restore button is enabled only for a staged preview and the exact typed phrase.
export function pcmsRestoreGate({stage,typed,busy=false}={}){
  if(busy) return Object.freeze({enabled:false,reason:"Working…"});
  if(!stage?.preview?.previewDigest) return Object.freeze({enabled:false,reason:"Choose a backup file to preview it first."});
  if(typed!==PCMS_RESTORE_PHRASE) return Object.freeze({enabled:false,reason:"Type "+PCMS_RESTORE_PHRASE+" to continue."});
  return Object.freeze({enabled:true,reason:null});
}

// The applicable restore: the staged preview plus the operator's typed phrase naming that
// exact preview. Core recomputes the digest from the backup and decides (A041-01).
export function pcmsConfirmedRestore(stage,typed){
  if(!pcmsRestoreGate({stage,typed}).enabled) throw Object.assign(new Error("Type "+PCMS_RESTORE_PHRASE+" after reviewing the preview."),{code:"PCMS_BACKUP_CONFIRMATION_REQUIRED"});
  return Object.freeze({
    schemaVersion:stage.schemaVersion,
    kind:stage.kind,
    stagedAt:stage.stagedAt,
    backup:stage.backup,
    preview:stage.preview,
    confirmation:Object.freeze({phrase:typed,previewDigest:stage.preview.previewDigest})
  });
}

// Every checklist row links to its subject (A041-02).
export function pcmsChecklistSubjectHref(subject){
  const kind=subject?.kind;
  const id=typeof subject?.id==="string"&&subject.id?subject.id:null;
  try{
    if(kind==="account") return id?pcmsV2Href("accounts",{id}):pcmsV2Href("accounts");
    if(kind==="accounts") return pcmsV2Href("accounts");
    if(kind==="module"&&id) return pcmsV2Href("module",{moduleId:id});
    if(kind==="settings"&&id) return pcmsV2Href("settings",{section:id});
    if(kind==="attention") return id?pcmsV2Href("attention",{id}):pcmsV2Href("attention");
    if(id) return pcmsV2Href("search",{query:id});
  }catch{}
  return pcmsV2Href("attention");
}

const STATUS=Object.freeze({PASS:"✓",FAIL:"?"});

export function presentPcmsRecoveryChecklist(checklist){
  const held=checklist?.hold?.state==="RECOVERY_HOLD";
  const items=Array.isArray(checklist?.items)?checklist.items:[];
  const rows=items.map((item)=>Object.freeze({
    id:item.id,
    kind:item.kind,
    status:item.status==="PASS"?"PASS":"FAIL",
    mark:STATUS[item.status==="PASS"?"PASS":"FAIL"],
    label:item.label,
    detail:item.detail||null,
    href:pcmsChecklistSubjectHref(item.subject),
    operationId:item.kind==="operation"&&item.reconcilable===true?item.operationId:null
  }));
  const failing=rows.filter((row)=>row.status!=="PASS").length;
  return Object.freeze({
    held,
    status:held
      ?"On hold after a restore — "+(failing?plural(failing,"check")+" must pass before changes can resume":"all checks pass")
      :"Normal — changes are allowed",
    rows:Object.freeze(held?rows:[]),
    failing,
    // Resume is enabled only when Core says the hold is releasable and every row passes.
    canResume:held&&checklist?.releasable===true&&failing===0
  });
}
