// Dashboard view models over the Core-merged pcms.ui-contribution/v1 snapshot (P033).
// Pure functions: the dashboard renders their output with textContent only. Core already
// validated every module value; these functions decide only where it appears.
import { PCMS_V2_BUILTIN_MODULE_IDS, parsePcmsRouteV2 } from "./router-v2.js";

const PRIORITY=Object.freeze({CRITICAL:0,HIGH:1,NORMAL:2,LOW:3});

export function emptyPcmsContributionSnapshot(){
  return Object.freeze({contractVersion:1,recovery:"NORMAL",modules:Object.freeze([]),unavailable:true});
}

export function contributionModules(snapshot){
  return Array.isArray(snapshot?.modules)?snapshot.modules:[];
}

export function findContribution(snapshot,moduleId){
  return contributionModules(snapshot).find((item)=>item.moduleId===moduleId)||null;
}

// Built-in modules still rendered by the inherited P026 module cards (until each one
// contributes through the contract, as Statistics does from P033).
export function legacyModuleIds(snapshot){
  const contributed=new Set(contributionModules(snapshot).filter((item)=>item.kind==="builtin").map((item)=>item.moduleId));
  return PCMS_V2_BUILTIN_MODULE_IDS.filter((id)=>!contributed.has(id));
}

// Every module id a deep link may address: legacy built-ins plus every module Core knows,
// including disabled or removed ones (their page explains the state instead of vanishing).
// A syntactically valid #/m/<id> link always resolves, so a purged or never-installed
// module explains itself ("This module isn't installed") instead of redirecting.
export function routableModuleIds(snapshot,rawHash=null){
  const ids=new Set([...PCMS_V2_BUILTIN_MODULE_IDS,...contributionModules(snapshot).map((item)=>item.moduleId)]);
  if(typeof rawHash==="string"){
    try{
      const route=parsePcmsRouteV2(rawHash);
      if(route.route==="module") ids.add(route.moduleId);
    }catch{}
  }
  return [...ids];
}

export function contributionNavItems(snapshot){
  return contributionModules(snapshot)
    .filter((item)=>item.nav)
    .map((item)=>Object.freeze({
      id:"module-"+item.moduleId,
      moduleId:item.moduleId,
      label:item.nav.label,
      href:item.nav.href,
      order:item.nav.order,
      dot:item.nav.dot,
      greyed:item.nav.greyed===true
    }))
    .sort((a,b)=>a.order-b.order||a.label.localeCompare(b.label));
}

export function overviewModuleCards(snapshot){
  return contributionModules(snapshot)
    .filter((item)=>item.nav)
    .map((item)=>Object.freeze({
      moduleId:item.moduleId,
      title:item.title,
      href:item.summary?.href||item.nav.href,
      status:item.summary?.status||{token:item.presentation.token,label:item.presentation.label},
      headline:item.summary?.headline||(item.summaryError?item.title+" information unavailable":item.presentation.pageMessage||item.presentation.label),
      facts:item.summary?.facts||[],
      banner:item.presentation.banner,
      greyed:item.nav.greyed===true,
      unavailable:Boolean(item.summaryError)
    }));
}

// Derived Attention (03 §4.6): recomputed on every refresh, never stored as HumanTasks.
export function derivedAttention(snapshot){
  return contributionModules(snapshot)
    .flatMap((item)=>item.conditions.map((condition)=>Object.freeze({...condition,moduleTitle:item.title})))
    .sort((a,b)=>PRIORITY[a.priority]-PRIORITY[b.priority]||a.title.localeCompare(b.title)||a.key.localeCompare(b.key));
}

export function mergeSearchResults(base,hits){
  const merged=[...(Array.isArray(base)?base:[])];
  for(const hit of Array.isArray(hits)?hits:[]){
    merged.push(Object.freeze({
      kind:"module",
      id:hit.moduleId+":"+hit.entity.kind+":"+hit.entity.id,
      title:hit.title,
      subtitle:hit.moduleTitle+(hit.subtitle?" · "+hit.subtitle:""),
      href:hit.href,
      score:hit.score
    }));
  }
  return merged.slice(0,50);
}

// HumanTasks stay Core records; a disabled module's tasks remain listed with a note and no
// actionable buttons (03 §6).
export function humanTaskModuleState(task,snapshot){
  if(task?.subjectRef?.kind!=="module") return null;
  const module=findContribution(snapshot,task.subjectRef.id);
  if(!module) return null;
  const state=module.presentation.state;
  if(state==="DISABLED"||state==="REMOVED"){
    return Object.freeze({blocked:true,note:module.title+" is "+(state==="DISABLED"?"disabled":"removed")+" — enable it to act"});
  }
  return Object.freeze({blocked:false,note:null});
}

export function modulePageModel(snapshot,route){
  const module=findContribution(snapshot,route.moduleId);
  if(!module){
    return Object.freeze({kind:"missing",moduleId:route.moduleId,title:route.moduleId,message:"This module isn't installed",banner:null});
  }
  const state=module.presentation;
  if(!state.included){
    return Object.freeze({kind:"state",moduleId:module.moduleId,title:module.title,state:state.state,token:state.token,label:state.label,
      message:state.pageMessage||state.label,banner:state.banner});
  }
  const views=module.page?.views||[];
  let view=null;
  if(route.view!==null){
    view=views.find((item)=>item.id===route.view)||null;
  } else {
    view=views.find((item)=>item.type==="list")||null;
  }
  return Object.freeze({
    kind:module.hasFrame&&route.view===null?"frame":"page",
    moduleId:module.moduleId,
    title:module.title,
    description:module.description,
    state:state.state,
    token:state.token,
    label:state.label,
    banner:state.banner,
    summary:module.summary,
    summaryError:module.summaryError,
    actions:module.actions.filter((action)=>action.appliesTo==="module"),
    allActions:module.actions,
    // P040: every list view is reachable from the page (tabs), not only the first one.
    listViews:Object.freeze(views.filter((item)=>item.type==="list").map((item)=>Object.freeze({id:item.id,title:item.title}))),
    settings:module.settings,
    view,
    objectId:route.objectId,
    missingView:route.view!==null&&view===null
  });
}

// When the module page must be rendered again. A running frame is kept across revision
// refreshes; state pages (disabled, removed, missing, …) carry no actions.
export function modulePageRenderKey(route,model,module){
  return [route.href,model.kind,model.state||"",module?.version??"",
    model.kind==="frame"?"":JSON.stringify([model.summary??null,model.banner??null,model.message??null,(model.actions||[]).map((action)=>action.held)])].join("|");
}

export function settingsModuleRows(snapshot){
  return contributionModules(snapshot).map((item)=>Object.freeze({
    moduleId:item.moduleId,
    title:item.title,
    kind:item.kind,
    version:item.version,
    token:item.presentation.token,
    label:item.presentation.label,
    message:item.presentation.pageMessage||item.presentation.banner||null,
    errorCode:item.errorCode||null
  }));
}
