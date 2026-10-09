// P040 Explorer built-in UI (pcms.ui-contribution/v1). Accounts are picked, observed source is an
// uploaded file hashed here, and discovery, reservation and deployment IDs are generated: the
// operator never types a durable ID or a hash.
import { sha256Hex } from "../../extension/pcms/providers/perchance/contract.js";

const GENERATOR_NAME="[a-z0-9][a-z0-9_-]{0,99}";
const CLAIM_STATUS=Object.freeze({
  READY:{token:"OK",label:"Reserved"},
  TARGET_MISSING:{token:"WARNING",label:"No longer observed"},
  ACCOUNT_UNAVAILABLE:{token:"WARNING",label:"Account unavailable"},
  UNKNOWN:{token:"UNCERTAIN",label:"Unknown"},
  RELEASED:{token:"INFO",label:"Released"}
});
const MESSAGES=Object.freeze({
  PCMS_EXPLORER_ACCOUNT_UNAVAILABLE:"That account is unavailable.",
  PCMS_EXPLORER_INVALID_TRANSITION:"This candidate is no longer current; record it again first.",
  PCMS_EXPLORER_CLAIM_CONFLICT:"This generator is already reserved.",
  PCMS_EXPLORER_REVISION_CONFLICT:"Explorer changed meanwhile. Try again.",
  PCMS_INTEGRATION_RESERVATION_NOT_READY:"This reservation is not ready. It needs a current observation with uploaded source.",
  PCMS_INTEGRATION_CROSS_MODULE_CONFLICT:"Deployer already has a different deployment for this generator."
});

function receipt(message,token="OK",label="Updated",extra={}){return {status:{token,label},message,...extra};}
function fold(value){return String(value).normalize("NFKC").toLocaleLowerCase("en-US");}
function nextId(prefix,taken){
  for(let n=1;n<100000;n+=1){const id=prefix+":"+n;if(!taken.has(id))return id;}
  throw new TypeError("No identifier is available");
}

