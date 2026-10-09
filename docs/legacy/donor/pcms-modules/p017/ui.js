// P040 Refresher built-in UI (pcms.ui-contribution/v1). Cohorts are created only by the explicit
// "New cohort…" action, generators are chosen with the Core picker, and refresh content always
// comes from the Deployer's confirmed release: nothing here asks for source, hashes or IDs.
import { describeConfirmedRelease } from "./release-source.js";

const MEMBER_SEPARATOR="@";
const UNRESOLVED=new Set(["PENDING","ACTIVE","RECONCILE","RETRYABLE"]);
const STATUS=Object.freeze({
  IDLE:{token:"INFO",label:"Not refreshed yet"},
  PENDING:{token:"ACTIVE",label:"Queued"},
  ACTIVE:{token:"ACTIVE",label:"Refreshing"},
  RECONCILE:{token:"UNCERTAIN",label:"Outcome unknown"},
  RETRYABLE:{token:"WARNING",label:"Will retry"},
  FAILED:{token:"WARNING",label:"Not applied"},
  CANCELLED:{token:"INFO",label:"Discarded"},
  SUCCEEDED:{token:"OK",label:"Refreshed"}
});
const REASONS=Object.freeze({
  NOT_DEPLOYED:"Not deployed yet",
  LEGACY_SOURCE:"Deployed from pasted source; deploy it from the repository first",
  UPDATE_PENDING:"An update is waiting in Deployer",
  BUSY:"Deployer is working on this generator",
  PAUSED:"Paused in Deployer",
  NO_STORED_CONTENT:"Manual deployment; no stored release to refresh",
  NO_RELEASE_SOURCE:"Deployer releases are unavailable"
});
const MESSAGES=Object.freeze({
  PCMS_REFRESHER_BUDGET_EXHAUSTED:"Today's refresh budget for this cohort is used up.",
  PCMS_REFRESHER_SCHEDULE_INACTIVE:"This cohort is paused or outside its active hours.",
  PCMS_REFRESHER_RELEASE_UNAVAILABLE:"There is no refreshable Deployer-confirmed release for this generator.",
  PCMS_REFRESHER_TARGET_CONFLICT:"That generator already belongs to a cohort.",
  PCMS_REFRESHER_ACCOUNT_UNAVAILABLE:"That generator is not deployed for this cohort's account.",
  PCMS_REFRESHER_OPERATION_BUSY:"A refresh is still unresolved. Check its outcome first.",
  PCMS_REFRESHER_INVALID_TRANSITION:"That is not possible in the current state.",
  PCMS_REFRESHER_REVISION_CONFLICT:"Refresher changed meanwhile. Try again.",
  PCMS_REFRESHER_CAPACITY:"The Refresher is full."
});

const policyFields=[
  {key:"mode",label:"Mode",kind:"choice",required:true,default:"automatic",options:[
    {id:"automatic",label:"Automatic in the background"},{id:"manual",label:"Only when I choose Refresh now"}]},
  {key:"dailyBudget",label:"Refresh up to this many generators per day",kind:"integer",required:true,min:1,max:500,default:3},
  {key:"startHour",label:"Day starts at (hour, UTC)",kind:"integer",required:true,min:0,max:23,default:8},
  {key:"activeHours",label:"Active for (hours)",kind:"integer",required:true,min:1,max:24,default:24,unit:"h",
    help:"Then rest for the days below; with 0 rest days the cohort stays active."},
  {key:"restDays",label:"Then rest for (days)",kind:"integer",required:true,min:0,max:365,default:0,unit:"d"}
];

