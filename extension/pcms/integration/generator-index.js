// pcms.generator-index/v1 (03 §4.5, 02 §5.3). Generators are not owned by Core: this is a
// rebuildable, non-authoritative projection joined from module listings. The Deployer listing
// is built from Deployer records and its status comes only from deriveGeneratorStatus. Other
// modules contribute listings with the same shape; rows are unioned by `ref`, and when two
// listings disagree on the account the row says "Account mismatch" instead of picking one.
import { PROVIDER_HANDOFF_TASK_KIND } from "./provider-handoff.js";

export const PCMS_GENERATOR_INDEX_CONTRACT="pcms.generator-index/v1";
export const PCMS_GENERATOR_INDEX_PAGE_SIZE=50;
export const PCMS_GENERATOR_INDEX_MAX_ROWS=4096;
export const PCMS_GENERATOR_STATUS_FILTERS=Object.freeze([
  "uncertain","waiting","deploying","drift","blocked","unavailable","failed","paused","new","update","sync","other"
]);
const FILTER_LABEL=Object.freeze({uncertain:"Outcome unknown",waiting:"Waiting for you",deploying:"Deploying",drift:"Changed on Perchance",
  blocked:"Blocked",unavailable:"Account unavailable",failed:"Failed",paused:"Paused",new:"Not yet deployed",update:"Update ready",
  sync:"In sync",other:"Other"});
const REF=/^perchance:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ACCOUNT=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function generatorRef(generatorId){
  const ref="perchance:"+String(generatorId);
  if(!REF.test(ref)) throw new TypeError("Generator ref is invalid");
  return ref;
}
export function generatorIdFromRef(ref){
  if(typeof ref!=="string"||!REF.test(ref)) throw new TypeError("Generator ref is invalid");
  return ref.slice("perchance:".length);
}

function text(value,max){
  const safe=value===null||value===undefined?"":String(value).replace(/[\u0000-\u001f\u007f]/g," ");
  return safe.length<=max?safe:safe.slice(0,max-1)+"…";
}

// Filter string grammar shared with router-v2 (`status:<key>,account:<id>`).
export function parseGeneratorIndexFilter(raw=""){
  const out={status:null,account:null};
  if(raw===null||raw===undefined||raw==="") return Object.freeze(out);
  if(typeof raw!=="string"||raw.length>240) throw new TypeError("Generator filter is invalid");
  for(const part of raw.split(",")){
    const index=part.indexOf(":");
    const key=part.slice(0,index); const value=part.slice(index+1);
    if(index<1||!value) throw new TypeError("Generator filter is invalid");
    if(key==="status"&&PCMS_GENERATOR_STATUS_FILTERS.includes(value)&&out.status===null) out.status=value;
    else if(key==="account"&&ACCOUNT.test(value)&&out.account===null) out.account=value;
    else throw new TypeError("Generator filter is invalid");
  }
  return Object.freeze(out);
}

// Union by ref (03 §4.5). Columns are namespaced by module; no listing wins on account.
export function mergeGeneratorListings(listings){
  const rows=new Map();
  for(const listing of listings){
    const moduleId=String(listing.moduleId);
    for(const item of listing.items){
      if(!item||typeof item.ref!=="string"||!REF.test(item.ref)) continue;
      const row=rows.get(item.ref)||{ref:item.ref,accounts:new Set(),title:null,sources:[],columns:{},status:null,next:null,notes:[],filter:null,deploymentId:null};
      if(typeof item.accountId==="string") row.accounts.add(item.accountId);
      if(!row.title&&item.title) row.title=text(item.title,120);
      row.sources.push(moduleId);
      row.columns={...row.columns,...item.columns};
      if(moduleId==="deployer"){
        row.status=item.status; row.next=item.next; row.notes=item.notes||[]; row.filter=item.filter; row.deploymentId=item.deploymentId;
      }
      rows.set(item.ref,row);
      if(rows.size>PCMS_GENERATOR_INDEX_MAX_ROWS) break;
    }
  }
  return [...rows.values()].map((row)=>{
    const accounts=[...row.accounts].sort();
    const mismatch=accounts.length>1;
    return Object.freeze({
      ref:row.ref,
      slug:row.ref.slice("perchance:".length),
      title:row.title,
      accountId:mismatch?null:(accounts[0]??null),
      accountIds:Object.freeze(accounts),
      status:mismatch?Object.freeze({token:"WARNING",label:"Account mismatch"}):(row.status||Object.freeze({token:"INFO",label:"Not managed by Deployer"})),
      next:row.next||Object.freeze({kind:"none",text:""}),
      notes:Object.freeze([...row.notes]),
      filter:mismatch||!PCMS_GENERATOR_STATUS_FILTERS.includes(row.filter)?"other":row.filter,
      columns:Object.freeze(row.columns),
      sources:Object.freeze([...new Set(row.sources)].sort()),
      deploymentId:row.deploymentId
    });
  }).sort((left,right)=>left.slug.localeCompare(right.slug));
}

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}
function method(value,name,label){
  if(!plain(value)||typeof value[name]!=="function") throw new TypeError(label+" is invalid");
  return value[name].bind(value);
}

