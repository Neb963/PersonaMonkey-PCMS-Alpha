// P040: the Core-rendered input dialog for module actions (pcms.ui-contribution/v1 §4.7.1).
// Durable IDs are never typed: account, Persona and generator fields are pickers over the
// UI-client reads, files are read in this tab and sent as text, and a `secret` field is a
// password box whose value leaves this tab only inside the redactable secret envelope and is
// cleared as soon as the dialog closes. Module text is always set with textContent.
import { wrapPcmsUiSecret } from "../integration/ui-contribution-contract.js";
import { createEntityPicker } from "./ui/picker/entity-picker.js";

const MAX_PICKER_PAGES=20;

function el(documentRef,tag,className=null,text=null){
  const node=documentRef.createElement(tag);
  if(className) node.className=className;
  if(text!==null&&text!==undefined) node.textContent=String(text);
  return node;
}
function clear(node){while(node.firstChild) node.removeChild(node.firstChild);}

// Picker sources. Each returns [{value,label}] sorted for display; values are the durable IDs.
export function createPcmsEntityPickerSources(runtime){
  return Object.freeze({
    async account(){
      const listed=await runtime.accounts.listAccounts();
      return (listed.accounts||[]).map((a)=>({value:a.accountId,label:String(a.displayName||a.accountId)}))
        .sort((a,b)=>a.label.localeCompare(b.label));
    },
    async persona(){
      if(typeof runtime.personaDirectory?.list!=="function") throw new Error("Managed Personas are unavailable");
      const personas=await runtime.personaDirectory.list();
      return personas.map((p)=>({value:p.personaUid,label:p.name}));
    },
    async generator(){
      const out=[];
      for(let page=1;page<=MAX_PICKER_PAGES;page+=1){
        const listed=await runtime.generators.list({page});
        for(const row of listed.rows) out.push({value:row.slug,label:(row.title&&row.title!==row.slug?row.title+" ("+row.slug+")":row.slug)+(row.accountLabel?" · "+row.accountLabel:"")});
        if(page>=listed.pages) break;
      }
      return out;
    }
  });
}

function fieldControl(documentRef,spec,options){
  if(spec.kind==="choice"){
    const select=el(documentRef,"select");
    for(const option of spec.options){const node=el(documentRef,"option",null,option.label);node.value=option.id;select.appendChild(node);}
    if(spec.default!==undefined) select.value=spec.default;
    return {control:select,read:()=>select.value||null};
  }
  if(spec.kind==="boolean"){
    const box=el(documentRef,"input");box.type="checkbox";box.checked=spec.default===true;
    return {control:box,read:()=>box.checked};
  }
  if(spec.kind==="integer"||spec.kind==="duration"){
    const input=el(documentRef,"input");input.type="number";input.step="1";
    if(spec.min!==undefined) input.min=String(spec.min);
    if(spec.max!==undefined) input.max=String(spec.max);
    if(spec.default!==undefined) input.value=String(spec.default);
    return {control:input,read:()=>input.value===""?null:Number(input.value)};
  }
  if(spec.kind==="entity"){
    // The shared P034 picker: a bounded, filterable list; nothing typed is ever submitted.
    const picker=createEntityPicker({documentRef,kind:spec.entityKind});
    picker.root.dataset.entityKind=spec.entityKind;
    picker.setOptions(options.map((option)=>({id:option.value,label:option.label,detail:option.detail||""})));
    return {control:picker.root,focus:picker,clear:()=>picker.destroy(),read:()=>picker.selectedId};
  }
  if(spec.kind==="file"){
    const input=el(documentRef,"input");input.type="file";
    if(spec.accept) input.accept=spec.accept;
    return {control:input,read:async()=>{
      const file=input.files?.[0];
      if(!file) return null;
      if(file.size>spec.maxBytes) throw new Error(spec.label+" is larger than "+Math.floor(spec.maxBytes/1024)+" KiB");
      return file.text();
    }};
  }
  if(spec.kind==="secret"){
    const input=el(documentRef,"input");input.type="password";input.autocomplete="new-password";input.spellcheck=false;
    input.maxLength=spec.maxLength;
    return {control:input,secret:true,clear:()=>{input.value="";},read:()=>input.value===""?null:wrapPcmsUiSecret(input.value)};
  }
  const input=el(documentRef,"input");input.type="text";input.spellcheck=false;
  if(spec.maxLength) input.maxLength=spec.maxLength;
  if(spec.pattern) input.pattern=spec.pattern;
  if(spec.default!==undefined) input.value=String(spec.default);
  return {control:input,read:()=>input.value.trim()===""?null:input.value.trim()};
}

export function createPcmsActionInputDialog({documentRef=globalThis.document,pickers}={}){
  const dialog=documentRef.getElementById("moduleInputDialog");
  if(!dialog) throw new Error("PCMS input dialog is missing");
  if(!pickers) throw new TypeError("PCMS input dialog requires picker sources");
  const form=documentRef.getElementById("moduleInputForm");
  const title=documentRef.getElementById("moduleInputTitle");
  const fields=documentRef.getElementById("moduleInputFields");
  const error=documentRef.getElementById("moduleInputError");
  const submit=documentRef.getElementById("moduleInputSubmit");
  const cancel=documentRef.getElementById("moduleInputCancel");
  let pending=null;
  let controls=[];

  function finish(result){
    for(const item of controls) item.clear?.();
    controls=[];
    clear(fields);
    const resolve=pending;
    pending=null;
    dialog.dataset.state="closed";
    dialog.removeAttribute("open");
    dialog.hidden=true;
    resolve?.(result);
  }
  cancel.addEventListener("click",(event)=>{event.preventDefault();finish(null);});
  dialog.addEventListener("cancel",(event)=>{event.preventDefault();finish(null);});
  form.addEventListener("submit",async(event)=>{
    event.preventDefault();
    if(!pending) return;
    error.textContent="";
    const input={};
    try{
      for(const item of controls){
        const value=await item.read();
        if(value===null||value===undefined){
          if(item.spec.required) throw new Error(item.spec.label+" is required");
          continue;
        }
        input[item.spec.key]=value;
      }
    } catch(caught){
      error.textContent=caught?.message||"Check the form";
      return;
    }
    finish(Object.freeze(input));
  });

  // Resolves to the input object, or null when the operator cancels.
  return async function collect(moduleTitle,action){
    if(pending) finish(null);
    clear(fields);
    error.textContent="";
    title.textContent=action.label.replace(/…$/,"");
    dialog.dataset.moduleTitle=moduleTitle;
    dialog.dataset.actionId=action.id;
    controls=[];
    for(const spec of action.input||[]){
      let options=[];
      if(spec.kind==="entity"){
        try{options=await pickers[spec.entityKind]();}
        catch{options=[];}
      }
      const field=fieldControl(documentRef,spec,options);
      const label=el(documentRef,"label",null,spec.label);
      label.dataset.inputKey=spec.key;
      label.dataset.inputKind=spec.kind;
      field.control.dataset.inputKey=spec.key;
      label.appendChild(field.control);
      if(spec.unit) label.appendChild(el(documentRef,"small",null,spec.unit));
      if(spec.help) label.appendChild(el(documentRef,"small",null,spec.help));
      fields.appendChild(label);
      controls.push({...field,spec});
    }
    submit.textContent=action.label.replace(/…$/,"");
    dialog.dataset.state="open";
    dialog.hidden=false;
    dialog.setAttribute("open","");
    (controls[0]?.focus||controls[0]?.control)?.focus?.();
    return new Promise((resolve)=>{pending=resolve;});
  };
}
