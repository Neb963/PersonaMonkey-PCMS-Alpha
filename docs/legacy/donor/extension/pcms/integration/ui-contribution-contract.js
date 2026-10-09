// pcms.ui-contribution/v1 — how built-in and runtime modules contribute to the dashboards
// (docs/design/pcms-ux-v2/03-module-ui-contract.md). Pure data and validation, shared by the
// background contribution host and the dashboard. Every value a module supplies crosses this
// file before Core stores or renders it: unknown keys are rejected, strings and arrays are
// bounded, and text is plain text (the dashboard renders it with textContent only).

export const PCMS_UI_CONTRIBUTION_CONTRACT="pcms.ui-contribution/v1";
export const PCMS_UI_CONTRIBUTION_VERSION=1;

export const PCMS_UI_CONTRIBUTION_ERROR_CODES=Object.freeze({
  INVALID:"PCMS_UI_CONTRIBUTION_INVALID",
  UNSUPPORTED:"PCMS_UI_CONTRIBUTION_UNSUPPORTED",
  NOT_AVAILABLE:"PCMS_UI_CONTRIBUTION_NOT_AVAILABLE",
  ACTION_UNKNOWN:"PCMS_UI_ACTION_UNKNOWN",
  CONFIRMATION_REQUIRED:"PCMS_UI_CONFIRMATION_REQUIRED",
  RECOVERY_HOLD:"PCMS_UI_RECOVERY_HOLD",
  TIMEOUT:"PCMS_UI_CONTRIBUTION_TIMEOUT"
});

export const PCMS_UI_STATUS_TOKENS=Object.freeze([
  "OK","INFO","ACTIVE","WAITING_HUMAN","WARNING","ERROR","UNCERTAIN","HELD","UNAVAILABLE"
]);
// The sidebar dot shows only these (03 §4.2).
export const PCMS_UI_DOT_TOKENS=Object.freeze(["WARNING","ERROR","UNCERTAIN"]);

export const PCMS_UI_ICONS=Object.freeze([
  "activity","archive","bell","box","chart","check","clock","cloud","code","compass","database","download",
  "file","flag","gear","grid","key","layers","link","list","refresh","search","upload","user"
]);

export const PCMS_UI_ACTION_RISKS=Object.freeze(["READ","LOCAL","EXTERNAL_MUTATION","BINDING","DESTRUCTIVE","RESOLUTION"]);
// Confirmed in a Core-rendered dialog, never inside a module frame (03 §5).
export const PCMS_UI_CONFIRM_RISKS=Object.freeze(["EXTERNAL_MUTATION","BINDING","DESTRUCTIVE","RESOLUTION"]);
// Blocked by Core during RECOVERY_HOLD before the module is called (03 §4.7).
export const PCMS_UI_HOLD_BLOCKED_RISKS=Object.freeze(["EXTERNAL_MUTATION","BINDING","DESTRUCTIVE"]);
export const PCMS_UI_ENTITY_KINDS=Object.freeze(["account","generator","persona","module","module-object"]);
export const PCMS_UI_FACET_KINDS=Object.freeze(["account","generator"]);
export const PCMS_UI_INPUT_KINDS=Object.freeze(["text","integer","choice","boolean","entity","file","secret"]);
// P040 (additive): a `secret` action field travels from the dashboard as {"$pcmsSecret": value} so
// every hop can recognise and redact it; only a built-in module (background Core, in process)
// receives the value, once, to hand it to the dedicated secret host. Never a setting, never a
// preview input, never offered to a runtime module.
export const PCMS_UI_SECRET_ENVELOPE_KEY="$pcmsSecret";
export const PCMS_UI_SECRET_MAX_LENGTH=4096;
export function wrapPcmsUiSecret(value){return Object.freeze({[PCMS_UI_SECRET_ENVELOPE_KEY]:value});}
export function isPcmsUiSecretEnvelope(value){
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===1
    &&Object.hasOwn(value,PCMS_UI_SECRET_ENVELOPE_KEY)&&typeof value[PCMS_UI_SECRET_ENVELOPE_KEY]==="string";
}
// Replaces every secret envelope in JSON data with a fixed marker (receipt hashing, logging).
export function redactPcmsUiSecrets(value,depth=0){
  if(depth>48||value===null||typeof value!=="object") return value;
  if(isPcmsUiSecretEnvelope(value)) return {[PCMS_UI_SECRET_ENVELOPE_KEY]:"[redacted]"};
  if(Array.isArray(value)) return value.map((item)=>redactPcmsUiSecrets(item,depth+1));
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactPcmsUiSecrets(item,depth+1)]));
}
export const PCMS_UI_SETTING_KINDS=Object.freeze(["text","integer","choice","boolean","entity","duration"]);
export const PCMS_UI_COLUMN_KINDS=Object.freeze(["text","status","time","count","entity"]);

