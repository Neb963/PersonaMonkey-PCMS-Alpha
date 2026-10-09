// Extension-page side of pcms.ui-client/v1: runtime.sendMessage for requests (which
// wakes a suspended event page) and the storage.session revision signal for changes.
// No long-lived port is used, so nothing here keeps the background alive (ADR-002 §8).
import { PCMS_STATUS_KEY, PCMS_UI_REVISION_KEY } from "../integration/ui-client-contract.js";

export function createFirefoxPcmsUiTransport({runtime=globalThis.browser?.runtime,storage=globalThis.browser?.storage}={}){
  if(!runtime||typeof runtime.sendMessage!=="function") throw new TypeError("PCMS UI transport requires browser.runtime");
  if(!storage?.session||typeof storage.session.get!=="function") throw new TypeError("PCMS UI transport requires storage.session");

  function changeSource(){
    if(storage.session.onChanged?.addListener) return {target:storage.session.onChanged,areaFilter:false};
    if(storage.onChanged?.addListener) return {target:storage.onChanged,areaFilter:true};
    return null;
  }

  return Object.freeze({
    send(message){return runtime.sendMessage(message);},
    async readSession(key){
      if(key!==PCMS_UI_REVISION_KEY&&key!==PCMS_STATUS_KEY) throw new TypeError("PCMS UI session key is not readable");
      const stored=await storage.session.get(key);
      return stored?.[key]??null;
    },
    subscribeRevision(onRevision){
      if(typeof onRevision!=="function") throw new TypeError("PCMS revision listener is invalid");
      const source=changeSource();
      if(!source) return ()=>{};
      const listener=(changes,area)=>{
        if(source.areaFilter&&area!=="session") return;
        const change=changes?.[PCMS_UI_REVISION_KEY];
        if(change&&change.newValue) onRevision(change.newValue);
      };
      source.target.addListener(listener);
      return ()=>{try{source.target.removeListener(listener);}catch{}};
    }
  });
}
