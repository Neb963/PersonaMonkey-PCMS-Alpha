export const NOW="2026-10-05T12:00:00.000Z";

const clone=(value)=>structuredClone(value);

export function record(namespace,key,value,{revision=1,updatedAt=NOW}={}) {
  return {namespace,key,revision,updatedAt,value:clone(value)};
}

export function makeStorage(initial=[]) {
  let records=initial.map(clone);
  let failReplace=false;
  const replacements=[];
  const normalize=(raw)=>{
    if(!Array.isArray(raw)) throw new Error("records");
    const seen=new Set();
    const out=raw.map((row)=>{
      if(!row||typeof row!=="object"||Array.isArray(row)) throw new Error("row");
      const keys=Object.keys(row);
      if(keys.length!==5||!["namespace","key","revision","updatedAt","value"].every(k=>Object.hasOwn(row,k))) throw new Error("shape");
      if(typeof row.namespace!=="string"||typeof row.key!=="string"||!Number.isSafeInteger(row.revision)||row.revision<1||Number.isNaN(Date.parse(row.updatedAt))) throw new Error("meta");
      const id=row.namespace+"\0"+row.key;if(seen.has(id)) throw new Error("duplicate");seen.add(id);
      return clone(row);
    });
    out.sort((a,b)=>a.namespace.localeCompare(b.namespace)||a.key.localeCompare(b.key));
    return Object.freeze(out);
  };
  const admin=Object.freeze({
    validateRecords:normalize,
    async snapshotRecords(){return normalize(records);},
    async replaceAllRecords(next){
      const safe=normalize(next);
      replacements.push(clone(safe));
      if(failReplace) throw new Error("replace failed");
      records=safe.map(clone);
      return {replaced:records.length};
    }
  });
  return Object.freeze({
    broker:Object.freeze({admin}),
    set(next){records=normalize(next).map(clone);},
    failReplace(value=true){failReplace=value;},
    get records(){return records.map(clone);},
    get replacements(){return replacements.map(clone);}
  });
}

export function makeHold(events=[]) {
  let revision=0;
  let value={schemaVersion:1,kind:"recovery-hold",state:"NORMAL",reason:null,enteredAt:null,releasedAt:null};
  return Object.freeze({
    api:Object.freeze({
      async getStatus(){return {revision,value:clone(value)};},
      async enterRecoveryHold({reason}={}){
        events.push("hold.enter");
        if(value.state!=="RECOVERY_HOLD"){
          revision+=1;value={...value,state:"RECOVERY_HOLD",reason,enteredAt:NOW,releasedAt:null};
        }
        return {hold:{revision,value:clone(value)},recoveredOperationIds:[]};
      },
      async releaseRecoveryHold({expectedRevision,checks}={}){
        events.push("hold.release");
        if(expectedRevision!==revision||!checks.moduleGenerations||!checks.personaBindings||!checks.providerCapabilities) throw new Error("incomplete");
        revision+=1;value={...value,state:"NORMAL",reason:null,releasedAt:NOW};
        return {revision,value:clone(value)};
      }
    }),
    get state(){return value.state;},
    get revision(){return revision;}
  });
}

export function makeRuntime(events=[],initial=[{moduleId:"live.module",revision:2,value:{state:"ACTIVE"}}]) {
  let states=initial.map(clone);
  let recovered=["restored.module"];
  return Object.freeze({
    api:Object.freeze({
      async listStates(){return states.map(clone);},
      async prepareUpdate(moduleId,{expectedRevision}={}){
        events.push("runtime.quiesce:"+moduleId);
        const row=states.find(x=>x.moduleId===moduleId);
        if(!row||row.revision!==expectedRevision) throw new Error("revision");
        row.revision+=1;row.value.state="IDLE";return clone(row);
      },
      async recoverAll(){events.push("runtime.recover");return Object.freeze([...recovered]);}
    }),
    setStates(next){states=next.map(clone);},
    setRecovered(ids){recovered=[...ids];}
  });
}

function op(operationId,state,revision=1){
  return {revision,value:{operationId,state}};
}

export function makeRemoteOps(events=[],initial=[]) {
  const rows=new Map(initial.map(row=>[row.value.operationId,clone(row)]));
  return Object.freeze({
    api:Object.freeze({
      async recoverInterruptedDispatches(){
        events.push("remote.recover");
        const recovered=[];
        for(const row of rows.values()){
          if(row.value.state==="DISPATCHING"){
            row.revision+=1;row.value.state="UNCERTAIN";recovered.push(row.value.operationId);
          }
        }
        return Object.freeze(recovered.sort());
      },
      async listUnresolved(){
        const unresolved=new Set(["PREPARED","DISPATCHING","UNCERTAIN","RETRYABLE"]);
        return [...rows.values()].filter(row=>unresolved.has(row.value.state)).sort((a,b)=>a.value.operationId.localeCompare(b.value.operationId)).map(clone);
      },
      async cancel(operationId,{expectedRevision}={}){
        events.push("remote.cancel:"+operationId);
        const row=rows.get(operationId);if(!row||row.revision!==expectedRevision||!["PREPARED","RETRYABLE"].includes(row.value.state)) throw new Error("cancel");
        row.revision+=1;row.value.state="CANCELLED";return clone(row);
      }
    }),
    get(operationId){const row=rows.get(operationId);return row?clone(row):null;},
    set(operationId,state,revision=1){rows.set(operationId,op(operationId,state,revision));},
    row(operationId){return rows.get(operationId);}
  });
}

export function makeProviderGate(remote,events=[],outcomes={}) {
  return Object.freeze({
    api:Object.freeze({
      async reconcile(operationId){
        events.push("provider.reconcile:"+operationId);
        const row=remote.row(operationId);if(!row||row.value.state!=="UNCERTAIN") throw new Error("state");
        const outcome=outcomes[operationId]||"UNKNOWN";
        row.revision+=1;
        if(outcome==="APPLIED") row.value.state="SUCCEEDED";
        else if(outcome==="NOT_APPLIED") row.value.state="RETRYABLE";
        else row.value.state="UNCERTAIN";
        return clone(row);
      }
    })
  });
}

export function makeChecks({personaBindings=true,providerCapabilities=true}={}) {
  return Object.freeze({
    api:Object.freeze({
      async personaBindings(){return personaBindings;},
      async providerCapabilities(){return providerCapabilities;}
    })
  });
}

export async function sha256Hex(text) {
  const {createHash}=await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}