export const PCMS_UI_LIMITS=Object.freeze({
  title:40,
  description:200,
  label:80,
  headline:80,
  text:200,
  value:120,
  facts:4,
  facetFacts:8,
  facetColumns:3,
  facetHistory:10,
  searchHits:20,
  searchMerged:50,
  publishedSearch:200,
  conditions:200,
  actions:32,
  settings:20,
  views:8,
  columns:8,
  detailSections:8,
  detailFacts:12,
  listRows:100,
  choiceOptions:12,
  consequences:8,
  excluded:50,
  activity:50,
  diagnostics:30,
  keywords:8,
  publishBytes:64*1024,
  downloadBytes:256*1024,
  textInput:4096,
  fileInputBytes:256*1024
});

const L=PCMS_UI_LIMITS;
const ID=/^[a-z][a-z0-9-]{0,47}$/;
const MODULE_ID=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const ENTITY_ID=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CONDITION_KEY=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const HREF=/^#\/[A-Za-z0-9._~:@/?=&,%+-]{0,400}$/;
const TASK_KIND=/^[a-z][a-z0-9._-]{0,95}$/;
const SETTING_KEY=/^[a-z][A-Za-z0-9]{0,47}$/;
const CONTROL=/[\u0000-\u001f\u007f]/;

export class PcmsUiContributionError extends Error {
  constructor(code,message){
    super(message||code);
    this.name="PcmsUiContributionError";
    this.code=code;
  }
}

function invalid(message){throw new PcmsUiContributionError(PCMS_UI_CONTRIBUTION_ERROR_CODES.INVALID,message);}

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

// Own enumerable data properties only; getters, symbols and unknown keys are rejected.
function record(value,label,required,optional=[]){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) invalid(label+" must be a plain object");
  const out={};
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!descriptor.enumerable||!Object.hasOwn(descriptor,"value")) invalid(label+" has an accessor "+key);
    if(!required.includes(key)&&!optional.includes(key)) invalid(label+" has unexpected key "+key);
    out[key]=descriptor.value;
  }
  for(const key of required) if(!Object.hasOwn(out,key)) invalid(label+" is missing "+key);
  return out;
}

function list(value,label,max){
  if(!Array.isArray(value)) invalid(label+" must be an array");
  if(value.length>max) invalid(label+" has more than "+max+" items");
  return value;
}

export function pcmsUiText(value,max,label,{empty=false}={}){
  if(typeof value!=="string"||value.length>max||(!empty&&value.trim().length<1)||CONTROL.test(value)) invalid(label+" is invalid");
  return value;
}

function optionalText(value,max,label){
  return value===undefined||value===null?null:pcmsUiText(value,max,label);
}

function oneOf(value,allowed,label){
  if(!allowed.includes(value)) invalid(label+" is invalid");
  return value;
}

function integer(value,label,min,max){
  if(!Number.isSafeInteger(value)||value<min||value>max) invalid(label+" is out of bounds");
  return value;
}

function timestamp(value,label){
  if(typeof value!=="string"||value.length>64||!Number.isFinite(Date.parse(value))) invalid(label+" is invalid");
  return value;
}

export function isPcmsUiModuleId(value){
  return typeof value==="string"&&value.length<=96&&MODULE_ID.test(value);
}

export function normalizePcmsUiModuleId(value,label="moduleId"){
  if(!isPcmsUiModuleId(value)) invalid(label+" is invalid");
  return value;
}

export function normalizePcmsUiHref(value,label="href"){
  if(typeof value!=="string"||!HREF.test(value)||value.includes("..")||value.includes("//")) invalid(label+" is invalid");
  return value;
}

export function normalizePcmsUiStatus(value,label="status"){
  const raw=record(value,label,["token","label"]);
  return Object.freeze({token:oneOf(raw.token,PCMS_UI_STATUS_TOKENS,label+".token"),label:pcmsUiText(raw.label,L.label,label+".label")});
}

