export function makeStateStore(shared={row:null}) {
  const clone=value=>structuredClone(value);
  return Object.freeze({
    shared,
    store:Object.freeze({
      async read(){return shared.row?clone(shared.row):null;},
      async compareAndSwap({expectedRevision,value}){
        const current=shared.row?.revision||0;
        if(current!==expectedRevision)return {ok:false,currentRevision:current};
        shared.row={revision:current+1,value:clone(value)};
        return {ok:true,revision:shared.row.revision,value:clone(shared.row.value)};
      }
    })
  });
}

export function account(accountId="acct-1",providerId="perchance"){
  return {
    schemaVersion:1,kind:"account",accountId,providerId,displayName:"Account",
    personaUid:"11111111-1111-1111-1111-111111111111",bindingEpoch:1,
    createdAt:"2026-10-05T06:00:00.000Z",updatedAt:"2026-10-05T06:00:00.000Z"
  };
}

export function makeAccounts(initial={}){
  const rows=new Map(Object.entries(initial).map(([id,value])=>[id,structuredClone(value)]));
  const failures=new Set();
  return Object.freeze({
    service:Object.freeze({
      async getAccount(accountId){
        if(failures.has(accountId))throw new Error("account lookup failed");
        const row=rows.get(accountId);return row?structuredClone(row):null;
      }
    }),
    set(id,value){rows.set(id,structuredClone(value));failures.delete(id);},
    remove(id){rows.delete(id);failures.delete(id);},
    fail(id){failures.add(id);}
  });
}

export function makeProvider(){
  const remoteRows=new Map();
  const mutations=[];
  let available=true;
  let mode={kind:"result",status:"APPLIED"};
  let reconcileState="SUCCEEDED";

  const gate=Object.freeze({
    async mutate({operation,dispatchInput}){
      mutations.push(structuredClone({operation,dispatchInput}));
      if(mode.kind==="throw-before"){
        remoteRows.set(operation.operationId,{value:{operationId:operation.operationId,state:"UNCERTAIN"}});
        throw new Error("ambiguous before apply");
      }
      if(mode.kind==="throw-after"){
        remoteRows.set(operation.operationId,{value:{operationId:operation.operationId,state:"UNCERTAIN"}});
        throw new Error("ambiguous after apply");
      }
      const state=mode.status==="NOT_APPLIED"?"FAILED":"SUCCEEDED";
      remoteRows.set(operation.operationId,{value:{operationId:operation.operationId,state}});
      return {status:mode.status};
    },
    async reconcile(operationId){
      remoteRows.set(operationId,{value:{operationId,state:reconcileState}});
      return {value:{state:reconcileState}};
    }
  });

  return Object.freeze({
    resolver:Object.freeze({async get(){return available?gate:null;}}),
    remoteReader:Object.freeze({async get(operationId){return remoteRows.has(operationId)?structuredClone(remoteRows.get(operationId)):null;}}),
    mutations,
    setAvailable(value){available=Boolean(value);},
    setResult(status){mode={kind:"result",status};},
    failBefore(state="RETRYABLE"){mode={kind:"throw-before"};reconcileState=state;},
    failAfter(state="SUCCEEDED"){mode={kind:"throw-after"};reconcileState=state;},
    clearRemote(operationId){remoteRows.delete(operationId);},
    setRemote(operationId,state){remoteRows.set(operationId,{value:{operationId,state}});}
  });
}
