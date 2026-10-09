// Background contribution host for pcms.ui-contribution/v1 (03 §2–§6). Dashboards are UI
// clients (ADR-002): they read the merged result through pcms.ui-client/v1 `ui.*` operations
// and never call a module directly.
//
// Built-in modules contribute in process through their `createUiContribution` descriptor.
// Runtime modules push their descriptor, summary, conditions and search entries with the
// `core.ui.publish` capability; Core validates and stores the latest publish durably, keyed
// to the package that published it, and serves it while the module is not activated
// (ADR-003 §3). Facets, list rows, details and actions are pulled on demand through the
// module supervisor, which activates the module lazily.
//
// Every presentation state of 03 §6 is computed here from the P022 lifecycle, the P031
// supervisor projection and contract validation, so one broken module never breaks a page.
import {
  PCMS_UI_CONFIRM_RISKS,
  PCMS_UI_CONTRIBUTION_ERROR_CODES,
  PCMS_UI_CONTRIBUTION_VERSION,
  PCMS_UI_DOT_TOKENS,
  PCMS_UI_FACET_KINDS,
  PCMS_UI_HOLD_BLOCKED_RISKS,
  PCMS_UI_LIMITS,
  PcmsUiContributionError,
  coercePcmsUiFieldValue,
  normalizePcmsUiActivityLine,
  normalizePcmsUiConditions,
  normalizePcmsUiDescriptor,
  normalizePcmsUiDetail,
  normalizePcmsUiDiagnostics,
  normalizePcmsUiEntityRef,
  normalizePcmsUiFacet,
  normalizePcmsUiInput,
  normalizePcmsUiListPage,
  normalizePcmsUiModuleId,
  normalizePcmsUiPublish,
  normalizePcmsUiReceipt,
  normalizePcmsUiSearchHits,
  normalizePcmsUiSummary,
  pcmsUiEntityHref
} from "./ui-contribution-contract.js";

export const PCMS_UI_CONTRIBUTION_NAMESPACE="core.ui-contributions";
export const PCMS_UI_PUBLISH_CAPABILITY="core.ui.publish";
export const PCMS_UI_FACET_TIMEOUT_MS=1500;
export const PCMS_UI_CALL_TIMEOUT_MS=10000;

// Presentation states (03 §6). `included` means summary/search/conditions/facets are merged.
export const PCMS_UI_PRESENTATION=Object.freeze({
  ACTIVE:"ACTIVE",
  UPDATE_AWAITS_APPROVAL:"UPDATE_AWAITS_APPROVAL",
  UPDATING:"UPDATING",
  FAILED:"FAILED",
  INSTALLING:"INSTALLING",
  DISABLED:"DISABLED",
  REMOVED:"REMOVED",
  NOT_INSTALLED:"NOT_INSTALLED",
  INCOMPATIBLE:"INCOMPATIBLE",
  AWAITING_UI:"AWAITING_UI",
  UNSUPPORTED:"UNSUPPORTED",
  HELD:"HELD"
});
const P=PCMS_UI_PRESENTATION;
const E=PCMS_UI_CONTRIBUTION_ERROR_CODES;

const BUILTIN_FUNCTIONS=["summary","search","facets","listGenerators","conditions","invoke","formatActivity","listRows","getDetail","diagnostics","createUiContribution"];
const RUNTIME_METHODS=Object.freeze({facet:"uiFacet",listRows:"uiListRows",getDetail:"uiGetDetail",invoke:"uiInvoke"});

function fail(code,message){throw new PcmsUiContributionError(code,message);}

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function requireMethods(value,names,label){
  if(!value||typeof value!=="object"||!names.every((name)=>typeof value[name]==="function")) throw new TypeError(label+" is invalid");
  return value;
}

function withTimeout(promise,ms,setTimer,clearTimer){
  let timer=null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve,reject)=>{timer=setTimer(()=>reject(new PcmsUiContributionError(E.TIMEOUT,"Module did not answer in time")),ms);})
  ]).finally(()=>clearTimer(timer));
}

function safeCode(error){
  return typeof error?.code==="string"&&error.code.length<=96?error.code:"PCMS_UI_CONTRIBUTION_FAILED";
}

function publishedKey(moduleId){return "published:"+moduleId;}
function settingsNamespace(moduleId){return "module."+moduleId+".settings";}