// EntityRef: Core-owned kinds and how they route (03 §3).
export function normalizePcmsUiEntityRef(value,label="entity"){
  const raw=record(value,label,["kind","id"],["moduleId","view"]);
  const kind=oneOf(raw.kind,PCMS_UI_ENTITY_KINDS,label+".kind");
  if(typeof raw.id!=="string"||!ENTITY_ID.test(raw.id)) invalid(label+".id is invalid");
  if(kind==="module"){
    if(Object.hasOwn(raw,"moduleId")||Object.hasOwn(raw,"view")) invalid(label+" is invalid");
    normalizePcmsUiModuleId(raw.id,label+".id");
    return Object.freeze({kind,id:raw.id});
  }
  if(kind==="module-object"){
    const moduleId=normalizePcmsUiModuleId(raw.moduleId,label+".moduleId");
    if(typeof raw.view!=="string"||!ID.test(raw.view)) invalid(label+".view is invalid");
    return Object.freeze({kind,id:raw.id,moduleId,view:raw.view});
  }
  if(Object.hasOwn(raw,"moduleId")||Object.hasOwn(raw,"view")) invalid(label+" is invalid");
  return Object.freeze({kind,id:raw.id});
}

export function pcmsUiEntityHref(entity){
  const ref=normalizePcmsUiEntityRef(entity);
  if(ref.kind==="account") return "#/accounts/"+encodeURIComponent(ref.id);
  if(ref.kind==="persona") return "#/accounts?f="+encodeURIComponent("persona:"+ref.id);
  if(ref.kind==="generator") return "#/search?q="+encodeURIComponent(ref.id);
  if(ref.kind==="module") return "#/m/"+encodeURIComponent(ref.id);
  return "#/m/"+encodeURIComponent(ref.moduleId)+"/"+encodeURIComponent(ref.view)+"/"+encodeURIComponent(ref.id);
}

function facts(value,label,max,{hrefs=false}={}){
  return Object.freeze(list(value,label,max).map((item,index)=>{
    const raw=record(item,label+"["+index+"]",["label","value"],hrefs?["href"]:[]);
    return Object.freeze({
      label:pcmsUiText(raw.label,L.label,label+".label"),
      value:pcmsUiText(String(raw.value),L.value,label+".value",{empty:true}),
      ...(raw.href!==undefined?{href:normalizePcmsUiHref(raw.href,label+".href")}:{})
    });
  }));
}

function inputField(value,label,kinds){
  const raw=record(value,label,["key","label","kind"],["required","min","max","maxLength","pattern","options","entityKind","unit","default","help","accept","maxBytes"]);
  if(typeof raw.key!=="string"||!SETTING_KEY.test(raw.key)) invalid(label+".key is invalid");
  const kind=oneOf(raw.kind,kinds,label+".kind");
  const out={key:raw.key,label:pcmsUiText(raw.label,L.label,label+".label"),kind,required:raw.required===true};
  if(raw.required!==undefined&&typeof raw.required!=="boolean") invalid(label+".required is invalid");
  if(raw.help!==undefined) out.help=pcmsUiText(raw.help,L.text,label+".help");
  if(kind==="integer"||kind==="duration"){
    out.min=integer(raw.min??0,label+".min",-1e9,1e9);
    out.max=integer(raw.max??1e9,label+".max",out.min,1e9);
    if(raw.unit!==undefined) out.unit=pcmsUiText(raw.unit,24,label+".unit");
  }
  if(kind==="text"){
    out.maxLength=integer(raw.maxLength??200,label+".maxLength",1,L.textInput);
    if(raw.pattern!==undefined){
      const pattern=pcmsUiText(raw.pattern,200,label+".pattern");
      try{new RegExp("^(?:"+pattern+")$","u");}catch{invalid(label+".pattern is invalid");}
      out.pattern=pattern;
    }
  }
  if(kind==="choice"){
    out.options=Object.freeze(list(raw.options,label+".options",L.choiceOptions).map((option,index)=>{
      const item=record(option,label+".options["+index+"]",["id","label"]);
      if(typeof item.id!=="string"||!ID.test(item.id)) invalid(label+".options.id is invalid");
      return Object.freeze({id:item.id,label:pcmsUiText(item.label,L.label,label+".options.label")});
    }));
    if(!out.options.length||new Set(out.options.map((option)=>option.id)).size!==out.options.length) invalid(label+".options are invalid");
  }
  if(kind==="entity") out.entityKind=oneOf(raw.entityKind,["account","generator","persona"],label+".entityKind");
  if(kind==="file"){
    out.maxBytes=integer(raw.maxBytes??L.fileInputBytes,label+".maxBytes",1,L.fileInputBytes);
    if(raw.accept!==undefined) out.accept=pcmsUiText(raw.accept,80,label+".accept");
  }
  if(kind==="secret"){
    out.maxLength=integer(raw.maxLength??1024,label+".maxLength",1,PCMS_UI_SECRET_MAX_LENGTH);
    if(raw.default!==undefined) invalid(label+".default is not allowed for a secret");
  }
  if(raw.default!==undefined) out.default=coercePcmsUiFieldValue(out,raw.default,label+".default");
  return Object.freeze(out);
}

