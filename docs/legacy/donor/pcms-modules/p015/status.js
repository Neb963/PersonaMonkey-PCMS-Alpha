// deriveGeneratorStatus (04 §E.11): the single source of generator status for every UI.
// Pure and deterministic. Rules are evaluated in order; the first match wins. Global overlays
// (recovery hold, provider unavailable) only rewrite the next action of a mutating step.
import {
  DEPLOYMENT_OPERATION_STATUS as S,
  confirmedMatchesDesired,
  isConfirmed,
  normalizeDeploymentRecord
} from "./schema.js";

export const GENERATOR_STATUS_MODES = Object.freeze(["ASSISTED", "AUTOMATIC", "PAUSED"]);
export const GENERATOR_REPOSITORY_STATES = Object.freeze(["PRESENT", "BLOCKED", "ABSENT"]);
const OBSERVED_LISTINGS = new Set(["PUBLICLY_LISTED", "UNLISTED", "UNKNOWN"]);
const OBSERVATION_METHODS = new Set(["PROVIDER_READ", "OPERATOR_CONFIRMED", "APPLY_CONFIRMED"]);
const MUTATING_NEXT = new Set(["deploy"]);

function invalid(label) { throw new TypeError("Generator status input is invalid: " + label); }
function bool(value, label) { if (typeof value !== "boolean") invalid(label); return value; }
function time(value, label) {
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) invalid(label);
  return value;
}
function hash(value, label) {
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) invalid(label);
  return value;
}

function normalizeObservation(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) invalid("observation");
  if (!OBSERVATION_METHODS.has(value.method)) invalid("observation.method");
  if (![true, false, null].includes(value.exists)) invalid("observation.exists");
  if (!OBSERVED_LISTINGS.has(value.listing)) invalid("observation.listing");
  return Object.freeze({
    method:value.method, observedAt:time(value.observedAt, "observation.observedAt"), exists:value.exists,
    payloadHash:hash(value.payloadHash ?? null, "observation.payloadHash"),
    thumbnailHash:hash(value.thumbnailHash ?? null, "observation.thumbnailHash"),
    listing:value.listing, challenge:bool(value.challenge ?? false, "observation.challenge"),
    baselineListing:OBSERVED_LISTINGS.has(value.baselineListing)?value.baselineListing:null,
    baselineThumbnailHash:hash(value.baselineThumbnailHash ?? null,"baselineThumbnailHash"),
    keptDesiredRevision:Number.isSafeInteger(value.keptDesiredRevision)?value.keptDesiredRevision:null
  });
}

function normalizeRepository(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || !GENERATOR_REPOSITORY_STATES.includes(value.state)) invalid("repository");
  const problem = value.problem ?? null;
  if (problem !== null && (typeof problem !== "string" || problem.length > 200)) invalid("repository.problem");
  return Object.freeze({ state:value.state, problem, hold:bool(value.hold ?? false, "repository.hold") });
}

export function normalizeGeneratorStatusInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("input");
  const mode = raw.mode ?? "ASSISTED";
  if (!GENERATOR_STATUS_MODES.includes(mode)) invalid("mode");
  const recovery = raw.recovery ?? "NORMAL";
  if (recovery !== "NORMAL" && recovery !== "RECOVERY_HOLD") invalid("recovery");
  return Object.freeze({
    deployment:normalizeDeploymentRecord(raw.deployment),
    liveDispatch:bool(raw.liveDispatch ?? false, "liveDispatch"),
    awaitingOperator:bool(raw.awaitingOperator ?? false, "awaitingOperator"),
    observeAvailable:bool(raw.observeAvailable ?? false, "observeAvailable"),
    observation:normalizeObservation(raw.observation),
    repository:normalizeRepository(raw.repository),
    accountHealthy:bool(raw.accountHealthy ?? true, "accountHealthy"),
    providerAvailable:bool(raw.providerAvailable ?? true, "providerAvailable"),
    mode,
    nextCheckAt:raw.nextCheckAt == null ? null : time(raw.nextCheckAt, "nextCheckAt"),
    recovery,
    now:time(raw.now, "now")
  });
}

