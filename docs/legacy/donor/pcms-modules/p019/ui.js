// P040 Provisioning built-in UI (pcms.ui-contribution/v1). The Persona comes from the picker, the
// account key and attempt ID are generated, and the credential is a `secret` field: Core hands the
// value to this background module once, it is stored through the dedicated secret host and only
// the resulting SecretRef is kept. The operator never sees or types a SecretRef.
const STEPS=Object.freeze(["Persona session","Sign up","Verify","Bind account"]);
const STATE=Object.freeze({
  SESSION_REQUIRED:{step:0,token:"INFO",label:"Ready to start",next:"Open the Persona session"},
  SESSION_ACTIVE:{step:1,token:"ACTIVE",label:"Session open",next:"Continue sign up"},
  WAITING_HUMAN:{step:1,token:"WAITING_HUMAN",label:"Waiting for you",next:"Finish the step in Attention, then continue"},
  READY_TO_PROVISION:{step:2,token:"ACTIVE",label:"Ready to verify",next:"Verify the account"},
  PROVISIONING:{step:2,token:"ACTIVE",label:"Verifying",next:"Continue"},
  RETRYABLE:{step:2,token:"WARNING",label:"Will retry",next:"Try verification again"},
  UNCERTAIN:{step:2,token:"UNCERTAIN",label:"Outcome unknown",next:"Check the outcome"},
  FINALIZING:{step:3,token:"ACTIVE",label:"Binding account",next:"Finish binding"},
  COMPLETED:{step:4,token:"OK",label:"Account created",next:"Nothing left to do"},
  CANCELLED:{step:4,token:"INFO",label:"Cancelled",next:"Nothing left to do"}
});
const MESSAGES=Object.freeze({
  PCMS_PROVISIONING_ACCOUNT_CONFLICT:"An account with that name already exists.",
  PCMS_PROVISIONING_PERSONA_CONFLICT:"That Persona is already bound to an account.",
  PCMS_PROVISIONING_SESSION_UNAVAILABLE:"The Persona session is not available. Try again.",
  PCMS_PROVISIONING_RECONCILE_REQUIRED:"The last step's outcome is unknown. Check the outcome first.",
  PCMS_PROVISIONING_INVALID_TRANSITION:"That is not possible in the current step.",
  PCMS_PROVISIONING_REVISION_CONFLICT:"Provisioning changed meanwhile. Try again.",
  PCMS_PROVISIONING_HUMAN_TASK_CONFLICT:"The open task in Attention could not be updated.",
  PCMS_PROVISIONING_CAPACITY:"Too many provisioning attempts are stored."
});

function receipt(message,token="OK",label="Updated",extra={}){return {status:{token,label},message,...extra};}
function fold(value){return String(value).normalize("NFKC").toLocaleLowerCase("en-US");}
export function provisioningAccountIdFor(displayName,taken){
  const stem=String(displayName).normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase()
    .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,120).replace(/-+$/,"")||"account";
  if(!taken.has(stem))return stem;
  for(let n=2;n<10000;n+=1){const id=stem+"-"+n;if(!taken.has(id))return id;}
  throw new TypeError("No account key is available for that name");
}
function stepsText(state){
  const at=STATE[state]?.step??0;
  return STEPS.map((name,index)=>(index+1)+" "+name+(index<at?" ✓":index===at&&state==="WAITING_HUMAN"?" ✋":"")).join(" · ");
}