// Validates one submitted field value against its spec; Core never forwards anything else.
export function coercePcmsUiFieldValue(field,value,label=field.key){
  if(value===null||value===undefined||value===""){
    if(field.required) invalid(label+" is required");
    return null;
  }
  if(field.kind==="text"){
    const text=pcmsUiText(value,field.maxLength,label,{empty:true});
    if(field.pattern&&!new RegExp("^(?:"+field.pattern+")$","u").test(text)) invalid(label+" does not match");
    return text;
  }
  if(field.kind==="integer"||field.kind==="duration") return integer(value,label,field.min,field.max);
  if(field.kind==="boolean"){if(typeof value!=="boolean") invalid(label+" is invalid"); return value;}
  if(field.kind==="choice"){if(!field.options.some((option)=>option.id===value)) invalid(label+" is invalid"); return value;}
  if(field.kind==="entity"){if(typeof value!=="string"||!ENTITY_ID.test(value)) invalid(label+" is invalid"); return value;}
  if(field.kind==="file"){
    if(typeof value!=="string"||new TextEncoder().encode(value).byteLength>field.maxBytes||value.includes("\u0000")) invalid(label+" is invalid");
    return value;
  }
  if(field.kind==="secret"){
    // Only the envelope is accepted, so a secret can never arrive as an unredactable plain string.
    if(!isPcmsUiSecretEnvelope(value)) invalid(label+" is invalid");
    const secret=value[PCMS_UI_SECRET_ENVELOPE_KEY];
    if(secret.length<1||secret.length>field.maxLength||secret.includes("\u0000")){
      if(field.required||secret.length>0) invalid(label+" is invalid");
      return null;
    }
    return secret;
  }
  invalid(label+" is invalid");
}

function inputSpec(value,label){
  if(value===null||value===undefined) return null;
  const fields=list(value,label,12).map((field,index)=>inputField(field,label+"["+index+"]",PCMS_UI_INPUT_KINDS));
  if(new Set(fields.map((field)=>field.key)).size!==fields.length) invalid(label+" has duplicate keys");
  return Object.freeze(fields);
}

export function normalizePcmsUiInput(spec,value){
  if(spec===null){
    if(value!==null&&value!==undefined) invalid("This action takes no input");
    return null;
  }
  const raw=value===null||value===undefined?{}:record(value,"input",[],spec.map((field)=>field.key));
  const out={};
  for(const field of spec){
    const coerced=coercePcmsUiFieldValue(field,raw[field.key]);
    if(coerced!==null) out[field.key]=coerced;
  }
  return Object.freeze(out);
}

function actionSpec(value,label){
  const raw=record(value,label,["id","label","appliesTo","risk"],["bulk","input","preview"]);
  if(typeof raw.id!=="string"||!ID.test(raw.id)) invalid(label+".id is invalid");
  const appliesTo=typeof raw.appliesTo==="string"&&(/^(?:generator|account|module)$/.test(raw.appliesTo)||/^module-object:[a-z][a-z0-9-]{0,47}$/.test(raw.appliesTo))
    ?raw.appliesTo:invalid(label+".appliesTo is invalid");
  let bulk=false;
  if(raw.bulk!==undefined&&raw.bulk!==false){
    const item=record(raw.bulk,label+".bulk",["max"]);
    bulk=Object.freeze({max:integer(item.max,label+".bulk.max",1,50)});
  }
  if(raw.preview!==undefined&&typeof raw.preview!=="boolean") invalid(label+".preview is invalid");
  const input=inputSpec(raw.input,label+".input");
  if(input?.some((field)=>field.kind==="secret")&&(raw.preview===true||bulk!==false)) invalid(label+" with a secret field cannot have a preview or bulk mode");
  return Object.freeze({
    id:raw.id,
    label:pcmsUiText(raw.label,L.label,label+".label"),
    appliesTo,
    risk:oneOf(raw.risk,PCMS_UI_ACTION_RISKS,label+".risk"),
    bulk,
    input,
    preview:raw.preview===true
  });
}

function column(value,label){
  const raw=record(value,label,["id","label","kind"]);
  if(typeof raw.id!=="string"||!ID.test(raw.id)) invalid(label+".id is invalid");
  return Object.freeze({id:raw.id,label:pcmsUiText(raw.label,L.label,label+".label"),kind:oneOf(raw.kind,PCMS_UI_COLUMN_KINDS,label+".kind")});
}