function receipt(message,token="OK",label="Updated",extra={}){return {status:{token,label},message,...extra};}
function fold(value){return String(value).normalize("NFKC").toLocaleLowerCase("en-US");}
function slug(value){
  return String(value).normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase()
    .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80).replace(/-+$/,"")||"cohort";
}
export function refresherCohortIdFor(name,existing){
  const stem=slug(name);const taken=new Set(existing);
  if(!taken.has(stem))return stem;
  for(let n=2;n<10000;n+=1){const id=stem.slice(0,90)+"-"+n;if(!taken.has(id))return id;}
  throw new TypeError("No cohort key is available for that name");
}
// The cohort window starts at `startHour` UTC: anchor on the latest such instant not in the future.
export function refresherPolicyFrom(input,now){
  const nowMs=Date.parse(now);const day=Math.floor(nowMs/86400000)*86400000;
  let anchor=day+input.startHour*3600000;if(anchor>nowMs)anchor-=86400000;
  return {mode:input.mode==="manual"?"MANUAL":"AUTO_RECENT",dailyBudget:input.dailyBudget,dayOffsetMinutes:input.startHour*60,
    activeHours:input.activeHours,sleepDays:input.restDays,anchorAt:new Date(anchor).toISOString()};
}
export function refresherMemberId(cohortId,generatorId){return cohortId+MEMBER_SEPARATOR+generatorId;}
function parseMemberId(id){
  const at=typeof id==="string"?id.indexOf(MEMBER_SEPARATOR):-1;
  if(at<1)throw new TypeError("Refresher member is invalid");
  return {cohortId:id.slice(0,at),generatorId:id.slice(at+1)};
}
function policyText(cohort){
  const p=cohort.policy;
  const window=p.sleepDays===0?"active continuously":"active "+p.activeHours+" h, then rest "+p.sleepDays+" d";
  return (p.mode==="MANUAL"?"Manual":"Automatic")+" · up to "+p.dailyBudget+" per day · day starts "+String(Math.floor(p.dayOffsetMinutes/60)).padStart(2,"0")+":00 UTC · "+window;
}
function memberStatus(member){
  if(member.operation.status==="IDLE"&&member.lastConfirmedAt)return STATUS.SUCCEEDED;
  return STATUS[member.operation.status]||STATUS.IDLE;
}