// 04 §E.8.2, compared against the baseline PCMS last confirmed, never against the repository.
export function deriveDrift({ deployment, observation }) {
  if (!observation || observation.method !== "PROVIDER_READ" || !isConfirmed(deployment.confirmed)) return null;
  if(observation.challenge)return null;
  if (Date.parse(observation.observedAt) <= Date.parse(deployment.confirmed.confirmedAt)) return null;
  if (observation.exists === false) return "MISSING";
  if (deployment.confirmed.baselineHash !== null && observation.payloadHash !== null
      && observation.payloadHash !== deployment.confirmed.baselineHash) return "CONTENT";
  const listing=observation.keptDesiredRevision!==null&&observation.keptDesiredRevision!==undefined
    ?observation.baselineListing:deployment.confirmed.listing;
  if (observation.listing !== "UNKNOWN" && listing!==null&&listing!=="UNKNOWN"&&observation.listing !== listing) return "LISTING";
  const thumb=observation.keptDesiredRevision!=null?observation.baselineThumbnailHash:deployment.confirmed.thumbnailHash;
  if(observation.exists===true&&observation.thumbnailHash!==thumb)return "THUMBNAIL";
  return null;
}

function hhmm(iso) {
  const date = new Date(iso);
  return String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0");
}

function age(fromIso, nowIso) {
  const minutes = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(fromIso)) / 60000));
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + " h";
  return Math.floor(hours / 24) + " d";
}

function modeNext(input) {
  if (input.mode === "AUTOMATIC") {
    return { kind:"deploy", text:"Deploys automatically at the next check" + (input.nextCheckAt ? " (≈" + hhmm(input.nextCheckAt) + ")" : ""),
      ...(input.nextCheckAt ? { at:input.nextCheckAt } : {}) };
  }
  if (input.mode === "PAUSED") return { kind:"deploy", text:"Automatic checks paused" };
  return { kind:"deploy", text:"Ready — deploy when you choose" };
}

function versionLabel(deployment) {
  return deployment.desired.origin.kind === "REPOSITORY" ? deployment.desired.origin.version : null;
}

const DRIFT_LABEL = Object.freeze({ CONTENT:"Changed on Perchance", LISTING:"Listing differs", THUMBNAIL:"Thumbnail differs", MISSING:"Missing on Perchance" });