function pageSpec(value,label,{kind,actionIds}){
  if(value===null||value===undefined) return null;
  const raw=record(value,label,[],["views","frame"]);
  if(raw.frame!==undefined){
    if(raw.frame!==true||kind!=="runtime"||raw.views!==undefined) invalid(label+".frame is only for runtime modules");
    return Object.freeze({frame:true,views:Object.freeze([])});
  }
  const views=list(raw.views,label+".views",L.views).map((view,index)=>{
    const item=record(view,label+".views["+index+"]",["id","title","type"],["columns","rowHref","actions","sections"]);
    if(typeof item.id!=="string"||!ID.test(item.id)) invalid(label+".views.id is invalid");
    const actions=Object.freeze(list(item.actions??[],label+".views.actions",L.actions).map((id)=>{
      if(!actionIds.includes(id)) invalid(label+".views.actions names an undeclared action");
      return id;
    }));
    if(item.type==="list"){
      if(item.sections!==undefined) invalid(label+".views.sections is only for detail views");
      const columns=Object.freeze(list(item.columns,label+".views.columns",L.columns).map((entry,i)=>column(entry,label+".columns["+i+"]")));
      if(!columns.length) invalid(label+".views.columns is empty");
      if(item.rowHref!==undefined&&(typeof item.rowHref!=="string"||!ID.test(item.rowHref))) invalid(label+".views.rowHref is invalid");
      return Object.freeze({id:item.id,title:pcmsUiText(item.title,L.title,label+".title"),type:"list",columns,rowHref:item.rowHref??null,actions});
    }
    if(item.type==="detail"){
      if(item.columns!==undefined||item.rowHref!==undefined) invalid(label+".views has list keys on a detail view");
      return Object.freeze({id:item.id,title:pcmsUiText(item.title,L.title,label+".title"),type:"detail",actions});
    }
    return invalid(label+".views.type is invalid");
  });
  if(new Set(views.map((view)=>view.id)).size!==views.length) invalid(label+".views has duplicate ids");
  // rowHref names the detail view a list row opens (#/m/<module>/<detail view>/<row id>).
  for(const view of views){
    if(view.type==="list"&&view.rowHref!==null&&!views.some((other)=>other.type==="detail"&&other.id===view.rowHref)) invalid(label+".views.rowHref names no detail view");
  }
  return Object.freeze({frame:false,views:Object.freeze(views)});
}

const DESCRIPTOR_KEYS=["contractVersion","moduleId","title"];
const DESCRIPTOR_OPTIONAL=["description","icon","nav","actions","settings","humanTaskActions","page","facets"];

// The static part of a descriptor (03 §4). `facets` lists the EntityRef kinds a module answers.
export function normalizePcmsUiDescriptor(value,{moduleId,kind="builtin"}={}){
  if(!plain(value)) invalid("Descriptor must be a plain object");
  if(value.contractVersion!==PCMS_UI_CONTRIBUTION_VERSION){
    const error=new PcmsUiContributionError(PCMS_UI_CONTRIBUTION_ERROR_CODES.UNSUPPORTED,"Unsupported contribution contract");
    error.contractVersion=Number.isSafeInteger(value.contractVersion)?value.contractVersion:null;
    throw error;
  }
  const raw=record(value,"descriptor",DESCRIPTOR_KEYS,DESCRIPTOR_OPTIONAL);
  if(raw.moduleId!==moduleId) invalid("descriptor.moduleId must equal the module id");
  const actions=Object.freeze(list(raw.actions??[],"descriptor.actions",L.actions).map((item,index)=>actionSpec(item,"actions["+index+"]")));
  const actionIds=actions.map((action)=>action.id);
  if(new Set(actionIds).size!==actionIds.length) invalid("descriptor.actions has duplicate ids");
  if(kind!=="builtin"&&actions.some((action)=>action.input?.some((field)=>field.kind==="secret"))) invalid("descriptor.actions: only built-in modules may take secret input");
  let nav=null;
  if(raw.nav!==null&&raw.nav!==undefined){
    const item=record(raw.nav,"descriptor.nav",["label"],["order","statusFrom"]);
    if(item.statusFrom!==undefined&&item.statusFrom!=="summary") invalid("descriptor.nav.statusFrom is invalid");
    nav=Object.freeze({
      label:pcmsUiText(item.label,24,"descriptor.nav.label"),
      order:integer(item.order??100,"descriptor.nav.order",0,1000),
      statusFrom:item.statusFrom??null
    });
  }
  const settings=Object.freeze(list(raw.settings??[],"descriptor.settings",L.settings)
    .map((item,index)=>inputField(item,"settings["+index+"]",PCMS_UI_SETTING_KINDS)));
  if(new Set(settings.map((item)=>item.key)).size!==settings.length) invalid("descriptor.settings has duplicate keys");
  const humanTaskActions={};
  for(const [taskKind,actionId] of Object.entries(record(raw.humanTaskActions??{},"descriptor.humanTaskActions",[],Object.keys(raw.humanTaskActions??{})))){
    if(!TASK_KIND.test(taskKind)||!actionIds.includes(actionId)) invalid("descriptor.humanTaskActions is invalid");
    humanTaskActions[taskKind]=actionId;
  }
  const facetKinds=Object.freeze([...new Set(list(raw.facets??[],"descriptor.facets",PCMS_UI_FACET_KINDS.length)
    .map((item)=>oneOf(item,PCMS_UI_FACET_KINDS,"descriptor.facets")))]);
  return Object.freeze({
    contractVersion:PCMS_UI_CONTRIBUTION_VERSION,
    moduleId,
    title:pcmsUiText(raw.title,L.title,"descriptor.title"),
    description:optionalText(raw.description,L.description,"descriptor.description"),
    icon:raw.icon===undefined?"box":oneOf(raw.icon,PCMS_UI_ICONS,"descriptor.icon"),
    nav,
    actions,
    settings,
    humanTaskActions:Object.freeze(humanTaskActions),
    facets:facetKinds,
    page:pageSpec(raw.page,"descriptor.page",{kind,actionIds})
  });
}

