// P037 Deployer built-in UI. Uses P033's bounded contribution protocol; no custom page authority.
function receipt(message,status="OK",label="Updated"){
  return {status:{token:status,label},message};
}
export function createUiContribution({moduleId="deployer",service}={}){
  if(!service||typeof service.read!=="function"||typeof service.startScan!=="function"
     ||typeof service.scanStep!=="function")throw new TypeError("Deployer UI requires repository service");
  const target=(slug)=>({kind:"module-object",moduleId,view:"generator",id:slug});
  const actions=[
    {id:"connect",label:"Set repository",appliesTo:"module",risk:"LOCAL",input:[
      {key:"owner",label:"GitHub owner",kind:"text",required:true,maxLength:100},
      {key:"repo",label:"Repository name",kind:"text",required:true,maxLength:100},
      {key:"ref",label:"Branch or tag",kind:"text",required:true,maxLength:200,default:"main"},
      {key:"accessType",label:"Access",kind:"choice",required:true,default:"public",
        options:[{id:"public",label:"Public"},{id:"token",label:"Token reference (SecretRef)"}]},
      {key:"secretRef",label:"SecretRef for authenticated access (not raw token)",kind:"text",maxLength:100},
      {key:"root",label:"Root folder (optional)",kind:"text",maxLength:256},
      {key:"listing",label:"Default listing",kind:"choice",required:true,options:[
        {id:"unlisted",label:"Unlisted"},{id:"public",label:"Publicly listed"}]}
    ]},
    {id:"check",label:"Check now",appliesTo:"module",risk:"LOCAL"},
    {id:"continue",label:"Continue scan",appliesTo:"module",risk:"LOCAL"},
    {id:"verification",label:"Verification settings",appliesTo:"module",risk:"LOCAL",input:[
      {key:"sweepLimit",label:"Verify up to this many generators per check",kind:"integer",required:true,min:1,max:100,default:20}]},
    {id:"automatic-on",label:"Turn on automatic deployment",appliesTo:"module",risk:"EXTERNAL_MUTATION"},
    {id:"automatic-off",label:"Turn off automatic deployment",appliesTo:"module",risk:"LOCAL"},
    {id:"link",label:"Link account folder",appliesTo:"module",risk:"BINDING",input:[
      {key:"folder",label:"Repository folder",kind:"text",required:true,maxLength:100},
      {key:"account",label:"PCMS account",kind:"entity",entityKind:"account",required:true}]},
    {id:"adopt",label:"Adopt into repository",appliesTo:"module-object:generator",risk:"BINDING"},
    {id:"deploy",label:"Deploy assisted",appliesTo:"module-object:generator",risk:"EXTERNAL_MUTATION"}
  ];
  const href="#/m/"+moduleId;
  // P042: Automatic is shown only as the operator's choice plus whether every gate holds.
  async function deploymentMode(){
    if(!service.automatic)return "Assisted";
    const status=await service.automatic.status();
    return !status.enabled?"Assisted":status.ready?"Automatic":"Automatic (waiting: gate unmet)";
  }
  async function automaticConditions(){
    if(!service.automatic)return [];
    const status=await service.automatic.status();
    if(!status.enabled||status.ready)return [];
    return status.gates.filter(g=>!g.met).map(g=>({key:"automatic-gate:"+g.id,priority:"HIGH",
      status:{token:"WARNING",label:"Automatic deployment waiting"},title:"Automatic deployment is not running: "+g.label.toLowerCase()+" is not met.",
      subject:{kind:"module",id:moduleId}}));
  }
  function displayItems(value){
    const normal=(value.snapshot?.items??[]).map(item=>({id:item.slug,item,error:null}));
    const errors=(value.snapshot?.problems??[]).map((bad,i)=>({id:"problem:"+i,item:null,error:bad}));
    return [...normal,...errors];
  }
  return {
    contractVersion:1,moduleId,title:"Deployer",description:"Repository releases, account links and assisted deployments.",
    icon:"cloud",nav:{label:"Deployer",order:20,statusFrom:"summary"},actions,
    page:{views:[{id:"releases",title:"Repository releases",type:"list",columns:[
      {id:"generator",label:"Generator",kind:"text"},
      {id:"release",label:"Release",kind:"text"},
      {id:"folder",label:"Folder",kind:"text"},
      {id:"state",label:"State",kind:"text"}],rowHref:"generator",
      actions:["connect","check","continue","link","verification","automatic-on","automatic-off"]},
      {id:"generator",title:"Generator",type:"detail",actions:["adopt","deploy"]}]},
    async summary(){
      const {value}=await service.read();
      return {status:value.lastFailure?{token:"WARNING",label:"Check failed"}:
        value.scan?{token:"ACTIVE",label:"Scanning"}:value.snapshot?{token:"OK",label:"Checked"}:
        {token:"INFO",label:"Not configured"},
        headline:value.scan?"Repository check in progress":value.lastFailure?"Previous snapshot retained":
          value.snapshot?value.snapshot.items.length+" generator releases":"Configure a repository to get started",
        facts:[{label:"Commit",value:value.snapshot?.commitId?.slice(0,12)??"—"},
          {label:"Last successful check",value:value.lastSuccessfulScanAt??"Never"},
          {label:"Problems",value:String(value.snapshot?.problems?.length??0)},
          {label:"Deployment",value:await deploymentMode()}],href};
    },
    async conditions(){
      const {value}=await service.read();
      const out=value.lastFailure?[{key:"repo-scan-failed",priority:"HIGH",status:{token:"ERROR",label:"Repository unavailable"},
        title:"Last repository scan failed ("+String(value.lastFailure.code).slice(0,80)+")",
        subject:{kind:"module",id:moduleId}}]:[];
      out.push(...await automaticConditions());
      if(service.observations){
        for(const item of value.snapshot?.items??[]){
          const {deployment}=await service.getDeploymentForSlug(item.slug);if(!deployment)continue;
          const observed=await service.observations.get(deployment.deploymentId);
          if(observed?.drift)out.push({key:"drift:"+item.slug,priority:"HIGH",status:{token:"WARNING",label:"Changed on Perchance"},
            title:item.slug+" changed on Perchance. Compare and choose; automatic deployment is paused.",subject:{kind:"generator",id:"perchance:"+item.slug}});
          if(out.length>=50)break;
        }
      }
      return out;
    },
    async listRows(_ctx,viewId,cursor=null){
      if(viewId!=="releases")throw new TypeError("Unknown Deployer view");
      const {value}=await service.read(),all=displayItems(value),offset=cursor??0;
      const slice=all.slice(offset,offset+100);
      return {rows:slice.map(({id,item,error})=>({id,cells:{
        generator:item?.title??error?.slug??"Unknown",
        release:item?.version??"—",
        folder:item?.accountFolder??error?.accountFolder??"—",
        state:error?.code??(value.links[item.accountFolder]?"Update ready / managed":"Unlinked account")
      }})),next:offset+100<all.length?offset+100:null};
    },
    async getDetail(_ctx,viewId,id){
      if(viewId!=="generator")throw new TypeError("Unknown Deployer detail");
      const {value}=await service.read(),row=displayItems(value).find(item=>item.id===id);
      if(!row)throw new TypeError("Generator not found");
      const item=row.item,bad=row.error;
      return {title:item?.title??bad?.slug??"Problem",sections:[{title:"Repository",facts:[
        {label:"Account folder",value:item?.accountFolder??bad?.accountFolder??"—"},
        {label:"Release",value:item?.version??"—"},
        {label:"Commit",value:value.snapshot?.commitId?.slice(0,12)??"—"},
        {label:"Validation",value:bad?.code??"Valid"}]}]};
    },
    async invoke(_ctx,actionId,ref,input,{mode}={}){
      if(mode==="preview"&&actionId==="automatic-on"){
        if(!service.automatic)throw new TypeError("Automatic deployment is unavailable");
        const unmet=(await service.automatic.gates()).gates.filter(g=>g.id!=="operator"&&!g.met);
        return {status:{token:unmet.length?"WARNING":"INFO",label:unmet.length?"Gates unmet":"Ready"},
          message:unmet.length?"Automatic deployment cannot be turned on until every gate holds.":"Eligible repository releases will deploy to Perchance in the background, without a dashboard.",
          impact:{title:"Turn on automatic deployment",consequences:[...(unmet.length?unmet.map(g=>"Unmet: "+g.label):[]),
            "Only targets marked deploy: auto that are ready, unpaused, not drifted, not uncertain and not failed are dispatched.",
            "At most 10 deployments per repository check, one at a time, at least 20 seconds apart; nothing is retried blindly."],
            confirmLabel:"Turn on"}};
      }
      if(mode==="preview"){
        return {status:{token:"INFO",label:"Ready"},message:"Review the repository action before continuing.",
          impact:{title:"Confirm Deployer action",consequences:["Only explicitly approved assisted deployments can mutate Perchance."],
            confirmLabel:"Continue"}};
      }
      if(actionId==="connect"){
        const current=await service.read();
        await service.configure({expectedRevision:current.revision,defaultListing:input.listing==="public"?"PUBLICLY_LISTED":"UNLISTED",
          config:{provider:"github",owner:input.owner,repo:input.repo,ref:input.ref,root:input.root??"",
            access:input.accessType==="token"?{kind:"token",secretRef:input.secretRef??""}:{kind:"public"},
            network:"default"}});
        return receipt("Repository configured. Select Check now to read the pinned commit.");
      }
      if(actionId==="link"){
        const current=await service.read();
        await service.linkFolder({folder:input.folder,accountId:input.account,expectedRevision:current.revision});
        return receipt("Folder linked to the selected account. Check again to prepare its releases.");
      }
      if(actionId==="check"){
        await service.startScan();
        const next=await service.scanStep();
        return receipt(next.done?"Repository check complete.":"Check started; select Continue scan to advance.",
          next.status==="FAILED"?"WARNING":"INFO",next.status==="FAILED"?"Check failed":"Scan");
      }
      if(actionId==="continue"){
        const next=await service.scanStep();
        return receipt(next.done?"Repository check complete.":"Scan checkpoint saved; continue until complete.",
          next.status==="FAILED"?"WARNING":"INFO",next.status==="FAILED"?"Check failed":"Scan");
      }
      if(actionId==="automatic-on"){
        if(!service.automatic)throw new TypeError("Automatic deployment is unavailable");
        await service.automatic.enable();
        return receipt("Automatic deployment is on. Eligible releases deploy in the background after each repository check.");
      }
      if(actionId==="automatic-off"){
        if(!service.automatic)throw new TypeError("Automatic deployment is unavailable");
        await service.automatic.disable();
        return receipt("Automatic deployment is off. Releases wait for you to deploy them.");
      }
      if(actionId==="verification"){
        if(!service.observations)throw new TypeError("Verification is unavailable");
        await service.observations.configure({sweepLimit:input.sweepLimit});
        return receipt("Verification limit saved. Compatible reads are spaced by at least 10 seconds; real Perchance reads remain gated.");
      }
      if(!ref||ref.kind!=="module-object"||ref.view!=="generator")throw new TypeError("A generator is required");
      const current=await service.read();
      const item=current.value.snapshot?.items.find(it=>it.slug===ref.id);
      if(!item)throw new TypeError("This generator is not a valid repository release");
      if(actionId==="adopt"){
        const deployed=await service.getDeploymentForSlug(item.slug);
        await service.adopt({slug:item.slug,expectedRevision:deployed.revision});
        return receipt("Manual generator adopted into the repository.");
      }
      if(actionId==="deploy"){
        const deployed=await service.getDeploymentForSlug(item.slug);
        await service.deployFromRepository({deploymentId:deployed.deployment?.deploymentId,
          expectedRevision:deployed.revision});
        return receipt("Assisted deployment handed off for confirmation.","WAITING_HUMAN","Waiting for you");
      }
      throw new TypeError("Unknown Deployer action");
    }
  };
}