// Splits a built-in contribution object into its static descriptor and its functions.
export function normalizeBuiltinContribution(value,moduleId){
  if(!plain(value)) fail(E.INVALID,"Built-in contribution must be a plain object");
  const descriptor={};
  const functions={};
  for(const [key,item] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!item.enumerable||!Object.hasOwn(item,"value")) fail(E.INVALID,"Built-in contribution has an accessor");
    if(key==="facets"){
      if(!plain(item.value)) fail(E.INVALID,"facets must be an object of functions");
      const facetFns={};
      for(const [kind,fn] of Object.entries(item.value)){
        if(!PCMS_UI_FACET_KINDS.includes(kind)||typeof fn!=="function") fail(E.INVALID,"facets are invalid");
        facetFns[kind]=fn;
      }
      functions.facets=Object.freeze(facetFns);
      descriptor.facets=Object.keys(facetFns);
    } else if(BUILTIN_FUNCTIONS.includes(key)){
      if(typeof item.value!=="function") fail(E.INVALID,key+" must be a function");
      functions[key]=item.value;
    } else {
      descriptor[key]=item.value;
    }
  }
  return Object.freeze({
    descriptor:normalizePcmsUiDescriptor(descriptor,{moduleId,kind:"builtin"}),
    functions:Object.freeze(functions)
  });
}