export function normalizePcmsUiSummary(value){
  const raw=record(value,"summary",["status","headline"],["facts","href"]);
  return Object.freeze({
    status:normalizePcmsUiStatus(raw.status,"summary.status"),
    headline:pcmsUiText(raw.headline,L.headline,"summary.headline"),
    facts:facts(raw.facts??[],"summary.facts",L.facts),
    href:raw.href===undefined?null:normalizePcmsUiHref(raw.href,"summary.href")
  });
}

export function normalizePcmsUiSearchHits(value,{limit=L.searchHits}={}){
  return Object.freeze(list(value,"search",limit).map((item,index)=>{
    const raw=record(item,"search["+index+"]",["entity","title","score"],["subtitle","status"]);
    return Object.freeze({
      entity:normalizePcmsUiEntityRef(raw.entity,"search.entity"),
      title:pcmsUiText(raw.title,L.label,"search.title"),
      subtitle:optionalText(raw.subtitle,L.text,"search.subtitle"),
      status:raw.status===undefined?null:normalizePcmsUiStatus(raw.status,"search.status"),
      score:integer(raw.score,"search.score",0,100)
    });
  }));
}

// Published search entries are matched by Core; a module is not woken per keystroke.
export function normalizePcmsUiPublishedSearch(value){
  return Object.freeze(list(value,"search",L.publishedSearch).map((item,index)=>{
    const raw=record(item,"search["+index+"]",["entity","title"],["subtitle","status","keywords"]);
    return Object.freeze({
      entity:normalizePcmsUiEntityRef(raw.entity,"search.entity"),
      title:pcmsUiText(raw.title,L.label,"search.title"),
      subtitle:optionalText(raw.subtitle,L.text,"search.subtitle"),
      status:raw.status===undefined?null:normalizePcmsUiStatus(raw.status,"search.status"),
      keywords:Object.freeze(list(raw.keywords??[],"search.keywords",L.keywords).map((word)=>pcmsUiText(word,L.label,"search.keyword")))
    });
  }));
}

export function normalizePcmsUiConditions(value,moduleId){
  const seen=new Set();
  return Object.freeze(list(value,"conditions",L.conditions).map((item,index)=>{
    const raw=record(item,"conditions["+index+"]",["key","priority","status","title","subject"],["since","actionId"]);
    if(typeof raw.key!=="string"||!CONDITION_KEY.test(raw.key)||seen.has(raw.key)) invalid("conditions.key is invalid");
    seen.add(raw.key);
    return Object.freeze({
      key:moduleId+":"+raw.key,
      moduleId,
      priority:oneOf(raw.priority,["CRITICAL","HIGH","NORMAL","LOW"],"conditions.priority"),
      status:normalizePcmsUiStatus(raw.status,"conditions.status"),
      title:pcmsUiText(raw.title,L.text,"conditions.title"),
      subject:normalizePcmsUiEntityRef(raw.subject,"conditions.subject"),
      since:raw.since===undefined?null:timestamp(raw.since,"conditions.since"),
      actionId:raw.actionId===undefined?null:pcmsUiText(raw.actionId,48,"conditions.actionId")
    });
  }));
}

