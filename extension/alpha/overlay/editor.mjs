/** P303 compact Perchance editor review surface. No provider mutation, no
 * privileged runtime message, and no alternate browser automation. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const STYLES = `
:host{all:initial;position:fixed;top:14px;right:14px;z-index:2147483000;max-width:calc(100vw - 28px);
 color-scheme:light dark;font:13px/1.45 system-ui,-apple-system,sans-serif}
section{box-sizing:border-box;max-width:315px;min-width:245px;padding:12px 14px;border:1px solid #7b8799;
 border-radius:10px;color:CanvasText;background:Canvas;box-shadow:0 3px 15px #0002}
h2{font-size:14px;margin:0 0 6px;font-weight:650}
p{margin:5px 0 9px;overflow-wrap:anywhere}
small{display:block;opacity:.8;margin-bottom:8px}
button{font:inherit;font-weight:600;border:1px solid #45659a;border-radius:6px;padding:7px 10px;
 background:ButtonFace;color:ButtonText;cursor:pointer}
button:focus-visible{outline:2px solid Highlight;outline-offset:3px}
button:disabled{cursor:not-allowed;opacity:.55}
[role=status]{font-size:12px;min-height:1.5em}
`;
function editorSlug(url) {
  try {
    const u=new URL(url);
    const key=u.pathname.slice(1);
    return u.protocol==='https:'&&u.hostname==='perchance.org'&&!u.port&&!u.username&&!u.password&&
      !u.search&&u.hash==='#edit'&&SLUG.test(key)&&u.pathname==='/'+key?key:null;
  }catch{return null;}
}
export function reviewEditorState({url,task,binding,sourceRevision}={}) {
  const key=editorSlug(url);
  if (!key) return {enabled:false,reason:'NOT_EDITOR'};
  if(!task||typeof task!=='object'||!binding||typeof binding!=='object'||
    task.key!==key||task.accountId!==binding.accountId||task.personaUid!==binding.personaUid||
    task.bindingEpoch!==binding.epoch||!Number.isSafeInteger(task.revision)||task.revision<1) {
    return {enabled:false,reason:'STALE_BINDING'};
  }
  if(task.state!=='COMPLETED'||task.reviewPending!==true||task.approvalRevision!==null||
    typeof task.savedSourceHash!=='string'||!HASH.test(task.savedSourceHash)||
    typeof task.savedSourceRevision!=='string'||task.savedSourceRevision.length<1) {
    return {enabled:false,reason:'REVIEW_NOT_READY'};
  }
  if(sourceRevision!==task.savedSourceRevision) return {enabled:false,reason:'STALE_EDITOR'};
  return {enabled:true,reason:null,key,accountId:task.accountId,epoch:task.bindingEpoch,taskId:task.id,
    taskRevision:task.revision,sourceHash:task.savedSourceHash,sourceRevision:task.savedSourceRevision};
}
export function createApprovalIntent({url,task,binding,sourceRevision,opId,expectedRevision}={}) {
  const check=reviewEditorState({url,task,binding,sourceRevision});
  if(!check.enabled||typeof opId!=='string'||!ID.test(opId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0) {
    const e=new Error(check.reason||'INVALID_REQUEST');e.code=check.reason==='STALE_EDITOR'?'SOURCE_DRIFT':'INVALID_REQUEST';throw e;
  }
  // This is ONLY the AI review approval intent for P402. It does not save,
  // publish, make a GitHub commit, switch public listing, or activate Refresher.
  return Object.freeze({command:'aiReview.approveIntent',expectedRevision,
    params:{key:check.key,accountId:check.accountId,accountBindingEpoch:check.epoch,
      expectedRevision,opId,options:{taskId:check.taskId,expectedTaskRevision:check.taskRevision,
        sourceHash:check.sourceHash,sourceRevision:check.sourceRevision,editorUrl:url}}});
}

/** Host is mounted by a future approved PersonaMonkey-owned page/injection
 * path. getContext/revision/approve are trusted callbacks, not direct browser
 * messaging from the Perchance origin. Without them, the action is disabled. */
