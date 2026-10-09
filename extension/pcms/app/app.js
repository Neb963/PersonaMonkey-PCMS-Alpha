import { installPcmsNamespace } from "../core/bootstrap.js";
import { PCMS_V2_BUILTIN_MODULE_IDS, pcmsV2Href, resolvePcmsRouteV2 } from "./router-v2.js";
import { pcmsStatusToken, presentPcmsCoreStatus, presentPcmsHumanTask, presentPcmsModule, presentPcmsReceipt } from "./primitives.js";
import { readPcmsCachedStatus, startPcmsLiveRuntime } from "./live-runtime.js";
import { startPcmsRuntimeWithRetry } from "./startup-retry.js";
import { createPcmsModuleProjectionService } from "./module-projections.js";
import { bindPcmsLiveControls } from "./live-controls.js";
import { createPcmsAccountsView } from "./views/accounts/accounts-view.js";
import { createPcmsGeneratorsView } from "./views/generators/generators-view.js";
import { createPcmsSettingsView } from "./views/settings/settings-view.js";
import {
  contributionNavItems,
  derivedAttention,
  emptyPcmsContributionSnapshot,
  findContribution,
  humanTaskModuleState,
  legacyModuleIds,
  mergeSearchResults,
  modulePageModel,
  modulePageRenderKey,
  overviewModuleCards,
  routableModuleIds,
  settingsModuleRows
} from "./contributions.js";
import { createPcmsConfirmDialog, createPcmsModuleActionRunner } from "./module-actions.js";
import { createPcmsActionInputDialog, createPcmsEntityPickerSources } from "./action-input.js";
import { createPcmsModuleFrameHost } from "./module-frame-host.js";
import {
  renderActivity,
  renderFacets,
  renderModulePage,
  renderOverviewCards,
  renderSettingsModules
} from "./module-view.js";

function element(documentRef,tag,className=null) {
  const node=documentRef.createElement(tag);
  if(className) node.className=className;
  return node;
}

function clear(node) {
  while(node.firstChild) node.removeChild(node.firstChild);
}

function appendStatusToken(documentRef,parent,token,label=null) {
  const definition=pcmsStatusToken(token);
  const badge=element(documentRef,"span","status-token");
  badge.dataset.token=token;
  badge.dataset.tone=definition.tone;
  badge.textContent=label||definition.label;
  parent.appendChild(badge);
  return badge;
}

function appendLink(documentRef,parent,{href,title,subtitle=null,badge=null}) {
  const link=element(documentRef,"a","item-link");
  link.href=href;
  const main=element(documentRef,"span","item-main");
  const strong=element(documentRef,"strong");
  strong.textContent=title;
  main.appendChild(strong);
  if(subtitle!==null) {
    const small=element(documentRef,"small");
    small.textContent=subtitle;
    main.appendChild(small);
  }
  link.appendChild(main);
  if(badge!==null) {
    const count=element(documentRef,"span","badge");
    count.textContent=String(badge);
    link.appendChild(count);
  }
  parent.appendChild(link);
  return link;
}

function section(documentRef,id) {
  const node=documentRef.getElementById(id);
  if(!node) throw new Error("PCMS app DOM is incomplete");
  return node;
}

