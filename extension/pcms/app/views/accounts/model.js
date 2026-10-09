// P034 Accounts view model. Pure, bounded, and independent of background authority.
export const ACCOUNT_PAGE_SIZE=25;
const MAX_ACCOUNT_ID=256;
const ACCOUNT_ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const UID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function suggestedAccountId(displayName,existingIds=[]) {
  if(typeof displayName!=="string"||!displayName.trim()) return "";
  const stem=displayName.normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,MAX_ACCOUNT_ID).replace(/-+$/,"")||"account";
  const taken=new Set(existingIds);
  if(!taken.has(stem))return stem;
  for(let suffix=2;suffix<10000;suffix++){
    const ending="-"+suffix;
    const id=stem.slice(0,MAX_ACCOUNT_ID-ending.length).replace(/-+$/,"")+ending;
    if(!taken.has(id))return id;
  }
  throw new Error("No available account key for that name.");
}
export function validateAccountDraft({displayName,accountId,personaUid},accounts,personas){
  if(typeof displayName!=="string"||displayName.length<1||displayName.length>160
      ||displayName.trim()!==displayName||/[\u0000-\u001f\u007f]/.test(displayName))throw new Error("Enter a display name (up to 160 characters).");
  if(typeof accountId!=="string"||!ACCOUNT_ID.test(accountId))throw new Error("Account key is invalid.");
  if(accounts.some(a=>a.accountId===accountId))throw new Error("Account key already exists.");
  if(typeof personaUid!=="string"||!UID.test(personaUid))throw new Error("Choose a managed Persona.");
  if(!personas.some(p=>p.personaUid===personaUid))throw new Error("Selected Persona is unavailable; refresh the list.");
  if(accounts.some(a=>a.personaUid===personaUid))throw new Error("Selected Persona is already bound.");
  return Object.freeze({displayName,accountId,personaUid});
}
export function visibleAccountPage(accounts,{search="",filter="",sort="name",direction="asc",page=1,routeByUid=new Map()}={}){
  const needle=String(search).normalize("NFKC").toLocaleLowerCase("en-US").trim();
  const terms=typeof filter==="string"?filter.split(",").filter(Boolean):[];
  const filtered=accounts.filter(a=>{
    const route=routeByUid.get(a.personaUid)||{};
    if(needle&&!([a.displayName,a.accountId,a.providerId,route.personaName]
      .some(v=>String(v||"").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle))))return false;
    return terms.every(entry=>{
      const i=entry.indexOf(":");const key=entry.slice(0,i),val=entry.slice(i+1);
      if(key==="persona")return a.personaUid===val;
      if(key==="provider")return a.providerId===val;
      if(key==="status")return (route.status||"unknown")===val;
      return false;
    });
  });
  const get=a=>sort==="id"?a.accountId:sort==="persona"?routeByUid.get(a.personaUid)?.personaName||"":sort==="provider"?a.providerId:a.displayName;
  filtered.sort((a,b)=>{
    const result=String(get(a)).localeCompare(String(get(b)),"en",{sensitivity:"base",numeric:true})||a.accountId.localeCompare(b.accountId);
    return direction==="desc"?-result:result;
  });
  const pages=Math.max(1,Math.ceil(filtered.length/ACCOUNT_PAGE_SIZE));
  const current=Math.max(1,Math.min(Number.isSafeInteger(page)?page:1,pages));
  return Object.freeze({items:Object.freeze(filtered.slice((current-1)*ACCOUNT_PAGE_SIZE,current*ACCOUNT_PAGE_SIZE)),
    total:filtered.length,page:current,pages,start:filtered.length?(current-1)*ACCOUNT_PAGE_SIZE+1:0,
    end:Math.min(current*ACCOUNT_PAGE_SIZE,filtered.length)});
}
export function summarizePersona(raw){
  if(!raw||typeof raw!=="object"||!UID.test(raw.personaUid||""))return null;
  const health=raw.health&&typeof raw.health==="object"?raw.health:null;
  const status=typeof health?.status==="string"?health.status.toLowerCase():"unknown";
  const checkedAt=typeof health?.checkedAt==="string"&&!Number.isNaN(Date.parse(health.checkedAt))?health.checkedAt:null;
  const name=typeof raw.name==="string"&&raw.name.trim()?raw.name.trim().slice(0,160):"Managed Persona";
  const detail=status==="direct"?"Direct · no routing protection"
    : status==="blocked"?"Blocked by route policy"
    : typeof health?.routeName==="string"&&health.routeName.trim()?health.routeName.trim().slice(0,96)
    : typeof health?.reason==="string"&&health.reason.trim()?health.reason.trim().slice(0,96):"Not checked";
  return Object.freeze({personaUid:raw.personaUid.toLowerCase(),personaName:name,status,route:detail,asOf:checkedAt});
}
export function unresolvedRebindReason(rows,accountId) {
  if(!Array.isArray(rows))return "Operation status is unavailable; rebind is disabled.";
  // UI cannot read the background's durable operation-to-account context.
  // Ambiguous operations must not be treated as safe for this account.
  if(rows.length) return rows.length+" unresolved operation(s) exist. Reconcile them before changing Persona bindings.";
  return null;
}
