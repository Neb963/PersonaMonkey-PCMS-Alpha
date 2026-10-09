export const UID_A="11111111-1111-1111-1111-111111111111";
export const UID_B="22222222-2222-2222-2222-222222222222";
export const UID_C="33333333-3333-3333-3333-333333333333";

export function makeStateStore(shared={row:null}) {
  const clone=(value)=>structuredClone(value);
  const store=Object.freeze({
    async read(){ return shared.row ? clone(shared.row) : null; },
    async compareAndSwap({expectedRevision,value}){
      const current=shared.row?.revision || 0;
      if(current!==expectedRevision) return {ok:false,currentRevision:current};
      const next={revision:current+1,value:clone(value)};
      shared.row=next;
      return {ok:true,revision:next.revision,value:clone(next.value)};
    }
  });
  return Object.freeze({store,shared});
}

export function makePersonaResolver(initial={}) {
  const rows=new Map(Object.entries(initial).map(([uid,value])=>[uid.toLowerCase(),structuredClone(value)]));
  let failUid=null;
  return Object.freeze({
    resolver:Object.freeze({
      async get(uid){
        const key=uid.toLowerCase();
        if(failUid===key) throw new Error("lookup failed");
        const row=rows.get(key);
        return row ? structuredClone(row) : null;
      }
    }),
    set(uid,value){ rows.set(uid.toLowerCase(),structuredClone(value)); },
    remove(uid){ rows.delete(uid.toLowerCase()); },
    fail(uid){ failUid=uid.toLowerCase(); },
    clearFailure(){ failUid=null; }
  });
}

export function persona(personaUid,cookieStoreId){ return {personaUid,cookieStoreId}; }
