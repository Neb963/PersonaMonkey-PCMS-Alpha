// P040 read-only cross-module query: which release the Deployer last confirmed for a generator,
// and that release's content read from its pinned repository commit only when a refresh is
// dispatched. Nothing is pasted, nothing is stored, and the hashes are re-verified on read.
import { readRepositoryRelease } from "../p015/repository-format.js";

// In flight on Perchance: wait. A PENDING desired release is an update waiting to be deployed.
const BUSY=new Set(["ACTIVE","RECONCILE","RETRYABLE"]);

// {release, accountId, refreshable, reason} for one Deployer v2 deployment record.
export function describeConfirmedRelease(deployment){
  if(!deployment) return null;
  const accountId=deployment.accountId;
  const confirmed=deployment.confirmed;
  if(deployment.desired.payloadKind!=="v2-release"||confirmed.payloadHash===null||confirmed.listing===null){
    return Object.freeze({release:null,accountId,refreshable:false,reason:confirmed.payloadHash===null?"NOT_DEPLOYED":"LEGACY_SOURCE"});
  }
  const release=Object.freeze({payloadKind:"v2-release",payloadHash:confirmed.payloadHash,thumbnailHash:confirmed.thumbnailHash,listing:confirmed.listing});
  let reason=null;
  if(deployment.policy.paused) reason="PAUSED";
  else if(BUSY.has(deployment.operation.status)) reason="BUSY";
  else if(deployment.desired.origin.kind!=="REPOSITORY") reason="NO_STORED_CONTENT";
  else if(confirmed.payloadHash!==deployment.desired.payloadHash||confirmed.thumbnailHash!==deployment.desired.thumbnailHash
    ||confirmed.listing!==deployment.desired.listing||deployment.operation.status!=="SUCCEEDED") reason="UPDATE_PENDING";
  return Object.freeze({release,accountId,refreshable:reason===null,reason});
}

export function createDeployerReleaseSource({deployer,repository=null,repositoryProvider=null,readRelease=readRepositoryRelease}={}){
  if(!deployer||typeof deployer.listDeployments!=="function") throw new TypeError("Refresher release source requires the Deployer");
  async function deploymentFor(generatorId){
    const listed=await deployer.listDeployments();
    return listed.deployments.find((item)=>item.targetRef.id===generatorId)||null;
  }
  return Object.freeze({
    async confirmedRelease(generatorId){
      return describeConfirmedRelease(await deploymentFor(generatorId));
    },
    // A refreshable confirmed release equals the desired REPOSITORY release, so its pinned commit,
    // path and version name exactly the bytes PCMS confirmed.
    async readRelease(generatorId,release){
      const deployment=await deploymentFor(generatorId);
      const described=describeConfirmedRelease(deployment);
      if(!described?.refreshable||described.release.payloadHash!==release?.payloadHash
        ||described.release.thumbnailHash!==release?.thumbnailHash||described.release.listing!==release?.listing) {
        throw new Error("Confirmed release changed");
      }
      if(!repository||typeof repository.read!=="function"||!repositoryProvider) throw new Error("Repository is unavailable");
      const state=await repository.read();
      if(!state?.value?.config) throw new Error("Repository is not configured");
      const origin=deployment.desired.origin;
      return readRelease({
        provider:repositoryProvider,
        config:state.value.config,
        snapshotItem:{origin:{kind:"REPOSITORY",path:origin.path},version:origin.version,
          payloadHash:release.payloadHash,thumbnailHash:release.thumbnailHash},
        commitId:origin.commitId
      });
    }
  });
}
