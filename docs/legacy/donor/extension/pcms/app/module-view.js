// Core-rendered module surfaces (pcms.ui-contribution/v1): module pages with declarative
// list/detail views, Overview cards, Account facets, the Activity feed and the
// Settings → Modules state list. Module text is always set with textContent.
import { pcmsStatusToken } from "./primitives.js";
import { pcmsUiEntityHref } from "../integration/ui-contribution-contract.js";

function el(documentRef,tag,className=null,text=null){
  const node=documentRef.createElement(tag);
  if(className) node.className=className;
  if(text!==null&&text!==undefined) node.textContent=String(text);
  return node;
}

export function clearNode(node){
  while(node.firstChild) node.removeChild(node.firstChild);
}

export function statusPill(documentRef,token,label){
  const node=el(documentRef,"span","status-token");
  node.dataset.token=token;
  node.dataset.tone=pcmsStatusToken(token).tone;
  node.textContent=label||pcmsStatusToken(token).label;
  return node;
}

function factsList(documentRef,facts){
  const list=el(documentRef,"dl","module-facts");
  for(const fact of facts||[]){
    const row=el(documentRef,"div");
    row.appendChild(el(documentRef,"dt",null,fact.label));
    const dd=el(documentRef,"dd");
    if(fact.href){
      const link=el(documentRef,"a",null,fact.value);
      link.href=fact.href;
      dd.appendChild(link);
    } else {
      dd.textContent=fact.value;
    }
    row.appendChild(dd);
    list.appendChild(row);
  }
  return list;
}

function formatCell(documentRef,value,column){
  const td=el(documentRef,"td");
  if(value===null||value===undefined){td.textContent="—";return td;}
  if(column.kind==="status"){td.appendChild(statusPill(documentRef,value.token,value.label));return td;}
  if(column.kind==="entity"){
    const link=el(documentRef,"a",null,value.label);
    link.href=pcmsUiEntityHref(value.entity);
    td.appendChild(link);
    return td;
  }
  td.textContent=String(value);
  return td;
}

export function renderOverviewCards(documentRef,container,cards){
  clearNode(container);
  for(const card of cards){
    const article=el(documentRef,"a","module-card");
    article.href=card.href;
    article.dataset.moduleId=card.moduleId;
    if(card.greyed) article.dataset.greyed="true";
    const head=el(documentRef,"div","module-card-head");
    head.appendChild(el(documentRef,"strong",null,card.title));
    head.appendChild(statusPill(documentRef,card.status.token,card.status.label));
    article.appendChild(head);
    article.appendChild(el(documentRef,"p","module-card-headline",card.headline));
    if(card.banner) article.appendChild(el(documentRef,"p","module-banner",card.banner));
    if(card.facts.length) article.appendChild(factsList(documentRef,card.facts));
    container.appendChild(article);
  }
}

function actionButton(documentRef,action,onAction){
  const button=el(documentRef,"button","inline-action",action.held?action.label+" · held":action.label);
  button.type="button";
  button.dataset.actionId=action.id;
  button.dataset.risk=action.risk;
  if(action.held) button.disabled=true;
  button.addEventListener("click",()=>onAction(action));
  return button;
}

export function renderSettingsForm(documentRef,container,{settings,values},onSave){
  clearNode(container);
  if(!settings.length) return;
  const form=el(documentRef,"form","live-form module-settings");
  form.appendChild(el(documentRef,"h4",null,"Settings"));
  for(const spec of settings){
    const label=el(documentRef,"label",null,spec.label);
    let input;
    if(spec.kind==="choice"){
      input=el(documentRef,"select");
      for(const option of spec.options){
        const node=el(documentRef,"option",null,option.label);
        node.value=option.id;
        input.appendChild(node);
      }
      input.value=values[spec.key]??"";
    } else if(spec.kind==="boolean"){
      input=el(documentRef,"input");
      input.type="checkbox";
      input.checked=values[spec.key]===true;
    } else {
      input=el(documentRef,"input");
      input.type=spec.kind==="integer"||spec.kind==="duration"?"number":"text";
      if(spec.min!==undefined) input.min=String(spec.min);
      if(spec.max!==undefined) input.max=String(spec.max);
      input.value=values[spec.key]===null||values[spec.key]===undefined?"":String(values[spec.key]);
    }
    input.name=spec.key;
    input.dataset.settingKey=spec.key;
    label.appendChild(input);
    if(spec.unit) label.appendChild(el(documentRef,"small",null,spec.unit));
    if(spec.help) label.appendChild(el(documentRef,"small",null,spec.help));
    form.appendChild(label);
    input.addEventListener("change",()=>{
      const value=spec.kind==="boolean"?input.checked
        :spec.kind==="integer"||spec.kind==="duration"?Number(input.value)
          :input.value;
      void onSave(spec.key,value);
    });
  }
  container.appendChild(form);
}