export function mountPcmsApp({
  projectionService,
  moduleProjectionService,
  runtime=null,
  documentRef=globalThis.document,
  windowRef=globalThis.window
}={}) {
  if(!projectionService || typeof projectionService.snapshot!=="function") {
    throw new TypeError("PCMS app requires a projection service");
  }
  if(!moduleProjectionService || typeof moduleProjectionService.snapshot!=="function") {
    throw new TypeError("PCMS app requires module projections");
  }
  if(!documentRef || !windowRef) throw new TypeError("PCMS app requires a document/window");

  const nav=section(documentRef,"primaryNav");
  const overview=section(documentRef,"viewOverview");
  const modules=section(documentRef,"viewModules");
  const attention=section(documentRef,"viewAttention");
  const accounts=section(documentRef,"viewAccounts");
  const search=section(documentRef,"viewSearch");
  const diagnostics=section(documentRef,"viewDiagnostics");
  const settingsBackup=documentRef.getElementById("viewSettingsBackup");
  const placeholder=section(documentRef,"viewPlaceholder");
  const modulePage=documentRef.getElementById("viewModulePage");
  const searchForm=section(documentRef,"searchForm");
  const searchInput=section(documentRef,"searchInput");
  const notificationStatus=section(documentRef,"notificationStatus");
  let disposed=false;
  let refreshGeneration=0;
  const accountsView=runtime?.accounts && documentRef.getElementById("accountsV2")
    ?createPcmsAccountsView({runtime,documentRef,windowRef,onChanged:()=>refresh()})
    :null;
  // P036: Generators list/detail from the Core generator index (mounted in the routed section).
  const generatorsView=runtime?.generators&&runtime?.deployer&&placeholder
    ?createPcmsGeneratorsView({runtime,documentRef,windowRef,mount:placeholder,onChanged:()=>refresh()})
    :null;
  // P041: Settings → Backup & restore and Settings → Modules drive Core through the UI client.
  const settingsView=runtime?.backupRestore&&runtime?.modules&&settingsBackup&&documentRef.getElementById("settingsModulesManager")
    ?createPcmsSettingsView({runtime,documentRef,windowRef,onChanged:()=>refresh()})
    :null;
  // P033: module contributions are read from Core (pcms.ui-contribution/v1 via ui.*).
  const contributionsLive=typeof runtime?.ui?.snapshot==="function"&&modulePage!==null;
  let actionRunner=null;
  let frameHost=null;
  let collectInput=null;
  if(contributionsLive&&documentRef.getElementById("moduleConfirmDialog")){
    actionRunner=createPcmsModuleActionRunner({runtime,confirm:createPcmsConfirmDialog({documentRef})});
    // P040: action inputs are collected in a Core-rendered dialog with pickers, never typed IDs.
    if(documentRef.getElementById("moduleInputDialog")){
      collectInput=createPcmsActionInputDialog({documentRef,pickers:createPcmsEntityPickerSources(runtime)});
    }
    frameHost=createPcmsModuleFrameHost({documentRef,windowRef,runtime,runAction:(request)=>runModuleAction(request)});
  }
  let modulePageKey=null;
  let lastContributions=emptyPcmsContributionSnapshot();

  function setVisible(route) {
    for(const [name,node] of [
      ["overview",overview],["modules",modules],["attention",attention],["accounts",accounts],
      ["search",search],["diagnostics",diagnostics],["placeholder",placeholder],["modulePage",modulePage],
      ["settingsBackup",settingsBackup]
    ]) if(node) node.hidden=name!==route;
    if(route!=="modulePage"&&modulePageKey!==null){
      modulePageKey=null;
      frameHost?.dispose();
    }
  }

  function renderNav(snapshot,currentRoute,moduleSnapshot,contributions) {
    clear(nav);
    const active=currentRoute.route==="module"
      ?"module-"+currentRoute.moduleId
      : currentRoute.route==="settings"
        ?"settings-"+currentRoute.section
        : currentRoute.route;
    const items=[
      {id:"overview",label:"Overview",href:"#/overview"},
      {id:"attention",label:"Attention",href:"#/attention",badge:snapshot.notifications.count},
      {id:"accounts",label:"Accounts",href:"#/accounts"},
      {id:"generators",label:"Generators",href:"#/generators"},
      ...legacyModuleIds(contributions).map((id)=>({
        id:"module-"+id,
        label:id[0].toUpperCase()+id.slice(1),
        href:"#/m/"+id,
        badge:moduleSnapshot?.[id]?.available===false?"!":null
      })),
      ...contributionNavItems(contributions).map((item)=>({...item,badge:null})),
      {id:"activity",label:"Activity",href:"#/activity"},
      {id:"settings-modules",label:"Module settings",href:"#/settings/modules"},
      {id:"settings-backup",label:"Backup & restore",href:"#/settings/backup"},
      {id:"settings-diagnostics",label:"Diagnostics",href:"#/settings/diagnostics"}
    ];
    for(const item of items) {
      const link=element(documentRef,"a","nav-link");
      link.href=item.href;
      link.textContent=item.label;
      if(item.id===active) link.setAttribute("aria-current","page");
      if(item.moduleId) link.dataset.moduleId=item.moduleId;
      if(item.greyed) link.dataset.greyed="true";
      if(item.dot){
        const dot=element(documentRef,"span","nav-dot");
        dot.dataset.token=item.dot;
        dot.setAttribute("aria-label",item.dot.toLowerCase());
        link.appendChild(dot);
      }
      if(item.badge!==null&&item.badge!==undefined) {
        const badge=element(documentRef,"span","nav-badge");
        badge.textContent=String(item.badge);
        link.appendChild(badge);
      }
      nav.appendChild(link);
    }
  }

  function renderOverview(snapshot,moduleSnapshot,contributions) {
    section(documentRef,"overviewAttentionCount").textContent=String(snapshot.notifications.count);
    section(documentRef,"overviewAccountCount").textContent=String(snapshot.accounts.accounts.length);
    const cards=overviewModuleCards(contributions);
    section(documentRef,"overviewModuleCount").textContent=String(
      legacyModuleIds(contributions).filter((id)=>moduleSnapshot?.[id]?.available===true).length
      +cards.filter((card)=>!card.greyed&&!card.unavailable).length
    );
    const container=documentRef.getElementById("overviewModuleCards");
    if(container) renderOverviewCards(documentRef,container,cards);
  }

  function renderContributedModules(contributions) {
    const list=documentRef.getElementById("contributedModuleList");
    if(list) renderSettingsModules(documentRef,list,settingsModuleRows(contributions));
  }

  function renderAttention(snapshot,selectedId=null,contributions=lastContributions) {
    const list=section(documentRef,"attentionList");
    clear(list);
    const items=selectedId===null
      ? snapshot.notifications.items
      : snapshot.notifications.items.filter((item)=>item.taskId===selectedId);
    for(const item of items) {
      appendLink(documentRef,list,{
        href:item.href,
        title:item.title,
        subtitle:item.priority+" · "+item.taskKind
      });
      // HumanTasks stay Core records; a disabled module's task stays listed but not actionable.
      const moduleState=humanTaskModuleState(item,contributions);
      if(moduleState?.blocked) {
        const note=element(documentRef,"p","module-status");
        note.dataset.moduleBlocked=item.subjectRef.id;
        note.textContent=moduleState.note;
        list.appendChild(note);
        continue;
      }
      if(item.taskKind==="provider.confirm-apply"&&runtime?.providerHandoff) {
        // ADR-002 §9: the answer is submitted as reconciliation, from any tab, at any time.
        const show=element(documentRef,"button","inline-action");
        show.type="button";
        show.dataset.handoffShow=item.taskId;
        show.textContent="Show details";
        list.appendChild(show);
        for(const [outcome,label] of [["APPLIED","Applied"],["NOT_APPLIED","Not applied"],["UNKNOWN","Still unknown"]]) {
          const answer=element(documentRef,"button","inline-action");
          answer.type="button";
          answer.dataset.handoffTask=item.taskId;
          answer.dataset.handoffOutcome=outcome;
          answer.textContent=label;
          list.appendChild(answer);
        }
      } else if(runtime?.humanTasks) {
        const resolve=element(documentRef,"button","inline-action");
        resolve.type="button";
        resolve.dataset.resolveTask=item.taskId;
        resolve.textContent="Mark done";
        list.appendChild(resolve);
      }
    }
    section(documentRef,"attentionEmpty").hidden=items.length!==0;
    const conditionList=documentRef.getElementById("attentionConditions");
    if(conditionList) {
      clear(conditionList);
      const conditions=selectedId===null?derivedAttention(contributions):[];
      for(const condition of conditions) {
        const link=appendLink(documentRef,conditionList,{
          href:"#/m/"+encodeURIComponent(condition.moduleId),
          title:condition.title,
          subtitle:condition.priority+" · "+condition.moduleTitle+" · derived"
        });
        link.dataset.conditionKey=condition.key;
        appendStatusToken(documentRef,link,condition.status.token,condition.status.label);
      }
      section(documentRef,"attentionConditionsHeading").hidden=conditions.length===0;
    }
  }

  async function renderAccountFacets(route,contributions,generation) {
    const container=documentRef.getElementById("accountFacets");
    if(!container) return;
    if(!contributionsLive||route.route!=="accounts"||route.id===null) {
      clear(container);
      delete container.dataset.accountId;
      return;
    }
    let result;
    try{result=await runtime.ui.facets({kind:"account",id:route.id});}
    catch{result={entity:{kind:"account",id:route.id},facets:[]};}
    if(disposed||generation!==refreshGeneration) return;
    renderFacets(documentRef,container,result,{
      snapshot:contributions,
      onAction:(module,action,entity)=>void runModuleAction({module,action,target:entity,collect:true}).catch(()=>{})
    });
    container.dataset.accountId=route.id;
  }

  function renderAccounts(snapshot,route) {
    if(accountsView) {
      void accountsView.render({accounts:snapshot.accounts.accounts,revision:snapshot.accounts.revision,route})
        .catch(()=>{notificationStatus.textContent="Accounts view unavailable.";notificationStatus.dataset.state="warning";});
      return;
    }
    const list=section(documentRef,"accountList");
    clear(list);
    for(const item of snapshot.accounts.accounts)appendLink(documentRef,list,{
      href:item.href,title:item.displayName,subtitle:item.providerId
    });
    section(documentRef,"accountsEmpty").hidden=snapshot.accounts.accounts.length!==0;
  }

  function renderSearch(snapshot,hits=[]) {
    searchInput.value=snapshot.search.query;
    const list=section(documentRef,"searchResults");
    clear(list);
    const results=mergeSearchResults(snapshot.search.results,hits);
    for(const result of results) {
      appendLink(documentRef,list,{
        href:result.href,
        title:result.title,
        subtitle:result.kind+" · "+result.subtitle
      });
    }
    section(documentRef,"searchEmpty").hidden=results.length!==0 || snapshot.search.query==="";
  }

  function renderActionTray(snapshot,receiptState) {
    const taskList=section(documentRef,"actionTrayDurableList");
    clear(taskList);
    for(const item of snapshot.notifications.items.slice(0,8)) {
      const presentation=presentPcmsHumanTask(item);
      const row=element(documentRef,"a","action-receipt");
      row.href=item.href;
      appendStatusToken(documentRef,row,presentation.token,presentation.label);
      const text=element(documentRef,"span");
      text.textContent=item.title;
      row.appendChild(text);
      taskList.appendChild(row);
    }

    const receiptList=section(documentRef,"actionTrayReceiptList");
    clear(receiptList);
    const receipts=Array.isArray(receiptState?.receipts)?receiptState.receipts.slice(0,8):[];
    for(const receipt of receipts) {
      const row=element(documentRef,"div","action-receipt");
      row.dataset.receiptId=receipt.receiptId;
      const presentation=presentPcmsReceipt(receipt);
      appendStatusToken(documentRef,row,presentation.token,presentation.label);
      const text=element(documentRef,"span");
      text.textContent=receipt.subject;
      row.appendChild(text);
      receiptList.appendChild(row);
    }
    // A direct command response is temporary feedback. Core's durable copy becomes
    // authoritative on the next revision, so never display the same ID twice.
    const localList=section(documentRef,"actionTrayLocalList");
    for(const row of [...localList.children]) {
      if(receipts.some((receipt)=>receipt.receiptId===row.dataset.receiptId)) row.remove();
    }
    if(receiptState?.unavailable) {
      const row=element(documentRef,"div","action-receipt");
      appendStatusToken(documentRef,row,"UNAVAILABLE","History unavailable");
      receiptList.appendChild(row);
    }
    section(documentRef,"actionTrayCount").textContent=snapshot.notifications.count?String(snapshot.notifications.count):"";
    section(documentRef,"actionTrayEmpty").hidden=taskList.childNodes.length!==0
      ||receiptList.childNodes.length!==0||localList.childNodes.length!==0;
  }

  function showReceipt(receipt) {
    const list=section(documentRef,"actionTrayReceiptList");
    const id=String(receipt?.receiptId||"");
    if(!id) return;
    // Avoid duplicate direct responses for a retried command.
    for(const previous of [...list.children]) if(previous.dataset.receiptId===id) previous.remove();
    const row=element(documentRef,"div","action-receipt");
    row.dataset.receiptId=id;
    const presentation=presentPcmsReceipt(receipt);
    appendStatusToken(documentRef,row,presentation.token,presentation.label);
    const text=element(documentRef,"span");
    text.textContent=String(receipt?.subject||"PCMS action");
    row.appendChild(text);
    list.prepend(row);
    while(list.childNodes.length>5) list.removeChild(list.lastChild);
    section(documentRef,"actionTrayEmpty").hidden=true;
  }

  async function renderActivityLines(route,generation) {
    const list=documentRef.getElementById("activityList");
    if(!list) return;
    list.hidden=route.route!=="activity"||!contributionsLive;
    if(list.hidden) return;
    let result;
    try{result=await runtime.ui.activity(30);}
    catch{result={lines:[]};}
    if(disposed||generation!==refreshGeneration) return;
    renderActivity(documentRef,list,result.lines);
  }

  function renderPlaceholder(route) {
    const heading=section(documentRef,"placeholderHeading");
    const body=section(documentRef,"placeholderBody");
    if(route.route==="generators") {
      heading.textContent="Generators";
      body.textContent=generatorsView
        ?"Every generator PCMS knows, with what PCMS wants, what it last confirmed and what to do next."
        :"Generators are unavailable until PCMS Core connects.";
    } else if(route.route==="activity") {
      heading.textContent="Activity";
      body.textContent="Module activity from the Audit Journal, newest first. The full Activity redesign belongs to its later phase.";
    } else {
      heading.textContent="Settings · "+String(route.section||"");
      body.textContent="This Settings section is reserved by the v2 shell and remains owned by its later phase.";
    }
  }

  function routeView(route,contributions=lastContributions) {
    if(route.route==="overview") return "overview";
    if(route.route==="attention") return "attention";
    if(route.route==="accounts") return "accounts";
    if(route.route==="search") return "search";
    if(route.route==="module"&&contributionsLive&&!legacyModuleIds(contributions).includes(route.moduleId)) return "modulePage";
    if(route.route==="module"||(route.route==="settings"&&route.section==="modules")) return "modules";
    if(route.route==="settings"&&route.section==="diagnostics") return "diagnostics";
    if(route.route==="settings"&&route.section==="backup"&&settingsBackup) return "settingsBackup";
    return "placeholder";
  }

  function updateCoreStatus(status,{live=false,pending=false}={}) {
    const presentation=presentPcmsCoreStatus(status,{live,pending});
    const pill=section(documentRef,"coreStatusPill");
    clear(pill);
    appendStatusToken(documentRef,pill,presentation.token,presentation.label);
    pill.dataset.state=presentation.state;
    section(documentRef,"diagnosticCoreState").textContent=presentation.state;
    section(documentRef,"diagnosticCoreAsOf").textContent=presentation.asOf||"—";
    section(documentRef,"coreHostStatus").textContent="Background · "+presentation.label.toLowerCase()
      +(status?.wake?" · "+String(status.wake).toLowerCase()+" wake":"");
    section(documentRef,"coreHostStatus").dataset.state=presentation.state==="UNAVAILABLE"?"error":"connected";
    return presentation;
  }

  function showModuleReceipt(receipt) {
    notificationStatus.textContent=receipt.cancelled
      ?"Action cancelled; nothing was changed."
      :String(receipt.message||receipt.status?.label||"Done");
    notificationStatus.dataset.state=receipt.cancelled||receipt.status?.token==="OK"||receipt.status?.token==="INFO"
      ?"connected":"warning";
    // Module receipts stay visible in the action tray (the status line follows revisions).
    const localList=section(documentRef,"actionTrayLocalList");
    const entry=element(documentRef,"div","action-receipt");
    entry.dataset.moduleAction=String(receipt.moduleId||"")+":"+String(receipt.actionId||"");
    entry.dataset.outcome=receipt.cancelled?"CANCELLED":String(receipt.status?.token||"INFO");
    appendStatusToken(documentRef,entry,receipt.cancelled?"INFO":String(receipt.status?.token||"INFO"),receipt.cancelled?"Cancelled":receipt.status?.label);
    const message=element(documentRef,"span");
    message.textContent=receipt.cancelled?"Cancelled; nothing was changed.":String(receipt.message||"");
    entry.appendChild(message);
    if(!receipt.cancelled&&receipt.followUp?.href){
      const follow=element(documentRef,"a");
      follow.href=receipt.followUp.href;
      follow.textContent=receipt.followUp.label;
      follow.dataset.followUp="true";
      entry.appendChild(follow);
    }
    localList.prepend(entry);
    while(localList.childNodes.length>8) localList.removeChild(localList.lastChild);
    section(documentRef,"actionTrayEmpty").hidden=true;
    if(receipt.download) {
      const row=element(documentRef,"div","action-receipt");
      const link=element(documentRef,"a");
      link.href=URL.createObjectURL(new Blob([receipt.download.text],{type:receipt.download.mediaType}));
      link.download=receipt.download.filename;
      link.dataset.download=receipt.download.filename;
      link.textContent="Download "+receipt.download.filename;
      row.appendChild(link);
      localList.prepend(row);
      section(documentRef,"actionTrayEmpty").hidden=true;
    }
  }

  async function runModuleAction({collect=false,...request}) {
    if(!actionRunner) throw new Error("Module actions are unavailable");
    try {
      let input=request.input??null;
      if(collect&&request.action.input?.length){
        if(!collectInput) throw new Error("Module action input is unavailable");
        input=await collectInput(request.module.title,request.action);
        if(input===null){
          const cancelled=Object.freeze({cancelled:true,moduleId:request.module.moduleId,actionId:request.action.id});
          showModuleReceipt(cancelled);
          return cancelled;
        }
      }
      const receipt=await actionRunner.run({...request,input});
      showModuleReceipt(receipt);
      // A Core-rendered module page shows module state; render it again after its action.
      if(collect&&!receipt.cancelled){modulePageKey=null;void refresh().catch(()=>{});}
      return receipt;
    } catch(error) {
      notificationStatus.textContent=request.action.label+" failed · "+String(error?.code||"error");
      notificationStatus.dataset.state="error";
      throw error;
    }
  }

  async function renderModuleRoute(route,contributions,generation) {
    if(!modulePage||route.route!=="module"||routeView(route,contributions)!=="modulePage") return;
    const model=modulePageModel(contributions,route);
    const module=findContribution(contributions,route.moduleId);
    const key=modulePageRenderKey(route,model,module);
    // A frame keeps running across revision refreshes; it is remounted only when its route,
    // presentation state or module version changes (not on a lazy re-activation).
    if(key===modulePageKey) return;
    modulePageKey=key;
    if(model.kind!=="frame") frameHost?.dispose();
    await renderModulePage(documentRef,modulePage,model,{
      run:(action,target)=>void runModuleAction({module,action,target,collect:true}).catch(()=>{}),
      listRows:(...args)=>runtime.ui.listRows(...args),
      getDetail:(...args)=>runtime.ui.getDetail(...args),
      getSettings:(moduleId)=>runtime.ui.getSettings(moduleId),
      setSetting:(moduleId,key,value)=>runtime.ui.setSetting(moduleId,key,value)
        .then(()=>{notificationStatus.textContent="Setting saved.";notificationStatus.dataset.state="connected";})
        .catch((error)=>{notificationStatus.textContent="Setting rejected · "+String(error?.code||"error");notificationStatus.dataset.state="error";}),
      mountFrame:(container,moduleId)=>frameHost?frameHost.mount(container,moduleId):Promise.resolve()
    });
    if(generation===refreshGeneration) modulePage.dataset.rendered=route.href;
  }

  async function readContributions() {
    if(!contributionsLive) return emptyPcmsContributionSnapshot();
    try {
      const value=await runtime.ui.snapshot();
      return Array.isArray(value?.modules)?value:emptyPcmsContributionSnapshot();
    } catch {
      return emptyPcmsContributionSnapshot();
    }
  }

  async function readSearchHits(parsed) {
    if(!contributionsLive||parsed.route!=="search"||!parsed.query) return [];
    try{return (await runtime.ui.search(parsed.query,20))?.hits||[];}
    catch{return [];}
  }

  async function refresh() {
    const generation=++refreshGeneration;
    const initial=resolvePcmsRouteV2(windowRef.location.hash);
    const parsed=initial.route;
    let snapshot,moduleSnapshot,receiptState,contributions,searchHits;
    try {
      [snapshot,moduleSnapshot,receiptState,contributions,searchHits]=await Promise.all([
        projectionService.snapshot({query:parsed.query}),
        moduleProjectionService.snapshot(),
        runtime?.uiReceipts?.list
          ?runtime.uiReceipts.list().then((result)=>{
            if(!Array.isArray(result?.receipts)) throw new Error("Invalid receipt projection");
            return {receipts:result.receipts,unavailable:false};
          }).catch(()=>({receipts:[],unavailable:true}))
          :Promise.resolve({receipts:[],unavailable:true}),
        readContributions(),
        readSearchHits(parsed)
      ]);
    } catch {
      if(disposed||generation!==refreshGeneration) return;
      notificationStatus.textContent="PCMS live projections are unavailable.";
      notificationStatus.dataset.state="error";
      setVisible("overview");
      return;
    }
    if(disposed||generation!==refreshGeneration) return;

    lastContributions=contributions;
    // A syntactically valid module link always resolves: the module page explains a
    // disabled, removed or never-installed module instead of redirecting (03 §6).
    const moduleIds=routableModuleIds(contributions,windowRef.location.hash);
    const resolved=resolvePcmsRouteV2(windowRef.location.hash,{
      accountIds:snapshot.accounts.accounts.map((item)=>item.accountId),
      attentionIds:snapshot.notifications.items.map((item)=>item.taskId),
      moduleIds:contributionsLive?moduleIds:PCMS_V2_BUILTIN_MODULE_IDS
    });
    if(!resolved.valid) {
      notificationStatus.textContent=resolved.reason==="NOT_FOUND"
        ?"That item is no longer available."
        :"That PCMS link is invalid and was opened safely at Overview.";
      notificationStatus.dataset.state="warning";
      windowRef.history.replaceState(null,"",resolved.route.href);
    } else {
      if(resolved.canonicalized) windowRef.history.replaceState(null,"",resolved.route.href);
      const modulesReady=PCMS_V2_BUILTIN_MODULE_IDS.every((id)=>moduleSnapshot?.[id]?.available===true)
        &&!contributions.modules.some((item)=>item.summaryError);
      notificationStatus.textContent=snapshot.notifications.count
        ? snapshot.notifications.count+" item"+(snapshot.notifications.count===1?"":"s")+" need attention."
        : modulesReady
          ? "PCMS is ready."
          : "PCMS is running; one or more module projections are unavailable.";
      notificationStatus.dataset.state=modulesReady?"connected":"warning";
    }
    const route=resolved.route;
    renderNav(snapshot,route,moduleSnapshot,contributions);
    renderOverview(snapshot,moduleSnapshot,contributions);
    renderContributedModules(contributions);
    renderAttention(snapshot,route.route==="attention"?route.id:null,contributions);
    renderAccounts(snapshot,route);
    renderSearch(snapshot,searchHits);
    renderActionTray(snapshot,receiptState);
    renderPlaceholder(route);
    setVisible(routeView(route,contributions));
    documentRef.body.dataset.pcmsContributions=contributionsLive?String(contributions.modules.length):"off";
    await Promise.all([
      renderModuleRoute(route,contributions,generation).catch(()=>{}),
      renderAccountFacets(route,contributions,generation).catch(()=>{}),
      renderActivityLines(route,generation).catch(()=>{}),
      settingsView?.refresh(route).catch(()=>{}),
      generatorsView?.render(route).catch(()=>{})
    ]);
  }

  function onHashChange(){ void refresh(); }
  function onSubmit(event) {
    event.preventDefault();
    let href;
    try { href=pcmsV2Href("search",{query:searchInput.value}); }
    catch { return; }
    windowRef.location.hash=href;
    void refresh();
  }

  windowRef.addEventListener("hashchange",onHashChange);
  searchForm.addEventListener("submit",onSubmit);
  void refresh();

  return Object.freeze({
    refresh,
    showReceipt,
    updateCoreStatus,
    destroy() {
      if(disposed) return;
      disposed=true;
      refreshGeneration+=1;
      accountsView?.destroy();
      settingsView?.destroy();
      generatorsView?.destroy();
      frameHost?.dispose();
      windowRef.removeEventListener("hashchange",onHashChange);
      searchForm.removeEventListener("submit",onSubmit);
    }
  });
}

