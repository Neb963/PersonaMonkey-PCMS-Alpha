// Shared bounded picker for PCMS EntityRefs. No free-text IDs are ever submitted.
function el(doc,tag,cls,text){const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
export function createEntityPicker({documentRef,kind="entity",onSelect=()=>{}}={}){
  if(!documentRef||typeof onSelect!=="function")throw new TypeError("Entity picker requires a document and callback");
  const root=el(documentRef,"div","entity-picker");
  const label=el(documentRef,"label","entity-picker-search-label","Search "+kind+"s");
  const input=el(documentRef,"input","entity-picker-search");
  input.type="search";input.placeholder="Filter "+kind+"s";input.autocomplete="off";input.maxLength=160;
  label.appendChild(input);
  const results=el(documentRef,"div","entity-picker-results");
  results.setAttribute("role","listbox");results.setAttribute("aria-label","Available "+kind+"s");
  const hint=el(documentRef,"p","entity-picker-hint");
  root.append(label,results,hint);
  let options=[],selectedId=null,closed=false;
  function render(){
    if(closed)return;
    results.replaceChildren();
    const q=input.value.toLocaleLowerCase("en-US").trim();
    const matches=options.filter(x=>(x.label+" "+(x.detail||"")).toLocaleLowerCase("en-US").includes(q));
    for(const option of matches.slice(0,100)){
      const button=el(documentRef,"button","entity-picker-option");
      button.type="button";button.dataset.entityId=option.id;button.setAttribute("role","option");
      button.setAttribute("aria-selected",String(option.id===selectedId));
      button.disabled=!!option.disabled;
      const title=el(documentRef,"strong",null,option.label);
      const subtitle=el(documentRef,"small",null,option.disabled?option.disabledReason||"Unavailable":option.detail||"");
      button.append(title,subtitle);results.appendChild(button);
    }
    hint.textContent=matches.length>100?"Showing 100 of "+matches.length+" matches. Refine your search."
      :matches.length===0?"No matching "+kind+"s.":"";
  }
  const handle=(event)=>{
    const button=event.target.closest?.("[data-entity-id]");
    if(!button||button.disabled)return;
    const option=options.find(x=>x.id===button.dataset.entityId);
    if(!option||option.disabled)return;
    selectedId=option.id;render();onSelect(option);
  };
  results.addEventListener("click",handle);input.addEventListener("input",render);
  return Object.freeze({root,
    setOptions(next,{selected=null}={}) {
      options=Array.isArray(next)?next.filter(x=>typeof x?.id==="string"&&typeof x?.label==="string").slice(0,2048):[];
      selectedId=selected;render();
    },
    get selectedId(){return selectedId;},
    focus(){input.focus();},
    destroy(){closed=true;results.removeEventListener("click",handle);input.removeEventListener("input",render);root.replaceChildren();}
  });
}
