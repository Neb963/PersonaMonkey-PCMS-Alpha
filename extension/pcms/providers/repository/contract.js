// pcms.repository-provider/v1 — no GitHub response shapes cross this boundary.
export const REPOSITORY_PROVIDER_CONTRACT="pcms.repository-provider/v1";
export const REPO_ERRORS=Object.freeze({
  UNAVAILABLE:"REPO_UNAVAILABLE", RATE_LIMITED:"REPO_RATE_LIMITED",
  AUTH_FAILED:"REPO_AUTH_FAILED", NOT_FOUND:"REPO_NOT_FOUND",
  TOO_LARGE:"REPO_TOO_LARGE", PROTOCOL:"REPO_PROTOCOL",
  TREE_TRUNCATED:"REPO_TREE_TRUNCATED", FORMAT_INVALID:"REPO_FORMAT_INVALID"
});
const NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const ROOT=/^[A-Za-z0-9._@/-]{1,256}$/;
const SHA=/^[a-f0-9]{40}$/;
const PATH=/^[A-Za-z0-9._@+/-]{1,512}$/;
export const REPOSITORY_MAX_TREE_ENTRIES=20000;
export const REPOSITORY_MAX_ITEMS=4096;
export const REPOSITORY_MAX_BLOB_BYTES=4*1024*1024+1024;
export class RepositoryProviderError extends Error {
  constructor(code,resetAt=null){
    super(code); this.name="RepositoryProviderError"; this.code=code;
    if(resetAt!==null)this.resetAt=resetAt;
  }
}
export function repositoryFailure(code,resetAt=null){return new RepositoryProviderError(code,resetAt);}
function record(value,keys,optional=[]){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getOwnPropertySymbols(value).length)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const desc=Object.getOwnPropertyDescriptors(value);
  for(const [k,v] of Object.entries(desc)){
    if(!v.enumerable||!Object.hasOwn(v,"value")||(!keys.includes(k)&&!optional.includes(k)))
      throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  }
  for(const k of keys)if(!Object.hasOwn(desc,k))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  return value;
}
function safePath(path){
  return typeof path==="string"&&PATH.test(path)&&path.split("/").every(s=>s&&s!=="."&&s!=="..");
}
export function normalizeRepositoryConfig(raw){
  const v=record(raw,["provider","owner","repo","ref","access"],["root","network"]);
  if(v.provider!=="github"||!NAME.test(v.owner)||!NAME.test(v.repo)||!REF.test(v.ref)||v.ref.split("/").some(s=>!s||s==="."||s===".."))
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const root=v.root??"";
  if(root!==""&&(!ROOT.test(root)||root.split("/").some(s=>!s||s==="."||s==="..")))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  if((v.network??"default")!=="default")throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const access=record(v.access,["kind"],["secretRef"]);
  if(access.kind!=="public"&&access.kind!=="token")throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  if(access.kind==="public"&&Object.hasOwn(access,"secretRef"))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  if(access.kind==="token"&&(typeof access.secretRef!=="string"||!/^pcms-secret:v1:[0-9a-fA-F-]{36}$/.test(access.secretRef)))
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  return Object.freeze({provider:"github",owner:v.owner,repo:v.repo,ref:v.ref,root,access:Object.freeze({...access}),network:"default"});
}
export function normalizeRepoCommitId(value){
  if(typeof value!=="string"||!SHA.test(value))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  return value;
}
export function normalizeRepoTree(tree){
  record(tree,["complete","entries"]);
  if(typeof tree.complete!=="boolean"||!Array.isArray(tree.entries))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  if(!tree.complete)throw repositoryFailure(REPO_ERRORS.TREE_TRUNCATED);
  if(tree.entries.length>REPOSITORY_MAX_TREE_ENTRIES)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
  const seen=new Set();
  const entries=tree.entries.map(entry=>{
    record(entry,["path","type","size","blobId"]);
    if(!safePath(entry.path)||!["file","dir"].includes(entry.type)||!Number.isSafeInteger(entry.size)||entry.size<0
       ||(entry.type==="file"&&!SHA.test(entry.blobId))||(entry.type==="dir"&&entry.blobId!==null)
       ||seen.has(entry.path))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    seen.add(entry.path);
    return Object.freeze({path:entry.path,type:entry.type,size:entry.size,blobId:entry.blobId});
  });
  entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return Object.freeze({complete:true,entries:Object.freeze(entries)});
}
export function repositoryPath(config,path){
  if(!safePath(path))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const c=normalizeRepositoryConfig(config);
  return c.root?c.root+"/"+path:path;
}
export function assertBlobInput(path,blobId,maxBytes){
  if(!safePath(path)||!SHA.test(blobId)||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>REPOSITORY_MAX_BLOB_BYTES)
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
}
