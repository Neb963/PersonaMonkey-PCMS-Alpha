import {
 REPO_ERRORS,REPOSITORY_MAX_TREE_ENTRIES,assertBlobInput,normalizeRepoCommitId,
 normalizeRepoTree,normalizeRepositoryConfig,repositoryFailure,repositoryPath
} from "./contract.js";

const API="https://api.github.com";
const MAX_JSON_BYTES=12*1024*1024;
const DEFAULT_TIMEOUT_MS=8000;
function errorFromStatus(status,headers){
  const remaining=headers.get("x-ratelimit-remaining");
  const retryHeader=headers.get("retry-after");
  if(status===401)return repositoryFailure(REPO_ERRORS.AUTH_FAILED);
  if(status===404)return repositoryFailure(REPO_ERRORS.NOT_FOUND);
  if(status===429||status===403&&(remaining==="0"||retryHeader!==null)){
    const retry=retryHeader===null?NaN:Number(retryHeader);
    const resetHeader=headers.get("x-ratelimit-reset");
    const reset=resetHeader===null?NaN:Number(resetHeader);
    const resetAt=Number.isFinite(reset)&&reset>0?new Date(reset*1000).toISOString()
      :Number.isFinite(retry)&&retry>=0?new Date(Date.now()+retry*1000).toISOString():null;
    return repositoryFailure(REPO_ERRORS.RATE_LIMITED,resetAt);
  }
  if(status===403)return repositoryFailure(REPO_ERRORS.AUTH_FAILED);
  return repositoryFailure(status>=500?REPO_ERRORS.UNAVAILABLE:REPO_ERRORS.PROTOCOL);
}
async function boundedJson(response,maxBytes,controller){
  const contentLength=response.headers.get("content-length");
  if(contentLength!==null){
    const n=Number(contentLength);
    if(!Number.isSafeInteger(n)||n<0)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    if(n>maxBytes)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
  }
  let raw;
  if(typeof response.body?.getReader==="function"){
    const reader=response.body.getReader(),chunks=[];
    let total=0;
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        if(!(value instanceof Uint8Array))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
        total+=value.byteLength;
        if(total>maxBytes){controller.abort();throw repositoryFailure(REPO_ERRORS.TOO_LARGE);}
        chunks.push(value);
      }
    }finally{try{reader.releaseLock?.();}catch{}}
    const combined=new Uint8Array(total);
    let offset=0;
    for(const part of chunks){combined.set(part,offset);offset+=part.length;}
    try{raw=new TextDecoder("utf-8",{fatal:true}).decode(combined);}
    catch{throw repositoryFailure(REPO_ERRORS.PROTOCOL);}
  }else{
    // Deterministic fetch doubles may implement text() only. A native Fetch
    // response has a stream, so production never buffers an unbounded body.
    if(typeof response.text!=="function")throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    raw=await response.text();
    if(typeof raw!=="string")throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    if(new TextEncoder().encode(raw).byteLength>maxBytes)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
  }
  try{return JSON.parse(raw);}catch{throw repositoryFailure(REPO_ERRORS.PROTOCOL);}
}
function decode64(base64,maxBytes){
  if(typeof base64!=="string"||base64.length>Math.ceil(maxBytes/3)*4+16||!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(base64))
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const cleaned=base64.replace(/[\r\n]/g,"");
  let binary;
  try{binary=atob(cleaned);}catch{throw repositoryFailure(REPO_ERRORS.PROTOCOL);}
  if(binary.length>maxBytes)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
  return Uint8Array.from(binary,ch=>ch.charCodeAt(0));
}
export function createGithubRepositoryProvider({
  fetchImpl=globalThis.fetch,secretResolver=null,
  timeoutMs=DEFAULT_TIMEOUT_MS,maxResponseBytes=MAX_JSON_BYTES
}={}){
  if(typeof fetchImpl!=="function")throw new TypeError("A background fetch implementation is required");
  if(secretResolver!==null&&typeof secretResolver!=="function")throw new TypeError("Secret resolver must be a function");
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>DEFAULT_TIMEOUT_MS
    ||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>MAX_JSON_BYTES)
    throw new TypeError("GitHub response bounds cannot be increased");

  async function get(config,path){
    const c=normalizeRepositoryConfig(config);
    let token=null;
    if(c.access.kind==="token"){
      if(!secretResolver)throw repositoryFailure(REPO_ERRORS.AUTH_FAILED);
      try{token=await secretResolver(c.access.secretRef);}catch{throw repositoryFailure(REPO_ERRORS.AUTH_FAILED);}
      if(typeof token!=="string"||!token||/[\r\n]/.test(token))throw repositoryFailure(REPO_ERRORS.AUTH_FAILED);
    }
    const headers={"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
    if(token!==null)headers.Authorization="Bearer "+token;
    const controller=new AbortController();
    let timeoutId=null;
    const timeout=new Promise((_,reject)=>{
      timeoutId=setTimeout(()=>{
        controller.abort();
        reject(repositoryFailure(REPO_ERRORS.UNAVAILABLE));
      },timeoutMs);
    });
    const request=(async()=>{
      let response;
      try{
        response=await fetchImpl(API+"/repos/"+encodeURIComponent(c.owner)+"/"+encodeURIComponent(c.repo)+"/"+path,{
          method:"GET",headers,redirect:"error",signal:controller.signal,credentials:"omit",cache:"no-store"
        });
      }catch{throw repositoryFailure(REPO_ERRORS.UNAVAILABLE);}
      if(!response||typeof response.status!=="number"||!response.headers||typeof response.headers.get!=="function")
        throw repositoryFailure(REPO_ERRORS.PROTOCOL);
      if(!response.ok)throw errorFromStatus(response.status,response.headers);
      try{return await boundedJson(response,maxResponseBytes,controller);}
      catch(error){if(error?.code)throw error;throw repositoryFailure(REPO_ERRORS.UNAVAILABLE);}
    })();
    try{return await Promise.race([request,timeout]);}
    finally{clearTimeout(timeoutId);}
  }
  const describe=config=>{
    const c=normalizeRepositoryConfig(config);
    return Object.freeze({kind:"github",label:"github · "+c.owner+"/"+c.repo+"@"+c.ref,
      webUrl:(path,commitId)=>"https://github.com/"+encodeURIComponent(c.owner)+"/"+encodeURIComponent(c.repo)+"/blob/"+normalizeRepoCommitId(commitId)+"/"+repositoryPath(c,path).split("/").map(encodeURIComponent).join("/")});
  };
  async function resolveRef(config){
    const c=normalizeRepositoryConfig(config);
    const raw=await get(c,"commits/"+c.ref.split("/").map(encodeURIComponent).join("%2F"));
    const commitId=normalizeRepoCommitId(raw?.sha);
    const at=raw?.commit?.committer?.date;
    if(typeof at!=="string"||!Number.isFinite(Date.parse(at)))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    return Object.freeze({commitId,committedAt:new Date(at).toISOString(),message:String(raw?.commit?.message??"").slice(0,200)});
  }
  async function listTree(config,commitId){
    const sha=normalizeRepoCommitId(commitId);
    const raw=await get(config,"git/trees/"+sha+"?recursive=1");
    if(raw?.truncated===true)throw repositoryFailure(REPO_ERRORS.TREE_TRUNCATED);
    if(raw?.truncated!==false||!Array.isArray(raw.tree)||raw.tree.length>REPOSITORY_MAX_TREE_ENTRIES)
      throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    return normalizeRepoTree({complete:true,entries:raw.tree.map(item=>({
      path:item.path,type:item.type==="blob"?"file":item.type==="tree"?"dir":"invalid",
      size:item.type==="blob"?item.size:0,blobId:item.type==="blob"?item.sha:null
    }))});
  }
  async function readBlob(config,commitId,path,blobId,{maxBytes}={}){
    normalizeRepoCommitId(commitId);
    assertBlobInput(path,blobId,maxBytes);
    const raw=await get(config,"git/blobs/"+blobId);
    if(raw?.encoding!=="base64"||!Number.isSafeInteger(raw.size)||raw.size<0)
      throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    if(raw.size>maxBytes)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
    const bytes=decode64(raw.content,maxBytes);
    if(bytes.length!==raw.size)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    return bytes;
  }
  return Object.freeze({describe,resolveRef,listTree,readBlob});
}
