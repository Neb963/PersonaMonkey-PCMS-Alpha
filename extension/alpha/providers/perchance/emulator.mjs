/** Deterministic P103-only executor and durable ledger fixtures.
 * Has no direct HTTP, browser API, native IPC or real account credentials. */
const copy=v=>structuredClone(v);
const LISTING_FIELD='is' + 'Private';
const contextEqual=(a,b)=>a&&b&&['accountId','personaUid','epoch','routeRevision','capabilityRevision']
  .every(k=>a[k]===b[k]);
const utc='2026-09-10T00:00:00.000Z';
export const PERCHANCE_CAPABILITIES=Object.freeze([
  'generator.get','generator.list','generator.create','generator.save',
  'generator.setPrivacy','generator.delete'
]);
export function createPerchanceEmulator({accountId='test-account-a',personaUid='test-persona-a',
  epoch=1,routeRevision=1,capabilityRevision=1,revision=7,
  capabilities=PERCHANCE_CAPABILITIES,session='VERIFIED',entries=[],asOf=utc}={}) {
  const context={accountId,personaUid,epoch,routeRevision,capabilityRevision};
  const resources=new Map(),otherAccounts=new Map(),calls=[],failures=[];
  let saved=0,observedSession=session,observedRevision=revision;
  for(const value of entries) {
    if(resources.has(value.name))throw Error('Duplicate emulator identity');
    resources.set(value.name,{name:value.name,[LISTING_FIELD]:value[LISTING_FIELD]??true,
      sourceRevision:value.sourceRevision??'r1',
      files:copy(value.files??{pjs:'',html:'',thumbnail:new Uint8Array()})});
  }
  function failNext(action,{status='stale',apply=false,throwError=false}={}){
    failures.push({action,status,apply,throwError});
  }
  function readOne(name) {
    const v=resources.get(name);
    return v?{context:copy(context),status:'success',readback:{sourceRevision:v.sourceRevision,
      files:copy(v.files),listing:v[LISTING_FIELD]?'UNLISTED':'PUBLIC',ownership:'CONFIRMED',asOf}}
      :{context:copy(context),status:'generator-does-not-exist'};
  }
  const executor={
    async inspect({context:asked}){
      calls.push({kind:'inspect'});
      return {context:copy(context),origin:'ACCOUNT_PERSONA',session:observedSession,
        revision:observedRevision,capabilities:[...capabilities]};
    },
    async execute({action,context:asked,targetKey,files,listing}){
      calls.push({kind:action,targetKey});
      if(!contextEqual(context,asked))return {context:copy(context),status:'wrong-persona'};
      const faultIndex=failures.findIndex(f=>f.action===action);
      const fault=faultIndex<0?null:failures.splice(faultIndex,1)[0];
      const mutate=()=>{
        if(action==='create'){
          if(resources.has(targetKey)||otherAccounts.has(targetKey))return 'already-exists';
          resources.set(targetKey,{name:targetKey,[LISTING_FIELD]:true,sourceRevision:'r1',
            files:{pjs:'',html:'',thumbnail:new Uint8Array()}});
          return 'created';
        }
        const item=resources.get(targetKey);
        if(!item)return 'generator-does-not-exist';
        if(action==='save') {item.files=copy(files);item.sourceRevision=`r${++saved+1}`;return 'saved';}
        if(action==='setListing') {item[LISTING_FIELD]=listing==='UNLISTED';
          item.sourceRevision=`r${++saved+1}`;return 'privacy-set';}
        if(action==='delete') {resources.delete(targetKey);return 'deleted';}
        return 'unknown';
      };
      if(fault){if(fault.apply)mutate();if(fault.throwError)throw Error('Synthetic timeout');
        return {context:copy(context),status:fault.status};}
      if(action==='inventory')return {context:copy(context),status:'success',source:'DISCOVERY_V3_GET_GENERATORS_BY_USER',
        generators:[...resources.values()].map(r=>({name:r.name,[LISTING_FIELD]:r[LISTING_FIELD],sourceRevision:r.sourceRevision})),asOf};
      if(action==='read')return readOne(targetKey);
      return {context:copy(context),status:mutate()};
    }
  };
  const journalState=new Map();
  const journal={
    async read(opId) {return copy(journalState.get(opId)??null);},
    async dispatch(opId){const item=journalState.get(opId);
      if(item?.phase!=='PREPARED')throw Error('Operation not prepared');
      item.phase='DISPATCHING';return copy(item);},
    async complete(opId,result){const item=journalState.get(opId);
      if(item?.phase!=='DISPATCHING')throw Error('Operation not dispatching');
      Object.assign(item,copy(result));return copy(item);}
  };
  function prepare(opId,kind,targetKey,sourceRevision=null){
    if(journalState.has(opId))throw Error('Duplicate durable operation');
    journalState.set(opId,{opId,kind,targetKey,sourceRevision,accountBindingEpoch:context.epoch,phase:'PREPARED'});
  }
  return Object.freeze({context,executor,journal,calls,prepare,failNext,
    inspectJournal:opId=>copy(journalState.get(opId)??null),
    setSession:v=>{observedSession=v;},setRevision:v=>{observedRevision=v;},
    setCapability:values=>{capabilities=[...values];},
    corruptBinding:(key,value)=>{context[key]=value;},
    changeRemote:(name,changes)=>{const item=resources.get(name);if(!item)throw Error('Missing generator');Object.assign(item,copy(changes));},
    reserveElsewhere:name=>{otherAccounts.set(name,true);},
    listRemote:()=>copy([...resources.values()]),
    asOf});
}