export function normalizePcmsUiFacet(value,{actionIds=[]}={}){
  if(value===null) return null;
  const raw=record(value,"facet",["title","facts"],["status","columns","actions","history"]);
  const columns={};
  if(raw.columns!==undefined){
    const entries=Object.entries(record(raw.columns,"facet.columns",[],Object.keys(raw.columns)));
    if(entries.length>L.facetColumns) invalid("facet.columns has too many columns");
    for(const [id,cell] of entries){
      if(!ID.test(id)) invalid("facet.columns id is invalid");
      const item=record(cell,"facet.columns."+id,["label","value"],["token"]);
      columns[id]=Object.freeze({
        label:pcmsUiText(item.label,L.label,"facet.columns.label"),
        value:pcmsUiText(String(item.value),L.value,"facet.columns.value",{empty:true}),
        token:item.token===undefined?null:oneOf(item.token,PCMS_UI_STATUS_TOKENS,"facet.columns.token")
      });
    }
  }
  return Object.freeze({
    title:pcmsUiText(raw.title,L.title,"facet.title"),
    status:raw.status===undefined?null:normalizePcmsUiStatus(raw.status,"facet.status"),
    facts:facts(raw.facts,"facet.facts",L.facetFacts,{hrefs:true}),
    columns:Object.freeze(columns),
    actions:Object.freeze(list(raw.actions??[],"facet.actions",L.actions).map((id)=>{
      if(!actionIds.includes(id)) invalid("facet.actions names an undeclared action");
      return id;
    })),
    history:Object.freeze(list(raw.history??[],"facet.history",L.facetHistory).map((item,index)=>{
      const entry=record(item,"facet.history["+index+"]",["at","text"],["token"]);
      return Object.freeze({
        at:timestamp(entry.at,"facet.history.at"),
        text:pcmsUiText(entry.text,L.text,"facet.history.text"),
        token:entry.token===undefined?null:oneOf(entry.token,PCMS_UI_STATUS_TOKENS,"facet.history.token")
      });
    }))
  });
}

function cell(value,columnSpec,label){
  if(value===null||value===undefined) return null;
  if(columnSpec.kind==="status") return normalizePcmsUiStatus(value,label);
  if(columnSpec.kind==="entity"){
    const raw=record(value,label,["entity","label"]);
    return Object.freeze({entity:normalizePcmsUiEntityRef(raw.entity,label+".entity"),label:pcmsUiText(raw.label,L.label,label+".label")});
  }
  if(columnSpec.kind==="count") return integer(value,label,0,Number.MAX_SAFE_INTEGER);
  if(columnSpec.kind==="time") return timestamp(value,label);
  return pcmsUiText(String(value),L.value,label,{empty:true});
}

export function normalizePcmsUiListPage(value,view){
  const raw=record(value,"rows",["rows"],["next"]);
  const rows=list(raw.rows,"rows.rows",L.listRows).map((row,index)=>{
    const item=record(row,"rows["+index+"]",["id","cells"]);
    if(typeof item.id!=="string"||!ENTITY_ID.test(item.id)) invalid("rows.id is invalid");
    const cells=record(item.cells,"rows.cells",[],view.columns.map((entry)=>entry.id));
    return Object.freeze({
      id:item.id,
      cells:Object.freeze(Object.fromEntries(view.columns.map((entry)=>[entry.id,cell(cells[entry.id],entry,"rows.cells."+entry.id)])))
    });
  });
  let next=null;
  if(raw.next!==undefined&&raw.next!==null) next=integer(raw.next,"rows.next",1,1e9);
  return Object.freeze({rows:Object.freeze(rows),next});
}

export function normalizePcmsUiDetail(value){
  const raw=record(value,"detail",["title","sections"],["status"]);
  return Object.freeze({
    title:pcmsUiText(raw.title,L.label,"detail.title"),
    status:raw.status===undefined?null:normalizePcmsUiStatus(raw.status,"detail.status"),
    sections:Object.freeze(list(raw.sections,"detail.sections",L.detailSections).map((section,index)=>{
      const item=record(section,"detail.sections["+index+"]",["title","facts"]);
      return Object.freeze({title:pcmsUiText(item.title,L.title,"detail.sections.title"),facts:facts(item.facts,"detail.facts",L.detailFacts,{hrefs:true})});
    }))
  });
}

