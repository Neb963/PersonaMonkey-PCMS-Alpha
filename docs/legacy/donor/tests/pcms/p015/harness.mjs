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

export function makeAccounts(initial={}) {
  const rows=new Map(Object.entries(initial).map(([id,value])=>[id,structuredClone(value)]));
  return Object.freeze({
    service:Object.freeze({
      async getAccount(accountId){
        const row=rows.get(accountId);
        return row ? structuredClone(row) : null;
      }
    }),
    set(accountId,value){ rows.set(accountId,structuredClone(value)); },
    remove(accountId){ rows.delete(accountId); }
  });
}

export function makeGateResolver(gate) {
  let available=true;
  return Object.freeze({
    resolver:Object.freeze({
      async get(){ return available ? gate : null; }
    }),
    setAvailable(value){ available=value===true; }
  });
}

export function account(accountId="acct-1") {
  return {
    schemaVersion:1,
    kind:"account",
    accountId,
    providerId:"perchance",
    displayName:"Account",
    personaUid:"11111111-1111-1111-1111-111111111111",
    bindingEpoch:1,
    createdAt:"2026-10-05T04:00:00.000Z",
    updatedAt:"2026-10-05T04:00:00.000Z"
  };
}
