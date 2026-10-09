import {createEntityPicker} from "../../ui/picker/entity-picker.js";
import {pcmsV2Href} from "../../router-v2.js";
import {suggestedAccountId,validateAccountDraft,visibleAccountPage,summarizePersona,unresolvedRebindReason} from "./model.js";
const LIMIT=64;
function e(doc,tag,cls,text){const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function button(doc,label,action){const n=e(doc,"button",null,label);n.type="button";if(action)n.dataset.accountsAction=action;return n;}
function message(error){return error?.code==="PCMS_ACCOUNTS_UNRESOLVED_OPERATION"
  ?"Rebind blocked: unresolved operations must be reconciled in Attention or Recovery first."
  :error?.code==="PCMS_ACCOUNTS_REVISION_CONFLICT"
    ?"Account data changed in another tab. Refresh and try again."
    :typeof error?.message==="string"?error.message:"The Accounts operation could not be completed.";}
async function listPersonaStatus(runtime){
  if(!runtime?.personaBroker?.request)throw new Error("Persona Broker is unavailable");
  const records=new Map(),seen=new Set();let cursor=null,seq=0;
  do{
    if(++seq>LIMIT)throw new Error("Persona directory is too large");
    const response=await runtime.personaBroker.request({requestId:"pcms-accounts-personas-"+seq+"-"+crypto.randomUUID(),
      command:"persona.list",params:{page:{size:100,...(cursor?{cursor}:{})}}});
    if(!response?.ok||!Array.isArray(response.result?.items))throw new Error("Persona directory is unavailable");
    for(const raw of response.result.items) {
      if(raw?.managed===false||raw?.archivedAt)continue;
      const safe=summarizePersona(raw);
      if(safe&&!records.has(safe.personaUid))records.set(safe.personaUid,safe);
    }
    if(response.result.hasMore) {
      if(typeof response.result.nextCursor!=="string"||!response.result.nextCursor||seen.has(response.result.nextCursor))
        throw new Error("Persona pagination protocol failed");
      cursor=response.result.nextCursor;seen.add(cursor);
    }else cursor=null;
  }while(cursor);
  return records;
}
export function createPcmsAccountsView({documentRef,windowRef,runtime,onChanged=async()=>{}}={}){
  if(!documentRef||!windowRef||!runtime?.accounts)throw new TypeError("Accounts UI requires a read-only UI-client runtime");
  const host=documentRef.getElementById("accountsV2");
  if(!host)throw new Error("Accounts view host is missing");
  const toolbar=e(documentRef,"div","accounts-toolbar"),search=e(documentRef,"input","accounts-search"),
    sort=e(documentRef,"select","accounts-sort"),filter=e(documentRef,"select","accounts-filter");
  search.type="search";search.placeholder="Search accounts or Personas";search.maxLength=160;
  search.setAttribute("aria-label","Search accounts");
  for(const [value,label] of [["name","Account name"],["id","Account key"],["persona","Persona name"],["provider","Provider"]]) {
    const opt=e(documentRef,"option",null,"Sort: "+label);opt.value=value;sort.appendChild(opt);
  }
  sort.setAttribute("aria-label","Sort accounts");
  for(const [value,label] of [["","All accounts"],["status:direct","Direct routing"],["status:blocked","Blocked route"],["status:unknown","Route unknown"]]) {
    const opt=e(documentRef,"option",null,label);opt.value=value;filter.appendChild(opt);
  }
  filter.setAttribute("aria-label","Filter accounts");
  const direction=button(documentRef,"Ascending","direction"),add=button(documentRef,"Add account","add");
  add.className="accounts-primary";
  toolbar.append(search,filter,sort,direction,add);
  const summary=e(documentRef,"p","accounts-summary");
  const body=e(documentRef,"div","accounts-table-container"),paging=e(documentRef,"div","accounts-paging"),
    detail=e(documentRef,"div","accounts-detail"),dialogHost=e(documentRef,"div","accounts-modal-host"),
    feedback=e(documentRef,"p","accounts-feedback");
  feedback.setAttribute("role","status");feedback.setAttribute("aria-live","polite");
  host.append(toolbar,feedback,summary,body,paging,detail,dialogHost);
  let accounts=[],revision=0,route={id:null,filter:""},people=new Map(),sortDirection="asc",page=1;
  let activeModal=null,renderEpoch=0,dead=false,lastRoute=null;
  const invalidPersonas=new Set();
  function status(messageText,tone=""){feedback.textContent=messageText;feedback.dataset.tone=tone;}
  function currentView(){return visibleAccountPage(accounts,{search:search.value,filter:route.filter||filter.value,sort:sort.value,
    direction:sortDirection,page,routeByUid:people});}
  function cell(row,text){const td=e(documentRef,"td",null,text);row.appendChild(td);return td;}
  function draw(){
    if(dead)return;
    body.replaceChildren();paging.replaceChildren();detail.replaceChildren();
    if(route.id){
      const account=accounts.find(a=>a.accountId===route.id);
      if(!account){summary.textContent="Account is no longer present.";return;}
      summary.textContent="Account details";
      const back=e(documentRef,"a",null,"All accounts");back.href="#/accounts";
      const heading=e(documentRef,"h3",null,account.displayName);
      const persona=people.get(account.personaUid);
      const dl=e(documentRef,"dl","accounts-details");
      for(const [k,v] of [["Persona",persona?.personaName||"Unavailable"],
        ["Route (last observed)",persona?.route||"Unavailable"],["Route observed at",persona?.asOf||"Not checked"],
        ["Perchance session","Unknown · no authenticated provider probe"],
        ["Account key",account.accountId],["Binding epoch",String(account.bindingEpoch)],["Provider",account.providerId]]) {
        const line=e(documentRef,"div");line.append(e(documentRef,"dt",null,k),e(documentRef,"dd",null,v));dl.appendChild(line);
      }
      const rebind=button(documentRef,"Rebind Persona","rebind");rebind.dataset.accountId=account.accountId;
      detail.append(back,heading,dl,rebind);return;
    }
    const result=currentView();page=result.page;
    summary.textContent=result.total+" account(s) · "+result.start+"–"+result.end+" displayed";
    if(!result.total){body.appendChild(e(documentRef,"p","empty-state",accounts.length?"No accounts match the filter.":"No accounts yet. Use Add account to create a binding."));return;}
    const table=e(documentRef,"table","accounts-table"),thead=e(documentRef,"thead"),
      header=e(documentRef,"tr");
    for(const col of ["Account","Persona","Route","Perchance session","Provider","Details"])header.appendChild(e(documentRef,"th",null,col));
    thead.appendChild(header);table.appendChild(thead);
    const tbody=e(documentRef,"tbody");
    for(const account of result.items){
      const row=e(documentRef,"tr");row.dataset.accountId=account.accountId;
      const name=cell(row,"");const link=e(documentRef,"a",null,account.displayName);
      link.href="#/accounts/"+encodeURIComponent(account.accountId);name.appendChild(link);
      const persona=people.get(account.personaUid);
      cell(row,persona?.personaName||"Persona unavailable");
      const routeCell=cell(row,persona?.route||"Route status unavailable");
      if(persona?.asOf)routeCell.title="Observed "+persona.asOf;
      cell(row,"Unknown · not verified");
      cell(row,account.providerId);
      const action=cell(row,"");const inspect=e(documentRef,"a",null,"View");
      inspect.href=link.href;action.appendChild(inspect);tbody.appendChild(row);
    }
    table.appendChild(tbody);body.appendChild(table);
    const previous=button(documentRef,"Previous","previous"),next=button(documentRef,"Next","next");
    previous.disabled=result.page===1;next.disabled=result.page>=result.pages;
    paging.append(previous,e(documentRef,"span",null,"Page "+result.page+" of "+result.pages),next);
  }
  function closeModal(){if(!activeModal)return;activeModal.picker.destroy();dialogHost.replaceChildren();activeModal=null;add.focus();}
  function pickerOptions(mode,account){
    return [...people.values()].sort((a,b)=>a.personaName.localeCompare(b.personaName)).map(persona=>{
      const bound=accounts.find(a=>a.personaUid===persona.personaUid);
      return {id:persona.personaUid,label:persona.personaName,detail:persona.route,
        disabled:!!bound && (mode==="create"||bound.accountId!==account?.accountId),
        disabledReason:bound?"Already bound to "+bound.displayName:null};
    });
  }
  async function modal(mode,account=null){
    if(activeModal)closeModal();
    dialogHost.replaceChildren();
    const mask=e(documentRef,"div","accounts-modal-backdrop"),panel=e(documentRef,"section","accounts-modal");
    panel.setAttribute("role","dialog");panel.setAttribute("aria-modal","true");
    panel.setAttribute("aria-label",mode==="create"?"Add account":"Rebind Persona");
    const title=e(documentRef,"h3",null,mode==="create"?"Add account":"Rebind "+account.displayName);
    const form=e(documentRef,"form","accounts-dialog-form");
    const name=mode==="create"?e(documentRef,"input"):null;
    if(name){
      name.required=true;name.maxLength=160;name.autocomplete="off";
      const label=e(documentRef,"label",null,"Account display name");label.appendChild(name);form.appendChild(label);
    }else form.appendChild(e(documentRef,"p",null,"Current Persona: "+(people.get(account.personaUid)?.personaName||"Unavailable")));
    const chosen=e(documentRef,"p","accounts-chosen","No Persona selected");
    const picker=createEntityPicker({documentRef,kind:"Persona",onSelect:(item)=>{
      if(!activeModal)return;activeModal.selectedUid=item.id;
      chosen.textContent="Selected: "+item.label;
      updateSubmit();
    }});
    picker.setOptions(pickerOptions(mode,account));
    const advanced=e(documentRef,"details","accounts-advanced"),advancedTitle=e(documentRef,"summary",null,"Account key · advanced");
    const key=e(documentRef,"input");key.readOnly=true;key.setAttribute("aria-label","Generated permanent account key");
    if(name){advanced.append(advancedTitle,key);}
    const reason=e(documentRef,"p","accounts-dialog-status");
    reason.setAttribute("role","status");reason.setAttribute("aria-live","polite");
    const actions=e(documentRef,"div","accounts-dialog-actions"),cancel=button(documentRef,"Cancel"),
      submit=e(documentRef,"button","accounts-primary",mode==="create"?"Add account":"Confirm rebind");
    submit.type="submit";cancel.addEventListener("click",closeModal);
    actions.append(cancel,submit);
    form.append(chosen,picker.root);
    if(name)form.appendChild(advanced);
    if(mode==="rebind")form.appendChild(e(documentRef,"p",null,
      "Future provider operations will use the new Persona. Ensure the required Perchance login exists there."));
    form.append(reason,actions);panel.append(title,form);mask.appendChild(panel);dialogHost.appendChild(mask);
    activeModal={mode,account,selectedUid:null,picker,name,key,submit,reason,busy:false,blocked:mode==="rebind"};
    function updateSubmit(){
      if(!activeModal)return;
      if(name)key.value=suggestedAccountId(name.value,accounts.map(a=>a.accountId));
      submit.disabled=activeModal.busy||activeModal.blocked||!activeModal.selectedUid
        ||!!name&&!name.value.trim()
        ||mode==="rebind"&&activeModal.selectedUid===account.personaUid;
    }
    if(name)name.addEventListener("input",updateSubmit);
    form.addEventListener("submit",async event=>{
      event.preventDefault();const state=activeModal;
      if(!state||state.busy||submit.disabled)return;
      state.busy=true;updateSubmit();reason.textContent="";
      try{
        if(mode==="create"){
          const draft=validateAccountDraft({displayName:name.value,accountId:key.value,personaUid:state.selectedUid},accounts,[...people.values()]);
          const listed=await runtime.accounts.listAccounts();
          // Preview and commit against the same revision; a concurrent collision fails via Core CAS.
          if(listed.revision!==revision)throw Object.assign(new Error("Accounts changed. Refresh before creating."),{code:"PCMS_ACCOUNTS_REVISION_CONFLICT"});
          await runtime.accounts.createAccount(draft,{expectedRevision:listed.revision});
          status("Account created: "+draft.displayName,"ok");
        } else {
          // The Core independently validates unresolved operations immediately before mutation.
          const blockers=unresolvedRebindReason(await runtime.remoteOps.listUnresolved(),account.accountId);
          if(blockers)throw new Error(blockers);
          const listed=await runtime.accounts.listAccounts();
          const live=listed.accounts.find(a=>a.accountId===account.accountId);
          if(!live||live.personaUid!==account.personaUid)throw new Error("Binding changed. Refresh first.");
          await runtime.accounts.rebindPersona(account.accountId,{expectedRevision:listed.revision,
            expectedPersonaUid:account.personaUid,newPersonaUid:state.selectedUid});
          status("Persona binding updated for "+account.displayName,"ok");
        }
        closeModal();await onChanged();
      }catch(error){reason.textContent=message(error);reason.dataset.tone="error";}
      finally{if(activeModal===state){state.busy=false;updateSubmit();}}
    });
    updateSubmit();if(name)name.focus();else picker.focus();
    if(mode==="rebind"){
      try{
        const blockers=unresolvedRebindReason(await runtime.remoteOps.listUnresolved(),account.accountId);
        if(activeModal?.account===account){activeModal.blocked=!!blockers;reason.textContent=blockers||"No unresolved operations were reported. Binding is still rechecked on submit.";updateSubmit();}
      }catch{
        if(activeModal?.account===account){activeModal.blocked=true;reason.textContent="Operation status unavailable; rebind is disabled.";updateSubmit();}
      }
    }
  }
  function onClick(event){
    const action=event.target.closest?.("[data-accounts-action]")?.dataset.accountsAction;
    if(!action)return;
    if(action==="direction"){sortDirection=sortDirection==="asc"?"desc":"asc";direction.textContent=sortDirection==="asc"?"Ascending":"Descending";page=1;draw();}
    if(action==="previous"){page--;draw();}
    if(action==="next"){page++;draw();}
    if(action==="add")void modal("create");
    if(action==="rebind"){
      const account=accounts.find(a=>a.accountId===event.target.closest("[data-account-id]")?.dataset.accountId);
      if(account)void modal("rebind",account);
    }
  }
  function onKey(event){if(event.key==="Escape"&&activeModal){event.preventDefault();closeModal();}}
  host.addEventListener("click",onClick);documentRef.addEventListener("keydown",onKey);
  search.addEventListener("input",()=>{page=1;draw();});
  sort.addEventListener("change",()=>{page=1;draw();});
  filter.addEventListener("change",()=>{page=1;windowRef.location.hash=pcmsV2Href("accounts",{filter:filter.value});});
  return Object.freeze({
    async render({accounts:nextAccounts,revision:nextRevision,route:nextRoute}){
      if(dead)return;
      if(nextRoute?.route&&nextRoute.route!=="accounts")return; // No account-directory scans on unrelated routes.
      const generation=++renderEpoch;
      accounts=Array.isArray(nextAccounts)?nextAccounts:[];revision=nextRevision;route=nextRoute;
      if(lastRoute!==route.id){page=1;lastRoute=route.id;}
      filter.value=route.filter||"";
      draw();
      try{
        const latest=await listPersonaStatus(runtime);
        if(dead||generation!==renderEpoch)return;
        people=latest;draw();
      }catch{
        if(dead||generation!==renderEpoch)return;
        people=new Map();draw();
        status("Persona routing status is unavailable. No route or session state is assumed.","warning");
      }
    },
    destroy(){dead=true;renderEpoch++;closeModal();host.removeEventListener("click",onClick);
      documentRef.removeEventListener("keydown",onKey);host.replaceChildren();}
  });
}
