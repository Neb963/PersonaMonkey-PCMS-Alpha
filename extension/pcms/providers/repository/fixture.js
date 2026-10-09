// Deterministic, network-free test double for pcms.repository-provider/v1.
import {REPO_ERRORS,normalizeRepositoryConfig,normalizeRepoCommitId,normalizeRepoTree,
  assertBlobInput,repositoryFailure,repositoryPath} from "./contract.js";

export function createFixtureRepositoryProvider({refs={},commits={},failures={}}={}){
  const mappedRefs=new Map(Object.entries(refs));
  const faults=new Map(Object.entries(failures));
  const bytes=value=>{
    if(typeof value==="string")return new TextEncoder().encode(value);
    if(value instanceof Uint8Array)return Uint8Array.from(value);
    if(Array.isArray(value)&&value.every(x=>Number.isInteger(x)&&x>=0&&x<=255))return Uint8Array.from(value);
    throw new TypeError("Fixture blob must be bytes or text");
  };
  function fail(phase){
    const fault=faults.get(phase);
    if(fault)throw repositoryFailure(fault.code||fault,fault.resetAt??null);
  }
  function commitFor(id){
    const commit=commits[id];
    if(!commit)throw repositoryFailure(REPO_ERRORS.NOT_FOUND);
    return commit;
  }
  function treeFor(id){
    const commit=commitFor(id);
    if(commit.complete===false)throw repositoryFailure(REPO_ERRORS.TREE_TRUNCATED);
    if(commit.entries){
      return normalizeRepoTree({complete:true,entries:commit.entries});
    }
    const paths=Object.keys(commit.blobs||{}).sort();
    const entries=paths.map((path,i)=>({path,type:"file",size:bytes(commit.blobs[path]).length,
      blobId:(i+1).toString(16).padStart(40,"0")}));
    return normalizeRepoTree({complete:true,entries});
  }
  function describe(raw){
    const c=normalizeRepositoryConfig(raw);
    return Object.freeze({kind:"github",label:"github · "+c.owner+"/"+c.repo+"@"+c.ref,
      webUrl:(path,commitId)=>"https://github.com/"+c.owner+"/"+c.repo+"/blob/"+normalizeRepoCommitId(commitId)+"/"+repositoryPath(c,path)});
  }
  async function resolveRef(raw){
    fail("resolveRef");const c=normalizeRepositoryConfig(raw);
    const sha=mappedRefs.get(c.ref);if(!sha)throw repositoryFailure(REPO_ERRORS.NOT_FOUND);
    const commitId=normalizeRepoCommitId(sha),value=commitFor(commitId);
    return Object.freeze({commitId,committedAt:value.committedAt??"2026-01-01T00:00:00.000Z",message:String(value.message??"fixture").slice(0,200)});
  }
  async function listTree(raw,commitId){
    normalizeRepositoryConfig(raw);normalizeRepoCommitId(commitId);fail("listTree");
    return treeFor(commitId);
  }
  async function readBlob(raw,commitId,path,blobId,{maxBytes}={}){
    normalizeRepositoryConfig(raw);normalizeRepoCommitId(commitId);assertBlobInput(path,blobId,maxBytes);
    fail("readBlob");
    const tree=treeFor(commitId).entries.find(e=>e.path===path&&e.type==="file");
    if(!tree||tree.blobId!==blobId)throw repositoryFailure(REPO_ERRORS.NOT_FOUND);
    const value=commitFor(commitId).blobs?.[path];
    if(value===undefined)throw repositoryFailure(REPO_ERRORS.NOT_FOUND);
    const content=bytes(value);
    if(content.length!==tree.size)throw repositoryFailure(REPO_ERRORS.PROTOCOL);
    if(content.length>maxBytes)throw repositoryFailure(REPO_ERRORS.TOO_LARGE);
    return Uint8Array.from(content);
  }
  return Object.freeze({describe,resolveRef,listTree,readBlob,
    // Fixture controls never enter the production provider.
    setRef:(ref,commitId)=>mappedRefs.set(ref,normalizeRepoCommitId(commitId)),
    setFailure:(phase,value)=>value?faults.set(phase,value):faults.delete(phase)});
}