export function createPcmsUiContributionHost({
  storageBroker,
  modules,
  moduleRegistry=null,
  recoveryHold=null,
  auditJournal=null,
  bundledModules=[],
  loadBundled=null,
  clock=()=>new Date().toISOString(),
  facetTimeoutMs=PCMS_UI_FACET_TIMEOUT_MS,
  callTimeoutMs=PCMS_UI_CALL_TIMEOUT_MS,
  setTimer=globalThis.setTimeout?.bind(globalThis),
  clearTimer=globalThis.clearTimeout?.bind(globalThis)
}={}){
  if(!storageBroker||typeof storageBroker.namespace!=="function") throw new TypeError("UI contribution host requires PCMS storage");
  requireMethods(modules,["list","get","call"],"Module supervisor API");
  if(moduleRegistry!==null) requireMethods(moduleRegistry,["getModule","getPackage"],"Module registry");
  if(recoveryHold!==null) requireMethods(recoveryHold,["getStatus"],"Recovery hold");
  if(auditJournal!==null) requireMethods(auditJournal,["append"],"Audit Journal");
  if(!Array.isArray(bundledModules)) throw new TypeError("Bundled module list is invalid");
  if(loadBundled!==null&&typeof loadBundled!=="function") throw new TypeError("Bundled module loader is invalid");
  if(typeof clock!=="function"||typeof setTimer!=="function"||typeof clearTimer!=="function") throw new TypeError("UI contribution host timers are invalid");

  const store=storageBroker.namespace(PCMS_UI_CONTRIBUTION_NAMESPACE);
  let builtinPromise=null;

  // --- built-in modules ---------------------------------------------------------------

  async function loadBuiltins(){
    const entries=loadBundled?await loadBundled():bundledModules;
    if(!Array.isArray(entries)) throw new TypeError("Bundled module list is invalid");
    const out=new Map();
    for(const entry of entries){
      let moduleId;
      try{moduleId=normalizePcmsUiModuleId(entry?.moduleId);}catch{continue;}
      if(out.has(moduleId)) continue;
      try{
        const raw=typeof entry.uiContribution==="function"?await entry.uiContribution():entry.uiContribution;
        out.set(moduleId,{moduleId,kind:"builtin",dependsOn:Object.freeze([...(entry.dependsOn||[])]),...normalizeBuiltinContribution(raw,moduleId),error:null});
      } catch(error){
        out.set(moduleId,{moduleId,kind:"builtin",dependsOn:Object.freeze([]),descriptor:null,functions:Object.freeze({}),error});
      }
    }
    return out;
  }

  function builtins(){
    if(!builtinPromise){
      const attempt=loadBuiltins();
      builtinPromise=attempt;
      attempt.catch(()=>{if(builtinPromise===attempt) builtinPromise=null;});
    }
    return builtinPromise;
  }

  async function holdState(){
    if(!recoveryHold) return "NORMAL";
    try{return (await recoveryHold.getStatus())?.value?.state==="RECOVERY_HOLD"?"RECOVERY_HOLD":"NORMAL";}
    catch{return "NORMAL";}
  }

  function context(recovery,generation=null){
    return Object.freeze({asOf:clock(),recovery,generation,locale:"en-US"});
  }

  // --- runtime publish cache ------------------------------------------------------------

  async function readPublished(moduleId){
    const row=await store.get(publishedKey(moduleId));
    const value=row?.value;
    if(!value||value.kind!=="ui-publish"||value.moduleId!==moduleId) return null;
    return value;
  }

  async function writePublished(moduleId,value){
    for(let attempt=0;attempt<4;attempt+=1){
      const current=await store.get(publishedKey(moduleId));
      try{return await store.compareAndSwap(publishedKey(moduleId),{expectedRevision:current?.revision??0,value});}
      catch(error){if(error?.code!=="PCMS_STORAGE_CAS_MISMATCH") throw error;}
    }
    fail(E.INVALID,"Published UI could not be stored");
  }

  // The capability handler bound into capability set v1 (granted per module authority).
  // Business outcomes are returned as {ok:false, code}; the stored marker makes an invalid
  // publish visible as "Module UI is invalid" instead of silently keeping an older one.
  async function publishCapability(raw,ctx){
    const moduleId=normalizePcmsUiModuleId(ctx?.moduleId);
    let error=null;
    try{normalizePcmsUiPublish(raw,moduleId);}
    catch(caught){error=caught;}
    await ctx.assertCurrent();
    const value={
      schemaVersion:1,
      kind:"ui-publish",
      moduleId,
      packageHash:ctx.packageHash,
      generation:ctx.generation,
      publishedAt:clock(),
      valid:!error,
      errorCode:error?safeCode(error):null,
      contractVersion:error?.contractVersion??null,
      // The module's own (validated) payload; it is validated again on every read.
      payload:error?null:JSON.parse(JSON.stringify(raw))
    };
    await writePublished(moduleId,value);
    return error
      ? Object.freeze({ok:false,code:value.errorCode})
      : Object.freeze({ok:true,generation:ctx.generation});
  }

  // --- presentation ---------------------------------------------------------------------

  function presentation(state,{token,label,banner=null,pageMessage=null,navVisible,greyed=false,included}){
    return Object.freeze({state,token,label,banner,pageMessage,navVisible,greyed,included});
  }

  async function runtimePresentation(described,published,runtimeSupport,recovery){
    const version=described.version;
    if(runtimeSupport?.state&&runtimeSupport.state!=="AVAILABLE"){
      return presentation(P.UNSUPPORTED,{token:"UNAVAILABLE",label:"Unavailable on this Firefox",pageMessage:"Requires Firefox 154+",navVisible:false,included:false});
    }
    if(described.status==="AWAITING_APPROVAL"&&!described.activePackageHash){
      return presentation(P.INSTALLING,{token:"WAITING_HUMAN",label:"Awaiting approval",pageMessage:"This module is waiting for its capabilities to be approved in Settings → Modules.",navVisible:false,included:false});
    }
    if(described.status==="REMOVED"){
      return presentation(P.REMOVED,{token:"UNAVAILABLE",label:"Removed",pageMessage:"Module removed · Reinstall or purge it in Settings → Modules",navVisible:false,included:false});
    }
    if(described.status==="DISABLED"){
      return presentation(P.DISABLED,{token:"UNAVAILABLE",label:"Disabled",pageMessage:"Module disabled · Enable in Settings",navVisible:false,included:false});
    }
    if(described.runtimeState==="DRAINING"){
      return presentation(P.UPDATING,{token:"ACTIVE",label:"Updating…",banner:"Updating…",navVisible:true,included:false});
    }
    if(published&&published.valid===false&&published.packageHash===described.activePackageHash){
      const unsupported=published.errorCode===E.UNSUPPORTED;
      return presentation(P.INCOMPATIBLE,{
        token:"UNAVAILABLE",label:"Incompatible",
        pageMessage:unsupported
          ?"Needs a newer PCMS (contract v"+(published.contractVersion??"?")+")"
          :"Module UI is invalid · see Settings → Diagnostics",
        navVisible:true,greyed:true,included:false
      });
    }
    if(!published||published.packageHash!==described.activePackageHash){
      return presentation(P.AWAITING_UI,{token:"INFO",label:"Starting",pageMessage:"This module has not published its interface yet.",navVisible:true,included:false});
    }
    if(described.failures>0){
      return presentation(P.FAILED,{token:"ERROR",label:"Errors ("+described.failures+")",
        banner:"Module failed to start ("+String(described.reason||"error")+"); running "+String(version||"last known good"),
        navVisible:true,included:true});
    }
    if(recovery==="RECOVERY_HOLD"){
      return presentation(P.HELD,{token:"HELD",label:"Active · recovery hold",banner:"Recovery hold: changes are paused until reconciliation.",navVisible:true,included:true});
    }
    if(described.candidate?.state==="AWAITING_APPROVAL"){
      return presentation(P.UPDATE_AWAITS_APPROVAL,{token:"WAITING_HUMAN",label:"Review update",banner:"Update "+described.candidate.version+" awaits approval",navVisible:true,included:true});
    }
    return presentation(P.ACTIVE,{token:"OK",label:"Active",navVisible:true,included:true});
  }

  function builtinPresentation(entry,recovery,summaryError){
    if(!entry.descriptor){
      const unsupported=entry.error?.code===E.UNSUPPORTED;
      return presentation(P.INCOMPATIBLE,{token:"UNAVAILABLE",label:"Incompatible",
        pageMessage:unsupported?"Needs a newer PCMS (contract v"+(entry.error.contractVersion??"?")+")":"Module UI is invalid · see Settings → Diagnostics",
        navVisible:true,greyed:true,included:false});
    }
    if(recovery==="RECOVERY_HOLD") return presentation(P.HELD,{token:"HELD",label:"Active · recovery hold",banner:"Recovery hold: changes are paused until reconciliation.",navVisible:true,included:true});
    if(summaryError) return presentation(P.ACTIVE,{token:"ERROR",label:"Errors",navVisible:true,included:true});
    return presentation(P.ACTIVE,{token:"OK",label:"Active",navVisible:true,included:true});
  }

  function actionsView(descriptor,recovery){
    return Object.freeze((descriptor?.actions||[]).map((action)=>Object.freeze({
      ...action,
      confirm:PCMS_UI_CONFIRM_RISKS.includes(action.risk),
      held:recovery==="RECOVERY_HOLD"&&PCMS_UI_HOLD_BLOCKED_RISKS.includes(action.risk)
    })));
  }

  function moduleView({moduleId,kind,descriptor,state,summary=null,summaryError=null,conditions=[],version=null,generation=null,hasFrame=false,recovery,diagnostics=[],errorCode=null}){
    const included=state.included;
    const dot=summary&&PCMS_UI_DOT_TOKENS.includes(summary.status.token)?summary.status.token
      :summaryError||state.token==="ERROR"?"ERROR":null;
    return Object.freeze({
      moduleId,
      kind,
      title:descriptor?.title||moduleId,
      description:descriptor?.description||null,
      icon:descriptor?.icon||"box",
      nav:state.navVisible?Object.freeze({
        label:descriptor?.nav?.label||descriptor?.title||moduleId,
        order:descriptor?.nav?.order??100,
        dot:descriptor?.nav?.statusFrom==="summary"||!descriptor?.nav?dot:null,
        greyed:state.greyed,
        href:"#/m/"+encodeURIComponent(moduleId)
      }):null,
      presentation:state,
      version,
      generation,
      summary:included?summary:null,
      summaryError:included?summaryError:null,
      conditions:included?conditions:Object.freeze([]),
      actions:included?actionsView(descriptor,recovery):Object.freeze([]),
      settings:included?(descriptor?.settings||Object.freeze([])):Object.freeze([]),
      facetKinds:included?(descriptor?.facets||Object.freeze([])):Object.freeze([]),
      humanTaskActions:descriptor?.humanTaskActions||Object.freeze({}),
      page:included?(descriptor?.page||null):null,
      hasFrame:included&&hasFrame&&descriptor?.page?.frame===true,
      diagnostics,
      errorCode
    });
  }

  async function callBuiltin(fn,args,timeoutMs=callTimeoutMs){
    return withTimeout(Promise.resolve().then(()=>fn(...args)),timeoutMs,setTimer,clearTimer);
  }

  async function packageHasUi(moduleId,packageHash){
    if(!moduleRegistry||!packageHash) return false;
    try{
      const pkg=await moduleRegistry.getPackage(packageHash);
      return pkg.manifest.moduleId===moduleId&&typeof pkg.manifest.ui==="string";
    } catch {return false;}
  }

  async function builtinView(entry,recovery){
    let summary=null;
    let summaryError=null;
    let conditions=Object.freeze([]);
    let diagnostics=Object.freeze([]);
    if(entry.descriptor){
      const ctx=context(recovery);
      if(entry.functions.summary){
        try{summary=normalizePcmsUiSummary(await callBuiltin(entry.functions.summary,[ctx]));}
        catch(error){summaryError=safeCode(error);}
      }
      if(entry.functions.conditions){
        try{conditions=normalizePcmsUiConditions(await callBuiltin(entry.functions.conditions,[ctx]),entry.moduleId);}
        catch{conditions=Object.freeze([]);}
      }
      if(entry.functions.diagnostics){
        try{diagnostics=normalizePcmsUiDiagnostics(await callBuiltin(entry.functions.diagnostics,[ctx]));}catch{}
      }
    }
    const state=builtinPresentation(entry,recovery,summaryError);
    return moduleView({moduleId:entry.moduleId,kind:"builtin",descriptor:entry.descriptor,state,summary,summaryError,conditions,recovery,diagnostics,
      errorCode:entry.descriptor?null:safeCode(entry.error)});
  }

  async function runtimeView(described,runtimeSupport,recovery){
    const published=await readPublished(described.moduleId);
    const state=await runtimePresentation(described,published,runtimeSupport,recovery);
    const payload=published?.valid&&published.packageHash===described.activePackageHash?published.payload:null;
    let descriptor=null;
    let summary=null;
    let conditions=Object.freeze([]);
    let diagnostics=Object.freeze([]);
    if(payload){
      // Re-validated on read: the stored row is data, never trusted code or markup.
      try{
        const normalized=normalizePcmsUiPublish(payload,described.moduleId);
        descriptor=normalized.descriptor;
        summary=normalized.summary;
        conditions=normalized.conditions;
        diagnostics=normalized.diagnostics;
      } catch {}
    }
    const hasFrame=descriptor?.page?.frame===true&&await packageHasUi(described.moduleId,described.activePackageHash);
    return moduleView({moduleId:described.moduleId,kind:"runtime",descriptor,state,summary,conditions,
      version:described.version,generation:described.generation,hasFrame,recovery,diagnostics,
      errorCode:published?.valid===false?published.errorCode:null});
  }

  async function listRuntime(){
    try{return await modules.list();}
    catch{return {runtime:{state:"UNAVAILABLE"},modules:[]};}
  }

  async function views(){
    const [entries,recovery,listed]=await Promise.all([builtins(),holdState(),listRuntime()]);
    const out=[];
    for(const entry of entries.values()) out.push(await builtinView(entry,recovery));
    for(const described of listed.modules||[]){
      if(entries.has(described.moduleId)) continue;
      out.push(await runtimeView(described,listed.runtime,recovery));
    }
    out.sort((a,b)=>(a.nav?.order??1000)-(b.nav?.order??1000)||a.title.localeCompare(b.title)||a.moduleId.localeCompare(b.moduleId));
    return {views:out,recovery,entries};
  }

  // Never wakes a module: built-ins answer in process, runtime modules from the publish cache.
  async function snapshot(){
    const {views:modulesView,recovery}=await views();
    return Object.freeze({
      contract:"pcms.ui-contribution/v1",
      contractVersion:PCMS_UI_CONTRIBUTION_VERSION,
      recovery,
      modules:Object.freeze(modulesView)
    });
  }

  async function resolve(moduleId){
    const id=normalizePcmsUiModuleId(moduleId);
    const {views:all,recovery,entries}=await views();
    const view=all.find((item)=>item.moduleId===id);
    if(!view||!view.presentation.included) fail(E.NOT_AVAILABLE,"Module contributions are not available");
    return {view,recovery,builtin:entries.get(id)||null};
  }

  function fold(text){return String(text||"").normalize("NFKC").toLocaleLowerCase("en-US");}

  function score(fields,needle){
    let best=null;
    for(const field of fields){
      const value=fold(field);
      let current=null;
      if(value===needle) current=100;
      else if(value.startsWith(needle)) current=90;
      else if(value.split(/[^a-z0-9]+/).some((token)=>token.startsWith(needle))) current=80;
      else if(value.includes(needle)) current=70;
      if(current!==null&&(best===null||current>best)) best=current;
    }
    return best;
  }

  async function search(query,limit=PCMS_UI_LIMITS.searchHits){
    if(typeof query!=="string"||query.length>200) fail(E.INVALID,"Search query is invalid");
    const needle=fold(query.trim());
    const bounded=Number.isSafeInteger(limit)&&limit>0&&limit<=PCMS_UI_LIMITS.searchHits?limit:PCMS_UI_LIMITS.searchHits;
    if(!needle) return Object.freeze({hits:Object.freeze([])});
    const {views:all,recovery,entries}=await views();
    const hits=[];
    for(const view of all){
      if(!view.presentation.included) continue;
      let moduleHits=[];
      if(view.kind==="builtin"){
        const fn=entries.get(view.moduleId)?.functions.search;
        if(fn){try{moduleHits=normalizePcmsUiSearchHits(await callBuiltin(fn,[context(recovery),query.trim(),bounded],facetTimeoutMs),{limit:bounded});}catch{}}
      } else {
        const published=await readPublished(view.moduleId);
        let entriesList=[];
        try{entriesList=normalizePcmsUiPublish(published.payload,view.moduleId).search;}catch{}
        for(const entry of entriesList){
          const matched=score([entry.title,entry.subtitle,...entry.keywords],needle);
          if(matched!==null) moduleHits.push({...entry,score:matched});
        }
        moduleHits=moduleHits.sort((a,b)=>b.score-a.score).slice(0,bounded);
      }
      const titleScore=score([view.title,view.moduleId],needle);
      if(titleScore!==null) moduleHits.push({entity:{kind:"module",id:view.moduleId},title:view.title,subtitle:"Module · "+view.presentation.label,status:null,score:titleScore});
      for(const hit of moduleHits){
        hits.push(Object.freeze({
          moduleId:view.moduleId,
          moduleTitle:view.title,
          entity:hit.entity,
          title:hit.title,
          subtitle:hit.subtitle??null,
          status:hit.status??null,
          score:hit.score,
          href:pcmsUiEntityHref(hit.entity)
        }));
      }
    }
    hits.sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)||a.moduleId.localeCompare(b.moduleId));
    return Object.freeze({hits:Object.freeze(hits.slice(0,PCMS_UI_LIMITS.searchMerged))});
  }

  // Facets for an Account or Generator page, in nav order; one failing module degrades to
  // "unavailable" for that module only (03 §4.4, bounded at 1.5 s).
  async function facets(entity){
    const ref=normalizePcmsUiEntityRef(entity);
    if(!PCMS_UI_FACET_KINDS.includes(ref.kind)) fail(E.INVALID,"Facets exist for accounts and generators only");
    const {views:all,recovery,entries}=await views();
    const out=[];
    for(const view of all){
      if(!view.facetKinds.includes(ref.kind)) continue;
      const actionIds=view.actions.map((action)=>action.id);
      let facet=null;
      let error=null;
      try{
        const raw=view.kind==="builtin"
          ?await callBuiltin(entries.get(view.moduleId).functions.facets[ref.kind],[context(recovery),ref],facetTimeoutMs)
          :await withTimeout(modules.call(view.moduleId,RUNTIME_METHODS.facet,{entity:ref}),facetTimeoutMs,setTimer,clearTimer);
        facet=normalizePcmsUiFacet(raw===undefined?null:raw,{actionIds});
      } catch(caught){error=safeCode(caught);}
      if(facet===null&&error===null) continue;
      out.push(Object.freeze({moduleId:view.moduleId,moduleTitle:view.title,facet,error}));
    }
    return Object.freeze({entity:ref,facets:Object.freeze(out)});
  }

  function viewSpec(view,viewId,type){
    const spec=view.page?.views?.find((item)=>item.id===viewId&&item.type===type);
    if(!spec&&!view.page?.frame) fail(E.NOT_AVAILABLE,"Module view is not declared");
    return spec||null;
  }

  async function listRows(moduleId,viewId,cursor=null){
    const {view,recovery,builtin}=await resolve(moduleId);
    if(typeof viewId!=="string"||viewId.length>48) fail(E.INVALID,"View id is invalid");
    if(cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<0)) fail(E.INVALID,"Cursor is invalid");
    const spec=viewSpec(view,viewId,"list");
    const raw=view.kind==="builtin"
      ?await callBuiltin(builtin.functions.listRows||(()=>fail(E.NOT_AVAILABLE,"Module has no rows")),[context(recovery),viewId,cursor])
      :await withTimeout(modules.call(moduleId,RUNTIME_METHODS.listRows,{view:viewId,cursor}),callTimeoutMs,setTimer,clearTimer);
    const columns=spec?spec.columns:framedColumns(raw);
    return normalizePcmsUiListPage(raw,{columns});
  }

  // A frame view supplies its own (bounded) column set with the rows.
  function framedColumns(raw){
    const cells=Array.isArray(raw?.rows)&&raw.rows[0]&&plain(raw.rows[0].cells)?Object.keys(raw.rows[0].cells):[];
    return cells.slice(0,PCMS_UI_LIMITS.columns).map((id)=>({id,label:id,kind:"text"}));
  }

  async function getDetail(moduleId,viewId,objectId){
    const {view,recovery,builtin}=await resolve(moduleId);
    if(typeof viewId!=="string"||viewId.length>48) fail(E.INVALID,"View id is invalid");
    if(typeof objectId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(objectId)) fail(E.INVALID,"Object id is invalid");
    viewSpec(view,viewId,"detail");
    const raw=view.kind==="builtin"
      ?await callBuiltin(builtin.functions.getDetail||(()=>fail(E.NOT_AVAILABLE,"Module has no details")),[context(recovery),viewId,objectId])
      :await withTimeout(modules.call(moduleId,RUNTIME_METHODS.getDetail,{view:viewId,id:objectId}),callTimeoutMs,setTimer,clearTimer);
    return normalizePcmsUiDetail(raw);
  }

  function targetFor(action,target,moduleId){
    if(action.appliesTo==="module"){
      if(target!==null&&target!==undefined){
        const ref=normalizePcmsUiEntityRef(target);
        if(ref.kind!=="module"||ref.id!==moduleId) fail(E.INVALID,"Action target does not match");
      }
      return Object.freeze({kind:"module",id:moduleId});
    }
    const ref=normalizePcmsUiEntityRef(target);
    if(action.appliesTo.startsWith("module-object:")){
      if(ref.kind!=="module-object"||ref.moduleId!==moduleId||ref.view!==action.appliesTo.slice("module-object:".length)) fail(E.INVALID,"Action target does not match");
    } else if(ref.kind!==action.appliesTo) fail(E.INVALID,"Action target does not match");
    return ref;
  }

  // Core validates every value before the module sees it and is the first line for risky
  // actions: execute of a confirm-risk action requires the Core dialog's confirmation, and
  // recovery hold blocks mutations before the module is called (03 §4.7, §5).
  async function runAction(moduleId,actionId,target,input,options,mode){
    const {view,recovery,builtin}=await resolve(moduleId);
    const action=view.actions.find((item)=>item.id===actionId);
    if(!action) fail(E.ACTION_UNKNOWN,"Action is not declared by this module");
    const ref=targetFor(action,target,view.moduleId);
    const safeInput=normalizePcmsUiInput(action.input,input);
    const opts=options===null||options===undefined?{}:options;
    if(!plain(opts)||!Object.keys(opts).every((key)=>["idempotencyKey","confirmed"].includes(key))) fail(E.INVALID,"Action options are invalid");
    const idempotencyKey=opts.idempotencyKey??null;
    if(idempotencyKey!==null&&(typeof idempotencyKey!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey))) fail(E.INVALID,"idempotencyKey is invalid");
    if(mode==="preview"&&!action.preview) fail(E.INVALID,"Action has no preview");
    if(mode==="execute"){
      if(action.held) fail(E.RECOVERY_HOLD,"Recovery hold blocks this action");
      if(action.confirm&&opts.confirmed!==true) fail(E.CONFIRMATION_REQUIRED,"This action must be confirmed in PCMS first");
    }
    const callOptions={mode,idempotencyKey};
    const raw=view.kind==="builtin"
      ?await callBuiltin(builtin.functions.invoke||(()=>fail(E.NOT_AVAILABLE,"Module has no actions")),[context(recovery),actionId,ref,safeInput,callOptions])
      :await withTimeout(modules.call(view.moduleId,RUNTIME_METHODS.invoke,{actionId,target:ref,input:safeInput,mode,idempotencyKey}),callTimeoutMs,setTimer,clearTimer);
    const receipt=normalizePcmsUiReceipt(raw,{mode,risk:action.risk});
    if(mode==="execute"&&auditJournal){
      try{
        await auditJournal.append({type:"module.ui.action",subject:{kind:"module",id:view.moduleId},
          data:{actionId,risk:action.risk,target:ref,status:receipt.status.token,confirmed:opts.confirmed===true}});
      } catch {}
    }
    return Object.freeze({moduleId:view.moduleId,actionId,risk:action.risk,generation:view.generation,...receipt});
  }

  function preview(moduleId,actionId,target,input){return runAction(moduleId,actionId,target,input,null,"preview");}
  function invoke(moduleId,actionId,target,input,options){return runAction(moduleId,actionId,target,input,options,"execute");}

  // Source for the sandboxed module-UI frame of a runtime module (03 §5). Reading it never
  // activates the module; requests from the frame later go through the calls above.
  async function frame(moduleId){
    const {view}=await resolve(moduleId);
    if(view.kind!=="runtime"||!view.hasFrame) fail(E.NOT_AVAILABLE,"Module has no page frame");
    const described=await modules.get(view.moduleId);
    const pkg=await moduleRegistry.getPackage(described.activePackageHash);
    const source=pkg.files[pkg.manifest.ui];
    if(typeof source!=="string") fail(E.NOT_AVAILABLE,"Module UI entry is missing");
    return Object.freeze({
      moduleId:view.moduleId,
      title:view.title,
      generation:described.generation,
      packageHash:described.activePackageHash,
      source,
      actions:Object.freeze(view.actions.map((action)=>Object.freeze({id:action.id,label:action.label,risk:action.risk,appliesTo:action.appliesTo,confirm:action.confirm,preview:action.preview,held:action.held})))
    });
  }

  async function recentModuleEvents(){
    if(typeof auditJournal?.read!=="function") return [];
    const head=await auditJournal.read({afterSequence:0,limit:1});
    let after=Math.max(0,(head.lastSequence||0)-500);
    const events=[];
    for(let page=0;page<2;page+=1){
      const read=await auditJournal.read({afterSequence:after,limit:500});
      events.push(...read.events);
      if(!read.hasMore||!read.events.length) break;
      after=read.events[read.events.length-1].sequence;
    }
    return events.filter((event)=>event?.subject?.kind==="module"&&typeof event.subject.id==="string");
  }

  // Activity feed lines for module events (03 §4.9); text-only, bounded, newest first.
  async function activity(limit=PCMS_UI_LIMITS.activity){
    const bounded=Number.isSafeInteger(limit)&&limit>0&&limit<=PCMS_UI_LIMITS.activity?limit:PCMS_UI_LIMITS.activity;
    const [events,{views:all,entries}]=await Promise.all([recentModuleEvents(),views()]);
    const lines=[];
    for(const event of events.reverse()){
      if(lines.length>=bounded) break;
      const view=all.find((item)=>item.moduleId===event.subject.id);
      if(!view) continue;
      let line=null;
      const formatter=entries.get(view.moduleId)?.functions.formatActivity;
      try{
        line=formatter
          ?normalizePcmsUiActivityLine(formatter(Object.freeze({type:event.type,at:event.timestamp??null,data:event.data??null}))??null)
          :normalizePcmsUiActivityLine({text:view.title+" · "+String(event.type).replace(/^module\.(?:event|lifecycle|ui)\./,"").slice(0,120),token:"INFO"});
      } catch {line=null;}
      if(line) lines.push(Object.freeze({moduleId:view.moduleId,moduleTitle:view.title,at:event.timestamp??null,sequence:event.sequence??null,...line}));
    }
    return Object.freeze({lines:Object.freeze(lines)});
  }

  // Setting values live in the module's own namespace (03 §4.8); Core validates and audits.
  async function getSettings(moduleId){
    const {view}=await resolve(moduleId);
    const namespace=storageBroker.namespace(settingsNamespace(view.moduleId));
    const values={};
    for(const spec of view.settings){
      const row=await namespace.get(spec.key);
      let value=spec.default??null;
      if(row){try{value=coercePcmsUiFieldValue({...spec,required:false},row.value);}catch{value=spec.default??null;}}
      values[spec.key]=value;
    }
    return Object.freeze({moduleId:view.moduleId,settings:view.settings,values:Object.freeze(values)});
  }

  async function setSetting(moduleId,key,value){
    const {view}=await resolve(moduleId);
    const spec=view.settings.find((item)=>item.key===key);
    if(!spec) fail(E.INVALID,"Setting is not declared");
    const coerced=coercePcmsUiFieldValue({...spec,required:true},value);
    const namespace=storageBroker.namespace(settingsNamespace(view.moduleId));
    for(let attempt=0;attempt<4;attempt+=1){
      const current=await namespace.get(key);
      try{
        await namespace.compareAndSwap(key,{expectedRevision:current?.revision??0,value:coerced});
        break;
      } catch(error){
        if(error?.code!=="PCMS_STORAGE_CAS_MISMATCH"||attempt===3) throw error;
      }
    }
    if(auditJournal){try{await auditJournal.append({type:"module.ui.setting",subject:{kind:"module",id:view.moduleId},data:{key}});}catch{}}
    return getSettings(view.moduleId);
  }

  return Object.freeze({
    capabilities:Object.freeze({[PCMS_UI_PUBLISH_CAPABILITY]:publishCapability}),
    readPublished,
    api:Object.freeze({snapshot,search,facets,listRows,getDetail,preview,invoke,frame,activity,getSettings,setSetting})
  });
}