// Core failure must never leave the dashboard with an empty, inaccessible navigation.
// This is a tab-local read-only shell; it does not attempt background recovery or work.
export function mountUnavailablePcmsShell({
  documentRef=globalThis.document,
  windowRef=globalThis.window
}={}) {
  const nav=section(documentRef,"primaryNav");
  const routes=[
    ["Overview","#/overview"],
    ["Attention","#/attention"],
    ["Accounts","#/accounts"],
    ["Generators","#/generators"],
    ["Modules","#/settings/modules"],
    ["Backup & restore","#/settings/backup"],
    ["Activity","#/activity"],
    ["Diagnostics","#/settings/diagnostics"]
  ];
  clear(nav);
  for(const [label,href] of routes){
    const link=element(documentRef,"a","nav-link");
    link.href=href;
    link.textContent=label;
    nav.appendChild(link);
  }
  // The page can be reloaded while Core is unavailable; no form should remain
  // actionable without a bound UI client.
  for(const form of documentRef.querySelectorAll(".live-form")){
    for(const control of form.querySelectorAll("button, input, select, textarea")) control.disabled=true;
  }
  function showRoute(){
    const resolved=resolvePcmsRouteV2(windowRef.location.hash,{accountIds:[],attentionIds:[]});
    const route=resolved.route;
    if(!resolved.valid||resolved.canonicalized) windowRef.history.replaceState(null,"",route.href);
    const diagnostics=route.route==="settings"&&route.section==="diagnostics";
    for(const id of ["viewOverview","viewModules","viewAttention","viewAccounts","viewSearch","viewDiagnostics","viewPlaceholder","viewSettingsBackup"]){
      section(documentRef,id).hidden=id!==(diagnostics?"viewDiagnostics":"viewPlaceholder");
    }
    section(documentRef,"placeholderHeading").textContent="PCMS Core unavailable";
    section(documentRef,"placeholderBody").textContent=
      "Background Core is unavailable. Open Settings → Diagnostics for the last known technical status.";
    for(const link of nav.children){
      if(link.getAttribute("href")===route.href) link.setAttribute("aria-current","page");
      else link.removeAttribute("aria-current");
    }
  }
  windowRef.addEventListener("hashchange",showRoute);
  showRoute();
  return Object.freeze({destroy(){windowRef.removeEventListener("hashchange",showRoute);}});
}

