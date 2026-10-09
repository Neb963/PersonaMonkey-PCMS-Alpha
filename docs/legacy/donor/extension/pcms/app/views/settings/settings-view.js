// Settings → Backup & restore and Settings → Modules (P041). A UI client only: every effect
// is a pcms.ui-client/v1 command to the background Core, which repeats each check itself.
import {
  PCMS_RESTORE_PHRASE,
  parsePcmsBackupFile,
  pcmsBackupFileText,
  pcmsBackupFilename,
  pcmsBackupId,
  pcmsConfirmedRestore,
  pcmsRestoreGate,
  presentPcmsRecoveryChecklist,
  presentPcmsRestorePreview
} from "./backup-model.js";
import {
  PCMS_MODULE_ARCHIVE_MAX_BYTES,
  pcmsModuleConfirmModel,
  pcmsModuleReviewModel,
  pcmsModulesPageModel,
  pcmsTypedConfirmationMatches
} from "./modules-model.js";

function el(doc,tag,cls,text){
  const node=doc.createElement(tag);
  if(cls) node.className=cls;
  if(text!==undefined&&text!==null) node.textContent=String(text);
  return node;
}
function clear(node){while(node.firstChild) node.removeChild(node.firstChild);}
function button(doc,label,data={}){
  const node=el(doc,"button",null,label);
  node.type="button";
  for(const [key,value] of Object.entries(data)) node.dataset[key]=value;
  return node;
}
function errorText(error){
  const code=typeof error?.code==="string"?error.code:null;
  const message=typeof error?.message==="string"&&error.message?error.message:"The request failed.";
  return code?message+" ("+code+")":message;
}
function randomSuffix(){
  const bytes=new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}
async function readFileText(file,maxBytes){
  if(!file) return null;
  if(typeof file.size==="number"&&file.size>maxBytes) throw Object.assign(new Error("The chosen file is too large."),{code:"PCMS_FILE_TOO_LARGE"});
  return file.text();
}

