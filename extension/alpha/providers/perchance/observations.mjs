/** Observations remain separate from account-owned inventory. No public feed
 * position, draft or AI history can prove account ownership or saved source. */
const keyOK=x=>typeof x==='string'&&/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(x);
const unique=a=>Array.isArray(a)&&a.every(keyOK)&&new Set(a).size===a.length;
export function classifyListingObservation({targetKey,feedKeys,renderedKeys,asOf}={}){
  if(!keyOK(targetKey)||!unique(feedKeys)||!unique(renderedKeys)||
    typeof asOf!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(asOf)||Number.isNaN(Date.parse(asOf))){
    return {status:'UNKNOWN',feedPosition:null,renderedPosition:null,asOf:null};
  }
  const f=feedKeys.indexOf(targetKey),r=renderedKeys.indexOf(targetKey);
  const feedPosition=f<0?null:f+1, renderedPosition=r<0?null:r+1;
  return {status:renderedPosition!==null?'VISIBLE':feedPosition!==null?'LIKELY_FILTERED':'NOT_VISIBLE',
    feedPosition,renderedPosition,asOf};
}
export function classifyAiSource({saved,workspace,history}={}){
  // Source strings are direct bytes; an AI transcript never substitutes for save readback.
  const valid=x=>x&&typeof x==='object'&&typeof x.pjs==='string'&&typeof x.html==='string';
  if(!valid(saved)||!valid(workspace)||!history||typeof history!=='object'||
    !['IDLE','ACTIVE','WAITING_HUMAN','UNKNOWN'].includes(history.state)){
    return Object.freeze({source:'UNKNOWN',approved:false});
  }
  const match=saved.pjs===workspace.pjs&&saved.html===workspace.html;
  return Object.freeze({source:match?'SAVED_MATCH':'LOCAL_UNSAVED',approved:false});
}