export function createUiContribution({moduleId="provisioning",service}={}){
  if(!service||typeof service.provisioning?.listAttempts!=="function"||typeof service.accounts?.listAccounts!=="function"
     ||typeof service.secrets?.create!=="function"||typeof service.secrets?.delete!=="function"){
    throw new TypeError("Provisioning UI requires the Provisioning, Accounts and secret services");
  }
  const {provisioning,accounts,secrets}=service;
  const attemptRef=(id)=>({kind:"module-object",moduleId,view:"attempt",id});

  const actions=[
    {id:"start",label:"Provision account…",appliesTo:"module",risk:"LOCAL",input:[
      {key:"name",label:"Account name",kind:"text",required:true,maxLength:160},
      {key:"persona",label:"Persona",kind:"entity",entityKind:"persona",required:true},
      {key:"credential",label:"Perchance password",kind:"secret",required:true,
        help:"Stored only in the dedicated secret host. PCMS keeps a reference, never the value."}]},
    {id:"continue",label:"Continue",appliesTo:"module-object:attempt",risk:"EXTERNAL_MUTATION"},
    {id:"check-outcome",label:"Check outcome",appliesTo:"module-object:attempt",risk:"LOCAL"},
    {id:"cancel",label:"Cancel provisioning",appliesTo:"module-object:attempt",risk:"RESOLUTION"}
  ];

  async function attempts(){return (await provisioning.listAttempts()).map((row)=>row.value);}
  async function guarded(run){
    try{return await run();}
    catch(error){const message=MESSAGES[error?.code];if(!message)throw error;return receipt(message,"WARNING","Not done");}
  }

  return {
    contractVersion:1,moduleId,title:"Provisioning",description:"Create new Perchance accounts step by step in a chosen Persona.",
    icon:"user",nav:{label:"Provisioning",order:60,statusFrom:"summary"},actions,
    humanTaskActions:{"operator.captcha":"continue","operator.provisioning-action":"continue"},
    page:{views:[
      {id:"attempts",title:"Provisioning attempts",type:"list",columns:[
        {id:"account",label:"Account",kind:"text"},{id:"step",label:"Step",kind:"text"},
        {id:"status",label:"Status",kind:"status"},{id:"updated",label:"Updated",kind:"time"}],
        rowHref:"attempt",actions:["start"]},
      {id:"attempt",title:"Provisioning attempt",type:"detail",actions:["continue","check-outcome","cancel"]}
    ]},

    async summary(){
      const all=await attempts();
      const open=all.filter((a)=>a.state!=="COMPLETED"&&a.state!=="CANCELLED");
      const waiting=open.filter((a)=>a.state==="WAITING_HUMAN").length;
      const uncertain=open.filter((a)=>a.state==="UNCERTAIN").length;
      return {status:uncertain?{token:"UNCERTAIN",label:"Outcome unknown"}:waiting?{token:"WAITING_HUMAN",label:"Waiting for you"}
        :{token:"OK",label:open.length?"In progress":"Idle"},
        headline:open.length?open.length+" in progress":"No accounts are being provisioned",
        facts:[{label:"In progress",value:String(open.length)},{label:"Completed",value:String(all.filter((a)=>a.state==="COMPLETED").length)}],
        href:"#/m/"+moduleId};
    },

    async search(_ctx,query,limit){
      const needle=fold(query);
      return (await attempts()).filter((a)=>fold(a.displayName).includes(needle)).slice(0,limit).map((a)=>({
        entity:attemptRef(a.attemptId),title:a.displayName,subtitle:"Provisioning · "+(STATE[a.state]?.label??a.state),score:70}));
    },

    async conditions(){
      return (await attempts()).filter((a)=>a.state==="WAITING_HUMAN"||a.state==="UNCERTAIN").slice(0,200).map((a)=>a.state==="UNCERTAIN"
        ?{key:"uncertain:"+a.attemptId,priority:"HIGH",status:{token:"UNCERTAIN",label:"Outcome unknown"},
          title:"Provisioning outcome unknown · New account "+a.displayName,subject:attemptRef(a.attemptId),since:a.updatedAt,actionId:"check-outcome"}
        :{key:"waiting:"+a.attemptId,priority:"NORMAL",status:{token:"WAITING_HUMAN",label:"Waiting for you"},
          title:"Complete the sign-up step · New account "+a.displayName,subject:attemptRef(a.attemptId),since:a.updatedAt,actionId:"continue"});
    },

    async listRows(_ctx,viewId,cursor=null){
      if(viewId!=="attempts")throw new TypeError("Unknown Provisioning view");
      const all=await attempts();const offset=cursor??0;
      return {rows:all.slice(offset,offset+100).map((a)=>({id:a.attemptId,cells:{account:a.displayName,step:stepsText(a.state),
        status:{token:STATE[a.state]?.token??"INFO",label:STATE[a.state]?.label??a.state},updated:a.updatedAt}})),next:offset+100<all.length?offset+100:null};
    },

    async getDetail(_ctx,viewId,id){
      if(viewId!=="attempt")throw new TypeError("Unknown Provisioning detail");
      const a=(await attempts()).find((item)=>item.attemptId===id);
      if(!a)throw new TypeError("Provisioning attempt not found");
      const meta=STATE[a.state]??{token:"INFO",label:a.state,next:"Continue"};
      return {title:"New account "+a.displayName,status:{token:meta.token,label:meta.label},sections:[
        {title:"Progress",facts:[{label:"Steps",value:stepsText(a.state)},{label:"Next",value:meta.next},
          {label:"Credential",value:"Stored in the secret host"}]},
        {title:"Technical details",facts:[{label:"Account key",value:a.accountId},{label:"Attempt",value:a.attemptId},
          {label:"Persona",value:a.personaUid},{label:"State",value:a.state}]}]};
    },

    async invoke(_ctx,actionId,ref,input,{mode}={}){
      if(mode==="preview")return receipt("Review the provisioning step.","INFO","Ready");
      if(actionId==="start"){
        return guarded(async()=>{
          const [listed,all]=await Promise.all([accounts.listAccounts(),attempts()]);
          const taken=new Set([...(listed.accounts||[]).map((a)=>a.accountId),...all.filter((a)=>a.state!=="CANCELLED").map((a)=>a.accountId)]);
          const accountId=provisioningAccountIdFor(input.name,taken);
          const attemptIds=new Set(all.map((a)=>a.attemptId));
          let n=1;while(attemptIds.has("attempt:"+accountId+":"+n))n+=1;
          const attemptId="attempt:"+accountId+":"+n;
          const credentialRef=await secrets.create(input.credential);
          try{
            await provisioning.createAttempt({attemptId,accountId,displayName:input.name,personaUid:input.persona,credentialRef});
          }catch(error){
            try{await secrets.delete(credentialRef);}catch{}
            throw error;
          }
          return receipt("Provisioning for "+input.name+" is ready. Choose Continue to open the Persona session.","OK","Started",
            {followUp:{href:"#/m/"+moduleId+"/attempt/"+encodeURIComponent(attemptId),label:"Open attempt"},subject:attemptRef(attemptId)});
        });
      }
      if(ref?.kind!=="module-object"||ref.moduleId!==moduleId||ref.view!=="attempt")throw new TypeError("A provisioning attempt is required");
      return guarded(async()=>{
        const row=await provisioning.getAttempt(ref.id);
        if(!row)throw new TypeError("Provisioning attempt not found");
        const state=row.value.state;
        if(actionId==="cancel"){await provisioning.cancelAttempt(ref.id,{expectedRevision:row.revision});return receipt("Provisioning cancelled.","INFO","Cancelled");}
        if(actionId==="check-outcome"){
          const next=await provisioning.reconcileAttempt(ref.id,{expectedRevision:row.revision});
          const meta=STATE[next.value.state]??{token:"INFO",label:next.value.state};
          return receipt("Outcome: "+meta.label+".",meta.token,meta.label);
        }
        if(actionId!=="continue")throw new TypeError("Unknown Provisioning action");
        if(state==="COMPLETED"||state==="CANCELLED")return receipt("Nothing left to do.","INFO",STATE[state].label);
        let next;
        if(state==="SESSION_REQUIRED")next=await provisioning.acquireSession(ref.id,{expectedRevision:row.revision});
        else if(state==="UNCERTAIN")next=await provisioning.reconcileAttempt(ref.id,{expectedRevision:row.revision});
        else next=await provisioning.advance(ref.id,{expectedRevision:row.revision});
        const meta=STATE[next.value.state]??{token:"INFO",label:next.value.state,next:"Continue"};
        return receipt(meta.label+" · Next: "+meta.next+".",meta.token,meta.label);
      });
    }
  };
}