async function bootPcmsApp() {
  const pcms=installPcmsNamespace();
  document.getElementById("namespaceVersion").textContent="v"+pcms.version;
  document.getElementById("brokerVersion").textContent="v"+pcms.broker.contractVersion;
  document.getElementById("commandCount").textContent=String(pcms.broker.commandCount);
  document.getElementById("brokerImplementation").textContent=pcms.broker.implementation;

  let cachedStatus=null;
  try { cachedStatus=await readPcmsCachedStatus(); } catch {}
  const initial=presentPcmsCoreStatus(cachedStatus,{live:false,pending:!cachedStatus});
  const initialPill=document.getElementById("coreStatusPill");
  initialPill.textContent=initial.label;
  initialPill.dataset.token=initial.token;
  document.getElementById("diagnosticCoreState").textContent=initial.state;
  document.getElementById("diagnosticCoreAsOf").textContent=initial.asOf||"—";

  const liveStatus=document.getElementById("brokerLiveStatus");
  try {
    const runtime=await startPcmsRuntimeWithRetry({startRuntime:startPcmsLiveRuntime});
    liveStatus.textContent="Connected · rev "+runtime.brokerRevision;
    liveStatus.dataset.state="connected";
    document.getElementById("diagnosticBrokerBootId").textContent=String(runtime.brokerBootId||"—");
    document.getElementById("diagnosticBrokerRevision").textContent=String(runtime.brokerRevision??"—");
    const moduleProjectionService=createPcmsModuleProjectionService({runtime});
    const app=mountPcmsApp({
      projectionService:runtime.uiProjection,
      moduleProjectionService,
      runtime
    });
    app.updateCoreStatus(runtime.coreStatus,{live:true});
    const controls=bindPcmsLiveControls({
      runtime,
      documentRef:document,
      refresh:app.refresh
    });
    const unsubscribeReceipt=runtime.subscribeReceipt?.((receipt)=>app.showReceipt(receipt))||(()=>{});
    let lastSeq=-1;
    const unsubscribe=runtime.subscribe((revision)=>{
      if(!Number.isSafeInteger(revision?.seq)||revision.seq<=lastSeq) return;
      lastSeq=revision.seq;
      document.body.dataset.pcmsRevision=String(revision.seq);
      document.getElementById("diagnosticUiRevision").textContent=String(revision.seq);
      void app.refresh();
      void controls.refreshRecovery();
      void Promise.resolve(runtime.readCachedStatus?.()).then((status)=>{
        if(status) app.updateCoreStatus(status,{live:true});
      }).catch(()=>{});
    });
    window.addEventListener("unload",()=>{
      unsubscribe();
      unsubscribeReceipt();
      controls.close();
      app.destroy();
      runtime.close();
    },{once:true});
  } catch {
    const presentation=presentPcmsCoreStatus({state:"UNAVAILABLE"},{live:false});
    const pill=document.getElementById("coreStatusPill");
    pill.textContent=presentation.label;
    pill.dataset.token=presentation.token;
    document.getElementById("diagnosticCoreState").textContent=presentation.state;
    liveStatus.textContent="Unavailable";
    liveStatus.dataset.state="error";
    document.getElementById("coreHostStatus").textContent="Background · unavailable";
    document.getElementById("coreHostStatus").dataset.state="error";
    document.getElementById("notificationStatus").textContent="PCMS Core is unavailable. Open Diagnostics for technical status.";
    document.getElementById("notificationStatus").dataset.state="error";
    const unavailable=mountUnavailablePcmsShell();
    window.addEventListener("unload",unavailable.destroy,{once:true});
  }
}

void bootPcmsApp();