function select(input) {
  const { deployment } = input;
  const op = deployment.operation.status;
  const awaiting = input.awaitingOperator && (op === S.ACTIVE || op === S.RECONCILE);
  if ((op === S.RECONCILE || (op === S.ACTIVE && !input.liveDispatch)) && !awaiting) {
    return { rule:1, status:{ token:"UNCERTAIN", label:"Outcome unknown — check needed" },
      next:{ kind:"reconcile", text:"Check Perchance. Nothing is retried until you answer." } };
  }
  if (awaiting) {
    return { rule:2, status:{ token:"WAITING_HUMAN", label:"Waiting for you in Perchance" },
      next:{ kind:"answer", text:"Finish the save in the Perchance tab, then confirm." } };
  }
  if (op === S.ACTIVE) {
    const version = versionLabel(deployment);
    return { rule:3, status:{ token:"ACTIVE", label:version ? "Deploying " + version : "Deploying" }, next:{ kind:"none", text:"" } };
  }
  if (isConfirmed(deployment.confirmed) && input.observeAvailable && deployment.confirmed.baselineHash === null && op === S.SUCCEEDED) {
    return { rule:4, status:{ token:"ACTIVE", label:"Verifying" }, next:{ kind:"none", text:"" } };
  }
  const drift = deriveDrift(input);
  if (drift) {
    return { rule:5, status:{ token:"WARNING", label:DRIFT_LABEL[drift] },
      next:{ kind:"compare", text:"Nothing happens automatically. Compare and choose." } };
  }
  if (input.repository?.state === "BLOCKED") {
    return { rule:6, status:{ token:"ERROR", label:"Repository problem" + (input.repository.problem ? " — " + input.repository.problem : "") },
      next:{ kind:"fixRepository", text:"Fix the repository, then check again." } };
  }
  if (!input.accountHealthy) {
    return { rule:7, status:{ token:"UNAVAILABLE", label:"Account unavailable" },
      next:{ kind:"fixAccount", text:"Fix the account's Persona binding." } };
  }
  if (op === S.FAILED) {
    return { rule:8, status:{ token:"ERROR", label:"Deployment failed — not applied" }, next:{ kind:"deploy", text:"Deploy again" } };
  }
  if (deployment.desired.origin.kind === "REPOSITORY" && input.repository?.state === "ABSENT") {
    return { rule:9, status:{ token:"INFO", label:"No longer in repository" }, next:{ kind:"none", text:"Nothing changes on Perchance." } };
  }
  if (input.repository?.hold || deployment.policy.paused) {
    return { rule:10, status:{ token:"INFO", label:input.observation?.keptDesiredRevision===deployment.desired.revision?"Diverged from repository":"Paused" }, next:{ kind:"resume", text:"Resume to deploy updates." } };
  }
  if (!isConfirmed(deployment.confirmed)) {
    const missing = input.observation?.exists === false;
    return { rule:11, status:{ token:"WARNING", label:missing ? "Not yet deployed · needs creation" : "Not yet deployed" }, next:modeNext(input) };
  }
  const keptMismatch=input.observation?.keptDesiredRevision!==null&&input.observation?.keptDesiredRevision!==undefined
    &&(deployment.confirmed.baselineHash!==deployment.desired.payloadHash
      ||input.observation.baselineThumbnailHash!==deployment.desired.thumbnailHash
      ||input.observation.baselineListing!=="UNKNOWN"&&input.observation.baselineListing!==null&&input.observation.baselineListing!==deployment.desired.listing);
  if (!confirmedMatchesDesired(deployment.confirmed, deployment.desired)||keptMismatch) {
    const listingOnly = (keptMismatch?deployment.confirmed.baselineHash:deployment.confirmed.payloadHash) === deployment.desired.payloadHash
      && (keptMismatch?input.observation.baselineThumbnailHash:deployment.confirmed.thumbnailHash) === deployment.desired.thumbnailHash;
    return { rule:12, status:{ token:"WARNING", label:listingOnly ? "Listing change ready" : "Update ready" }, next:modeNext(input) };
  }
  const verified = deployment.confirmed.baselineHash!==null
    &&input.observation?.method === "PROVIDER_READ"&&!input.observation.challenge&&input.observation.exists===true
    &&input.observation.payloadHash===deployment.confirmed.baselineHash
    &&Date.parse(input.observation.observedAt) >= Date.parse(deployment.confirmed.confirmedAt);
  return { rule:13, status:{ token:"OK", label:"In sync" }, next:{ kind:"none", text:"Nothing to do." },
    notes:[verified ? "verified " + age(input.observation.observedAt, input.now) + " ago" : "not verified"] };
}

export function deriveGeneratorStatus(rawInput) {
  const input = normalizeGeneratorStatusInput(rawInput);
  const chosen = select(input);
  let next = chosen.next;
  if (MUTATING_NEXT.has(next.kind)) {
    if (input.recovery === "RECOVERY_HOLD") next = { kind:"held", text:"On hold until recovery checks finish" };
    else if (!input.providerAvailable) next = { kind:"waitProvider", text:"Waiting for Perchance" };
  }
  return Object.freeze({
    rule:chosen.rule,
    status:Object.freeze({ ...chosen.status }),
    next:Object.freeze({ ...next }),
    notes:Object.freeze([...(chosen.notes || [])])
  });
}
