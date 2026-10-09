// The Deployer's GeneratorListing (03 §4.5): one item per deployment with Deployer-owned
// columns (status, repo, perchance, listing). Status comes only from deriveGeneratorStatus.
// The Perchance column shows what PCMS last confirmed, never a guessed provider version.
import { deriveGeneratorStatus } from "./status.js";

const RULE_FILTER = Object.freeze({ 1:"uncertain", 2:"waiting", 3:"deploying", 4:"deploying", 5:"drift", 6:"blocked", 7:"unavailable",
  8:"failed", 9:"other", 10:"paused", 11:"new", 12:"update", 13:"sync" });
const LISTING_WORDS = Object.freeze({ PUBLICLY_LISTED:"Public", UNLISTED:"Unlisted" });

function short(hash) { return typeof hash === "string" ? hash.slice(0, 8) : ""; }

function perchanceColumn(deployment, status) {
  if (deployment.confirmed.payloadHash === null) return "—";
  const origin = deployment.desired.origin;
  const label = origin.kind === "REPOSITORY" && deployment.desired.payloadHash === deployment.confirmed.payloadHash
    ? origin.version : "#" + short(deployment.confirmed.payloadHash);
  return status.token === "UNCERTAIN" ? label + " ?" : label;
}

export function deployerGeneratorListing({ deployments, healthyAccounts = new Set(), openHandoffTargets = new Set(), recovery = "NORMAL", mode = "ASSISTED", now, observations=new Map(), observeAvailable=false }) {
  return Object.freeze({
    moduleId:"deployer",
    items:Object.freeze(deployments.map((deployment) => {
      const derived = deriveGeneratorStatus({
        deployment,
        awaitingOperator:openHandoffTargets.has(deployment.targetRef.id),
        accountHealthy:healthyAccounts.has(deployment.accountId),
        recovery,
        mode,
        observation:observations.get(deployment.deploymentId)??null,
        observeAvailable:observeAvailable&&observations.get(deployment.deploymentId)?.method!=="OPERATOR_CONFIRMED",
        now
      });
      const origin = deployment.desired.origin;
      return Object.freeze({
        ref:"perchance:" + deployment.targetRef.id,
        accountId:deployment.accountId,
        title:null,
        deploymentId:deployment.deploymentId,
        filter:RULE_FILTER[derived.rule],
        status:derived.status,
        next:derived.next,
        notes:derived.notes,
        columns:Object.freeze({
          repo:origin.kind === "REPOSITORY" ? origin.version : "manual",
          perchance:perchanceColumn(deployment, derived.status),
          listing:deployment.desired.listing ? LISTING_WORDS[deployment.desired.listing] : "Not managed"
        })
      });
    }))
  });
}
