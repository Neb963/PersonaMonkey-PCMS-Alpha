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

export function account(accountId="acct-1", providerId="perchance") {
  return {
    schemaVersion:1,
    kind:"account",
    accountId,
    providerId,
    displayName:"Account",
    personaUid:"11111111-1111-1111-1111-111111111111",
    bindingEpoch:1,
    createdAt:"2026-10-05T04:00:00.000Z",
    updatedAt:"2026-10-05T04:00:00.000Z"
  };
}

export function makeAccounts(initial={}) {
  const rows=new Map(Object.entries(initial).map(([id,value])=>[id,structuredClone(value)]));
  const failures=new Set();
  return Object.freeze({
    service:Object.freeze({
      async getAccount(accountId){
        if(failures.has(accountId)) throw new Error("account lookup failed");
        const row=rows.get(accountId);
        return row ? structuredClone(row) : null;
      }
    }),
    set(accountId,value){ rows.set(accountId,structuredClone(value)); failures.delete(accountId); },
    remove(accountId){ rows.delete(accountId); failures.delete(accountId); },
    fail(accountId){ failures.add(accountId); }
  });
}
