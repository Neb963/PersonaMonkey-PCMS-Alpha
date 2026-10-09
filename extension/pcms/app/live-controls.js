// Attention handoff controls (ADR-002 §9): show an assisted-handoff confirmation, record the
// operator's answer and resolve a HumanTask. The P026 operator forms that used to live here were
// removed in P040; their workflows are module pages (Refresher, Explorer, Provisioning, Deployer),
// the Accounts view (P034) and Settings → Backup & restore (P041).

function setStatus(documentRef,message,state="",key="system"){
  const list=documentRef.getElementById("actionTrayLocalList")||documentRef.getElementById("liveActionStatus");
  if(!list)return;
  let node=[...list.children].find((child)=>child.dataset?.actionKey===key);
  if(!node){
    node=documentRef.createElement("div");
    node.className="action-local";
    node.dataset.actionKey=key;
    list.prepend(node);
  }
  node.textContent=message;
  node.dataset.state=state;
  const empty=documentRef.getElementById("actionTrayEmpty");
  if(empty)empty.hidden=true;
}
function errorMessage(error){
  // ADR-002 §9: an assisted provider step is handed off, so its outcome is not known yet.
  if(typeof error?.code==="string"&&/PROVIDER_PROTOCOL$/.test(error.code)) {
    return "Outcome not confirmed yet. If PCMS opened a confirmation in Attention, answer it there; PCMS will not replay the action.";
  }
  return error?.code?error.code+": "+error.message:(error?.message||String(error));
}

export function bindPcmsLiveControls({runtime,documentRef=globalThis.document,refresh=async()=>{}}={}){
  if(!runtime||!documentRef) throw new TypeError("Live controls require runtime and document");
  const cleanups=[];

  function on(target,event,handler){
    target?.addEventListener(event,handler);
    if(target)cleanups.push(()=>target.removeEventListener(event,handler));
  }
  const attention=documentRef.getElementById("attentionList");
  const handoffDetail=documentRef.getElementById("handoffDetail");
  function showHandoff(detail){
    if(!handoffDetail)return;
    documentRef.getElementById("handoffTitle").textContent=detail.title||"Waiting for your confirmation";
    documentRef.getElementById("handoffInstructions").textContent=detail.instructions||"";
    documentRef.getElementById("handoffHash").textContent=detail.sourceHash?"SHA-256: "+detail.sourceHash:"";
    const source=documentRef.getElementById("handoffSource");
    source.value=detail.source||"";
    documentRef.getElementById("handoffSourceLabel").hidden=!detail.source;
    documentRef.getElementById("handoffCopy").hidden=!detail.source;
    handoffDetail.hidden=false;
  }
  on(documentRef.getElementById("handoffClose"),"click",()=>{if(handoffDetail)handoffDetail.hidden=true;});
  on(documentRef.getElementById("handoffCopy"),"click",async()=>{
    const source=documentRef.getElementById("handoffSource");
    const copy=documentRef.getElementById("handoffCopy");
    try{await globalThis.navigator?.clipboard?.writeText?.(source.value);copy.textContent="Copied";}
    catch{source.focus();source.select();copy.textContent="Selected — press Ctrl+C";}
  });
  on(attention,"click",async(event)=>{
    const show=event.target.closest?.("[data-handoff-show]");
    if(show){
      event.preventDefault();
      try{
        const detail=await runtime.providerHandoff.describe(show.dataset.handoffShow);
        if(!detail)throw new Error("This confirmation is no longer available");
        showHandoff(detail);
      }catch(error){setStatus(documentRef,errorMessage(error),"error");}
      return;
    }
    const answer=event.target.closest?.("[data-handoff-task]");
    if(answer){
      event.preventDefault();
      setStatus(documentRef,"Recording your answer…");
      try{
        const result=await runtime.providerHandoff.answer(answer.dataset.handoffTask,answer.dataset.handoffOutcome);
        if(handoffDetail)handoffDetail.hidden=true;
        setStatus(documentRef,"Answer recorded · operation "+String(result.operationState||"unknown"),"connected");
        await refresh();
      }catch(error){setStatus(documentRef,errorMessage(error),"error");}
      return;
    }
    const button=event.target.closest?.("[data-resolve-task]");
    if(!button)return;
    event.preventDefault();
    setStatus(documentRef,"Resolving HumanTask…");
    try{
      const task=await runtime.humanTasks.get(button.dataset.resolveTask);
      if(!task)throw new Error("HumanTask not found");
      await runtime.humanTasks.resolve(task.value.taskId,{expectedRevision:task.revision,resolutionCode:"completed"});
      setStatus(documentRef,"HumanTask resolved.","connected");
      await refresh();
    }catch(error){
      setStatus(documentRef,errorMessage(error),"error");
    }
  });

  return Object.freeze({
    // Recovery state lives in Settings → Backup & restore (P041); kept for the shell's call site.
    refreshRecovery(){return Promise.resolve();},
    close(){for(const cleanup of cleanups)cleanup();}
  });
}
