import { PCMS_UI_ERROR_CODES, pcmsUiError } from "./errors.js";

export const PCMS_V2_SETTINGS_SECTIONS=Object.freeze(["modules","backup","diagnostics","connections","about"]);
export const PCMS_V2_BUILTIN_MODULE_IDS=Object.freeze(["deployer","refresher","explorer","statistics","provisioning"]);

const ENTITY=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
// Built-in ids and runtime module package ids (pcms.module.archive/v1, e.g. "acme.reports").
const MODULE=/^(?=.{1,96}$)[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const FILTER_VALUE=/^[A-Za-z0-9._@/-]{1,96}$/;
const MAX_HASH=1024;
const MAX_QUERY=200;
const MAX_FILTER=240;
const FILTER_KEYS=Object.freeze({
  accounts:new Set(["status","persona","provider"]),
  generators:new Set(["status","account"]),
  activity:new Set(["kind","status","account","module"])
});

function invalid(message="Invalid PCMS route"){
  throw pcmsUiError(PCMS_UI_ERROR_CODES.DEEP_LINK_INVALID,message);
}

function decode(value){
  try{return decodeURIComponent(value);}
  catch{invalid();}
}

function entity(value){
  const decoded=decode(value);
  if(!ENTITY.test(decoded)) invalid();
  return decoded;
}

function moduleId(value){
  const decoded=decode(value);
  if(!MODULE.test(decoded)) invalid();
  return decoded;
}

export function normalizePcmsV2Search(value){
  if(typeof value!=="string"||value.length>MAX_QUERY||/[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value.trim().normalize("NFKC");
}

export function normalizePcmsV2Filter(route,value){
  if(typeof value!=="string"||value.length>MAX_FILTER||/[\u0000-\u001f\u007f]/.test(value)) invalid();
  const text=value.trim().normalize("NFKC");
  if(!text) return "";
  const allowed=FILTER_KEYS[route];
  if(!allowed) invalid();
  const seen=new Set();
  const normalized=[];
  for(const rawPart of text.split(",")){
    const split=rawPart.indexOf(":");
    if(split<1||split===rawPart.length-1) invalid();
    const key=rawPart.slice(0,split).trim();
    const val=rawPart.slice(split+1).trim();
    if(!allowed.has(key)||seen.has(key)||!FILTER_VALUE.test(val)) invalid();
    seen.add(key);
    normalized.push(key+":"+val);
  }
  return normalized.join(",");
}

function query(raw,allowed){
  if(!raw) return Object.freeze({});
  const out={};
  for(const pair of raw.split("&")){
    const split=pair.indexOf("=");
    if(split<1) invalid();
    const key=decode(pair.slice(0,split));
    const value=decode(pair.slice(split+1));
    if(!allowed.includes(key)||Object.hasOwn(out,key)) invalid();
    out[key]=value;
  }
  return Object.freeze(out);
}

function qs(entries){
  return entries.filter(([,value])=>value!==null&&value!==undefined&&value!=="")
    .map(([key,value])=>encodeURIComponent(key)+"="+encodeURIComponent(String(value))).join("&");
}

function baseRoute(route,extra={}){
  return Object.freeze({
    route,id:null,query:"",filter:"",page:null,section:null,moduleId:null,view:null,objectId:null,
    legacy:false,...extra
  });
}

export function pcmsV2Href(route,options={}){
  if(route==="overview") return "#/overview";
  if(route==="attention"){
    return options.id==null?"#/attention":"#/attention/"+encodeURIComponent(String(options.id));
  }
  if(route==="accounts"){
    const path=options.id==null?"#/accounts":"#/accounts/"+encodeURIComponent(String(options.id));
    const filter=normalizePcmsV2Filter("accounts",String(options.filter||""));
    return path+(filter?"?"+qs([["f",filter]]):"");
  }
  if(route==="generators"){
    // P036 generator detail: #/generators/perchance/<slug> (02 §2.3).
    if(options.id!=null){
      if(!ENTITY.test(String(options.id))||options.filter||options.page!=null) invalid();
      return "#/generators/perchance/"+encodeURIComponent(String(options.id));
    }
    const filter=normalizePcmsV2Filter("generators",String(options.filter||""));
    let page=null;
    if(options.page!==null&&options.page!==undefined&&options.page!==""){
      page=Number(options.page);
      if(!Number.isSafeInteger(page)||page<1||page>10000) invalid();
    }
    const suffix=qs([["f",filter],["p",page]]);
    return "#/generators"+(suffix?"?"+suffix:"");
  }
  if(route==="module"){
    if(!MODULE.test(String(options.moduleId||""))) invalid();
    let href="#/m/"+encodeURIComponent(options.moduleId);
    if(options.view!=null){
      if(!ENTITY.test(String(options.view))) invalid();
      href+="/"+encodeURIComponent(options.view);
    }
    if(options.objectId!=null){
      if(options.view==null||!ENTITY.test(String(options.objectId))) invalid();
      href+="/"+encodeURIComponent(options.objectId);
    }
    return href;
  }
  if(route==="activity"){
    const filter=normalizePcmsV2Filter("activity",String(options.filter||""));
    return "#/activity"+(filter?"?"+qs([["f",filter]]):"");
  }
  if(route==="settings"){
    if(!PCMS_V2_SETTINGS_SECTIONS.includes(options.section)) invalid();
    return "#/settings/"+encodeURIComponent(options.section);
  }
  if(route==="search"){
    const text=normalizePcmsV2Search(String(options.query||""));
    return text?"#/search?q="+encodeURIComponent(text):"#/search";
  }
  invalid();
}

export function parsePcmsRouteV2(rawHash){
  if(typeof rawHash!=="string"||rawHash.length>MAX_HASH) invalid();
  if(rawHash===""||rawHash==="#"||rawHash==="#/"){
    return baseRoute("overview",{href:"#/overview",legacy:true});
  }
  if(!rawHash.startsWith("#/")||rawHash.includes("\\")) invalid();

  const body=rawHash.slice(2);
  const q=body.indexOf("?");
  const path=q<0?body:body.slice(0,q);
  const rawQuery=q<0?"":body.slice(q+1);
  const parts=path.split("/");
  if(parts.some((part)=>part==="")) invalid();

  if(parts[0]==="modules"){
    if(parts.length!==1||rawQuery) invalid();
    return baseRoute("settings",{section:"modules",href:"#/settings/modules",legacy:true});
  }
  if(parts[0]==="overview"){
    if(parts.length!==1||rawQuery) invalid();
    return baseRoute("overview",{href:"#/overview"});
  }
  if(parts[0]==="attention"){
    if(parts.length>2||rawQuery) invalid();
    const id=parts.length===2?entity(parts[1]):null;
    return baseRoute("attention",{id,href:pcmsV2Href("attention",{id})});
  }
  if(parts[0]==="accounts"){
    if(parts.length>2) invalid();
    const params=query(rawQuery,["f"]);
    const id=parts.length===2?entity(parts[1]):null;
    const filter=normalizePcmsV2Filter("accounts",params.f||"");
    return baseRoute("accounts",{id,filter,href:pcmsV2Href("accounts",{id,filter})});
  }
  if(parts[0]==="generators"){
    if(parts.length===3&&parts[1]==="perchance"){
      if(rawQuery) invalid();
      const id=entity(parts[2]);
      return baseRoute("generators",{id,href:pcmsV2Href("generators",{id})});
    }
    if(parts.length!==1) invalid();
    const params=query(rawQuery,["f","p"]);
    const filter=normalizePcmsV2Filter("generators",params.f||"");
    const page=params.p===undefined?null:Number(params.p);
    const href=pcmsV2Href("generators",{filter,page});
    return baseRoute("generators",{filter,page,href});
  }
  if(parts[0]==="m"){
    if(parts.length<2||parts.length>4||rawQuery) invalid();
    const id=moduleId(parts[1]);
    const view=parts.length>=3?entity(parts[2]):null;
    const objectId=parts.length===4?entity(parts[3]):null;
    return baseRoute("module",{moduleId:id,view,objectId,href:pcmsV2Href("module",{moduleId:id,view,objectId})});
  }
  if(parts[0]==="activity"){
    if(parts.length!==1) invalid();
    const params=query(rawQuery,["f"]);
    const filter=normalizePcmsV2Filter("activity",params.f||"");
    return baseRoute("activity",{filter,href:pcmsV2Href("activity",{filter})});
  }
  if(parts[0]==="settings"){
    if(parts.length!==2||rawQuery) invalid();
    const section=entity(parts[1]);
    if(!PCMS_V2_SETTINGS_SECTIONS.includes(section)) invalid();
    return baseRoute("settings",{section,href:pcmsV2Href("settings",{section})});
  }
  if(parts[0]==="search"){
    if(parts.length!==1) invalid();
    const params=query(rawQuery,["q"]);
    const search=normalizePcmsV2Search(params.q||"");
    return baseRoute("search",{query:search,href:pcmsV2Href("search",{query:search})});
  }
  invalid();
}

export function resolvePcmsRouteV2(rawHash,{
  accountIds=[],
  attentionIds=[],
  moduleIds=PCMS_V2_BUILTIN_MODULE_IDS
}={}){
  let route;
  try{route=parsePcmsRouteV2(rawHash);}
  catch{
    return Object.freeze({
      valid:false,reason:"INVALID",
      route:parsePcmsRouteV2("#/overview"),
      canonicalized:true
    });
  }
  let source=null;
  let selected=null;
  if(route.route==="accounts"&&route.id!==null){source=accountIds;selected=route.id;}
  if(route.route==="attention"&&route.id!==null){source=attentionIds;selected=route.id;}
  if(route.route==="module"){source=moduleIds;selected=route.moduleId;}
  if(source!==null){
    if(!Array.isArray(source)) invalid();
    if(!source.some((value)=>typeof value==="string"&&value===selected)){
      return Object.freeze({
        valid:false,reason:"NOT_FOUND",
        route:parsePcmsRouteV2("#/overview"),
        canonicalized:true
      });
    }
  }
  return Object.freeze({valid:true,reason:null,route,canonicalized:route.legacy===true||route.href!==rawHash});
}