export function createPcmsSettingsView({documentRef,windowRef,runtime,onChanged=async()=>{},now=()=>new Date()}={}){
  if(!documentRef||!windowRef||typeof runtime?.backupRestore?.stageRestore!=="function"||typeof runtime?.modules?.list!=="function"){
    throw new TypeError("Settings requires the PCMS UI-client runtime");
  }
  const backupHost=documentRef.getElementById("settingsBackup");
  const modulesHost=documentRef.getElementById("settingsModulesManager");
  if(!backupHost||!modulesHost) throw new Error("Settings view hosts are missing");
  let dead=false;
  const cleanups=[];
  function on(node,type,handler){node.addEventListener(type,handler);cleanups.push(()=>node.removeEventListener(type,handler));}
  async function changed(){try{await onChanged();}catch{}}

  // ---- Backup & restore --------------------------------------------------------------------
  const status=el(documentRef,"p","settings-status");
  status.dataset.recoveryStatus="loading";
  status.textContent="Loading recovery state…";
  const note=el(documentRef,"p","settings-note","Backups never contain secret values; credentials are kept as references only.");
  const createBtn=button(documentRef,"Create backup",{backupCreate:"true"});
  createBtn.className="settings-primary";
  const download=el(documentRef,"a","settings-download");
  download.hidden=true;
  const backupFeedback=el(documentRef,"p","settings-feedback");
  backupFeedback.setAttribute("role","status");
  backupFeedback.setAttribute("aria-live","polite");
  backupFeedback.dataset.backupFeedback="";

  const restoreHeading=el(documentRef,"h3",null,"Restore");
  const fileLabel=el(documentRef,"label","settings-file","Choose backup file… ");
  const fileInput=el(documentRef,"input");
  fileInput.type="file";
  fileInput.accept=".json,application/json";
  fileInput.dataset.restoreFile="true";
  fileLabel.appendChild(fileInput);

  const preview=el(documentRef,"div","settings-preview");
  preview.dataset.restorePreview="none";
  preview.hidden=true;
  const previewSummary=el(documentRef,"p","settings-preview-summary");
  const previewGroups=el(documentRef,"p","settings-preview-groups");
  const previewDiff=el(documentRef,"p","settings-preview-diff");
  const previewModules=el(documentRef,"p","settings-preview-modules");
  const previewEffects=el(documentRef,"ul","settings-preview-effects");
  const typedLabel=el(documentRef,"label","settings-typed","Type "+PCMS_RESTORE_PHRASE+" to continue ");
  const typed=el(documentRef,"input");
  typed.autocomplete="off";
  typed.spellcheck=false;
  typed.dataset.restoreTyped="true";
  typedLabel.appendChild(typed);
  const restoreBtn=button(documentRef,"Restore",{restoreApply:"true"});
  restoreBtn.className="danger";
  restoreBtn.disabled=true;
  const restoreCancel=button(documentRef,"Cancel",{restoreCancel:"true"});
  const gateText=el(documentRef,"small","settings-gate");
  const previewActions=el(documentRef,"div","operator-actions");
  previewActions.append(restoreCancel,restoreBtn);
  preview.append(previewSummary,previewGroups,previewDiff,previewModules,previewEffects,typedLabel,gateText,previewActions);

  const checklist=el(documentRef,"section","settings-checklist");
  checklist.dataset.recoveryChecklist="none";
  checklist.hidden=true;
  const checklistHeading=el(documentRef,"h3",null,"Checks before changes can resume");
  const checklistList=el(documentRef,"ul","settings-checklist-items");
  const resumeBtn=button(documentRef,"Resume normal operation",{recoveryResume:"true"});
  resumeBtn.disabled=true;
  const resumeHint=el(documentRef,"small","settings-gate","Enabled when all checks pass.");
  checklist.append(checklistHeading,checklistList,resumeBtn,resumeHint);

  backupHost.append(status,note,createBtn,download,restoreHeading,fileLabel,preview,checklist,backupFeedback);

  let stage=null;
  let busy=false;
  let downloadUrl=null;

  function feedback(node,text,state="info"){node.textContent=text;node.dataset.state=state;}

  function updateGate(){
    const gate=pcmsRestoreGate({stage,typed:typed.value,busy});
    restoreBtn.disabled=!gate.enabled;
    gateText.textContent=gate.reason||"";
    preview.dataset.restoreGate=gate.enabled?"open":"closed";
  }

  function clearStage(){
    stage=null;
    typed.value="";
    preview.hidden=true;
    preview.dataset.restorePreview="none";
    fileInput.value="";
    updateGate();
  }

  function showPreview(staged){
    const view=presentPcmsRestorePreview(staged.preview);
    previewSummary.textContent=view.summary;
    previewGroups.textContent=view.groups.join(" · ");
    previewDiff.textContent=view.differences;
    previewModules.textContent=view.modules;
    clear(previewEffects);
    for(const line of view.effects) previewEffects.appendChild(el(documentRef,"li",null,line));
    preview.hidden=false;
    preview.dataset.restorePreview=staged.preview.backupId;
    typed.value="";
    updateGate();
  }

  async function renderChecklist(){
    let list;
    try{list=await runtime.backupRestore.recoveryChecklist();}
    catch(error){
      status.textContent="Recovery state is unavailable · "+errorText(error);
      status.dataset.recoveryStatus="UNAVAILABLE";
      return;
    }
    if(dead) return;
    const view=presentPcmsRecoveryChecklist(list);
    status.textContent=(view.held?"⏸ ":"✓ ")+view.status;
    status.dataset.recoveryStatus=view.held?"RECOVERY_HOLD":"NORMAL";
    checklist.hidden=!view.held;
    checklist.dataset.recoveryChecklist=view.held?String(view.failing):"none";
    clear(checklistList);
    for(const row of view.rows){
      const item=el(documentRef,"li","settings-check");
      item.dataset.checkId=row.id;
      item.dataset.checkStatus=row.status;
      item.appendChild(el(documentRef,"span","settings-check-mark",row.mark));
      const link=el(documentRef,"a","settings-check-subject",row.label);
      link.href=row.href;
      link.dataset.checkSubject=row.href;
      item.appendChild(link);
      if(row.detail) item.appendChild(el(documentRef,"small",null,row.detail));
      if(row.operationId){
        item.appendChild(button(documentRef,"Check",{checkOperation:row.operationId}));
      }
      checklistList.appendChild(item);
    }
    resumeBtn.disabled=!view.canResume||busy;
    resumeBtn.dataset.canResume=String(view.canResume);
  }

  on(createBtn,"click",async()=>{
    if(busy) return;
    busy=true;createBtn.disabled=true;
    feedback(backupFeedback,"Creating backup…");
    try{
      const when=now();
      const backup=await runtime.backupRestore.createBackup({backupId:pcmsBackupId(when,randomSuffix())});
      const filename=pcmsBackupFilename(when);
      if(downloadUrl) windowRef.URL.revokeObjectURL(downloadUrl);
      downloadUrl=windowRef.URL.createObjectURL(new windowRef.Blob([pcmsBackupFileText(backup)],{type:"application/json"}));
      download.href=downloadUrl;
      download.download=filename;
      download.dataset.backupDownload=filename;
      download.textContent="Download "+filename+" again";
      download.hidden=false;
      download.click?.();
      feedback(backupFeedback,"Backup "+backup.backupId+" created · "+backup.recordCount+" records · saved as "+filename,"connected");
    }catch(error){
      feedback(backupFeedback,"Backup failed · "+errorText(error),"error");
    }finally{busy=false;createBtn.disabled=false;}
  });

  on(fileInput,"change",async()=>{
    const file=fileInput.files?.[0]||null;
    if(!file) return;
    stage=null;updateGate();
    feedback(backupFeedback,"Checking "+file.name+"…");
    try{
      const raw=parsePcmsBackupFile(await readFileText(file,15*1024*1024));
      const staged=await runtime.backupRestore.stageRestore(raw);
      if(dead) return;
      stage=staged;
      showPreview(staged);
      feedback(backupFeedback,"Preview ready. Nothing has changed yet.","connected");
    }catch(error){
      clearStage();
      feedback(backupFeedback,"This backup cannot be restored · "+errorText(error),"error");
    }
  });
  on(typed,"input",updateGate);
  on(restoreCancel,"click",()=>{clearStage();feedback(backupFeedback,"Restore cancelled; nothing was changed.");});
  on(restoreBtn,"click",async()=>{
    if(!pcmsRestoreGate({stage,typed:typed.value,busy}).enabled) return;
    busy=true;updateGate();
    feedback(backupFeedback,"Restoring…");
    try{
      const result=await runtime.backupRestore.applyStagedRestore(pcmsConfirmedRestore(stage,typed.value));
      feedback(backupFeedback,"Restored "+result.backupId+". PCMS is on hold until the checks below pass.","warning");
      busy=false;
      clearStage();
      await renderChecklist();
      await changed();
    }catch(error){
      busy=false;updateGate();
      feedback(backupFeedback,"Restore failed · "+errorText(error),"error");
    }
  });
  on(checklistList,"click",async(event)=>{
    const target=event.target?.closest?.("[data-check-operation]");
    if(!target||busy) return;
    event.preventDefault?.();
    busy=true;target.disabled=true;
    feedback(backupFeedback,"Checking operation…");
    try{
      const result=await runtime.backupRestore.reconcileOperation(target.dataset.checkOperation);
      feedback(backupFeedback,result.resolved?"Operation settled.":"Outcome still unknown · "+String(result.state||""),result.resolved?"connected":"warning");
    }catch(error){
      feedback(backupFeedback,"Check failed · "+errorText(error),"error");
    }finally{
      busy=false;
      await renderChecklist();
      await changed();
    }
  });
  on(resumeBtn,"click",async()=>{
    if(busy||resumeBtn.disabled) return;
    busy=true;resumeBtn.disabled=true;
    feedback(backupFeedback,"Running final checks…");
    try{
      const result=await runtime.backupRestore.reconcileAndRelease();
      feedback(backupFeedback,result.released
        ?"Checks passed. Normal operation resumed."
        :"Still on hold: "+(result.unresolvedOperationIds.length?result.unresolvedOperationIds.length+" operation(s) need checking.":"a check is still failing."),
      result.released?"connected":"warning");
    }catch(error){
      feedback(backupFeedback,"Resume failed · "+errorText(error),"error");
    }finally{
      busy=false;
      await renderChecklist();
      await changed();
    }
  });

  // ---- Modules -------------------------------------------------------------------------------
  const runtimeLine=el(documentRef,"p","settings-note");
  runtimeLine.dataset.modulesRuntime="loading";
  const table=el(documentRef,"table","settings-modules");
  const head=el(documentRef,"thead");
  const headRow=el(documentRef,"tr");
  for(const label of ["Module","Version","Source","State",""]) headRow.appendChild(el(documentRef,"th",null,label));
  head.appendChild(headRow);
  const body=el(documentRef,"tbody");
  table.append(head,body);
  const installLabel=el(documentRef,"label","settings-file","Install from file… ");
  const installInput=el(documentRef,"input");
  installInput.type="file";
  installInput.accept=".json,.pcms,.txt,application/json,text/plain";
  installInput.dataset.moduleInstall="true";
  installLabel.appendChild(installInput);
  const dialog=el(documentRef,"div","settings-dialog");
  dialog.setAttribute("role","dialog");
  dialog.hidden=true;
  dialog.dataset.moduleDialog="closed";
  const modulesFeedback=el(documentRef,"p","settings-feedback");
  modulesFeedback.setAttribute("role","status");
  modulesFeedback.setAttribute("aria-live","polite");
  modulesFeedback.dataset.modulesFeedback="";
  modulesHost.append(runtimeLine,table,installLabel,dialog,modulesFeedback);

  let lastModules=new Map();
  let moduleBusy=false;
  let dialogResolve=null;

  function closeDialog(result){
    const resolve=dialogResolve;
    dialogResolve=null;
    clear(dialog);
    dialog.hidden=true;
    dialog.dataset.moduleDialog="closed";
    resolve?.(result);
  }

  // Review: Approve / Reject. Confirm: Confirm / Cancel, with an optional typed phrase.
  function openDialog({kind,title,risk,lines,capabilities=null,phrase=null,acceptLabel,rejectLabel="Cancel"}){
    if(dialogResolve) closeDialog(null);
    clear(dialog);
    dialog.dataset.moduleDialog=kind;
    if(risk) dialog.dataset.risk=risk;
    dialog.appendChild(el(documentRef,"h3",null,title));
    const list=el(documentRef,"ul");
    for(const line of lines||[]) list.appendChild(el(documentRef,"li",null,line));
    for(const item of capabilities||[]){
      const li=el(documentRef,"li",item.added?"capability-new":null);
      if(item.added) li.appendChild(el(documentRef,"strong",null,"New: "));
      li.appendChild(documentRef.createTextNode("can "+item.text));
      li.dataset.capability=item.capability;
      li.dataset.capabilityNew=String(item.added);
      list.appendChild(li);
    }
    dialog.appendChild(list);
    let typedInput=null;
    const accept=button(documentRef,acceptLabel,{dialogAccept:"true"});
    accept.className=risk==="DESTRUCTIVE"?"danger":"settings-primary";
    if(phrase!==null){
      const label=el(documentRef,"label","settings-typed","Type "+phrase+" to confirm ");
      typedInput=el(documentRef,"input");
      typedInput.autocomplete="off";
      typedInput.spellcheck=false;
      typedInput.dataset.dialogTyped="true";
      label.appendChild(typedInput);
      dialog.appendChild(label);
      accept.disabled=true;
      typedInput.addEventListener("input",()=>{accept.disabled=typedInput.value!==phrase;});
    }
    const reject=button(documentRef,rejectLabel,{dialogReject:"true"});
    const actions=el(documentRef,"div","operator-actions");
    actions.append(reject,accept);
    dialog.appendChild(actions);
    dialog.hidden=false;
    return new Promise((resolve)=>{
      dialogResolve=resolve;
      accept.addEventListener("click",()=>{if(!accept.disabled) closeDialog({accepted:true,typed:typedInput?.value??null});});
      reject.addEventListener("click",()=>closeDialog({accepted:false}));
    });
  }

  async function renderModules(){
    let listed;
    try{listed=await runtime.modules.list();}
    catch(error){
      runtimeLine.textContent="Modules are unavailable · "+errorText(error);
      runtimeLine.dataset.modulesRuntime="UNAVAILABLE";
      return;
    }
    if(dead) return;
    lastModules=new Map((listed.modules||[]).map((item)=>[item.moduleId,item]));
    const model=pcmsModulesPageModel(listed);
    runtimeLine.textContent=model.runtimeMessage;
    runtimeLine.dataset.modulesRuntime=model.runtimeAvailable?"AVAILABLE":"UNAVAILABLE";
    installInput.disabled=!model.runtimeAvailable||moduleBusy;
    clear(body);
    for(const row of model.rows){
      const tr=el(documentRef,"tr");
      tr.dataset.moduleRow=row.moduleId;
      tr.dataset.moduleSource=row.source;
      tr.dataset.state=row.state;
      tr.dataset.token=row.token;
      tr.appendChild(el(documentRef,"td",null,row.title));
      tr.appendChild(el(documentRef,"td",null,row.version||"—"));
      tr.appendChild(el(documentRef,"td",null,row.source));
      const state=el(documentRef,"td");
      const pill=el(documentRef,"span","status-token",row.state);
      pill.dataset.token=row.token;
      state.appendChild(pill);
      if(row.detail) state.appendChild(el(documentRef,"small",null," "+row.detail));
      tr.appendChild(state);
      const actions=el(documentRef,"td","settings-row-actions");
      for(const item of row.actions){
        const node=button(documentRef,item.label,{moduleAction:item.id,moduleId:row.moduleId});
        if(item.packageHash) node.dataset.packageHash=item.packageHash;
        node.disabled=moduleBusy;
        actions.appendChild(node);
      }
      tr.appendChild(actions);
      body.appendChild(tr);
    }
  }

  async function review(module){
    const model=pcmsModuleReviewModel(module);
    const answer=await openDialog({
      kind:"review",title:model.title,risk:"LOCAL",
      lines:["This module asks to:"],
      capabilities:model.capabilities,
      acceptLabel:"Approve",rejectLabel:"Reject"
    });
    if(answer===null) return null;
    if(answer.accepted) return runtime.modules.approve(model.moduleId,model.packageHash);
    return runtime.modules.reject(model.moduleId,model.packageHash);
  }

  async function runModuleCommand(label,fn){
    if(moduleBusy) return;
    moduleBusy=true;
    feedback(modulesFeedback,label+"…");
    try{
      const result=await fn();
      if(result!==undefined) feedback(modulesFeedback,result,"connected");
    }catch(error){
      feedback(modulesFeedback,label+" failed · "+errorText(error),"error");
    }finally{
      moduleBusy=false;
      await renderModules();
      await changed();
    }
  }

  function describeResult(result,fallback){
    if(!result) return fallback;
    if(result.purged===true) return result.moduleId+" purged · "+result.dataKeysDeleted+" data entries deleted.";
    if(result.installed===false) return result.moduleId+" is no longer installed.";
    return result.moduleId+" · "+String(result.status||"").toLowerCase().replaceAll("_"," ")+(result.version?" · "+result.version:"");
  }

  on(installInput,"change",async()=>{
    const file=installInput.files?.[0]||null;
    if(!file) return;
    await runModuleCommand("Installing "+file.name,async()=>{
      const text=await readFileText(file,PCMS_MODULE_ARCHIVE_MAX_BYTES);
      installInput.value="";
      let result=await runtime.modules.install(text);
      if(result?.candidate?.state==="AWAITING_APPROVAL"){
        moduleBusy=false;
        await renderModules();
        moduleBusy=true;
        const reviewed=await review(result);
        if(reviewed===null) return result.moduleId+" is waiting for approval.";
        result=reviewed;
      }
      return describeResult(result,"Installed.");
    });
  });

  on(body,"click",async(event)=>{
    const target=event.target?.closest?.("[data-module-action]");
    if(!target||moduleBusy) return;
    const id=target.dataset.moduleId;
    const kind=target.dataset.moduleAction;
    const module=lastModules.get(id);
    if(!module) return;
    if(kind==="review"){
      await runModuleCommand("Reviewing "+id,async()=>{
        const result=await review(module);
        return result===null?id+" is waiting for approval.":describeResult(result,"Done.");
      });
      return;
    }
    if(kind==="enable") return runModuleCommand("Enabling "+id,async()=>describeResult(await runtime.modules.enable(id)));
    if(kind==="disable") return runModuleCommand("Disabling "+id,async()=>describeResult(await runtime.modules.disable(id)));
    const packageHash=target.dataset.packageHash||null;
    const model=pcmsModuleConfirmModel(kind,{moduleId:id},{packageHash});
    await runModuleCommand(model.confirmLabel+" "+id,async()=>{
      const answer=await openDialog({
        kind,title:model.title,risk:model.risk,lines:model.lines,phrase:model.phrase,acceptLabel:model.confirmLabel
      });
      if(!answer?.accepted) return "Cancelled; nothing was changed.";
      if(!pcmsTypedConfirmationMatches(model,answer.typed)) return "Cancelled; the typed name did not match.";
      if(kind==="rollback") return describeResult(await runtime.modules.rollback(id,packageHash));
      if(kind==="remove") return describeResult(await runtime.modules.remove(id));
      if(kind==="purge") return describeResult(await runtime.modules.purge(id));
      return "Nothing to do.";
    });
  });

  async function refresh(route){
    if(dead||route?.route!=="settings") return;
    if(route.section==="backup") await renderChecklist();
    if(route.section==="modules"&&!moduleBusy) await renderModules();
  }

  return Object.freeze({
    refresh,
    destroy(){
      if(dead) return;
      dead=true;
      closeDialog(null);
      if(downloadUrl) try{windowRef.URL.revokeObjectURL(downloadUrl);}catch{}
      for(const cleanup of cleanups) cleanup();
    }
  });
}