// The module page. `ops` supplies the UI-client reads and the action runner.
export async function renderModulePage(documentRef,container,model,ops){
  clearNode(container);
  container.dataset.moduleId=model.moduleId;
  container.dataset.state=model.state||model.kind;
  const header=el(documentRef,"div","view-head");
  const titleWrap=el(documentRef,"div");
  titleWrap.appendChild(el(documentRef,"span","eyebrow","Module"));
  titleWrap.appendChild(el(documentRef,"h2",null,model.title));
  header.appendChild(titleWrap);
  if(model.token) header.appendChild(statusPill(documentRef,model.token,model.label));
  container.appendChild(header);
  if(model.banner){
    const banner=el(documentRef,"p","module-banner",model.banner);
    banner.setAttribute("role","status");
    container.appendChild(banner);
  }
  if(model.kind==="missing"||model.kind==="state"){
    const message=el(documentRef,"p","empty-state module-page-message",model.message);
    message.dataset.pageMessage="true";
    container.appendChild(message);
    return;
  }
  if(model.description) container.appendChild(el(documentRef,"p","module-description",model.description));

  if(model.summary||model.summaryError){
    const card=el(documentRef,"section","module-summary");
    if(model.summary){
      card.appendChild(statusPill(documentRef,model.summary.status.token,model.summary.status.label));
      card.appendChild(el(documentRef,"p","module-card-headline",model.summary.headline));
      card.appendChild(factsList(documentRef,model.summary.facts));
    } else {
      card.appendChild(el(documentRef,"p","module-status",model.title+" information unavailable · "+model.summaryError));
    }
    container.appendChild(card);
  }

  if(model.actions.length){
    const bar=el(documentRef,"div","module-actions");
    for(const action of model.actions) bar.appendChild(actionButton(documentRef,action,(chosen)=>ops.run(chosen,{kind:"module",id:model.moduleId})));
    container.appendChild(bar);
  }

  if(model.kind!=="frame"&&(model.listViews?.length||0)>1){
    const tabs=el(documentRef,"nav","module-view-tabs");
    tabs.setAttribute("aria-label",model.title+" views");
    for(const item of model.listViews){
      const link=el(documentRef,"a",null,item.title);
      link.href="#/m/"+encodeURIComponent(model.moduleId)+"/"+encodeURIComponent(item.id);
      link.dataset.viewId=item.id;
      if(model.view?.id===item.id) link.setAttribute("aria-current","page");
      tabs.appendChild(link);
    }
    container.appendChild(tabs);
  }

  if(model.kind==="frame"){
    const frameContainer=el(documentRef,"div","module-frame-container");
    frameContainer.id="moduleFrameContainer";
    container.appendChild(frameContainer);
    await ops.mountFrame(frameContainer,model.moduleId);
  } else if(model.missingView){
    container.appendChild(el(documentRef,"p","empty-state","This module view is not available."));
  } else if(model.view?.type==="list"){
    const section=el(documentRef,"section","module-view");
    section.dataset.viewId=model.view.id;
    section.appendChild(el(documentRef,"h3",null,model.view.title));
    const status=el(documentRef,"p","module-status","Loading…");
    section.appendChild(status);
    container.appendChild(section);
    try{
      const page=await ops.listRows(model.moduleId,model.view.id,null);
      status.remove();
      const table=el(documentRef,"table","module-table");
      const head=el(documentRef,"tr");
      for(const column of model.view.columns) head.appendChild(el(documentRef,"th",null,column.label));
      const thead=el(documentRef,"thead");thead.appendChild(head);table.appendChild(thead);
      const tbody=el(documentRef,"tbody");
      for(const row of page.rows){
        const tr=el(documentRef,"tr");
        tr.dataset.rowId=row.id;
        model.view.columns.forEach((column,index)=>{
          const td=formatCell(documentRef,row.cells[column.id],column);
          if(index===0&&model.view.rowHref){
            const link=el(documentRef,"a",null,td.textContent);
            link.href="#/m/"+encodeURIComponent(model.moduleId)+"/"+encodeURIComponent(model.view.rowHref)+"/"+encodeURIComponent(row.id);
            clearNode(td);td.appendChild(link);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      section.appendChild(table);
      if(!page.rows.length) section.appendChild(el(documentRef,"p","empty-state","Nothing to show yet."));
    } catch(error){
      status.textContent=model.title+" information unavailable · "+String(error?.code||"error");
      status.dataset.state="error";
    }
  } else if(model.view?.type==="detail"&&model.objectId){
    const section=el(documentRef,"section","module-view");
    section.dataset.viewId=model.view.id;
    container.appendChild(section);
    try{
      const detail=await ops.getDetail(model.moduleId,model.view.id,model.objectId);
      section.appendChild(el(documentRef,"h3",null,detail.title));
      if(detail.status) section.appendChild(statusPill(documentRef,detail.status.token,detail.status.label));
      // P040: the detail view's declared actions act on this module object.
      const objectActions=(model.view.actions||[]).map((id)=>(model.allActions||[]).find((action)=>action.id===id))
        .filter((action)=>action&&action.appliesTo==="module-object:"+model.view.id);
      if(objectActions.length){
        const bar=el(documentRef,"div","module-actions module-object-actions");
        const target={kind:"module-object",moduleId:model.moduleId,view:model.view.id,id:model.objectId};
        for(const action of objectActions) bar.appendChild(actionButton(documentRef,action,(chosen)=>ops.run(chosen,target)));
        section.appendChild(bar);
      }
      for(const part of detail.sections){
        section.appendChild(el(documentRef,"h4",null,part.title));
        section.appendChild(factsList(documentRef,part.facts));
      }
    } catch(error){
      section.appendChild(el(documentRef,"p","module-status",model.title+" information unavailable · "+String(error?.code||"error")));
    }
  }

  if(model.settings.length){
    const settings=el(documentRef,"section","module-settings-section");
    container.appendChild(settings);
    try{
      const current=await ops.getSettings(model.moduleId);
      renderSettingsForm(documentRef,settings,current,(key,value)=>ops.setSetting(model.moduleId,key,value));
    } catch {}
  }
}

export function renderFacets(documentRef,container,result,{snapshot,onAction}){
  clearNode(container);
  for(const entry of result?.facets||[]){
    const section=el(documentRef,"section","module-facet");
    section.dataset.moduleId=entry.moduleId;
    if(!entry.facet){
      section.appendChild(el(documentRef,"p","module-status",entry.moduleTitle+" information unavailable · Retry"));
      section.dataset.state="error";
      container.appendChild(section);
      continue;
    }
    const head=el(documentRef,"div","module-card-head");
    head.appendChild(el(documentRef,"strong",null,entry.facet.title));
    if(entry.facet.status) head.appendChild(statusPill(documentRef,entry.facet.status.token,entry.facet.status.label));
    section.appendChild(head);
    section.appendChild(factsList(documentRef,entry.facet.facts));
    const module=(snapshot?.modules||[]).find((item)=>item.moduleId===entry.moduleId);
    const actions=(module?.actions||[]).filter((action)=>entry.facet.actions.includes(action.id));
    if(actions.length){
      const bar=el(documentRef,"div","module-actions");
      for(const action of actions) bar.appendChild(actionButton(documentRef,action,(chosen)=>onAction(module,chosen,result.entity)));
      section.appendChild(bar);
    }
    for(const item of entry.facet.history){
      section.appendChild(el(documentRef,"p","module-history",item.at+" · "+item.text));
    }
    container.appendChild(section);
  }
}

export function renderActivity(documentRef,container,lines){
  clearNode(container);
  for(const line of lines){
    const row=el(documentRef,"div","action-receipt");
    row.dataset.moduleId=line.moduleId;
    row.appendChild(statusPill(documentRef,line.token,null));
    row.appendChild(el(documentRef,"span",null,line.text));
    if(line.at) row.appendChild(el(documentRef,"small",null,line.at));
    container.appendChild(row);
  }
}

export function renderSettingsModules(documentRef,container,rows){
  clearNode(container);
  for(const row of rows){
    const item=el(documentRef,"div","module-row");
    item.dataset.moduleId=row.moduleId;
    item.dataset.state=row.label;
    const strong=el(documentRef,"strong",null,row.title+(row.version?" "+row.version:""));
    item.appendChild(strong);
    item.appendChild(statusPill(documentRef,row.token,row.label));
    const detail=[row.kind==="builtin"?"Built-in":"Runtime module",row.message,row.errorCode].filter(Boolean).join(" · ");
    item.appendChild(el(documentRef,"small",null,detail));
    container.appendChild(item);
  }
}