export function createUiContribution({moduleId="explorer",service}={}){
  if(!service||typeof service.explorer?.listCandidates!=="function"||typeof service.explorerDeployer?.createDeploymentFromClaim!=="function"
     ||typeof service.deployer?.listDeployments!=="function"||typeof service.accounts?.listAccounts!=="function"){
    throw new TypeError("Explorer UI requires the Explorer, Deployer bridge and Accounts services");
  }
  const {explorer,explorerDeployer,deployer,accounts}=service;
  const candidateRef=(id)=>({kind:"module-object",moduleId,view:"candidate",id});
  const reservationRef=(id)=>({kind:"module-object",moduleId,view:"reservation",id});

  const actions=[
    {id:"record",label:"Record discovery…",appliesTo:"module",risk:"LOCAL",input:[
      {key:"account",label:"Account that owns it",kind:"entity",entityKind:"account",required:true},
      {key:"generator",label:"Generator name on Perchance",kind:"text",required:true,maxLength:100,pattern:GENERATOR_NAME,
        help:"As in perchance.org/<name>."},
      {key:"source",label:"Downloaded generator source (optional)",kind:"file",accept:".txt,.perchance,text/plain",
        help:"PCMS keeps only its fingerprint; it is needed to prepare a deployment."}]},
    {id:"reserve",label:"Reserve for deployment",appliesTo:"module-object:candidate",risk:"LOCAL"},
    {id:"prepare",label:"Prepare deployment",appliesTo:"module-object:reservation",risk:"LOCAL"},
    {id:"release",label:"Release reservation",appliesTo:"module-object:reservation",risk:"LOCAL"}
  ];

  async function snapshot(){
    const [candidates,reservations,listed]=await Promise.all([explorer.listCandidates(),explorer.listReservations(),accounts.listAccounts()]);
    return {candidates,reservations,names:new Map((listed.accounts||[]).map((a)=>[a.accountId,a.displayName||a.accountId]))};
  }
  async function guarded(run){
    try{return await run();}
    catch(error){const message=MESSAGES[error?.code];if(!message)throw error;return receipt(message,"WARNING","Not done");}
  }

  return {
    contractVersion:1,moduleId,title:"Explorer",description:"Generators observed on Perchance and reserved for deployment.",
    icon:"compass",nav:{label:"Explorer",order:40,statusFrom:"summary"},actions,
    page:{views:[
      {id:"candidates",title:"Candidates",type:"list",columns:[
        {id:"generator",label:"Generator",kind:"text"},{id:"account",label:"Account",kind:"text"},
        {id:"freshness",label:"Observed",kind:"status"},{id:"reservation",label:"Reservation",kind:"text"}],
        rowHref:"candidate",actions:["record"]},
      {id:"candidate",title:"Candidate",type:"detail",actions:["reserve"]},
      {id:"reservations",title:"Reservations",type:"list",columns:[
        {id:"generator",label:"Generator",kind:"text"},{id:"account",label:"Account",kind:"text"},{id:"status",label:"Status",kind:"status"}],
        rowHref:"reservation"},
      {id:"reservation",title:"Reservation",type:"detail",actions:["prepare","release"]}
    ]},

    async summary(){
      const {candidates,reservations}=await snapshot();
      const active=reservations.reservations.filter((r)=>r.status!=="RELEASED");
      const attention=active.filter((r)=>r.status!=="READY").length;
      return {status:attention?{token:"WARNING",label:"Needs attention"}:{token:"OK",label:"Up to date"},
        headline:candidates.candidates.length+" candidates · "+active.length+" reserved",
        facts:[{label:"Candidates",value:String(candidates.candidates.length)},{label:"Reserved",value:String(active.length)}],href:"#/m/"+moduleId};
    },

    async search(_ctx,query,limit){
      const needle=fold(query);const {candidates}=await snapshot();
      return candidates.candidates.filter((c)=>fold(c.generatorId).includes(needle)).slice(0,limit).map((c)=>({
        entity:candidateRef(c.candidateId),title:c.generatorId,subtitle:"Explorer candidate",score:fold(c.generatorId).startsWith(needle)?80:60}));
    },

    async conditions(){
      const {reservations}=await snapshot();
      return reservations.reservations.filter((r)=>r.status!=="RELEASED"&&r.status!=="READY").slice(0,200).map((r)=>({
        key:"reservation:"+r.claimId,priority:"NORMAL",status:CLAIM_STATUS[r.status]||CLAIM_STATUS.UNKNOWN,
        title:"Reservation needs attention · "+r.targetRef.id,subject:reservationRef(r.claimId),actionId:"release"}));
    },

    facets:{
      async generator(_ctx,entity){
        const {candidates,reservations}=await snapshot();
        const candidate=candidates.candidates.find((c)=>c.generatorId===entity.id);
        const reservation=reservations.reservations.find((r)=>r.targetRef.id===entity.id&&r.status!=="RELEASED");
        if(!candidate&&!reservation)return null;
        return {title:"Explorer",facts:[
          ...(candidate?[{label:"Observed",value:candidate.freshness==="CURRENT"?"In the latest observation":"Not in the latest observation"}]:[]),
          {label:"Reservation",value:reservation?(CLAIM_STATUS[reservation.status]||CLAIM_STATUS.UNKNOWN).label:"None"}]};
      }
    },

    async listRows(_ctx,viewId,cursor=null){
      const snap=await snapshot();const offset=cursor??0;
      if(viewId==="candidates"){
        const all=snap.candidates.candidates;
        return {rows:all.slice(offset,offset+100).map((c)=>({id:c.candidateId,cells:{generator:c.generatorId,account:snap.names.get(c.accountId)??c.accountId,
          freshness:c.freshness==="CURRENT"?{token:"OK",label:"Current"}:{token:"INFO",label:"Stale"},
          reservation:c.claimStatus?(CLAIM_STATUS[c.claimStatus]||CLAIM_STATUS.UNKNOWN).label:"—"}})),next:offset+100<all.length?offset+100:null};
      }
      if(viewId==="reservations"){
        const all=snap.reservations.reservations;
        return {rows:all.slice(offset,offset+100).map((r)=>({id:r.claimId,cells:{generator:r.targetRef.id,account:snap.names.get(r.accountId)??r.accountId,
          status:CLAIM_STATUS[r.status]||CLAIM_STATUS.UNKNOWN}})),next:offset+100<all.length?offset+100:null};
      }
      throw new TypeError("Unknown Explorer view");
    },

    async getDetail(_ctx,viewId,id){
      const snap=await snapshot();
      if(viewId==="candidate"){
        const c=snap.candidates.candidates.find((item)=>item.candidateId===id);
        if(!c)throw new TypeError("Candidate not found");
        return {title:c.generatorId,status:c.freshness==="CURRENT"?{token:"OK",label:"Current"}:{token:"INFO",label:"Stale"},sections:[
          {title:"Observation",facts:[{label:"Account",value:snap.names.get(c.accountId)??c.accountId,href:"#/accounts/"+encodeURIComponent(c.accountId)},
            {label:"Source",value:c.observedSourceHash?"Fingerprint recorded":"Not uploaded"},
            {label:"Reservation",value:c.claimStatus?(CLAIM_STATUS[c.claimStatus]||CLAIM_STATUS.UNKNOWN).label:"None"}]}]};
      }
      if(viewId==="reservation"){
        const r=snap.reservations.reservations.find((item)=>item.claimId===id);
        if(!r)throw new TypeError("Reservation not found");
        return {title:r.targetRef.id,status:CLAIM_STATUS[r.status]||CLAIM_STATUS.UNKNOWN,sections:[
          {title:"Reservation",facts:[{label:"Account",value:snap.names.get(r.accountId)??r.accountId,href:"#/accounts/"+encodeURIComponent(r.accountId)},
            {label:"Ready to deploy",value:r.actions.canCreateDeployment?"Yes":"No"}]},
          {title:"Technical details",facts:[{label:"Reservation",value:r.claimId},{label:"Deployment",value:r.deploymentId}]}]};
      }
      throw new TypeError("Unknown Explorer detail");
    },

    async invoke(ctx,actionId,ref,input,{mode}={}){
      if(mode==="preview")return receipt("Review the Explorer action.","INFO","Ready");
      if(actionId==="record"){
        return guarded(async()=>{
          const current=await explorer.listCandidates(input.account);
          // An observation adds to what was observed before for this account; it never drops it.
          const entries=new Map(current.candidates.filter((c)=>c.freshness==="CURRENT").map((c)=>[c.generatorId,c.observedSourceHash]));
          const hash=input.source===undefined?(entries.get(input.generator)??null):await sha256Hex(input.source);
          entries.set(input.generator,hash);
          const discoveryId="discovery:"+Date.parse(ctx?.asOf??new Date().toISOString())+":"+(current.revision+1);
          const result=await explorer.recordDiscovery({accountId:input.account,discoveryId,
            candidates:[...entries].map(([generatorId,observedSourceHash])=>({generatorId,observedSourceHash}))},{expectedRevision:current.revision});
          const candidate=result.candidates.find((c)=>c.generatorId===input.generator);
          return receipt("Recorded "+input.generator+" for "+input.account+".","OK","Recorded",
            candidate?{followUp:{href:"#/m/"+moduleId+"/candidate/"+encodeURIComponent(candidate.candidateId),label:"Open candidate"}}:{});
        });
      }
      if(ref?.kind!=="module-object"||ref.moduleId!==moduleId)throw new TypeError("An Explorer object is required");
      return guarded(async()=>{
        if(actionId==="reserve"&&ref.view==="candidate"){
          const [candidates,reservations]=await Promise.all([explorer.listCandidates(),explorer.listReservations()]);
          const candidate=candidates.candidates.find((c)=>c.candidateId===ref.id);
          if(!candidate)throw new TypeError("Candidate not found");
          const claims=new Set(reservations.reservations.map((r)=>r.claimId));
          const deployments=new Set([...reservations.reservations.map((r)=>r.deploymentId),
            ...(await deployer.listDeployments()).deployments.map((d)=>d.deploymentId)]);
          const claimId=nextId("reserve:"+candidate.generatorId,claims);
          const deploymentId=nextId("explore:"+candidate.generatorId,deployments);
          const result=await explorer.claimCandidate(candidate.candidateId,{claimId,deploymentId},{expectedRevision:candidates.revision});
          return receipt("Reserved "+candidate.generatorId+".","OK","Reserved",
            {followUp:{href:"#/m/"+moduleId+"/reservation/"+encodeURIComponent(result.reservation.claimId),label:"Open reservation"}});
        }
        if(ref.view==="reservation"){
          const reservations=await explorer.listReservations();
          const reservation=reservations.reservations.find((r)=>r.claimId===ref.id);
          if(!reservation)throw new TypeError("Reservation not found");
          if(actionId==="prepare"){
            const listed=await deployer.listDeployments();
            const result=await explorerDeployer.createDeploymentFromClaim(reservation.claimId,{expectedDeployerRevision:listed.revision});
            return receipt(result.created?"Deployment prepared in Deployer.":"Deployment was already prepared.","OK","Prepared",
              {followUp:{href:"#/generators/perchance/"+encodeURIComponent(reservation.targetRef.id),label:"Open generator"}});
          }
          if(actionId==="release"){
            await explorer.releaseClaim(reservation.claimId,{expectedRevision:reservations.revision});
            return receipt("Reservation released.");
          }
        }
        throw new TypeError("Unknown Explorer action");
      });
    }
  };
}
