// P037 manual, bounded background scan. P038 owns schedules and restart wakeups, not this file.
import {REPO_ERRORS,normalizeRepositoryConfig,repositoryFailure}
  from "../../extension/pcms/providers/repository/contract.js";
import {GENERATOR_REPOSITORY_VALIDATOR_VERSION,validateRepositorySlice,
  finalizeRepositorySnapshot,readRepositoryRelease} from "./repository-format.js";
import {DEPLOYER_ERROR_CODES} from "./errors.js";

const FOLDER=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const BATCH=8;
function defaultState(){return {schemaVersion:1,config:null,defaultListing:"UNLISTED",
  mode:"assisted",identityEpoch:1,scanSequence:0,links:{},needsApply:false,snapshot:null,scan:null,
  lastCheckedAt:null,lastSuccessfulScanAt:null,lastFailure:null};}
function sameId(a,b){return a&&b&&a.provider===b.provider&&a.owner===b.owner&&a.repo===b.repo&&a.root===b.root;}
function sameConfig(a,b){return sameId(a,b)&&a.ref===b.ref&&JSON.stringify(a.access)===JSON.stringify(b.access);}
function fail(code){throw repositoryFailure(code);}
function validateState(value){
  if(!value||typeof value!=="object"||value.schemaVersion!==1||!Number.isSafeInteger(value.identityEpoch)
    ||!Number.isSafeInteger(value.scanSequence)||!value.links||typeof value.links!=="object")
    fail(REPO_ERRORS.PROTOCOL);
  return value;
}
export function createDeployerRepositoryService({stateStore,ledgerStore,repositoryProvider,deployer,accounts,
  recoveryHold=null,auditJournal=null,clock=()=>new Date().toISOString()}={}){
  if(typeof stateStore?.read!=="function"||typeof stateStore?.compareAndSwap!=="function"
    ||typeof ledgerStore?.get!=="function"||typeof ledgerStore?.compareAndSwap!=="function"
    ||typeof repositoryProvider?.resolveRef!=="function"||typeof repositoryProvider?.listTree!=="function"
    ||typeof repositoryProvider?.readBlob!=="function"
    ||typeof deployer?.listDeployments!=="function"||typeof deployer?.createDeployment!=="function"
    ||typeof deployer?.setDesired!=="function"||typeof accounts?.getAccount!=="function"
    ||typeof clock!=="function")throw new TypeError("Deployer repository dependencies are missing");

  async function read(){const row=await stateStore.read();return row===null?{revision:0,value:defaultState()}
    :{revision:row.revision,value:validateState(row.value)};}
  async function cas(current,next){
    const result=await stateStore.compareAndSwap({expectedRevision:current.revision,value:next});
    if(result?.ok!==true)fail(REPO_ERRORS.PROTOCOL);
    return {revision:result.revision,value:result.value};
  }
  async function configure({config,defaultListing="UNLISTED",expectedRevision}={}){
    const normalized=normalizeRepositoryConfig(config);
    if(!["PUBLICLY_LISTED","UNLISTED"].includes(defaultListing))fail(REPO_ERRORS.PROTOCOL);
    const current=await read();
    if(current.revision!==expectedRevision||current.value.scan!==null)fail(REPO_ERRORS.PROTOCOL);
    const changedIdentity=current.value.config!==null&&!sameId(current.value.config,normalized);
    const changed=!sameConfig(current.value.config,normalized)||current.value.defaultListing!==defaultListing;
    const next={...current.value,config:normalized,defaultListing,
      identityEpoch:current.value.identityEpoch+(changedIdentity?1:0),
      // Account-folder names have meaning only inside a repository identity.
      // Switching owner/repo/root must never inherit bindings from the old one.
      links:changedIdentity?{}:current.value.links,
      needsApply:changed?false:current.value.needsApply,
      snapshot:changed?null:current.value.snapshot,lastCheckedAt:changed?null:current.value.lastCheckedAt,
      lastFailure:null};
    return cas(current,next);
  }
  async function linkFolder({folder,accountId,expectedRevision}={}){
    if(!FOLDER.test(folder)||!ID.test(accountId))fail(REPO_ERRORS.PROTOCOL);
    if(!await accounts.getAccount(accountId))fail(REPO_ERRORS.NOT_FOUND);
    const current=await read();
    if(current.revision!==expectedRevision||current.value.scan!==null)fail(REPO_ERRORS.PROTOCOL);
    const links={...current.value.links,[folder]:accountId};
    return cas(current,{...current.value,links,needsApply:true});
  }
  async function unlinkFolder({folder,expectedRevision}={}){
    if(!FOLDER.test(folder))fail(REPO_ERRORS.PROTOCOL);
    const current=await read();
    if(current.revision!==expectedRevision||current.value.scan!==null)fail(REPO_ERRORS.PROTOCOL);
    const links={...current.value.links};
    delete links[folder];
    return cas(current,{...current.value,links,needsApply:true});
  }
  async function startScan(){
    const current=await read();
    if(!current.value.config)fail(REPO_ERRORS.NOT_FOUND);
    if(current.value.scan!==null)return Object.freeze({alreadyRunning:true,scan:current.value.scan});
    const scanSequence=current.value.scanSequence+1;
    const scan={scanId:scanSequence,step:"RESOLVE",commitId:null,cursor:0,items:[],problems:[],applied:0,deferred:false};
    await cas(current,{...current.value,scanSequence,scan,lastFailure:null});
    return Object.freeze({alreadyRunning:false,scan});
  }
  async function ledgerFor(state,slugs){
    const rows={};
    const found=new Map();
    for(const slug of new Set(slugs)){
      if(!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug))continue;
      const key="epoch:"+state.identityEpoch+":"+slug;
      const row=await ledgerStore.get(key);
      found.set(slug,{key,revision:row?.revision??0,raw:row?.value??[]});
      rows[slug]=row?.value??[];
    }
    return {rows,found};
  }
  async function persistLedger(result,found){
    for(const [slug,prior] of found){
      const next=result.ledger[slug]??[];
      if(JSON.stringify(next)===JSON.stringify(prior.raw))continue;
      const saved=await ledgerStore.compareAndSwap(prior.key,{expectedRevision:prior.revision,value:next});
      if(saved?.revision===undefined)fail(REPO_ERRORS.PROTOCOL);
    }
  }
  async function applyOne(state,item){
    const accountId=state.links[item.accountFolder];
    if(!accountId||!await accounts.getAccount(accountId))return "UNLINKED";
    const current=await deployer.listDeployments();
    const existing=current.deployments.find(v=>v.targetRef.id===item.slug);
    if(existing&&existing.accountId!==accountId)return "ACCOUNT_CHANGED";
    if(existing&&existing.desired.origin.kind!=="REPOSITORY")return "MANUAL";
    const intent={payloadHash:item.payloadHash,thumbnailHash:item.thumbnailHash,listing:item.listing,
      origin:{...item.origin,commitId:state.snapshot.commitId}};
    if(!existing){
      await deployer.createDeployment({deploymentId:"gen:"+item.slug,accountId,generatorId:item.slug,...intent},
        {expectedRevision:current.revision});
      return "CREATED";
    }
    try{
      const same=existing.desired.payloadHash===item.payloadHash&&existing.desired.thumbnailHash===item.thumbnailHash
        &&existing.desired.listing===item.listing;
      const method=same?"setRepositoryOrigin":"setDesired";
      await deployer[method](existing.deploymentId,{expectedRevision:current.revision,
        expectedDesiredRevision:existing.desired.revision,...intent});
      return same?"UNCHANGED":"UPDATED";
    }catch(e){if(e?.code===DEPLOYER_ERROR_CODES.OPERATION_BUSY)return "QUEUED";throw e;}
  }
  async function recoveryHeld(){
    if(!recoveryHold)return false;
    const status=await recoveryHold.getStatus();
    return status?.value?.state==="RECOVERY_HOLD";
  }
  async function scanStep({batchSize=BATCH}={}){
    if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>32)fail(REPO_ERRORS.PROTOCOL);
    let current=await read(),state=current.value,scan=state.scan;
    if(!scan)return Object.freeze({done:true,status:"IDLE",snapshot:state.snapshot});
    try{
      const config=state.config;
      if(scan.step==="RESOLVE"){
        const resolved=await repositoryProvider.resolveRef(config);
        const unchanged=state.snapshot?.commitId===resolved.commitId
          &&state.snapshot?.validatorVersion===GENERATOR_REPOSITORY_VALIDATOR_VERSION;
        if(unchanged){
          if(state.needsApply){
            await cas(current,{...state,scan:{...scan,step:"APPLY",commitId:resolved.commitId},lastFailure:null});
          }else{
            await cas(current,{...state,scan:null,lastCheckedAt:clock(),lastFailure:null});
            return Object.freeze({done:true,status:"UNCHANGED"});
          }
        }else{
          await cas(current,{...state,scan:{...scan,step:"VALIDATE",commitId:resolved.commitId}});
        }
      }else if(scan.step==="VALIDATE"){
        // Refetched at the pinned SHA on each bounded step; no giant tree or file payloads in DB.
        const tree=await repositoryProvider.listTree(config,scan.commitId);
        const prefix=config.root?config.root+"/":"";
        const paths=tree.entries.filter(e=>e.path.startsWith(prefix)&&e.path.endsWith("/generator.json")
          &&e.path.slice(prefix.length).split("/").length===3).sort((a,b)=>a.path.localeCompare(b.path));
        const chunk=paths.slice(scan.cursor,scan.cursor+batchSize).map(x=>x.path.slice(prefix.length).split("/")[1]);
        const {rows,found}=await ledgerFor(state,chunk);
        const part=await validateRepositorySlice({provider:repositoryProvider,config,commitId:scan.commitId,
          tree,ledger:rows,defaultListing:state.defaultListing,firstSeenAt:clock(),cursor:scan.cursor,
          batchSize,items:scan.items,problems:scan.problems});
        // Write the validated ledger before advancing cursor. Repeated steps compare by content.
        await persistLedger(part,found);
        await cas(current,{...state,scan:{...scan,step:part.done?"FINALIZE":"VALIDATE",cursor:part.cursor,
          items:part.items,problems:part.problems}});
      }else if(scan.step==="FINALIZE"){
        const snapshot=finalizeRepositorySnapshot({commitId:scan.commitId,items:scan.items,problems:scan.problems});
        await cas(current,{...state,snapshot,needsApply:true,scan:{...scan,step:"APPLY",items:[],problems:[],applied:0},
          lastCheckedAt:clock(),lastSuccessfulScanAt:clock(),lastFailure:null});
        if(auditJournal&&state.snapshot?.commitId!==snapshot.commitId){
          try{await auditJournal.append({type:"deployer.repository.scanned",subject:{kind:"module",id:"deployer"},
            data:{commitId:snapshot.commitId,items:snapshot.items.length,problems:snapshot.problems.length}});}catch{}
        }
      }else if(scan.step==="APPLY"){
        if(await recoveryHeld()){
          await cas(current,{...state,scan:null});return Object.freeze({done:true,status:"HELD",snapshot:state.snapshot});
        }
        const remaining=state.snapshot?.items??[];
        let cursor=scan.applied;
        for(let n=0;n<batchSize&&cursor<remaining.length;n++,cursor++){
          const outcome=await applyOne(state,remaining[cursor]);
          // BUSY never discards a newer repository intent. A future unchanged-ref
          // scan will retry these local preparations after reconciliation.
          current=await read();state=current.value;
          if(state.scan?.scanId!==scan.scanId||state.scan.step!=="APPLY")fail(REPO_ERRORS.PROTOCOL);
          await cas(current,{...state,scan:{...state.scan,applied:cursor+1,
            deferred:state.scan.deferred===true||outcome==="QUEUED"}});
        }
        current=await read();state=current.value;
        if(state.scan?.scanId!==scan.scanId)fail(REPO_ERRORS.PROTOCOL);
        if(state.scan.applied===(state.snapshot?.items.length??0)){
          await cas(current,{...state,scan:null,needsApply:state.scan.deferred===true});
          return Object.freeze({done:true,status:"SUCCESS",snapshot:state.snapshot});
        }
      }else fail(REPO_ERRORS.PROTOCOL);
    }catch(e){
      const code=typeof e?.code==="string"?e.code:REPO_ERRORS.UNAVAILABLE;
      // During APPLY preserve the cursor for an explicit retry; never abandon
      // a successfully published snapshot with only some targets prepared.
      current=await read();
      if(current.value.scan?.scanId===scan.scanId){
        try{await cas(current,{...current.value,scan:scan.step==="APPLY"?current.value.scan:null,lastFailure:{code,
          ...(e?.resetAt?{resetAt:e.resetAt}:{})},lastCheckedAt:clock()});}catch{}
      }
      return Object.freeze({done:true,status:"FAILED",error:code});
    }
    const result=await read();
    return Object.freeze({done:false,status:result.value.scan?.step??"IDLE",cursor:result.value.scan?.cursor??null});
  }
  async function scanNow({maxSteps=512}={}){
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>512)fail(REPO_ERRORS.PROTOCOL);
    const initial=await startScan();
    if(initial.alreadyRunning)return initial;
    let result;
    for(let n=0;n<maxSteps;n++){
      result=await scanStep();
      if(result.done)return result;
    }
    return Object.freeze({done:false,status:"CONTINUE"});
  }
  async function getDeploymentForSlug(slug){
    if(typeof slug!=="string"||!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug))fail(REPO_ERRORS.PROTOCOL);
    const result=await deployer.listDeployments();
    return Object.freeze({revision:result.revision,deployment:result.deployments.find(d=>d.targetRef.id===slug)??null});
  }
  async function adopt({slug,expectedRevision}={}){
    const state=(await read()).value;
    const item=state.snapshot?.items.find(v=>v.slug===slug);
    if(!item)fail(REPO_ERRORS.NOT_FOUND);
    const accountId=state.links[item.accountFolder];
    if(!accountId)fail(REPO_ERRORS.PROTOCOL);
    const current=await deployer.listDeployments();
    const deployment=current.deployments.find(v=>v.targetRef.id===slug);
    if(!deployment||deployment.desired.origin.kind!=="MANUAL"||deployment.accountId!==accountId
      ||current.revision!==expectedRevision)fail(REPO_ERRORS.PROTOCOL);
    if(typeof deployer.adoptRepository!=="function")fail(REPO_ERRORS.PROTOCOL);
    return deployer.adoptRepository(deployment.deploymentId,{expectedRevision,
      expectedDesiredRevision:deployment.desired.revision,payloadHash:item.payloadHash,
      thumbnailHash:item.thumbnailHash,listing:item.listing,
      origin:{...item.origin,commitId:state.snapshot.commitId}});
  }
  async function deployFromRepository({deploymentId,expectedRevision}={}){
    const state=(await read()).value;
    const existing=await deployer.getDeployment(deploymentId);
    if(!existing||existing.desired.origin.kind!=="REPOSITORY")fail(REPO_ERRORS.PROTOCOL);
    const item=state.snapshot?.items.find(v=>v.slug===existing.targetRef.id);
    if(!item||item.deploy==="hold"||item.payloadHash!==existing.desired.payloadHash||item.thumbnailHash!==existing.desired.thumbnailHash
       ||item.listing!==existing.desired.listing||existing.desired.origin.commitId!==state.snapshot.commitId)
      fail(REPO_ERRORS.PROTOCOL);
    const payload=await readRepositoryRelease({provider:repositoryProvider,config:state.config,
      snapshotItem:item,commitId:state.snapshot.commitId});
    return deployer.deploy(deploymentId,{expectedRevision,payload});
  }
  async function readDesiredPayload(deploymentId){
    const state=(await read()).value,existing=await deployer.getDeployment(deploymentId);
    const item=state.snapshot?.items.find(v=>v.slug===existing?.targetRef.id);
    if(!existing||existing.desired.origin.kind!=="REPOSITORY"||!item||existing.desired.origin.commitId!==state.snapshot.commitId
      ||item.payloadHash!==existing.desired.payloadHash||item.thumbnailHash!==existing.desired.thumbnailHash)fail(REPO_ERRORS.PROTOCOL);
    return readRepositoryRelease({provider:repositoryProvider,config:state.config,snapshotItem:item,commitId:state.snapshot.commitId});
  }
  return Object.freeze({read,configure,linkFolder,unlinkFolder,startScan,scanStep,scanNow,getDeploymentForSlug,adopt,deployFromRepository,readDesiredPayload});
}