export function createUiContribution({moduleId="refresher",service}={}){
  if(!service||typeof service.refresher?.listCohortViews!=="function"||typeof service.accounts?.listAccounts!=="function"
     ||typeof service.deployer?.listDeployments!=="function"||typeof service.wake!=="function"){
    throw new TypeError("Refresher UI requires the Refresher, Accounts and Deployer services");
  }
  const {refresher,accounts,deployer}=service;
  // Background dispatch is capability-gated (P042/P044); when it is off, due refreshes surface
  // in Attention and the operator runs them with Refresh now.
  async function automatic(){
    if(typeof service.unattended!=="function")return false;
    try{return (await service.unattended())===true;}catch{return false;}
  }
  const cohortRef=(id)=>({kind:"module-object",moduleId,view:"cohort",id});
  const memberRef=(cohortId,generatorId)=>({kind:"module-object",moduleId,view:"member",id:refresherMemberId(cohortId,generatorId)});

  const actions=[
    {id:"new-cohort",label:"New cohort…",appliesTo:"module",risk:"LOCAL",input:[
      {key:"name",label:"Cohort name",kind:"text",required:true,maxLength:80},
      {key:"account",label:"Account",kind:"entity",entityKind:"account",required:true},
      {key:"generator",label:"First generator",kind:"entity",entityKind:"generator",required:true},
      ...policyFields,
      {key:"enabled",label:"Start enabled",kind:"boolean",default:true}]},
    {id:"add-generator",label:"Add generator…",appliesTo:"module-object:cohort",risk:"LOCAL",input:[
      {key:"generator",label:"Generator",kind:"entity",entityKind:"generator",required:true}]},
    {id:"edit-policy",label:"Edit schedule…",appliesTo:"module-object:cohort",risk:"LOCAL",input:policyFields},
    {id:"rename",label:"Rename…",appliesTo:"module-object:cohort",risk:"LOCAL",input:[
      {key:"name",label:"Cohort name",kind:"text",required:true,maxLength:80}]},
    {id:"enable",label:"Enable",appliesTo:"module-object:cohort",risk:"LOCAL"},
    {id:"disable",label:"Pause",appliesTo:"module-object:cohort",risk:"LOCAL"},
    {id:"refresh-now",label:"Refresh now",appliesTo:"module-object:member",risk:"EXTERNAL_MUTATION",preview:true},
    {id:"check-outcome",label:"Check outcome",appliesTo:"module-object:member",risk:"LOCAL"},
    {id:"discard",label:"Discard pending refresh",appliesTo:"module-object:member",risk:"RESOLUTION"},
    {id:"remove",label:"Remove from cohort",appliesTo:"module-object:member",risk:"LOCAL"}
  ];

  async function snapshot(){
    const [views,listed,deployments]=await Promise.all([refresher.listCohortViews(),accounts.listAccounts(),deployer.listDeployments()]);
    const accountNames=new Map((listed.accounts||[]).map((a)=>[a.accountId,a.displayName||a.accountId]));
    const byGenerator=new Map(deployments.deployments.map((d)=>[d.targetRef.id,describeConfirmedRelease(d)]));
    return {views,accountNames,byGenerator};
  }
  function memberRows(snap){
    return snap.views.cohorts.flatMap((cohort)=>cohort.members.map((member)=>({cohort,member})));
  }
  function readiness(snap,cohort,member){
    if(member.sourceKind!=="DEPLOYER_CONFIRMED")return "Legacy pasted-source member";
    const described=snap.byGenerator.get(member.generatorId)||null;
    if(!described)return REASONS.NOT_DEPLOYED;
    if(described.accountId!==cohort.accountId)return "Deployed for a different account";
    return described.refreshable?"Ready":REASONS[described.reason]||"Not refreshable";
  }
  async function findCohort(id){
    const listed=await refresher.listCohorts();
    const cohort=listed.cohorts.find((item)=>item.cohortId===id);
    if(!cohort)throw new TypeError("This cohort no longer exists");
    return {revision:listed.revision,cohort};
  }
  async function failureReceipt(run){
    try{return await run();}
    catch(error){
      const message=MESSAGES[error?.code];
      if(!message)throw error;
      return receipt(message,"WARNING","Not done");
    }
  }

  return {
    contractVersion:1,moduleId,title:"Refresher",description:"Keeps deployed generators fresh on a schedule, from their Deployer-confirmed release.",
    icon:"refresh",nav:{label:"Refresher",order:30,statusFrom:"summary"},actions,
    page:{views:[
      {id:"cohorts",title:"Cohorts",type:"list",columns:[
        {id:"name",label:"Cohort",kind:"text"},{id:"account",label:"Account",kind:"text"},{id:"mode",label:"Mode",kind:"text"},
        {id:"today",label:"Today",kind:"text"},{id:"members",label:"Generators",kind:"count"},{id:"status",label:"Status",kind:"status"}],
        rowHref:"cohort",actions:["new-cohort"]},
      {id:"cohort",title:"Cohort",type:"detail",actions:["add-generator","edit-policy","rename","enable","disable"]},
      {id:"members",title:"Generators in cohorts",type:"list",columns:[
        {id:"generator",label:"Generator",kind:"text"},{id:"cohort",label:"Cohort",kind:"text"},
        {id:"last",label:"Last refresh",kind:"text"},{id:"status",label:"Status",kind:"status"},{id:"ready",label:"Content",kind:"text"}],
        rowHref:"member"},
      {id:"member",title:"Generator in cohort",type:"detail",actions:["refresh-now","check-outcome","discard","remove"]}
    ]},

    async summary(){
      const {views}=await snapshot();
      const refreshedToday=views.cohorts.reduce((n,c)=>n+c.members.filter((m)=>m.confirmedToday).length,0);
      const budget=views.cohorts.filter((c)=>c.enabled).reduce((n,c)=>n+c.budget.limit,0);
      const uncertain=views.cohorts.some((c)=>c.members.some((m)=>m.operationStatus==="RECONCILE"||m.operationStatus==="ACTIVE"));
      const background=await automatic();
      return {status:uncertain?{token:"UNCERTAIN",label:"Outcome unknown"}:views.cohorts.length?{token:"OK",label:"Scheduled"}:{token:"INFO",label:"No cohorts"},
        headline:views.cohorts.length?views.cohorts.length+" cohort"+(views.cohorts.length===1?"":"s")+" · "+refreshedToday+" refreshes today (budget "+budget+")"
          :"Create a cohort to keep generators fresh",
        facts:[{label:"Cohorts",value:String(views.cohorts.length)},{label:"Refreshes today",value:String(refreshedToday)},
          {label:"Daily budget",value:String(budget)},
          {label:"Background refresh",value:background?"Automatic":"Assisted: use Refresh now"}],href:"#/m/"+moduleId};
    },

    async search(_ctx,query,limit){
      const needle=fold(query);const {views}=await snapshot();
      return views.cohorts.filter((c)=>fold(c.name).includes(needle)).slice(0,limit).map((c)=>({
        entity:cohortRef(c.cohortId),title:c.name,subtitle:"Refresher cohort · "+c.members.length+" generators",score:fold(c.name).startsWith(needle)?85:65}));
    },

    async conditions(){
      const snap=await snapshot();const out=[];const background=await automatic();
      for(const {cohort,member} of memberRows(snap)){
        if(member.operationStatus==="RECONCILE"||member.operationStatus==="ACTIVE"){
          out.push({key:"uncertain:"+refresherMemberId(cohort.cohortId,member.generatorId),priority:"HIGH",status:{token:"UNCERTAIN",label:"Outcome unknown"},
            title:"Refresh outcome unknown · "+member.generatorId,subject:memberRef(cohort.cohortId,member.generatorId),actionId:"check-outcome"});
        } else if(member.sourceKind==="LEGACY_SOURCE"&&UNRESOLVED.has(member.operationStatus)){
          out.push({key:"legacy:"+refresherMemberId(cohort.cohortId,member.generatorId),priority:"NORMAL",status:{token:"WARNING",label:"Needs a decision"},
            title:"Legacy refresh needs source · "+member.generatorId,subject:memberRef(cohort.cohortId,member.generatorId),actionId:"discard"});
        } else if(!background&&cohort.mode==="AUTO_RECENT"&&member.eligible&&readiness(snap,cohort,member)==="Ready"){
          out.push({key:"due:"+refresherMemberId(cohort.cohortId,member.generatorId),priority:"NORMAL",status:{token:"INFO",label:"Refresh due"},
            title:"Refresh due · "+member.generatorId+" ("+cohort.name+")",subject:memberRef(cohort.cohortId,member.generatorId),actionId:"refresh-now"});
        }
      }
      return out.slice(0,200);
    },

    facets:{
      async generator(_ctx,entity){
        const snap=await snapshot();const row=memberRows(snap).find(({member})=>member.generatorId===entity.id);
        if(!row)return {title:"Refresher",facts:[{label:"Cohort",value:"Not in a cohort"}],columns:{cohort:{label:"Refresher",value:"—"}}};
        const status=memberStatus({operation:{status:row.member.operationStatus},lastConfirmedAt:row.member.lastConfirmedAt});
        return {title:"Refresher",status,facts:[
          {label:"Cohort",value:row.cohort.name,href:"#/m/"+moduleId+"/cohort/"+encodeURIComponent(row.cohort.cohortId)},
          {label:"Last refresh",value:row.member.lastConfirmedAt??"Never"},
          {label:"Content",value:readiness(snap,row.cohort,row.member)}],
          columns:{cohort:{label:"Refresher",value:row.cohort.name,token:status.token}}};
      },
      async account(_ctx,entity){
        const {views}=await snapshot();const mine=views.cohorts.filter((c)=>c.accountId===entity.id);
        if(!mine.length)return null;
        return {title:"Refresher",facts:[{label:"Cohorts",value:String(mine.length),href:"#/m/"+moduleId},
          {label:"Generators",value:String(mine.reduce((n,c)=>n+c.members.length,0))}]};
      }
    },

    async listRows(_ctx,viewId,cursor=null){
      const snap=await snapshot();const offset=cursor??0;
      if(viewId==="cohorts"){
        const all=snap.views.cohorts;
        return {rows:all.slice(offset,offset+100).map((c)=>({id:c.cohortId,cells:{
          name:c.name,account:snap.accountNames.get(c.accountId)??c.accountId,mode:c.mode==="MANUAL"?"Manual":"Automatic",
          today:c.budget.used+" of "+c.budget.limit,members:c.members.length,
          status:!c.enabled?{token:"INFO",label:"Paused"}:c.mode==="MANUAL"?{token:"INFO",label:"Manual"}
            :c.active?{token:"OK",label:"Active"}:{token:"INFO",label:"Resting"}}})),next:offset+100<all.length?offset+100:null};
      }
      if(viewId==="members"){
        const all=memberRows(snap);
        return {rows:all.slice(offset,offset+100).map(({cohort,member})=>({id:refresherMemberId(cohort.cohortId,member.generatorId),cells:{
          generator:member.generatorId,cohort:cohort.name,last:member.lastConfirmedAt??"Never",
          status:memberStatus({operation:{status:member.operationStatus},lastConfirmedAt:member.lastConfirmedAt}),
          ready:readiness(snap,cohort,member)}})),next:offset+100<all.length?offset+100:null};
      }
      throw new TypeError("Unknown Refresher view");
    },

    async getDetail(_ctx,viewId,id){
      const snap=await snapshot();
      if(viewId==="cohort"){
        const cohort=snap.views.cohorts.find((c)=>c.cohortId===id);
        if(!cohort)throw new TypeError("Cohort not found");
        return {title:cohort.name,status:cohort.enabled?{token:"OK",label:"Enabled"}:{token:"INFO",label:"Paused"},sections:[
          {title:"Schedule",facts:[{label:"Account",value:snap.accountNames.get(cohort.accountId)??cohort.accountId,href:"#/accounts/"+encodeURIComponent(cohort.accountId)},
            {label:"Policy",value:policyText(cohort)},{label:"Today",value:cohort.budget.used+" of "+cohort.budget.limit+" used"},
            {label:"Now",value:cohort.mode==="MANUAL"?"Manual only":cohort.active?"Active":"Resting"}]},
          {title:"Generators",facts:cohort.members.slice(0,12).map((m)=>({label:m.generatorId,
            value:memberStatus({operation:{status:m.operationStatus},lastConfirmedAt:m.lastConfirmedAt}).label+" · "+readiness(snap,cohort,m),
            href:"#/m/"+moduleId+"/member/"+encodeURIComponent(refresherMemberId(cohort.cohortId,m.generatorId))}))}]};
      }
      if(viewId==="member"){
        const {cohortId,generatorId}=parseMemberId(id);
        const cohort=snap.views.cohorts.find((c)=>c.cohortId===cohortId);const member=cohort?.members.find((m)=>m.generatorId===generatorId);
        if(!member)throw new TypeError("Generator is not in this cohort");
        return {title:generatorId,status:memberStatus({operation:{status:member.operationStatus},lastConfirmedAt:member.lastConfirmedAt}),sections:[
          {title:"Refresh",facts:[{label:"Cohort",value:cohort.name,href:"#/m/"+moduleId+"/cohort/"+encodeURIComponent(cohortId)},
            {label:"Last refresh",value:member.lastConfirmedAt??"Never"},{label:"Refreshes",value:String(member.confirmedCount)},
            {label:"Content",value:readiness(snap,cohort,member)}]},
          {title:"Technical details",facts:[{label:"Operation",value:member.operationId??"—"},{label:"Operation state",value:member.operationStatus},
            {label:"Source",value:member.sourceKind==="DEPLOYER_CONFIRMED"?"Deployer-confirmed release":"Legacy pasted source"}]}]};
      }
      throw new TypeError("Unknown Refresher detail");
    },

    async invoke(_ctx,actionId,ref,input,{mode}={}){
      if(actionId==="new-cohort"){
        if(mode==="preview")return receipt("Review the new cohort.","INFO","Ready");
        return failureReceipt(async()=>{
          const listed=await refresher.listCohorts();
          const cohortId=refresherCohortIdFor(input.name,listed.cohorts.map((c)=>c.cohortId));
          await refresher.createCohort({cohortId,name:input.name,accountId:input.account,enabled:input.enabled!==false,
            policy:refresherPolicyFrom(input,_ctx?.asOf??new Date().toISOString()),members:[{generatorId:input.generator}]},{expectedRevision:listed.revision});
          await service.wake();
          return receipt("Cohort created. It refreshes "+input.generator+" from its Deployer-confirmed release.","OK","Created",
            {followUp:{href:"#/m/"+moduleId+"/cohort/"+encodeURIComponent(cohortId),label:"Open cohort"},subject:cohortRef(cohortId)});
        });
      }
      if(ref?.kind!=="module-object"||ref.moduleId!==moduleId)throw new TypeError("A Refresher object is required");
      if(ref.view==="cohort"){
        if(mode==="preview")return receipt("Review the cohort change.","INFO","Ready");
        return failureReceipt(async()=>{
          const {revision,cohort}=await findCohort(ref.id);
          if(actionId==="add-generator"){await refresher.addMember(cohort.cohortId,{expectedRevision:revision,generatorId:input.generator});await service.wake();return receipt(input.generator+" added to "+cohort.name+".");}
          if(actionId==="edit-policy"){await refresher.updatePolicy(cohort.cohortId,{expectedRevision:revision,enabled:cohort.enabled,policy:refresherPolicyFrom(input,_ctx?.asOf??new Date().toISOString())});await service.wake();return receipt("Schedule updated.");}
          if(actionId==="rename"){await refresher.renameCohort(cohort.cohortId,{expectedRevision:revision,name:input.name});return receipt("Cohort renamed.");}
          if(actionId==="enable"||actionId==="disable"){
            await refresher.updatePolicy(cohort.cohortId,{expectedRevision:revision,enabled:actionId==="enable",policy:cohort.policy});
            await service.wake();return receipt(actionId==="enable"?"Cohort enabled.":"Cohort paused.");
          }
          throw new TypeError("Unknown Refresher action");
        });
      }
      if(ref.view!=="member")throw new TypeError("Unknown Refresher object");
      const {cohortId,generatorId}=parseMemberId(ref.id);
      if(mode==="preview"){
        const snap=await snapshot();const cohort=snap.views.cohorts.find((c)=>c.cohortId===cohortId);const member=cohort?.members.find((m)=>m.generatorId===generatorId);
        if(!member)throw new TypeError("Generator is not in this cohort");
        return {status:{token:"INFO",label:"Ready"},message:"Refresh "+generatorId+" on Perchance.",impact:{title:"Refresh "+generatorId+"?",consequences:[
          "PCMS re-saves the Deployer-confirmed release of "+generatorId+" on Perchance.",
          "Content: "+readiness(snap,cohort,member)+".","Counts against today's budget ("+cohort.budget.used+" of "+cohort.budget.limit+" used)."],confirmLabel:"Refresh"}};
      }
      return failureReceipt(async()=>{
        const {revision,cohort}=await findCohort(cohortId);
        if(actionId==="refresh-now"){
          const result=await refresher.refreshNow(cohortId,generatorId);
          return receipt(result.status==="NOT_APPLIED"?"Perchance did not apply the refresh.":"Refreshed "+generatorId+".",
            result.status==="NOT_APPLIED"?"WARNING":"OK",result.status==="NOT_APPLIED"?"Not applied":"Refreshed");
        }
        if(actionId==="check-outcome"){
          const result=await refresher.reconcileRefresh(cohortId,generatorId,{expectedRevision:revision});
          const status=STATUS[result.member.operation.status]||STATUS.IDLE;
          return receipt("Outcome: "+status.label+".",status.token,status.label);
        }
        if(actionId==="discard"){await refresher.cancelRefresh(cohortId,generatorId,{expectedRevision:revision});await service.wake();return receipt("Pending refresh discarded.");}
        if(actionId==="remove"){await refresher.removeMember(cohort.cohortId,generatorId,{expectedRevision:revision});return receipt(generatorId+" removed from "+cohort.name+".");}
        throw new TypeError("Unknown Refresher action");
      });
    }
  };
}