export function normalizePcmsUiReceipt(value,{mode="execute",risk="READ"}={}){
  const raw=record(value,"receipt",["status","message"],["subject","impact","followUp","operationRef","download"]);
  const out={
    status:normalizePcmsUiStatus(raw.status,"receipt.status"),
    message:pcmsUiText(raw.message,L.text,"receipt.message"),
    subject:raw.subject===undefined?null:normalizePcmsUiEntityRef(raw.subject,"receipt.subject"),
    impact:null,
    followUp:null,
    operationRef:null,
    download:null
  };
  if(raw.impact!==undefined){
    if(mode!=="preview") invalid("receipt.impact is only returned by a preview");
    const item=record(raw.impact,"receipt.impact",["title","consequences","confirmLabel"],["excluded"]);
    out.impact=Object.freeze({
      title:pcmsUiText(item.title,L.label,"impact.title"),
      consequences:Object.freeze(list(item.consequences,"impact.consequences",L.consequences).map((text)=>pcmsUiText(text,L.text,"impact.consequence"))),
      confirmLabel:pcmsUiText(item.confirmLabel,24,"impact.confirmLabel"),
      excluded:Object.freeze(list(item.excluded??[],"impact.excluded",L.excluded).map((entry,index)=>{
        const excluded=record(entry,"impact.excluded["+index+"]",["subject","reason"]);
        return Object.freeze({subject:normalizePcmsUiEntityRef(excluded.subject,"impact.excluded.subject"),reason:pcmsUiText(excluded.reason,L.text,"impact.excluded.reason")});
      }))
    });
  }
  if(raw.followUp!==undefined){
    const item=record(raw.followUp,"receipt.followUp",["href","label"]);
    out.followUp=Object.freeze({href:normalizePcmsUiHref(item.href,"followUp.href"),label:pcmsUiText(item.label,L.label,"followUp.label")});
  }
  if(raw.operationRef!==undefined){
    const item=record(raw.operationRef,"receipt.operationRef",["kind","id"]);
    if(item.kind!=="remote-operation"||typeof item.id!=="string"||!ENTITY_ID.test(item.id)) invalid("receipt.operationRef is invalid");
    out.operationRef=Object.freeze({kind:item.kind,id:item.id});
  }
  if(raw.download!==undefined){
    // A READ action may hand the operator a bounded text file (for example a CSV export).
    if(risk!=="READ") invalid("receipt.download is only for READ actions");
    const item=record(raw.download,"receipt.download",["filename","mediaType","text"]);
    if(typeof item.filename!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.filename)) invalid("download.filename is invalid");
    if(!["text/csv","text/plain","application/json"].includes(item.mediaType)) invalid("download.mediaType is invalid");
    if(typeof item.text!=="string"||new TextEncoder().encode(item.text).byteLength>L.downloadBytes) invalid("download.text is invalid");
    out.download=Object.freeze({filename:item.filename,mediaType:item.mediaType,text:item.text});
  }
  return Object.freeze(out);
}

export function normalizePcmsUiActivityLine(value){
  if(value===null) return null;
  const raw=record(value,"activity",["text"],["subject","token"]);
  return Object.freeze({
    text:pcmsUiText(raw.text,L.text,"activity.text"),
    subject:raw.subject===undefined?null:normalizePcmsUiEntityRef(raw.subject,"activity.subject"),
    token:raw.token===undefined?"INFO":oneOf(raw.token,PCMS_UI_STATUS_TOKENS,"activity.token")
  });
}

export function normalizePcmsUiDiagnostics(value){
  return facts(value,"diagnostics",L.diagnostics);
}

// The payload a runtime module pushes with core.ui.publish (03 §4): its descriptor plus the
// state Core serves to dashboards while the module itself is not activated.
export function normalizePcmsUiPublish(value,moduleId){
  let bytes;
  try{bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;}
  catch{invalid("Published UI must be JSON data");}
  if(bytes>L.publishBytes) invalid("Published UI exceeds 64 KiB");
  const raw=record(value,"publish",["descriptor"],["summary","conditions","search","diagnostics"]);
  const descriptor=normalizePcmsUiDescriptor(raw.descriptor,{moduleId,kind:"runtime"});
  return Object.freeze({
    descriptor,
    summary:raw.summary===undefined||raw.summary===null?null:normalizePcmsUiSummary(raw.summary),
    conditions:normalizePcmsUiConditions(raw.conditions??[],moduleId),
    search:normalizePcmsUiPublishedSearch(raw.search??[]),
    diagnostics:normalizePcmsUiDiagnostics(raw.diagnostics??[])
  });
}
