/** Strict, bounded background-only IndexedDB inbox. No secrets or arbitrary text. */
export const ATTENTION_DB = 'persona-monkey-pcms-alpha-attention';
export const ATTENTION_KINDS = Object.freeze(['AI_REVIEW','AUTH_REQUIRED','UPDATE_FAILED',
  'SOURCE_DRIFT','REFRESH_SUSPENDED','RECOVERY_HOLD','SYSTEM_WARNING']);
const STATES = ['OPEN','ACKNOWLEDGED'];
const NOTICE = ['UNSENT','DISPATCHING','SHOWN','UNCERTAIN','SKIPPED'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const ok = (test, code='RECOVERY_HOLD') => {if (!test) throw Object.assign(new Error(code),{code});};
const identifier = x => typeof x === 'string' && ID.test(x);
const instant = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const keys = (x,want) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).length === want.length &&
  want.every(k => Object.hasOwn(x,k));
const ITEM_FIELDS = ['id','kind','accountId','key','bindingEpoch','occurrence','taskId',
  'state','notice','revision','createdAt','updatedAt'];
export function validateAttentionLedger(s) {
  ok(keys(s,['schemaVersion','revision','items']) && s.schemaVersion === 1 && integer(s.revision) &&
    Array.isArray(s.items) && s.items.length <= 8192);
  const ids = new Set(), fingerprints = new Set();
  for(const t of s.items){
    ok(keys(t,ITEM_FIELDS) && identifier(t.id) && ATTENTION_KINDS.includes(t.kind) &&
      identifier(t.accountId) && (t.key === null || (typeof t.key === 'string' && SLUG.test(t.key))) &&
      integer(t.bindingEpoch) && t.bindingEpoch > 0 && identifier(t.occurrence) &&
      (t.taskId === null || identifier(t.taskId)) && STATES.includes(t.state) && NOTICE.includes(t.notice) &&
      integer(t.revision) && t.revision > 0 && instant(t.createdAt) && instant(t.updatedAt));
    ok(t.kind === 'AI_REVIEW' ? t.taskId !== null && t.key !== null : t.taskId === null);
    const fingerprint = `${t.kind}\0${t.accountId}\0${t.key ?? ''}\0${t.occurrence}`;
    ok(!ids.has(t.id) && !fingerprints.has(fingerprint)); ids.add(t.id); fingerprints.add(fingerprint);
  }
  return s;
}

/** One readwrite transaction per change; optimistic revision is verified inside
 * the transaction. Updater is synchronous and must not return a Promise. */
export function createAttentionStore({indexedDB=globalThis.indexedDB,databaseName=ATTENTION_DB}={}) {
  ok(indexedDB && typeof indexedDB.open === 'function' &&
    (databaseName === ATTENTION_DB || /^persona-monkey-pcms-alpha-attention-test-[a-z0-9-]+$/.test(databaseName)), 'INVALID_REQUEST');
  let connection=null, opening=null;
  async function connect(){
    if(connection)return connection;
    if(!opening)opening=new Promise((resolve,reject)=>{
      let request,failed=false;
      try{request=indexedDB.open(databaseName,1);}catch{reject(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));return;}
      request.onblocked=()=>{failed=true;reject(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));};
      request.onupgradeneeded=()=>{if(failed){request.transaction.abort();return;}
        request.result.createObjectStore('inbox').add({schemaVersion:1,revision:0,items:[]},'state');};
      request.onerror=()=>reject(Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'}));
      request.onsuccess=()=>{if(failed){request.result.close();return;}
        const db=request.result;
        if(db.version!==1||db.objectStoreNames.length!==1||!db.objectStoreNames.contains('inbox')){
          db.close();reject(Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'}));return;}
        db.onversionchange=()=>{db.close();connection=null;};connection=db;resolve(db);};
    }).finally(()=>{opening=null;});
    return opening;
  }
  async function transaction(mode,expected,update){
    const db=await connect();
    return new Promise((resolve,reject)=>{
      let tx,output,error;
      try{tx=db.transaction('inbox',mode,mode==='readwrite'?{durability:'strict'}:undefined);}
      catch{reject(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));return;}
      const abort=e=>{error=e;try{tx.abort();}catch{}};
      tx.onabort=()=>reject(error||Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));
      tx.oncomplete=()=>resolve(output);tx.onerror=()=>{};
      const request=tx.objectStore('inbox').get('state');
      request.onerror=()=>abort(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));
      request.onsuccess=()=>{
        try{
          const before=validateAttentionLedger(request.result),next=structuredClone(before);
          if(mode==='readwrite'){
            ok(before.revision===expected,'STALE_REVISION');
            const returned=update(next);ok(!returned || typeof returned.then!=='function','INVALID_REQUEST');
            next.revision++;validateAttentionLedger(next);
            tx.objectStore('inbox').put(next,'state');
          }
          output=structuredClone(mode==='readwrite'?next:before);
        }catch(e){abort(e?.code?e:Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'}));}
      };
    });
  }
  return Object.freeze({read:()=>transaction('readonly'),change:(revision,update)=>transaction('readwrite',revision,update),
    close(){connection?.close();connection=null;}});
}
