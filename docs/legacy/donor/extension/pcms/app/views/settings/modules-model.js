// Settings → Modules view model (P041, design 02 §5.9). Pure functions over the P031
// modules.list/get descriptions; every lifecycle step runs live in the background Core.
import { PCMS_V2_BUILTIN_MODULE_IDS } from "../../router-v2.js";

export const PCMS_MODULE_ARCHIVE_MAX_BYTES=1024*1024;

// Plain-language capability names (pcms.module-capabilities/v1).
const CAPABILITY_TEXT=Object.freeze({
  "module.storage.read":"read its own saved data",
  "module.storage.write":"save its own data",
  "module.timers.ensure":"schedule its own background work",
  "module.timers.cancel":"cancel its own scheduled work",
  "module.timers.list":"see its own schedules",
  "module.audit.append":"write entries to the PCMS journal",
  "module.attention.open":"ask you for attention",
  "module.attention.settle":"close the attention items it opened"
});

export function describePcmsModuleCapability(capability){
  if(Object.hasOwn(CAPABILITY_TEXT,capability)) return CAPABILITY_TEXT[capability];
  return "use "+String(capability);
}

function short(hash){return typeof hash==="string"?hash.slice(0,12):"";}

const BUILTIN_TITLES=Object.freeze({
  accounts:"Accounts",deployer:"Deployer",refresher:"Refresher",explorer:"Explorer",
  statistics:"Statistics",provisioning:"Provisioning"
});

export function pcmsBuiltinModuleRows(){
  return Object.freeze(["accounts",...PCMS_V2_BUILTIN_MODULE_IDS].map((moduleId)=>Object.freeze({
    moduleId,
    title:BUILTIN_TITLES[moduleId]||moduleId,
    version:null,
    source:"Built-in",
    token:"OK",
    state:moduleId==="accounts"?"Active · required":"Active",
    detail:null,
    actions:Object.freeze([])
  })));
}

function previousPackage(module){
  const retained=Array.isArray(module.retainedPackageHashes)?module.retainedPackageHashes:[];
  return retained.find((hash)=>hash!==module.activePackageHash)||null;
}

function action(id,label,extra={}){return Object.freeze({id,label,...extra});}

// One row per installed runtime module; actions are exactly what its state allows.
export function pcmsRuntimeModuleRow(module){
  const id=module.moduleId;
  const rollbackTo=previousPackage(module);
  const candidate=module.candidate||null;
  let token="OK";
  let state;
  let detail=module.reason||null;
  const actions=[];
  switch(module.status){
    case "AWAITING_APPROVAL":
      token="WAITING_HUMAN";
      state="Waiting for approval"+(candidate?.version?" · "+candidate.version:"");
      actions.push(action("review","Review",{packageHash:candidate?.packageHash||null}));
      actions.push(action("remove","Remove…"));
      break;
    case "DISABLED":
      token="UNAVAILABLE";
      state="Disabled";
      actions.push(action("enable","Enable"));
      if(rollbackTo) actions.push(action("rollback","Roll back…",{packageHash:rollbackTo}));
      actions.push(action("remove","Remove…"));
      break;
    case "REMOVED":
      token="UNAVAILABLE";
      state="Removed · data kept for restore";
      detail="Install it again from file to reinstall, or purge it to delete its data and retained packages.";
      actions.push(action("purge","Purge…"));
      break;
    case "UNAVAILABLE":
      token="ERROR";
      state=module.failures?"Failed to start ("+module.failures+")":"Unavailable";
      actions.push(action("disable","Disable"));
      if(rollbackTo) actions.push(action("rollback","Roll back…",{packageHash:rollbackTo}));
      actions.push(action("remove","Remove…"));
      break;
    default:
      state=module.status==="ACTIVE"?"Active":"Ready · starts when needed";
      actions.push(action("disable","Disable"));
      if(rollbackTo) actions.push(action("rollback","Roll back…",{packageHash:rollbackTo}));
      actions.push(action("remove","Remove…"));
  }
  if(candidate?.state==="AWAITING_APPROVAL"&&module.status!=="AWAITING_APPROVAL"&&module.status!=="REMOVED"){
    token="WAITING_HUMAN";
    state="Update "+(candidate.version||short(candidate.packageHash))+" needs approval";
    actions.unshift(action("review","Review update",{packageHash:candidate.packageHash}));
  }
  return Object.freeze({
    moduleId:id,
    title:id,
    version:module.version||null,
    source:"Installed",
    token,
    state,
    detail,
    actions:Object.freeze(actions)
  });
}

export function pcmsModulesPageModel(listed){
  const runtime=listed?.runtime||{state:"AVAILABLE"};
  const modules=Array.isArray(listed?.modules)?listed.modules.filter((item)=>item?.installed!==false):[];
  return Object.freeze({
    runtimeAvailable:runtime.state==="AVAILABLE",
    runtimeMessage:runtime.state==="AVAILABLE"
      ?"Installing starts the module immediately — no rebuild, reload or restart."
      :"Runtime modules require Firefox 154 or later"+(runtime.message?" · "+runtime.message:""),
    rows:Object.freeze([...pcmsBuiltinModuleRows(),...modules.map(pcmsRuntimeModuleRow)])
  });
}

// Review install/update dialog: capabilities in plain language, new ones highlighted.
export function pcmsModuleReviewModel(module){
  const candidate=module?.candidate;
  if(!candidate?.packageHash) throw new TypeError("Nothing to review");
  const added=new Set(candidate.addedCapabilities||[]);
  const current=module.status==="AWAITING_APPROVAL"?[]:(module.capabilities||[]);
  const all=[...new Set([...current,...added])].sort();
  return Object.freeze({
    moduleId:module.moduleId,
    packageHash:candidate.packageHash,
    title:(module.status==="AWAITING_APPROVAL"?"Install ":"Update ")+module.moduleId+" "+(candidate.version||""),
    version:candidate.version||null,
    capabilities:Object.freeze(all.map((capability)=>Object.freeze({
      capability,
      text:describePcmsModuleCapability(capability),
      added:added.has(capability)
    })))
  });
}

export function pcmsModuleConfirmModel(kind,row,{packageHash=null}={}){
  if(kind==="remove") return Object.freeze({
    kind,title:"Remove "+row.moduleId+"?",risk:"EXTERNAL",
    lines:Object.freeze([
      "The module stops now and disappears from navigation.",
      "Its data is kept for a later restore or reinstall.",
      "Retained packages are kept so you can reinstall or roll back."
    ]),
    phrase:null,confirmLabel:"Remove"
  });
  if(kind==="purge") return Object.freeze({
    kind,title:"Purge "+row.moduleId+"?",risk:"DESTRUCTIVE",
    lines:Object.freeze([
      "The module's data and its retained packages are deleted permanently.",
      "This cannot be undone. Create a backup first if you may need them."
    ]),
    phrase:row.moduleId,confirmLabel:"Purge"
  });
  if(kind==="rollback") return Object.freeze({
    kind,title:"Roll back "+row.moduleId+"?",risk:"LOCAL",
    lines:Object.freeze([
      "The module switches live to the previously installed package "+short(packageHash)+".",
      "Its data is kept."
    ]),
    phrase:null,confirmLabel:"Roll back"
  });
  throw new TypeError("Unknown module confirmation");
}

export function pcmsTypedConfirmationMatches(model,typed){
  return model.phrase===null||typed===model.phrase;
}
