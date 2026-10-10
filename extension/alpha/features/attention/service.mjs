/** P404: one durable action-required inbox. Desktop notices are optional output,
 * never the source of truth. Call only from the background Core composition. */
import { ATTENTION_KINDS } from './store.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SLUG=/^[a-z0-9][a-z0-9_-]{0,99}$/;
const LABELS=Object.freeze({
  AI_REVIEW:['AI review ready','A generator needs your approval.'],
  AUTH_REQUIRED:['Account action required','An account needs a manual session check.'],
  UPDATE_FAILED:['Update needs attention','A generator update could not be confirmed.'],
  SOURCE_DRIFT:['Source change detected','A generator source change needs reconciliation.'],
  REFRESH_SUSPENDED:['Refresh suspended','Repeated refresh failures need investigation.'],
  RECOVERY_HOLD:['Recovery hold','Uncertain work needs reconciliation before retry.'],
  SYSTEM_WARNING:['PCMS needs attention','Review the action-required inbox.']
});
const ensure=(condition,code='INVALID_REQUEST')=>{if(!condition)throw Object.assign(new Error(code),{code});};
const valid=x=>typeof x==='string'&&ID.test(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const isInt=x=>Number.isSafeInteger(x)&&x>=0;
const respond=(result,revision)=>({ok:true,result,revision});
const error=(code,revision)=>({ok:false,error:{code,message:({INVALID_REQUEST:'Invalid attention request.',
  STALE_REVISION:'Attention changed; refresh before retry.',STALE_BINDING:'Account binding changed.',
  WAITING_HUMAN:'AI approval is no longer pending.',RATE_LIMIT:'Attention capacity is exhausted.',
  RECOVERY_HOLD:'Attention state needs reconciliation.',NOT_APPLIED:'Attention item does not exist.',
  UNAVAILABLE:'Attention is unavailable.',CONFLICT:'Attention item has already been acknowledged.',
  UNCERTAIN:'Editor open is uncertain; reconcile before retry.'})[code]??'Attention action is unavailable.',
  retryable:code==='UNAVAILABLE'||code==='RATE_LIMIT'},revision});
const supported=new Set(['INVALID_REQUEST','STALE_REVISION','STALE_BINDING','WAITING_HUMAN',
  'RATE_LIMIT','RECOVERY_HOLD','NOT_APPLIED','UNAVAILABLE','CONFLICT','UNCERTAIN']);
// The frozen AttentionRecord fields are mandatory; supplemental presentation
// fields expose revision and explicit operator action without storing UI copy.
const CODES=Object.freeze({AI_REVIEW:'WAITING_HUMAN',AUTH_REQUIRED:'WAITING_HUMAN',
  UPDATE_FAILED:'UNCERTAIN',SOURCE_DRIFT:'SOURCE_DRIFT',REFRESH_SUSPENDED:'RECOVERY_HOLD',
  RECOVERY_HOLD:'RECOVERY_HOLD',SYSTEM_WARNING:'UNAVAILABLE'});
const project=t=>({id:t.id,targetKey:t.key??t.accountId,code:CODES[t.kind],
  message:LABELS[t.kind][1],createdAt:t.createdAt,
  acknowledgedAt:t.state==='ACKNOWLEDGED'?t.updatedAt:null,
  kind:t.kind,accountId:t.accountId,key:t.key,state:t.state,
  notice:t.notice,revision:t.revision,updatedAt:t.updatedAt,
  action:t.kind==='AI_REVIEW'?'OPEN_EDITOR':null});
const same=(t,kind,accountId,key,occurrence)=>t.kind===kind&&t.accountId===accountId&&
  t.key===key&&t.occurrence===occurrence;

export function createAttentionService({store,aiTasks,tabs,notifier,
  readRevision=async()=>0,now=()=>new Date().toISOString(),makeId=()=>crypto.randomUUID()}={}) {
  ensure(store?.read&&store?.change&&aiTasks?.read&&tabs?.openPendingReview&&
    typeof readRevision==='function'&&typeof now==='function'&&typeof makeId==='function');
  let last=0;
  async function run(fn){try{return await fn();}catch(e){return error(supported.has(e?.code)?e.code:'UNAVAILABLE',last);}}
  async function revision(){const r=await readRevision();ensure(isInt(r),'UNAVAILABLE');last=r;return r;}
  async function change(transform){
    for(let attempt=0;attempt<64;attempt++){
      const s=await store.read();
      try{return await store.change(s.revision,transform);}
      catch(e){if(e?.code!=='STALE_REVISION'||attempt===63)throw e;}
    }
  }
  async function taskFor({taskId,accountId,key,epoch}){
    const task=(await aiTasks.read()).tasks.find(t=>t.id===taskId);
    ensure(task&&task.accountId===accountId&&task.key===key&&task.bindingEpoch===epoch,
      'STALE_BINDING');
    ensure(task.state==='COMPLETED'&&task.reviewPending===true&&task.approvalRevision===null,
      'WAITING_HUMAN');
    return task;
  }
  async function notifyOnce(itemId){
    let claimed=false;
    await change(s=>{
      claimed=false;
      const item=s.items.find(t=>t.id===itemId);
      ensure(item,'NOT_APPLIED');
      if(item.notice==='UNSENT'){
        claimed=true;item.notice='DISPATCHING';item.revision++;item.updatedAt=now();
      }
    });
    if(!claimed)return;
    const current=(await store.read()).items.find(t=>t.id===itemId);
    let delivered=false;
    try{
      if(notifier?.show){
        await notifier.show({id:`pcms-alpha:${itemId}`,title:LABELS[current.kind][0],
          message:LABELS[current.kind][1]});
        delivered=true;
      }
    }catch{ /* In-app inbox survives denied permissions, crashes and API errors. */ }
    // Failure to record the receipt leaves DISPATCHING, which also deduplicates.
    try{await change(s=>{
      const item=s.items.find(t=>t.id===itemId);
      ensure(item&&item.notice==='DISPATCHING','RECOVERY_HOLD');
      item.notice=notifier?.show?(delivered?'SHOWN':'UNCERTAIN'):'SKIPPED';
      item.revision++;item.updatedAt=now();
    });}catch{ /* never repeat a possibly shown desktop notice */ }
  }
  async function raise(p={}){return run(async()=>{
    ensure(object(p)&&valid(p.accountId)&&valid(p.opId)&&isInt(p.expectedRevision)&&
      isInt(p.accountBindingEpoch)&&p.accountBindingEpoch>0&&
      (p.key===undefined||SLUG.test(p.key))&&object(p.options));
    ensure(p.expectedRevision===await revision(),'STALE_REVISION');
    const {kind,occurrence,taskId}=p.options;
    ensure(ATTENTION_KINDS.includes(kind)&&valid(occurrence??p.opId)&&
      Object.keys(p.options).every(k=>['kind','occurrence','taskId'].includes(k)));
    const key=p.key??null,token=occurrence??p.opId,ai=kind==='AI_REVIEW';
    ensure(ai?valid(taskId)&&key!==null:taskId===undefined);
    if(ai)await taskFor({taskId,accountId:p.accountId,key,epoch:p.accountBindingEpoch});
    let itemId;
    await change(s=>{
      const existing=s.items.find(t=>same(t,kind,p.accountId,key,token));
      if(existing){itemId=existing.id;return;}
      ensure(s.items.length<8192,'RATE_LIMIT');
      itemId=`attention:${makeId()}`;ensure(valid(itemId));
      const at=now();
      s.items.push({id:itemId,kind,accountId:p.accountId,key,bindingEpoch:p.accountBindingEpoch,
        occurrence:token,taskId:ai?taskId:null,state:'OPEN',notice:'UNSENT',revision:1,
        createdAt:at,updatedAt:at});
    });
    await notifyOnce(itemId);
    return respond(project((await store.read()).items.find(t=>t.id===itemId)),await revision());
  });}
  async function list(p={}){return run(async()=>{
    ensure(object(p)&&(p.accountId===undefined||valid(p.accountId))&&
      (p.limit===undefined||(isInt(p.limit)&&p.limit>0&&p.limit<=200)));
    const s=await store.read();
    const rows=s.items.filter(t=>(p.accountId===undefined||t.accountId===p.accountId)&&t.state==='OPEN')
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    let offset=0;
    if(p.cursor!==undefined){const m=/^v1\.(\d+)\.(\d+)$/.exec(p.cursor);
      ensure(m&&Number(m[1])===s.revision,'STALE_REVISION');offset=Number(m[2]);
      ensure(isInt(offset)&&offset>0&&offset<rows.length);}
    const end=offset+(p.limit??100);
    return respond({items:rows.slice(offset,end).map(project),cursor:end<rows.length?`v1.${s.revision}.${end}`:null,
      asOf:now()},await revision());
  });}
  async function get(p={}){return run(async()=>{
    ensure(object(p)&&valid(p.key));
    const s=await store.read(),item=s.items.find(t=>t.id===p.key);
    ensure(item,'NOT_APPLIED');return respond(project(item),await revision());
  });}
  async function acknowledge(p={}){return run(async()=>{
    ensure(object(p)&&valid(p.accountId)&&isInt(p.expectedRevision)&&
      isInt(p.accountBindingEpoch)&&p.accountBindingEpoch>0&&
      valid(p.opId)&&object(p.options)&&valid(p.options.attentionId)&&
      isInt(p.options.expectedItemRevision)&&
      Object.keys(p.options).every(k=>['attentionId','expectedItemRevision','action'].includes(k)));
    ensure(p.expectedRevision===await revision(),'STALE_REVISION');
    const {attentionId,expectedItemRevision,action='ACK'}=p.options;
    ensure(['ACK','OPEN_EDITOR'].includes(action));
    const current=(await store.read()).items.find(t=>t.id===attentionId);
    ensure(current,'NOT_APPLIED');ensure(current.accountId===p.accountId&&
      current.bindingEpoch===p.accountBindingEpoch,'STALE_BINDING');
    ensure(current.revision===expectedItemRevision,'STALE_REVISION');
    ensure(current.state==='OPEN','CONFLICT');
    if(action==='OPEN_EDITOR'){
      ensure(current.kind==='AI_REVIEW'&&current.taskId,'INVALID_REQUEST');
      await taskFor({taskId:current.taskId,accountId:current.accountId,
        key:current.key,epoch:current.bindingEpoch});
      const open=await tabs.openPendingReview({taskId:current.taskId,opId:p.opId});
      return respond({attention:project(current),editor:{phase:open.phase,tabId:open.tabId}},await revision());
    }
    const updated=await change(s=>{
      const row=s.items.find(t=>t.id===attentionId);
      ensure(row&&row.accountId===p.accountId&&row.bindingEpoch===p.accountBindingEpoch,'STALE_BINDING');
      ensure(row.revision===expectedItemRevision,'STALE_REVISION');ensure(row.state==='OPEN','CONFLICT');
      row.state='ACKNOWLEDGED';row.revision++;row.updatedAt=now();
    });
    return respond(project(updated.items.find(t=>t.id===attentionId)),await revision());
  });}
  return Object.freeze({raise,list,get,acknowledge});
}

/** Use Firefox notifications through an injected capability, never from content
 * scripts and never for provider/browser execution. */
export function createDesktopAttentionNotifier({notifications}={}){
  return Object.freeze({async show({id,title,message}){
    ensure(notifications&&typeof notifications.create==='function','UNAVAILABLE');
    ensure(typeof id==='string'&&id.startsWith('pcms-alpha:')&&
      Object.values(LABELS).some(([t,m])=>title===t&&message===m));
    await notifications.create(id,{type:'basic',title,message});
  }});
}
