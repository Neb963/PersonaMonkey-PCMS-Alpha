// Module action invocation from the dashboard (pcms.ui-contribution/v1 §4.7, §5).
// Preview first when the action declares one; confirm-risk actions are confirmed in a
// Core-rendered dialog (never inside a module frame); execute reuses the preview's
// idempotency key. Core repeats the confirmation and recovery-hold checks itself.

function randomKey(){
  const bytes=new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return "uia-"+[...bytes].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

const RISK_TEXT=Object.freeze({
  EXTERNAL_MUTATION:"This changes state outside PCMS.",
  BINDING:"This changes which Persona or account something is bound to.",
  DESTRUCTIVE:"This removes data and cannot be undone.",
  RESOLUTION:"This records a decision that settles an open item."
});

export function pcmsActionConfirmation(moduleTitle,action,impact){
  return Object.freeze({
    title:impact?.title||action.label+"?",
    module:moduleTitle,
    risk:action.risk,
    consequences:Object.freeze(impact?.consequences?.length?[...impact.consequences]:[RISK_TEXT[action.risk]||"Please confirm this action."]),
    excluded:Object.freeze([...(impact?.excluded||[])]),
    confirmLabel:impact?.confirmLabel||action.label
  });
}

export function createPcmsModuleActionRunner({runtime,confirm,newKey=randomKey}={}){
  if(typeof runtime?.ui?.invoke!=="function"||typeof runtime.ui.preview!=="function") throw new TypeError("Module actions require the PCMS UI client");
  if(typeof confirm!=="function") throw new TypeError("Module actions require a Core confirmation dialog");

  async function run({module,action,target=null,input=null}){
    if(!module||!action) throw new TypeError("Module action is invalid");
    if(action.held){
      const error=new Error("Recovery hold: this action is paused until reconciliation");
      error.code="PCMS_UI_RECOVERY_HOLD";
      throw error;
    }
    const idempotencyKey=newKey();
    let impact=null;
    if(action.preview){
      const preview=await runtime.ui.preview(module.moduleId,action.id,target,input);
      impact=preview?.impact||null;
    }
    if(action.confirm||impact){
      const accepted=await confirm(pcmsActionConfirmation(module.title,action,impact));
      if(accepted!==true) return Object.freeze({cancelled:true,moduleId:module.moduleId,actionId:action.id});
    }
    const receipt=await runtime.ui.invoke(module.moduleId,action.id,target,input,{idempotencyKey,confirmed:action.confirm===true||Boolean(impact)});
    return Object.freeze({cancelled:false,...receipt});
  }

  return Object.freeze({run});
}

// The Core dialog: rendered by the dashboard into its own <dialog>, outside any module frame.
export function createPcmsConfirmDialog({documentRef=globalThis.document}={}){
  const dialog=documentRef.getElementById("moduleConfirmDialog");
  if(!dialog) throw new Error("PCMS confirm dialog is missing");
  const title=documentRef.getElementById("moduleConfirmTitle");
  const moduleLine=documentRef.getElementById("moduleConfirmModule");
  const list=documentRef.getElementById("moduleConfirmConsequences");
  const accept=documentRef.getElementById("moduleConfirmAccept");
  const cancel=documentRef.getElementById("moduleConfirmCancel");
  let pending=null;

  function finish(result){
    const resolve=pending;
    pending=null;
    dialog.dataset.state="closed";
    dialog.removeAttribute("open");
    dialog.hidden=true;
    resolve?.(result);
  }
  accept.addEventListener("click",(event)=>{event.preventDefault();finish(true);});
  cancel.addEventListener("click",(event)=>{event.preventDefault();finish(false);});
  dialog.addEventListener("cancel",(event)=>{event.preventDefault();finish(false);});

  return function confirm(model){
    if(pending) finish(false);
    title.textContent=model.title;
    moduleLine.textContent=model.module+" · "+model.risk.replaceAll("_"," ").toLowerCase();
    while(list.firstChild) list.removeChild(list.firstChild);
    for(const text of model.consequences){
      const item=documentRef.createElement("li");
      item.textContent=text;
      list.appendChild(item);
    }
    for(const excluded of model.excluded){
      const item=documentRef.createElement("li");
      item.textContent="Excluded: "+excluded.subject.id+" — "+excluded.reason;
      list.appendChild(item);
    }
    accept.textContent=model.confirmLabel;
    dialog.dataset.risk=model.risk;
    dialog.dataset.state="open";
    // Non-modal on purpose: nothing has executed yet and nothing waits in this tab's
    // memory except the operator's answer; closing the tab simply cancels (ADR-002 §9).
    dialog.hidden=false;
    dialog.setAttribute("open","");
    cancel.focus?.();
    return new Promise((resolve)=>{pending=resolve;});
  };
}
