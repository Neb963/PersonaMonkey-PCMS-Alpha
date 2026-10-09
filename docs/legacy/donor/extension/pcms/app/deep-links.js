import { PCMS_UI_ERROR_CODES, pcmsUiError } from "./errors.js";

export const PCMS_UI_ROUTES = Object.freeze(["overview","modules","attention","accounts","search"]);
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const QUERY_MAX = 200;

function fail() { throw pcmsUiError(PCMS_UI_ERROR_CODES.DEEP_LINK_INVALID); }

function boundedId(value) {
  if(typeof value!=="string" || !ENTITY_ID_PATTERN.test(value)) fail();
  return value;
}

export function normalizePcmsSearchQuery(value) {
  if(typeof value!=="string" || value.length>QUERY_MAX || /[\u0000-\u001f\u007f]/.test(value)) {
    throw pcmsUiError(PCMS_UI_ERROR_CODES.INVALID_ARGUMENT);
  }
  return value.trim().normalize("NFKC");
}

export function pcmsRouteHref(route,{id=null,query=""}={}) {
  if(!PCMS_UI_ROUTES.includes(route)) fail();
  if(route==="attention" || route==="accounts") {
    if(id===null) return "#/"+route;
    return "#/"+route+"/"+encodeURIComponent(boundedId(id));
  }
  if(id!==null) fail();
  if(route==="search") {
    const safe=normalizePcmsSearchQuery(query);
    return safe ? "#/search?q="+encodeURIComponent(safe) : "#/search";
  }
  if(query!=="") fail();
  return route==="modules" ? "#/modules" : "#/overview";
}

function decodeSegment(value) {
  let decoded;
  try { decoded=decodeURIComponent(value); } catch { fail(); }
  return boundedId(decoded);
}

function decodeQuery(value) {
  let decoded;
  try { decoded=decodeURIComponent(value); } catch { fail(); }
  return normalizePcmsSearchQuery(decoded);
}

export function parsePcmsDeepLink(rawHash) {
  if(typeof rawHash!=="string" || rawHash.length>1024) fail();
  if(rawHash==="" || rawHash==="#" || rawHash==="#/" || rawHash==="#/overview") {
    return Object.freeze({route:"overview",id:null,query:"",href:"#/overview"});
  }
  if(!rawHash.startsWith("#/") || rawHash.includes("\\")) fail();
  const body=rawHash.slice(2);
  const q=body.indexOf("?");
  const path=q<0?body:body.slice(0,q);
  const queryString=q<0?"":body.slice(q+1);
  const parts=path.split("/");
  if(parts.some((part)=>part.length===0)) fail();
  const route=parts[0];
  if(!PCMS_UI_ROUTES.includes(route)) fail();

  if(route==="overview" || route==="modules") {
    if(parts.length!==1 || queryString!=="") fail();
    return Object.freeze({route,id:null,query:"",href:"#/"+route});
  }

  if(route==="search") {
    if(parts.length!==1) fail();
    if(queryString==="") return Object.freeze({route,id:null,query:"",href:"#/search"});
    if(!queryString.startsWith("q=") || queryString.includes("&")) fail();
    const query=decodeQuery(queryString.slice(2));
    return Object.freeze({route,id:null,query,href:pcmsRouteHref("search",{query})});
  }

  if(queryString!=="" || parts.length>2) fail();
  const id=parts.length===2?decodeSegment(parts[1]):null;
  return Object.freeze({route,id,query:"",href:pcmsRouteHref(route,{id})});
}

export function resolvePcmsDeepLink(rawHash,{accountIds=[],attentionIds=[]}={}) {
  const route=parsePcmsDeepLink(rawHash);
  if(route.id===null) return Object.freeze({valid:true,route});
  const source=route.route==="accounts"?accountIds:attentionIds;
  if(!Array.isArray(source)) fail();
  const exists=source.some((id)=>typeof id==="string" && id===route.id);
  if(!exists) {
    return Object.freeze({
      valid:false,
      reason:"NOT_FOUND",
      route:Object.freeze({route:"overview",id:null,query:"",href:"#/overview"})
    });
  }
  return Object.freeze({valid:true,route});
}