export function mountAiReviewOverlay({document:doc,view,host,loadContext,requestApproval,createOpId}={}) {
  if(!doc||typeof doc.createElement!=='function'||!view||typeof view.addEventListener!=='function'||
    !host||typeof host.attachShadow!=='function') throw new TypeError('Overlay requires a host and document');
  const shadow=host.attachShadow({mode:'closed'});
  const style=doc.createElement('style');style.textContent=STYLES;shadow.appendChild(style);
  const panel=doc.createElement('section'); panel.setAttribute('aria-label','PCMS AI review');
  const heading=doc.createElement('h2');heading.textContent='PCMS AI review';panel.appendChild(heading);
  const description=doc.createElement('p');description.textContent='Save changes in Perchance first. Review approval only records intent; it does not publish.';
  panel.appendChild(description);
  const details=doc.createElement('small');panel.appendChild(details);
  const button=doc.createElement('button');button.type='button';button.textContent='Request Mark ready';button.disabled=true;
  panel.appendChild(button);
  const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  panel.appendChild(status);shadow.appendChild(panel);
  let latest=null,disposed=false,sequence=0,busy=false;
  async function refresh() {
    const request=++sequence;
    button.disabled=true;
    const url=String(view.location?.href??'');
    if(!editorSlug(url)){latest=null;status.textContent='Editor context unavailable.';return;}
    if(typeof loadContext!=='function'||typeof requestApproval!=='function'||typeof createOpId!=='function'){
      latest=null;status.textContent='Connect through the authorized PersonaMonkey review panel.';return;
    }
    try{
      const current=await loadContext({url});
      if(disposed||request!==sequence)return;
      const state=reviewEditorState({url,task:current?.task,binding:current?.binding,
        sourceRevision:current?.sourceRevision});
      latest=state.enabled?current:null;
      details.textContent=state.enabled?`${state.key} · revision ${state.taskRevision}`:'Review unavailable';
      status.textContent=state.enabled?'Source verified. Approval request available.':`Review blocked: ${state.reason}.`;
      button.disabled=busy||!state.enabled;
    }catch{
      if(disposed||request!==sequence)return;
      latest=null;status.textContent='Unable to reconnect to authoritative review state.';
    }
  }
  async function approve() {
    if(disposed||busy||!latest)return;
    busy=true;button.disabled=true;status.textContent='Verifying current saved source…';
    const current=latest;latest=null;
    try {
      // Always refresh before sending a one-shot intent. A stale or reloaded
      // editor is never allowed to approve an unrelated Generator or Persona.
      const updated=await loadContext({url:String(view.location.href)});
      if(disposed)return;
      const opId=createOpId();
      const envelope=createApprovalIntent({url:String(view.location.href),task:updated?.task,binding:updated?.binding,
        sourceRevision:updated?.sourceRevision,opId,expectedRevision:updated?.expectedRevision});
      const response=await requestApproval(envelope);
      if(disposed)return;
      status.textContent=response?.ok===true?'Approval intent recorded. Publication requires the release workflow.':
        `Approval blocked: ${response?.error?.code||'UNAVAILABLE'}.`;
    }catch(e){if(!disposed)status.textContent=`Approval blocked: ${e?.code||'UNAVAILABLE'}.`;}
    finally {busy=false;if(!disposed)await refresh();}
  }
  const change=()=>{void refresh();};
  const click=()=>{void approve();};
  button.addEventListener('click',click);
  view.addEventListener('hashchange',change);
  view.addEventListener('pageshow',change);
  doc.addEventListener?.('visibilitychange',change);
  void refresh();
  return Object.freeze({refresh,dispose(){disposed=true;sequence++;view.removeEventListener('hashchange',change);
    view.removeEventListener('pageshow',change);doc.removeEventListener?.('visibilitychange',change);
    button.removeEventListener('click',click);host.remove();}});
}
