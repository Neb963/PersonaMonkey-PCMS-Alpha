// pcms.generator-repository/v1: commit-pinned, content-addressed, no file bytes in snapshots.
import {generatorPayloadHash,thumbnailHash,PERCHANCE_MAX_SOURCE_BYTES,PERCHANCE_MAX_THUMBNAIL_BYTES}
  from "../../extension/pcms/providers/perchance/contract.js";
import {REPO_ERRORS,REPOSITORY_MAX_ITEMS,normalizeRepositoryConfig,normalizeRepoCommitId,
  normalizeRepoTree,repositoryFailure} from "../../extension/pcms/providers/repository/contract.js";

export const GENERATOR_REPOSITORY_CONTRACT="pcms.generator-repository/v1";
export const GENERATOR_MANIFEST_FORMAT="pcms.generator/v1";
export const GENERATOR_MARKER_FORMAT="pcms.generator-repository/v1";
export const GENERATOR_REPOSITORY_VALIDATOR_VERSION=1;
export const GENERATOR_REPO_PROBLEM_CODES=Object.freeze({
  MANIFEST:"GEN_MANIFEST_INVALID",SLUG:"GEN_SLUG_MISMATCH",DUPLICATE:"GEN_DUPLICATE_SLUG",
  ACCOUNT:"GEN_ACCOUNT_UNLINKED",ACCOUNT_CHANGED:"GEN_ACCOUNT_CHANGED",
  RELEASE:"GEN_RELEASE_MISSING",FILE:"GEN_FILE_MISSING",TEXT:"GEN_TEXT_INVALID",
  SIZE:"GEN_TOO_LARGE",THUMBNAIL:"GEN_THUMBNAIL_INVALID",CHANGELOG:"GEN_CHANGELOG_INVALID",
  MODIFIED:"GEN_RELEASE_MODIFIED",MANUAL:"GEN_MANAGED_MANUALLY"
});
const SLUG=/^[a-z0-9][a-z0-9_-]{0,99}$/;
const FOLDER=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const VERSION=/^[0-9A-Za-z.+-]{1,64}$/;
const HASH=/^[0-9a-f]{64}$/;
const MARKER="pcms-generators.json";
const encoder=new TextEncoder();
const decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});
const MAX_MANIFEST=16*1024,MAX_CHANGELOG=256*1024,MAX_MARKER=1024;
// Perchance's v2 thumbnail contract accepts base64, while repository files are bytes.
// Chunking prevents argument-stack overflow for images up to 1 MiB.
function encodeThumbnail(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length>PERCHANCE_MAX_THUMBNAIL_BYTES)
    throw issue(GENERATOR_REPO_PROBLEM_CODES.THUMBNAIL);
  const blocks=[];
  for(let i=0;i<bytes.length;i+=8192)blocks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
  return btoa(blocks.join(""));
}
const MAX_LEDGER_VERSIONS=20;
function issue(code,detail=null){return Object.freeze({code,...(detail===null?{}:{detail:String(detail).slice(0,160)})});}
function exact(value,required,optional=[]){
  if(value===null||typeof value!=="object"||Array.isArray(value)||Object.getOwnPropertySymbols(value).length)return false;
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null)return false;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  return required.every(k=>Object.hasOwn(descriptors,k))&&Object.entries(descriptors).every(([k,d])=>
    (required.includes(k)||optional.includes(k))&&d.enumerable&&Object.hasOwn(d,"value"));
}
function decode(bytes,max,code){
  if(!(bytes instanceof Uint8Array)||bytes.length>max)throw issue(code);
  let text;
  try{text=decoder.decode(bytes);}catch{throw issue(code);}
  if(text.includes("\u0000")||encoder.encode(text).length!==bytes.length)throw issue(code);
  return text;
}
function parseJson(bytes,max,code){
  const text=decode(bytes,max,code);
  try{return JSON.parse(text);}catch{throw issue(code);}
}
export function normalizeGeneratorManifest(raw,folderSlug,defaultListing="UNLISTED"){
  if(!exact(raw,["format","slug","release"],["title","listing","deploy"])||
    raw.format!==GENERATOR_MANIFEST_FORMAT||!SLUG.test(raw.slug)||!SLUG.test(folderSlug))
    throw issue(GENERATOR_REPO_PROBLEM_CODES.MANIFEST);
  if(raw.slug!==folderSlug)throw issue(GENERATOR_REPO_PROBLEM_CODES.SLUG);
  if(!VERSION.test(raw.release)||(raw.title!==undefined&&(typeof raw.title!=="string"||raw.title.length>120||/[\u0000-\u001f]/.test(raw.title))))
    throw issue(GENERATOR_REPO_PROBLEM_CODES.MANIFEST);
  const listing=raw.listing??defaultListing;
  if(!["PUBLICLY_LISTED","UNLISTED"].includes(listing)||!["auto","manual","hold"].includes(raw.deploy??"auto"))
    throw issue(GENERATOR_REPO_PROBLEM_CODES.MANIFEST);
  return Object.freeze({slug:raw.slug,title:raw.title??raw.slug,version:raw.release,listing,deploy:raw.deploy??"auto"});
}
function join(root,path){return root?root+"/"+path:path;}
function fileAt(index,path){
  const entry=index.get(path);
  if(!entry||entry.type!=="file")return null;
  return entry;
}
async function blob(provider,config,commitId,path,index,maxBytes,missingCode){
  const meta=fileAt(index,path);
  if(!meta)throw issue(missingCode);
  if(meta.size>maxBytes)throw issue(GENERATOR_REPO_PROBLEM_CODES.SIZE);
  try{
    const bytes=await provider.readBlob(config,commitId,path,meta.blobId,{maxBytes});
    if(!(bytes instanceof Uint8Array)||bytes.byteLength!==meta.size)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    return bytes;
  }catch(e){
    // Transport failures invalidate the whole scan; malformed per-generator bytes do not.
    if(e?.code&&String(e.code).startsWith("REPO_"))throw e;
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  }
}
function normalizeLedger(raw){
  if(raw===null||raw===undefined)return {};
  if(!exact(raw,[],Object.keys(raw)))throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const out=Object.create(null);
  for(const [slug,versions] of Object.entries(raw)){
    if(!SLUG.test(slug)||!Array.isArray(versions)||versions.length>MAX_LEDGER_VERSIONS)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    out[slug]=versions.map(v=>{
      if(!exact(v,["version","payloadHash","thumbnailHash","firstSeenCommit","firstSeenAt"])
        ||!VERSION.test(v.version)||!HASH.test(v.payloadHash)
        ||v.thumbnailHash!==null&&!HASH.test(v.thumbnailHash)||!Number.isFinite(Date.parse(v.firstSeenAt))
        ||typeof v.firstSeenCommit!=="string"||!/^[a-f0-9]{40}$/.test(v.firstSeenCommit))
        throw repositoryFailure(REPO_ERRORS.PROTOCOL);
      return {...v};
    });
  }
  return out;
}
function stableItem({folder,manifest,path,payloadHash,thumbnailHash:thumb}){
  return Object.freeze({slug:manifest.slug,accountFolder:folder,title:manifest.title,version:manifest.version,
    deploy:manifest.deploy,listing:manifest.listing,payloadHash,thumbnailHash:thumb,
    origin:Object.freeze({kind:"REPOSITORY",path,version:manifest.version})});
}
function stableProblem(folder,slug,path,fault){
  return Object.freeze({accountFolder:folder,slug,path,code:fault.code||GENERATOR_REPO_PROBLEM_CODES.MANIFEST,
    detail:fault.detail??null});
}

