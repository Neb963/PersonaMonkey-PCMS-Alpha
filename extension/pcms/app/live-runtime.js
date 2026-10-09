// The dashboard is a UI client of the background-hosted PCMS Core (ADR-002 §1, §8).
// This module constructs no Core service: every call goes through pcms.ui-client/v1.
import { createPcmsUiClient } from "./ui-client.js";
import { createFirefoxPcmsUiTransport } from "../platform/firefox-ui-client-transport.js";
import { PCMS_STATUS_KEY } from "../integration/ui-client-contract.js";

let requestSequence=0;
let personaDirectorySequence=0;
const PERSONA_UID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read-only directory over the Persona Broker reads that Core proxies for UI clients.
export function createLivePersonaDirectory(personaBroker) {
  return Object.freeze({
    async list() {
      const personas=[];
      const seen=new Set();
      let cursor=null;
      let pageCount=0;
      do {
        pageCount+=1;
        if(pageCount>64) throw new Error("Persona list pagination exceeded safety bound");
        const response=await personaBroker.request(Object.freeze({
          requestId:"pcms-live-personas-"+(++personaDirectorySequence),
          command:"persona.list",
          params:Object.freeze({
            page:Object.freeze({size:100,...(cursor?{cursor}:{})})
          })
        }));
        if(!response.ok) throw new Error(response.error?.message||"Persona list request failed");
        const result=response.result;
        if(!result||typeof result!=="object"||Array.isArray(result)||!Array.isArray(result.items)
            ||typeof result.hasMore!=="boolean") {
          throw new Error("Persona list response is invalid");
        }
        for(const raw of result.items) {
          const personaUid=typeof raw?.personaUid==="string"&&PERSONA_UID_PATTERN.test(raw.personaUid)
            ? raw.personaUid.toLowerCase()
            : null;
          const cookieStoreId=typeof raw?.cookieStoreId==="string"&&raw.cookieStoreId.length
            ? raw.cookieStoreId
            : null;
          if(!personaUid||!cookieStoreId||raw?.managed===false||raw?.archivedAt||seen.has(personaUid)) continue;
          seen.add(personaUid);
          personas.push(Object.freeze({
            personaUid,
            cookieStoreId,
            name:typeof raw?.name==="string"&&raw.name.trim()?raw.name.trim().slice(0,160):"Managed Persona"
          }));
        }
        if(result.hasMore) {
          if(typeof result.nextCursor!=="string"||!result.nextCursor) throw new Error("Persona list cursor is invalid");
          cursor=result.nextCursor;
        } else {
          cursor=null;
        }
      } while(cursor);
      personas.sort((a,b)=>a.name.localeCompare(b.name)||a.personaUid.localeCompare(b.personaUid));
      return Object.freeze(personas);
    }
  });
}


export async function readPcmsCachedStatus({transport=null}={}) {
  const uiTransport=transport||createFirefoxPcmsUiTransport();
  if(typeof uiTransport.readSession!=="function") return null;
  return uiTransport.readSession(PCMS_STATUS_KEY);
}

export async function startPcmsLiveRuntime({transport=null}={}) {
  const uiTransport=transport||createFirefoxPcmsUiTransport();
  const client=createPcmsUiClient({transport:uiTransport});
  try {
    const coreStatus=await client.status();
    if(coreStatus?.state!=="RUNNING") throw new Error("PCMS Core is "+String(coreStatus?.state||"unavailable"));
    const personaBroker=client.runtime.personaBroker;
    const response=await personaBroker.request(Object.freeze({
      requestId:"pcms-live-status-"+(++requestSequence),
      command:"system.status",
      params:Object.freeze({})
    }));
    if(!response.ok) throw new Error("Persona Broker status request failed");
    return Object.freeze({
      ...client.runtime,
      coreStatus,
      brokerStatus:response.result,
      brokerBootId:response.bootId,
      brokerRevision:response.revision,
      personaDirectory:createLivePersonaDirectory(personaBroker),
      subscribe:client.subscribe,
      subscribeReceipt:client.subscribeReceipt,
      readCachedStatus:()=>typeof uiTransport.readSession==="function"?uiTransport.readSession(PCMS_STATUS_KEY):null,
      close:client.close
    });
  } catch(error) {
    client.close();
    throw error;
  }
}
