/** P305 IndexedDB journal. update() is one strict read-modify-write transaction. */
export function createVisibilityLedger({indexedDB=globalThis.indexedDB,
  databaseName='persona-monkey-alpha-visibility-v1'}={}) {
  if(!indexedDB || typeof indexedDB.open!=='function' || typeof databaseName!=='string' || !databaseName)
    throw new TypeError('IndexedDB required for visibility persistence');
  let pending;
  function open() {
    if(pending) return pending;
    pending=new Promise((resolve,reject)=>{
      const request=indexedDB.open(databaseName,1);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('ledger'))
        request.result.createObjectStore('ledger');};
      request.onerror=()=>reject(new Error('RECOVERY_HOLD'));
      request.onblocked=()=>reject(new Error('RECOVERY_HOLD'));
      request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    }).catch(e=>{pending=null;throw e;});return pending;
  }
  async function transact(mode,mutator) {
    const db=await open();return new Promise((resolve,reject)=>{
      let tx;try{tx=db.transaction('ledger',mode,mode==='readwrite'?{durability:'strict'}:undefined);}
      catch{reject(new Error('RECOVERY_HOLD'));return;}
      let value,aborted=false,cause=null;
      tx.onabort=()=>reject(cause?.code && ['INVALID_REQUEST','STALE_REVISION','RATE_LIMIT','RECOVERY_HOLD'].includes(cause.code) ? cause : new Error('RECOVERY_HOLD'));
      tx.onerror=()=>{aborted=true;};
      tx.oncomplete=()=>aborted?reject(new Error('RECOVERY_HOLD')):resolve(value);
      const store=tx.objectStore('ledger'),request=store.get('state');
      request.onerror=()=>{try{tx.abort();}catch{}};
      request.onsuccess=()=>{
        try {
          const input=request.result===undefined?null:request.result;
          value=mode==='readwrite'?mutator(structuredClone(input)):input;
          if(mode==='readwrite') store.put(structuredClone(value),'state');
        }catch(error){cause=error;try{tx.abort();}catch{}}
      };
    });
  }
  return Object.freeze({read:()=>transact('readonly'),update:fn=>{
    if(typeof fn!=='function')throw new TypeError('Atomic update callback required');
    return transact('readwrite',fn);
  },close(){if(pending)pending.then(db=>db.close()).catch(()=>{});pending=null;}});
}