// Can resume from a persisted item cursor: partial results are never published as a snapshot.
export async function validateRepositorySlice({
  provider,config,commitId,tree,ledger={},defaultListing="UNLISTED",firstSeenAt="2026-01-01T00:00:00.000Z",
  cursor=0,batchSize=16,items=[],problems=[]
}={}){
  const c=normalizeRepositoryConfig(config),sha=normalizeRepoCommitId(commitId);
  const index=new Map(normalizeRepoTree(tree).entries.map(e=>[e.path,e]));
  if(!["PUBLICLY_LISTED","UNLISTED"].includes(defaultListing)||!Number.isSafeInteger(cursor)||cursor<0
     ||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>64)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const pref=c.root?c.root+"/":"";
  const marker=index.get(pref+MARKER);
  if(!marker||marker.type!=="file"||marker.size>MAX_MARKER)throw repositoryFailure(REPO_ERRORS.FORMAT_INVALID);
  const content=await blob(provider,c,sha,pref+MARKER,index,MAX_MARKER,REPO_ERRORS.FORMAT_INVALID);
  let markerJson;
  try{markerJson=parseJson(content,MAX_MARKER,REPO_ERRORS.FORMAT_INVALID);}
  catch{throw repositoryFailure(REPO_ERRORS.FORMAT_INVALID);}
  if(!exact(markerJson,["format"])||markerJson.format!==GENERATOR_MARKER_FORMAT)
    throw repositoryFailure(REPO_ERRORS.FORMAT_INVALID);
  const manifests=[...index.keys()].filter(path=>path.startsWith(pref)&&path.slice(pref.length).split("/").length===3
    &&path.endsWith("/generator.json")&&fileAt(index,path)).sort();
  if(manifests.length>REPOSITORY_MAX_ITEMS)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
  if(cursor>manifests.length)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const ledgerNext=normalizeLedger(ledger);
  const chunkItems=[...items],chunkProblems=[...problems];
  const end=Math.min(manifests.length,cursor+batchSize);
  for(let i=cursor;i<end;i++){
    const path=manifests[i],parts=path.slice(pref.length).split("/"),[folder,slug]=parts;
    try{
      if(!FOLDER.test(folder)||!SLUG.test(slug))throw issue(GENERATOR_REPO_PROBLEM_CODES.MANIFEST);
      const m=parseJson(await blob(provider,c,sha,path,index,MAX_MANIFEST,GENERATOR_REPO_PROBLEM_CODES.MANIFEST),
        MAX_MANIFEST,GENERATOR_REPO_PROBLEM_CODES.MANIFEST);
      const manifest=normalizeGeneratorManifest(m,slug,defaultListing);
      const releasePath=folder+"/"+slug+"/releases/"+manifest.version;
      const codePath=join(c.root,releasePath+"/code.perchance"),htmlPath=join(c.root,releasePath+"/page.html");
      if(!fileAt(index,codePath)||!fileAt(index,htmlPath))throw issue(GENERATOR_REPO_PROBLEM_CODES.FILE);
      const codeMeta=index.get(codePath),htmlMeta=index.get(htmlPath);
      if(codeMeta.size+htmlMeta.size>PERCHANCE_MAX_SOURCE_BYTES)throw issue(GENERATOR_REPO_PROBLEM_CODES.SIZE);
      const code=decode(await blob(provider,c,sha,codePath,index,PERCHANCE_MAX_SOURCE_BYTES,GENERATOR_REPO_PROBLEM_CODES.FILE),
        PERCHANCE_MAX_SOURCE_BYTES,GENERATOR_REPO_PROBLEM_CODES.TEXT);
      const html=decode(await blob(provider,c,sha,htmlPath,index,PERCHANCE_MAX_SOURCE_BYTES,GENERATOR_REPO_PROBLEM_CODES.FILE),
        PERCHANCE_MAX_SOURCE_BYTES,GENERATOR_REPO_PROBLEM_CODES.TEXT);
      const payloadHash=await generatorPayloadHash(code,html);
      const thumbPath=join(c.root,releasePath+"/thumbnail.jpeg");
      let thumb=null;
      if(fileAt(index,thumbPath)){
        const raw=await blob(provider,c,sha,thumbPath,index,PERCHANCE_MAX_THUMBNAIL_BYTES,GENERATOR_REPO_PROBLEM_CODES.THUMBNAIL);
        if(raw.length<4||raw[0]!==255||raw[1]!==216||raw[2]!==255)throw issue(GENERATOR_REPO_PROBLEM_CODES.THUMBNAIL);
        thumb=await thumbnailHash(encodeThumbnail(raw));
      }
      const changelogPath=join(c.root,releasePath+"/changelog.md");
      if(fileAt(index,changelogPath)){
        try{decode(await blob(provider,c,sha,changelogPath,index,MAX_CHANGELOG,GENERATOR_REPO_PROBLEM_CODES.CHANGELOG),
          MAX_CHANGELOG,GENERATOR_REPO_PROBLEM_CODES.CHANGELOG);}
        catch(e){if(e?.code?.startsWith("REPO_"))throw e;chunkProblems.push(stableProblem(folder,slug,path,issue(GENERATOR_REPO_PROBLEM_CODES.CHANGELOG)));}
      }
      const existing=ledgerNext[slug]?.find(v=>v.version===manifest.version);
      if(existing&&(existing.payloadHash!==payloadHash||existing.thumbnailHash!==thumb))
        throw issue(GENERATOR_REPO_PROBLEM_CODES.MODIFIED);
      if(!existing){
        const versions=ledgerNext[slug]??[];
        ledgerNext[slug]=[...versions,{version:manifest.version,payloadHash,thumbnailHash:thumb,
          firstSeenCommit:sha,firstSeenAt}].slice(-MAX_LEDGER_VERSIONS);
      }
      chunkItems.push(stableItem({folder,manifest,path,payloadHash,thumbnailHash:thumb}));
    }catch(e){
      if(e?.code?.startsWith("REPO_"))throw e;
      chunkProblems.push(stableProblem(folder,slug,path,e));
    }
  }
  return Object.freeze({done:end===manifests.length,cursor:end,items:chunkItems,problems:chunkProblems,ledger:ledgerNext});
}
export function finalizeRepositorySnapshot({commitId,items=[],problems=[]}={}){
  const sha=normalizeRepoCommitId(commitId),counts=new Map();
  for(const item of items)counts.set(item.slug,(counts.get(item.slug)??0)+1);
  const bySlug=new Map();
  for(const item of items)if(!bySlug.has(item.slug))bySlug.set(item.slug,[]);
  for(const item of items)bySlug.get(item.slug).push(item);
  const blocked=new Set([...counts].filter(([,n])=>n>1).map(([slug])=>slug));
  // A malformed manifest still claims its folder/slug, preventing accidental cross-account adoption.
  for(const bad of problems){
    // A bad optional changelog is a warning on the same release, not a
    // competing slug declaration; it must never turn a valid item into a duplicate.
    if(bad.code===GENERATOR_REPO_PROBLEM_CODES.CHANGELOG)continue;
    if(!bySlug.has(bad.slug))bySlug.set(bad.slug,[]);
    bySlug.get(bad.slug).push(bad);
    if(bySlug.get(bad.slug).length>1)blocked.add(bad.slug);
  }
  const clean=items.filter(item=>!blocked.has(item.slug)).sort((a,b)=>a.slug<b.slug?-1:a.slug>b.slug?1:0);
  const errs=[...problems,...items.filter(item=>blocked.has(item.slug)).map(item=>stableProblem(
    item.accountFolder,item.slug,item.origin.path,issue(GENERATOR_REPO_PROBLEM_CODES.DUPLICATE)))];
  errs.sort((a,b)=>a.slug===b.slug?a.accountFolder.localeCompare(b.accountFolder):a.slug.localeCompare(b.slug));
  return Object.freeze({format:GENERATOR_REPOSITORY_CONTRACT,validatorVersion:GENERATOR_REPOSITORY_VALIDATOR_VERSION,
    commitId:sha,items:Object.freeze(clean),problems:Object.freeze(errs)});
}
export async function readRepositoryRelease({provider,config,snapshotItem,commitId}={}){
  const c=normalizeRepositoryConfig(config),sha=normalizeRepoCommitId(commitId);
  if(!snapshotItem||snapshotItem.origin?.kind!=="REPOSITORY")throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const tree=normalizeRepoTree(await provider.listTree(c,sha));
  const index=new Map(tree.entries.map(e=>[e.path,e]));
  const base=snapshotItem.origin.path.replace(/\/generator\.json$/,"")+"/releases/"+snapshotItem.version;
  const codePath=base+"/code.perchance",htmlPath=base+"/page.html",thumbPath=base+"/thumbnail.jpeg";
  const codeMeta=fileAt(index,codePath),htmlMeta=fileAt(index,htmlPath);
  if(!codeMeta||!htmlMeta||codeMeta.size+htmlMeta.size>PERCHANCE_MAX_SOURCE_BYTES)
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  const code=decode(await blob(provider,c,sha,codePath,index,PERCHANCE_MAX_SOURCE_BYTES,REPO_ERRORS.PROTOCOL),
    PERCHANCE_MAX_SOURCE_BYTES,GENERATOR_REPO_PROBLEM_CODES.TEXT);
  const html=decode(await blob(provider,c,sha,htmlPath,index,PERCHANCE_MAX_SOURCE_BYTES,REPO_ERRORS.PROTOCOL),
    PERCHANCE_MAX_SOURCE_BYTES,GENERATOR_REPO_PROBLEM_CODES.TEXT);
  let thumbnail=null;
  if(fileAt(index,thumbPath))thumbnail=encodeThumbnail(await blob(provider,c,sha,thumbPath,index,PERCHANCE_MAX_THUMBNAIL_BYTES,REPO_ERRORS.PROTOCOL));
  if(await generatorPayloadHash(code,html)!==snapshotItem.payloadHash
     ||(thumbnail===null?null:await thumbnailHash(thumbnail))!==snapshotItem.thumbnailHash)
    throw repositoryFailure(REPO_ERRORS.PROTOCOL);
  return Object.freeze({code,html,thumbnail});
}