export function createGeneratorIndexService({deployer,accounts,humanTasks,recoveryHold=null,observations=null,automatic=null,listingSources=[],clock=()=>new Date().toISOString()}={}){
  const listDeployments=method(deployer,"listDeployments","Generator index Deployer source");
  const deployerListing=method(deployer,"listGeneratorListing","Generator index Deployer listing");
  const listAccounts=method(accounts,"listAccounts","Generator index Accounts source");
  const listAttention=method(humanTasks,"listAttention","Generator index HumanTask source");
  if(!Array.isArray(listingSources)||listingSources.some((source)=>typeof source!=="function")) throw new TypeError("Generator listing sources are invalid");
  if(typeof clock!=="function") throw new TypeError("Generator index clock is invalid");

  async function recoveryState(){
    if(!recoveryHold) return "NORMAL";
    try{return (await recoveryHold.getStatus())?.value?.state==="RECOVERY_HOLD"?"RECOVERY_HOLD":"NORMAL";}
    catch{return "NORMAL";}
  }

  // P042: rows read "Deploys automatically" only while the operator has Automatic turned on.
  async function deploymentMode(){
    if(!automatic) return "ASSISTED";
    try{return (await automatic.readControl()).value.enabled===true?"AUTOMATIC":"ASSISTED";}
    catch{return "ASSISTED";}
  }

  async function build(){
    const [deployed,accountList,tasks,recovery]=await Promise.all([listDeployments(),listAccounts(),listAttention({limit:500}),recoveryState()]);
    const accountMap=new Map(accountList.accounts.map((account)=>[account.accountId,account]));
    const openHandoffTargets=new Set(tasks
      .filter((task)=>task.value.taskKind===PROVIDER_HANDOFF_TASK_KIND&&task.value.subjectRef?.kind==="generator")
      .map((task)=>task.value.subjectRef.id));
    const handoffTask=new Map(tasks
      .filter((task)=>task.value.taskKind===PROVIDER_HANDOFF_TASK_KIND&&task.value.subjectRef?.kind==="generator")
      .map((task)=>[task.value.subjectRef.id,task.value.taskId]));
    const listings=[await deployerListing({deployments:deployed.deployments,healthyAccounts:new Set(accountMap.keys()),openHandoffTargets,recovery,mode:await deploymentMode(),now:clock()})];
    for(const source of listingSources){
      try{
        const listing=await source();
        if(plain(listing)&&typeof listing.moduleId==="string"&&Array.isArray(listing.items)) listings.push(listing);
      }catch{}
    }
    return {rows:mergeGeneratorListings(listings),accountMap,deployed,handoffTask,recovery};
  }

  function accountLabel(accountMap,accountId){
    const account=accountId?accountMap.get(accountId):null;
    return account?text(account.displayName||account.accountId,80):(accountId?text(accountId,80)+" (missing)":"—");
  }

  function publicRow(row,accountMap){
    return Object.freeze({...row,accountLabel:accountLabel(accountMap,row.accountId)});
  }

  async function list({filter="",page=1}={}){
    const parsed=parseGeneratorIndexFilter(filter);
    if(!Number.isSafeInteger(page)||page<1||page>10000) throw new TypeError("Generator index page is invalid");
    const {rows,accountMap}=await build();
    const counts=Object.fromEntries(PCMS_GENERATOR_STATUS_FILTERS.map((key)=>[key,0]));
    for(const row of rows) counts[row.filter]+=1;
    const matching=rows.filter((row)=>(!parsed.status||row.filter===parsed.status)
      &&(!parsed.account||row.accountIds.includes(parsed.account)));
    const pages=Math.max(1,Math.ceil(matching.length/PCMS_GENERATOR_INDEX_PAGE_SIZE));
    const current=Math.min(page,pages);
    return Object.freeze({
      contract:PCMS_GENERATOR_INDEX_CONTRACT,
      total:rows.length,
      matching:matching.length,
      filter:parsed,
      counts:Object.freeze(counts),
      chips:Object.freeze(PCMS_GENERATOR_STATUS_FILTERS.filter((key)=>counts[key]>0).map((key)=>Object.freeze({key,label:FILTER_LABEL[key],count:counts[key]}))),
      page:current,
      pages,
      rows:Object.freeze(matching.slice((current-1)*PCMS_GENERATOR_INDEX_PAGE_SIZE,current*PCMS_GENERATOR_INDEX_PAGE_SIZE).map((row)=>publicRow(row,accountMap))),
      accounts:Object.freeze([...accountMap.values()].map((account)=>Object.freeze({accountId:account.accountId,label:accountLabel(accountMap,account.accountId)})))
    });
  }

  // Generator detail: the Deployer facet (desired / last confirmed), the open handoff, and
  // technical details. Hashes appear only in technical details; content never appears.
  async function get(ref){
    const generatorId=generatorIdFromRef(ref);
    const {rows,accountMap,deployed,handoffTask}=await build();
    const row=rows.find((item)=>item.ref===ref)||null;
    const deployment=deployed.deployments.find((item)=>item.targetRef.id===generatorId)||null;
    if(!row&&!deployment) return null;
    const facet=deployment?Object.freeze({
      deploymentId:deployment.deploymentId,
      revision:deployed.revision,
      desiredRevision:deployment.desired.revision,
      payloadKind:deployment.desired.payloadKind,
      origin:deployment.desired.origin,
      desiredListing:deployment.desired.listing,
      desiredHasThumbnail:deployment.desired.thumbnailHash!==null,
      confirmedAt:deployment.confirmed.confirmedAt,
      confirmedListing:deployment.confirmed.listing,
      confirmedMatchesDesired:deployment.confirmed.payloadHash===deployment.desired.payloadHash
        &&deployment.confirmed.thumbnailHash===deployment.desired.thumbnailHash&&deployment.confirmed.listing===deployment.desired.listing,
      operationStatus:deployment.operation.status,
      paused:deployment.policy.paused,
      pauseReason:deployment.policy.pauseReason,
      observation:observations?await observations.get(deployment.deploymentId):null,
      technical:Object.freeze({
        deploymentId:deployment.deploymentId,
        desiredRevision:deployment.desired.revision,
        payloadHash:deployment.desired.payloadHash,
        thumbnailHash:deployment.desired.thumbnailHash,
        confirmedPayloadHash:deployment.confirmed.payloadHash,
        baselineHash:deployment.confirmed.baselineHash,
        operationId:deployment.operation.operationId
      })
    }):null;
    return Object.freeze({
      contract:PCMS_GENERATOR_INDEX_CONTRACT,
      row:row?publicRow(row,accountMap):null,
      deployer:facet,
      handoffTaskId:handoffTask.get(generatorId)??null
    });
  }

  // Entity picker/search source: every Core generator picker searches this index (03 §4.5).
  async function search(query="",limit=20){
    const needle=String(query).normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if(needle.length>200||!Number.isSafeInteger(limit)||limit<1||limit>50) throw new TypeError("Generator search is invalid");
    const {rows,accountMap}=await build();
    return Object.freeze(rows
      .filter((row)=>!needle||row.slug.toLocaleLowerCase("en-US").includes(needle)||(row.title||"").toLocaleLowerCase("en-US").includes(needle))
      .slice(0,limit)
      .map((row)=>Object.freeze({ref:row.ref,slug:row.slug,title:row.title,accountId:row.accountId,accountLabel:accountLabel(accountMap,row.accountId),status:row.status})));
  }

  return Object.freeze({list,get,search});
}
