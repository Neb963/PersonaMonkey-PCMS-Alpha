import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID, SCHEMA_VERSION } from "./constants.js";
import { normalizeScript } from "./storage.js";
import { analyzeGrants, parseUserscriptMetadata } from "./userscripts.js";
import { assertExternalArtifactMetadataMatchesSource } from "./external-artifact-integrity.js";
import {
  EXTERNAL_AUTOMATION_LIMITS,
  INTEGRATION_COMMAND_DESCRIPTORS,
  INTEGRATION_ERROR_CODES,
  INTEGRATION_EVENTS_PORT,
  INTEGRATION_PROTOCOL_VERSION,
  getIntegrationCommandDescriptor,
  MAX_INTEGRATION_EVENT_BYTES,
  isAuthorizedIntegrationSender,
  isPlainObject,
  listIntegrationCommandDescriptors,
  makeIntegrationError,
  normalizeIntegrationPolicy,
  sanitizeIntegrationValue,
  validateOwnerResultValue,
  structuredIntegrationError,
  validateIntegrationRequest
} from "./management-integration-protocol.js";

const OPERATION_STORE_KEY = "personamonkeyIntegrationOperations";
const MAX_OPERATION_RECORDS = 64;
const MAX_PENDING_OPERATIONS_PER_SENDER = 16;
const MAX_INTEGRATION_EVENT_PORTS_TOTAL = 32;
const MAX_INTEGRATION_EVENT_PORTS_PER_SENDER = 4;
const DEFAULT_LIST_PAGE_SIZE = 50;
const listCursorNonce = crypto.randomUUID();
const EXTERNAL_ARTIFACT_SCRIPT_PREFIX = "external-artifact-";
const EXTERNAL_INPUT_TTL_DEFAULT = 5 * 60_000;

function listFingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16);
}

function pagedList(request, values, key, project) {
  const revision = request.listRevision;
  const pageSize = request.params.page?.size ?? (request.params.page ? DEFAULT_LIST_PAGE_SIZE : 100);
  let offset = 0;
  let token;
  if (request.params.page?.cursor) {
    try { token = JSON.parse(decodeURIComponent(request.params.page.cursor)); } catch {}
    if (!isPlainObject(token) || token.v !== 1 || token.command !== request.command
        || token.pageSize !== pageSize || !Number.isSafeInteger(token.offset) || token.offset < 0
        || typeof token.bootId !== "string" || !Number.isSafeInteger(token.revision)
        || typeof token.fingerprint !== "string" || token.signature !== listFingerprint(listCursorNonce + JSON.stringify({
          v: token.v, command: token.command, bootId: token.bootId,
          revision: token.revision, pageSize: token.pageSize, offset: token.offset,
          fingerprint: token.fingerprint
        }))) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PAGE_INVALID);
    }
    if (token.bootId !== request.listBootId || token.revision !== revision) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PAGE_STALE, undefined, { retryable: true });
    }
    offset = token.offset;
  }
  const ordered = values.map((value, index) => ({ value, index, sortKey: String(key(value) ?? "") }))
    .sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.index - b.index);
  // Job progress may change without a persisted state revision; bind a cursor to the entire public snapshot.
  const projected = ordered.map(({ value }) => project(value));
  const fingerprint = listFingerprint(JSON.stringify(projected));
  if (token?.fingerprint !== undefined && token.fingerprint !== fingerprint) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.PAGE_STALE, undefined, { retryable: true });
  }
  if (offset > ordered.length || (offset === ordered.length && offset !== 0)) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.PAGE_INVALID);
  }
  const items = projected.slice(offset, offset + pageSize);
  const hasMore = offset + items.length < ordered.length;
  // Unpaged small lists keep the original array result shape.
  if (!request.params.page && !hasMore) return items;
  const nextToken = {
    v: 1, command: request.command, bootId: request.listBootId,
    revision, pageSize, offset: offset + items.length, fingerprint
  };
  return {
    items,
    hasMore,
    nextCursor: hasMore ? encodeURIComponent(JSON.stringify({
      ...nextToken, signature: listFingerprint(listCursorNonce + JSON.stringify(nextToken))
    })) : null
  };
}

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function fingerprint(command, params) {
  return JSON.stringify(stable({ command, params }));
}

function operationKey(senderId, operationId) {
  return JSON.stringify([String(senderId || ""), String(operationId || "")]);
}

function senderFromOperationKey(key) {
  try {
    const value = JSON.parse(key);
    return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
  } catch {
    return null;
  }
}

function operationIdFromOperationKey(key) {
  try {
    const value = JSON.parse(key);
    return Array.isArray(value) && typeof value[1] === "string" ? value[1] : null;
  } catch {
    return null;
  }
}

export function createIntegrationOperationStore(storageArea, { key = OPERATION_STORE_KEY, limit = MAX_OPERATION_RECORDS, pendingPerSender = MAX_PENDING_OPERATIONS_PER_SENDER } = {}) {
  if (!storageArea?.get || !storageArea?.set) throw new Error("Integration operation store requires browser.storage.local");
  let tail = Promise.resolve();

  function enqueue(task) {
    const pending = tail.then(task, task);
    tail = pending.catch(() => {});
    return pending;
  }

  async function readAll() {
    const stored = await storageArea.get(key);
    const raw = stored?.[key];
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  async function get(senderId, operationId) {
    // Observe any queued write before answering a retry lookup.
    await tail;
    const all = await readAll();
    return all[operationKey(senderId, operationId)] || null;
  }

  async function put(senderId, operationId, record) {
    return enqueue(async () => {
      const all = await readAll();
      const composite = operationKey(senderId, operationId);
      const boundedLimit = Math.max(8, Math.min(256, Number(limit) || MAX_OPERATION_RECORDS));
      const boundedPerSender = Math.max(1, Math.min(64, Number(pendingPerSender) || MAX_PENDING_OPERATIONS_PER_SENDER));
      const existing = all[composite] || null;
      if (!existing && record?.state === "pending") {
        const rows = Object.entries(all).filter(([, row]) => row?.state === "pending");
        const pendingCount = rows.length;
        const senderPendingCount = rows.filter(([storedKey]) => senderFromOperationKey(storedKey) === String(senderId || "")).length;
        if (pendingCount >= boundedLimit || senderPendingCount >= boundedPerSender) {
          throw makeIntegrationError(
            INTEGRATION_ERROR_CODES.OPERATION_CAPACITY,
            "Integration operation correlation capacity for this caller is temporarily exhausted",
            { retryable: true }
          );
        }
      }
      const nextOrder = Object.values(all).reduce(
        (max, row) => Math.max(max, Number.isSafeInteger(row?.updatedOrder) ? row.updatedOrder : 0),
        0
      ) + 1;
      all[composite] = {
        ...clone(record),
        updatedAt: new Date().toISOString(),
        updatedOrder: nextOrder
      };
      const rows = Object.entries(all)
        .sort((a, b) => {
          const pendingA = a[1]?.state === "pending" ? 0 : 1;
          const pendingB = b[1]?.state === "pending" ? 0 : 1;
          if (pendingA !== pendingB) return pendingA - pendingB;
          const orderA = Number.isSafeInteger(a[1]?.updatedOrder) ? a[1].updatedOrder : 0;
          const orderB = Number.isSafeInteger(b[1]?.updatedOrder) ? b[1].updatedOrder : 0;
          if (orderA !== orderB) return orderB - orderA;
          const timeOrder = String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || ""));
          if (timeOrder !== 0) return timeOrder;
          return a[0].localeCompare(b[0]);
        })
        .slice(0, boundedLimit);
      await storageArea.set({ [key]: Object.fromEntries(rows) });
      return all[composite];
    });
  }

  async function listForSender(senderId) {
    await tail;
    const all = await readAll();
    const wanted = String(senderId || "");
    return Object.entries(all)
      .filter(([storedKey]) => senderFromOperationKey(storedKey) === wanted)
      .map(([storedKey, row]) => ({
        operationId: operationIdFromOperationKey(storedKey),
        ...clone(row)
      }))
      .filter((row) => row.operationId);
  }

  return Object.freeze({ get, put, listForSender });
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

const PUBLIC_HEALTH_REASONS = new Set([
  "Route has not been tested",
  "Persona is not managed",
  "Network route is Block",
  "Direct route configured",
  "Protection policy is not ready",
  "Assigned route is missing or disabled",
  "Required browser protection is unavailable",
  "Configured and fail-closed; run Test to verify the exit",
  "Exit verified; DNS check incomplete",
  "Exit verified; DNS leak detected",
  "Proxy, DNS, and exit verified"
]);

function publicHealthReason(health) {
  const reason = typeof health?.reason === "string" ? health.reason : "";
  if (PUBLIC_HEALTH_REASONS.has(reason)) return reason;
  const status = String(health?.status || "").toLowerCase();
  if (status === "healthy") return "Proxy, DNS, and exit verified";
  if (status === "blocked") return "Network route is Block";
  if (status === "direct") return "Direct route configured";
  if (status === "warning") return "Route verification incomplete";
  if (status === "error") return "Route verification failed";
  if (status === "unmanaged") return "Persona is not managed";
  return "Route status unavailable";
}

function publicHealth(health) {
  if (!isPlainObject(health)) return null;
  const allowed = [
    "status", "routeId", "routeName", "protected", "proxy", "dns",
    "exitIp", "exitCountry", "checkedAt", "ageMs"
  ];
  return sanitizeIntegrationValue({
    ...Object.fromEntries(allowed.filter((key) => Object.hasOwn(health, key)).map((key) => [key, health[key]])),
    reason: publicHealthReason(health)
  }, { maxDepth: 3 });
}

function publicPersona(persona) {
  if (!isPlainObject(persona)) return null;
  const personaUid = typeof persona.personaUid === "string" ? persona.personaUid : null;
  const cookieStoreId = typeof persona.cookieStoreId === "string"
    ? persona.cookieStoreId
    : typeof persona.containerId === "string"
      ? persona.containerId
      : (typeof persona.id === "string" ? persona.id : null);
  const keys = [
    "name", "icon", "iconUrl", "color", "managed", "owned", "description",
    "createdAt", "lastUsedAt", "expiresAt", "archivedAt", "status", "statistics",
    "activeTabs", "protection"
  ];
  const cookieSummary = isPlainObject(persona.cookies)
    ? { count: count(persona.cookies.count), bytes: count(persona.cookies.bytes) }
    : null;
  return sanitizeIntegrationValue({
    personaUid,
    cookieStoreId,
    ...Object.fromEntries(keys.filter((key) => Object.hasOwn(persona, key)).map((key) => [key, persona[key]])),
    ...(cookieSummary ? { cookieSummary } : {}),
    ...(persona.health ? { health: publicHealth(persona.health) } : {})
  });
}

function publicRoute(route) {
  if (!isPlainObject(route)) return null;
  const allowed = ["id", "name", "provider", "type", "host", "port", "proxyDNS", "country", "city", "server", "enabled", "createdAt"];
  return sanitizeIntegrationValue(Object.fromEntries(allowed.filter((key) => Object.hasOwn(route, key)).map((key) => [key, route[key]])));
}

function publicStorage(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  if (isPlainObject(value.cookies)) {
    out.cookieSummary = {
      count: count(value.cookies.count),
      bytes: count(value.cookies.bytes),
      domainCount: Array.isArray(value.cookies.byDomain) ? value.cookies.byDomain.length : 0
    };
  } else if (typeof value.cookies === "number") {
    out.cookiesRemoved = count(value.cookies);
  }
  for (const key of ["localStorage", "sessionStorage"]) {
    if (isPlainObject(value[key])) out[key] = { items: count(value[key].items), bytes: count(value[key].bytes) };
  }
  if (isPlainObject(value.indexedDB)) out.indexedDB = { databases: count(value.indexedDB.databases) };
  if (isPlainObject(value.cacheStorage)) out.cacheStorage = { caches: count(value.cacheStorage.caches) };
  if (isPlainObject(value.estimated)) out.estimated = { usage: count(value.estimated.usage), quota: count(value.estimated.quota) };
  if (Object.hasOwn(value, "activeTabs")) out.activeTabs = count(value.activeTabs);
  if (Array.isArray(value.inspectedOrigins)) out.inspectedOriginCount = value.inspectedOrigins.length;
  if (typeof value.complete === "boolean") out.complete = value.complete;
  if (typeof value.scope === "string") out.scope = value.scope.slice(0, 32);
  if (typeof value.siteData === "boolean") out.siteData = value.siteData;
  if (Object.hasOwn(value, "openOriginCaches")) out.openOriginCaches = count(value.openOriginCaches);
  return sanitizeIntegrationValue(out, { maxDepth: 5 });
}

function publicSystemStatus(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  if (typeof value.status === "string") out.status = value.status.slice(0, 64);
  if (isPlainObject(value.security)) {
    const securityKeys = [
      "ready", "privacySafe", "networkPredictionSafe", "webRTCSafe",
      "proxyControl", "initializedAt"
    ];
    out.security = Object.fromEntries(
      securityKeys.filter((key) => Object.hasOwn(value.security, key)).map((key) => [key, value.security[key]])
    );
  }
  if (Object.hasOwn(value, "managedPersonaCount")) out.managedPersonaCount = count(value.managedPersonaCount);
  if (isPlainObject(value.routeHealth)) {
    out.routeHealth = Object.fromEntries(
      ["healthy", "blocked", "degraded", "unknown"].map((key) => [key, count(value.routeHealth[key])])
    );
  }
  if (Object.hasOwn(value, "runningWorkflowJobCount")) out.runningWorkflowJobCount = count(value.runningWorkflowJobCount);
  if (Object.hasOwn(value, "eventSequence")) out.eventSequence = count(value.eventSequence);
  return sanitizeIntegrationValue(out, { maxDepth: 4 });
}

function publicWorkflow(workflow, state) {
  if (!isPlainObject(workflow)) return null;
  return sanitizeIntegrationValue({
    id: domainText(workflow.id || "", 256),
    name: domainText(workflow.name || "", 200),
    enabled: workflow.enabled !== false,
    createdAt: workflow.createdAt || null,
    updatedAt: workflow.updatedAt || null,
    steps: (Array.isArray(workflow.steps) ? workflow.steps : []).map((step, index) => {
      const profile = state.profiles?.[step?.profileId];
      return {
        id: domainText(step?.id || `step-${index + 1}`, 100),
        personaUid: profile?.personaUid || null,
        cookieStoreId: profile?.containerId || (step?.profileId ? domainText(step.profileId, 256) : null),
        urls: Array.isArray(step?.urls) ? step.urls : [],
        urlCount: Array.isArray(step?.urls) ? step.urls.length : 0,
        scriptIds: Array.isArray(step?.scriptIds) ? step.scriptIds : [],
        concurrency: Number(step?.concurrency) || 0,
        completion: step?.completion ? {
          mode: domainText(step.completion.mode || "load", 32),
          value: domainText(step.completion.value || "", 4096),
          timeoutMs: Number(step.completion.timeoutMs) || 0
        } : null,
        retries: Number(step?.retries) || 0,
        retryDelayMs: Number(step?.retryDelayMs) || 0,
        closeTabs: step?.closeTabs !== false,
        stopOnError: step?.stopOnError !== false
      };
    })
  });
}

function publicUserscript(script, state) {
  if (!isPlainObject(script)) return null;
  const assignedProfileIds = Array.isArray(script.assignedProfileIds)
    ? script.assignedProfileIds
    : (Array.isArray(script.profileIds) ? script.profileIds : []);
  const assignedPersonaUids = [...new Set(assignedProfileIds
    .map((profileId) => state.profiles?.[profileId])
    .filter((profile) => profile?.managed && !profile.rotationRole && profile.personaUid)
    .map((profile) => profile.personaUid))];
  const compatibility = isPlainObject(script.compatibility) ? script.compatibility : {};
  return sanitizeIntegrationValue({
    id: domainText(script.id, 256),
    name: domainText(script.name, 200),
    namespace: domainText(script.namespace, 500),
    version: domainText(script.version, 100),
    enabled: script.enabled !== false,
    matches: Array.isArray(script.matches) ? script.matches : [],
    includeMatches: Array.isArray(script.includeMatches) ? script.includeMatches : [],
    excludeMatches: Array.isArray(script.excludeMatches) ? script.excludeMatches : [],
    excludes: Array.isArray(script.excludes) ? script.excludes : [],
    runAt: domainText(script.runAt || "document_idle", 32),
    world: domainText(script.world || "USER_SCRIPT", 32),
    grants: Array.isArray(script.grants) ? script.grants : [],
    connects: Array.isArray(script.connects) ? script.connects : [],
    compatibility: {
      compatible: compatibility.compatible === true,
      supported: Array.isArray(compatibility.supported) ? compatibility.supported : [],
      unsupported: Array.isArray(compatibility.unsupported) ? compatibility.unsupported : []
    },
    assignedPersonaUids
  }, { maxDepth: 5 });
}

function boundedText(value, max) {
  return value == null ? null : String(value).slice(0, max);
}

function domainText(value, max) {
  if (value == null) return null;
  const text = String(value);
  if (text.length > max) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
  return text;
}

function publicJobError(state, kind = "workflow", hasError = false) {
  const value = String(state || "").toLowerCase();
  if (value === "stopped" || value === "stopping") return kind === "task" ? "Task stopped" : "Workflow stopped";
  if (value === "interrupted") return kind === "task" ? "Task interrupted" : "Workflow interrupted";
  if (value === "failed" || hasError) return kind === "task" ? "Task failed" : "Workflow failed";
  return null;
}

function publicProfileRef(profileId, state) {
  const id = typeof profileId === "string" ? profileId : null;
  if (!id) return { personaUid: null, cookieStoreId: null };
  const profile = state.profiles?.[id];
  return {
    personaUid: profile?.personaUid || null,
    cookieStoreId: profile?.containerId || id
  };
}

function publicJob(job, state) {
  if (!isPlainObject(job)) return null;
  const stepProgress = Array.isArray(job.stepProgress) ? job.stepProgress.map((step) => ({
    index: count(step?.index),
    state: boundedText(step?.state, 32),
    ...publicProfileRef(step?.profileId, state),
    personaName: boundedText(step?.personaName, 128),
    total: count(step?.total),
    completed: count(step?.completed),
    failed: count(step?.failed),
    stopped: count(step?.stopped),
    retrying: count(step?.retrying),
    active: count(step?.active),
    startedAt: boundedText(step?.startedAt, 64),
    finishedAt: boundedText(step?.finishedAt, 64)
  })) : [];

  const tasks = Array.isArray(job.tasks) ? job.tasks.map((task) => ({
    id: boundedText(task?.id, 128),
    stepIndex: count(task?.stepIndex),
    ...publicProfileRef(task?.profileId, state),
    personaName: boundedText(task?.personaName, 128),
    state: boundedText(task?.state, 32),
    attempts: count(task?.attempts),
    retryPolicy: isPlainObject(task?.retryPolicy)
      ? { maxRetries: count(task.retryPolicy.maxRetries) }
      : null,
    completion: isPlainObject(task?.completion)
      ? { mode: boundedText(task.completion.mode, 32) }
      : null,
    startedAt: boundedText(task?.startedAt, 64),
    finishedAt: boundedText(task?.finishedAt, 64),
    nextRetryAt: boundedText(task?.nextRetryAt, 64),
    error: publicJobError(task?.state, "task", Boolean(task?.error)),
    attemptHistory: Array.isArray(task?.attemptHistory) ? task.attemptHistory.map((attempt) => ({
      attempt: count(attempt?.attempt),
      state: boundedText(attempt?.state, 32),
      startedAt: boundedText(attempt?.startedAt, 64),
      finishedAt: boundedText(attempt?.finishedAt, 64),
      error: attempt?.error ? "Attempt failed" : null
    })) : []
  })) : [];

  return sanitizeIntegrationValue({
    id: boundedText(job.id, 128),
    workflowId: boundedText(job.workflowId, 256),
    workflowName: boundedText(job.workflowName, 200),
    state: boundedText(job.state, 32),
    ...publicProfileRef(job.profileId, state),
    createdAt: boundedText(job.createdAt, 64),
    startedAt: boundedText(job.startedAt, 64),
    finishedAt: boundedText(job.finishedAt, 64),
    currentStep: Number.isInteger(job.currentStep) ? job.currentStep : -1,
    totalSteps: count(job.totalSteps),
    failed: String(job.state || "").toLowerCase() === "failed",
    error: publicJobError(job.state, "workflow", Boolean(job.error)),
    stepProgress,
    tasks
  });
}

function publicRouteTest(value) {
  if (!isPlainObject(value)) return null;
  const data = isPlainObject(value.data) ? value.data : {};
  const dns = isPlainObject(value.dns) ? value.dns : {};
  const nativeStatus = isPlainObject(value.mullvadNative) ? value.mullvadNative : {};
  return sanitizeIntegrationValue({
    ok: value.ok === true,
    failed: value.ok !== true,
    error: value.error ? "Route verification failed" : null,
    connectionCheckFailed: Boolean(value.connectionCheckError),
    checkedAt: boundedText(value.checkedAt, 64),
    exit: {
      ip: boundedText(data.ip, 128),
      city: boundedText(data.city, 128),
      country: boundedText(data.country, 128),
      mullvadExit: data.mullvad_exit_ip === true
    },
    dns: {
      checked: dns.checked === true,
      leaking: typeof dns.leaking === "boolean" ? dns.leaking : null,
      serverCount: Array.isArray(dns.servers) ? dns.servers.length : 0
    },
    native: {
      installed: nativeStatus.installed === true,
      ready: nativeStatus.ready === true
    }
  }, { maxDepth: 4 });
}

function availability(personaApi) {
  const out = new Set(["system", "events"]);
  if (personaApi?.PersonaManager) out.add("personas");
  if (personaApi?.StorageManager) out.add("persona-storage");
  if (personaApi?.RouteManager) out.add("routes");
  if (personaApi?.UserscriptManager) out.add("userscripts");
  if (personaApi?.WorkflowRunner) {
    out.add("workflows");
    if (typeof personaApi.WorkflowRunner.listJobs === "function") out.add("workflow-jobs");
  }
  if (personaApi?.Diagnostics) out.add("diagnostics");
  if (personaApi?.WorkflowRunner?.runExternalExecution
      && personaApi?.WorkflowRunner?.getExternalExecution) out.add("external-automation");
  if (personaApi?.UserscriptManager) out.add("external-executable-install");
  return out;
}

function commandAvailable(personaApi, command) {
  if (command === "system.describe") return true;
  if (command === "system.status") {
    return typeof personaApi?.Diagnostics?.getSystemStatus === "function"
      || typeof personaApi?.Diagnostics?.getStatus === "function";
  }
  if (command.startsWith("userscript.artifact.")) {
    return Boolean(personaApi?.UserscriptManager?.list && personaApi?.UserscriptManager?.assign);
  }
  if (command.startsWith("persona.control.")) return Boolean(personaApi?.PersonaManager?.get);
  if (command.startsWith("execution.input.") || command.startsWith("execution.secret.")) return true;
  if (command === "execution.start") return typeof personaApi?.WorkflowRunner?.runExternalExecution === "function";
  if (command === "execution.list") return typeof personaApi?.WorkflowRunner?.listExternalExecutions === "function";
  if (command === "execution.get") return typeof personaApi?.WorkflowRunner?.getExternalExecution === "function";
  if (command === "execution.result.get") return typeof personaApi?.WorkflowRunner?.getExternalExecutionResult === "function";
  if (command === "execution.result.ack") return typeof personaApi?.WorkflowRunner?.acknowledgeExternalExecution === "function";
  if (command === "execution.cancel") return typeof personaApi?.WorkflowRunner?.stopExternalExecution === "function";
  if (command === "execution.focus") return typeof personaApi?.WorkflowRunner?.focusExternalExecution === "function";
  const parts = command.split(".");
  if (parts[0] === "persona") return typeof personaApi?.PersonaManager?.[parts[1]] === "function";
  if (parts[0] === "storage") return typeof personaApi?.StorageManager?.[parts[1]] === "function";
  if (parts[0] === "route") return typeof personaApi?.RouteManager?.[parts[1]] === "function";
  if (parts[0] === "userscript") return typeof personaApi?.UserscriptManager?.[parts[1]] === "function";
  if (parts[0] === "workflow" && parts[1] === "jobs") {
    const method = {
      list: "listJobs",
      get: "getJob",
      stop: "stopJob",
      clearFinished: "clearFinishedJobs"
    }[parts[2]];
    return Boolean(method && typeof personaApi?.WorkflowRunner?.[method] === "function");
  }
  if (parts[0] === "workflow") return typeof personaApi?.WorkflowRunner?.[parts[1]] === "function";
  return false;
}

function requireMethod(personaApi, service, method) {
  const fn = personaApi?.[service]?.[method];
  if (typeof fn !== "function") {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.CAPABILITY_UNAVAILABLE, `${service} is unavailable`);
  }
  return fn.bind(personaApi[service]);
}

export const INTERNAL_PCMS_INTEGRATION_SENDER_ID = "pcms-internal@personamonkey.local";

export function createManagementIntegration({
  personaApi,
  stateManager,
  sourceEventHub,
  operationStore,
  product = "PersonaMonkey Route Manager",
  productVersion = "1.2.0",
  managementProtocolVersion = 1,
  personaApiVersion = "0.7",
  selfExtensionId = null,
  getExternalRuntimeAvailability = async () => ({ userScriptsPermission: false, userScriptsExecute: false, tabOwnership: false })
} = {}) {
  if (!personaApi || !stateManager) throw new Error("PersonaMonkey integration dependencies are incomplete");
  const bootId = stateManager.getBootId();
  const subscribers = new Set();
  const eventPorts = new Map();
  const personaIndex = new Map();
  const operationLocks = new Map();
  const executionAdmissionLocks = new Map();
  const workflowAdmissionLocks = new Map();
  const rotationLocks = new Map();
  const leaseLocks = new Map();
  const leaseCapacityLocks = new Map();
  const artifactLocks = new Map();
  const artifactCapacityLocks = new Map();
  const controlLeases = new Map();
  const externalInputs = new Map();
  const externalSecrets = new Map();
  const inputWaiters = new Map();
  const executionsByLease = new Map();
  const executionLeaseIds = new Map();
  const executionArtifactRefs = new Map();
  const activeExecutionAdmissions = new Set();
  const automationSenders = new Set();
  let priorAuthorizedSenders = new Set();
  let eventSequence = 0;
  let leaseExpiryTimer = null;

  async function state() { return stateManager.getState(); }
  function withWorkflowAdmissionLock(operation) {
    return serializeKeyed(workflowAdmissionLocks, "management-admission", operation);
  }
  function workflowPersonaUids(current, workflowId) {
    const workflow = current.workflows?.[workflowId];
    if (!workflow) throw makeIntegrationError(INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND);
    return [...new Set((workflow.steps || []).map((step) => {
      const profile = current.profiles?.[step.profileId];
      return profile?.managed && !profile.rotationRole ? String(profile.personaUid || "").trim().toLowerCase() : "";
    }).filter(Boolean))].sort();
  }

  function assertDirectPersonaAuthority(current, personaUids, allowDirectIntent, currentPolicy) {
    const wanted = new Set((personaUids || []).map((uid) => String(uid || "").trim().toLowerCase()).filter(Boolean));
    if (!wanted.size) return;
    const usesDirect = Object.values(current.profiles || {}).some((profile) =>
      profile?.managed && !profile.rotationRole
      && wanted.has(String(profile.personaUid || "").trim().toLowerCase())
      && profile.routeId === DIRECT_ROUTE_ID);
    if (usesDirect && (allowDirectIntent !== true || currentPolicy.allowDirect !== true)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED,
        "Direct routing requires request intent and local authority");
    }
  }

  function sameSortedStrings(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
  function expectedPersonaUidSet(value) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return null;
    const normalized = value.map((item) => item.trim().toLowerCase());
    return [...new Set(normalized)].sort();
  }
  function expectedLeaseSet(value) {
    if (!Array.isArray(value)) return null;
    const pairs = [];
    for (const item of value) {
      if (!isPlainObject(item) || typeof item.personaUid !== "string" || !item.personaUid.trim() ||
          typeof item.leaseId !== "string" || !item.leaseId.trim()) return null;
      pairs.push({ personaUid: item.personaUid.trim().toLowerCase(), leaseId: item.leaseId.trim() });
    }
    pairs.sort((a, b) => a.personaUid.localeCompare(b.personaUid) || a.leaseId.localeCompare(b.leaseId));
    if (new Set(pairs.map((item) => item.personaUid)).size !== pairs.length) return null;
    return pairs;
  }
  function sameLeaseSet(left, right) {
    return left.length === right.length && left.every((item, index) =>
      item.personaUid === right[index].personaUid && item.leaseId === right[index].leaseId);
  }
  async function policy() { return normalizeIntegrationPolicy((await state()).global?.integration); }

  const utf8 = (value) => new TextEncoder().encode(String(value ?? ""));
  const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  async function sha256(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
  async function artifactOwnerKey(senderId) {
    return sha256(utf8(`personamonkey/external-artifact-owner/v1\0${String(senderId || "")}`));
  }
  function base64ToBytes(value) {
    if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Input chunk encoding is invalid");
    }
    const raw = atob(value);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
  function authorizedAutomation(policyValue) {
    if (policyValue.allowExternalAutomation !== true) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.AUTOMATION_NOT_ALLOWED);
    }
  }
  function authorizeAutomationSender(senderId, policyValue) {
    authorizedAutomation(policyValue);
    automationSenders.add(String(senderId || ""));
  }
  function authorizedExecutableInstall(policyValue) {
    if (policyValue.allowExecutableInstall !== true) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.EXECUTABLE_INSTALL_NOT_ALLOWED);
    }
  }
  async function runtimeAvailability() {
    try {
      const value = await getExternalRuntimeAvailability();
      return {
        userScriptsPermission: value?.userScriptsPermission === true,
        userScriptsExecute: value?.userScriptsExecute === true,
        tabOwnership: value?.tabOwnership === true
      };
    } catch {
      return { userScriptsPermission: false, userScriptsExecute: false, tabOwnership: false };
    }
  }
  function externalExecutionAvailable(runtime) {
    return runtime.userScriptsPermission && runtime.userScriptsExecute && runtime.tabOwnership
      && typeof personaApi?.WorkflowRunner?.runExternalExecution === "function";
  }
  async function requireExternalExecutionRuntime() {
    const runtime = await runtimeAvailability();
    if (!externalExecutionAvailable(runtime)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.CAPABILITY_UNAVAILABLE, "Firefox userscript execution or owned-tab support is unavailable");
    }
    return runtime;
  }
  function activeLeaseForPersona(personaUid) {
    const key = String(personaUid || "").toLowerCase();
    const lease = controlLeases.get(key);
    return lease && lease.expiresAt > Date.now() ? lease : null;
  }
  function scheduleLeaseExpiry() {
    if (leaseExpiryTimer !== null) clearTimeout(leaseExpiryTimer);
    leaseExpiryTimer = null;
    let nextExpiry = Infinity;
    for (const lease of controlLeases.values()) nextExpiry = Math.min(nextExpiry, lease.expiresAt);
    if (!Number.isFinite(nextExpiry)) return;
    leaseExpiryTimer = setTimeout(() => {
      leaseExpiryTimer = null;
      void reapExpiredControlLeases().catch(() => {});
    }, Math.max(0, nextExpiry - Date.now()));
    leaseExpiryTimer?.unref?.();
  }
  async function routeFingerprint(profile, sourceState) {
    return sha256(utf8(JSON.stringify(stable({
      routeId: profile?.routeId || null,
      route: profile?.routeId ? sourceState?.routes?.[profile.routeId] || null : null,
      enforcePrivacyControls: sourceState?.global?.enforcePrivacyControls === true
    }))));
  }
  function zeroTransient(item) {
    if (item?.bytes instanceof Uint8Array) item.bytes.fill(0);
    if (Array.isArray(item?.chunks)) {
      for (const chunk of item.chunks) if (chunk instanceof Uint8Array) chunk.fill(0);
      item.chunks.length = 0;
    }
    if (typeof item?.value === "string") item.value = "";
  }
  function cleanExpiredTransient() {
    const time = Date.now();
    for (const [ref, item] of externalInputs) if (item.expiresAt <= time) {
      zeroTransient(item);
      externalInputs.delete(ref);
    }
    for (const [ref, item] of externalSecrets) if (item.expiresAt <= time) {
      zeroTransient(item);
      externalSecrets.delete(ref);
    }
    for (const [key, waiter] of inputWaiters) if (waiter.expiresAt <= time) {
      if (removeInputWaiter(key, waiter)) waiter.reject(makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_EXPIRED));
    }
  }
  function removeInputWaiter(key, waiter) {
    // Timer callbacks can already be queued when a waiter is submitted or
    // discarded. Identity-check before deletion so an old timer cannot erase
    // a newer waiter that reused the same execution/input key.
    if (inputWaiters.get(key) !== waiter) return false;
    clearTimeout(waiter.timer);
    inputWaiters.delete(key);
    return true;
  }
  function rejectExecutionWaiters(senderId, executionId) {
    for (const [key, waiter] of inputWaiters) if (waiter.senderId === senderId && waiter.executionId === executionId) {
      if (removeInputWaiter(key, waiter)) waiter.reject(makeIntegrationError(INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE));
    }
  }
  function discardExecutionTransient(senderId, executionId) {
    for (const [ref, item] of externalInputs) {
      if (item.senderId === senderId && item.executionId === executionId) {
        zeroTransient(item);
        externalInputs.delete(ref);
      }
    }
    for (const [ref, item] of externalSecrets) {
      if (item.senderId === senderId && item.executionId === executionId) {
        zeroTransient(item);
        externalSecrets.delete(ref);
      }
    }
    rejectExecutionWaiters(senderId, executionId);
    executionArtifactRefs.delete(executionId);
    const leaseIds = executionLeaseIds.get(executionId) || new Set();
    for (const leaseId of leaseIds) {
      const executions = executionsByLease.get(leaseId);
      executions?.delete(executionId);
      if (!executions?.size) executionsByLease.delete(leaseId);
    }
    executionLeaseIds.delete(executionId);
  }
  function discardSenderTransient(senderId) {
    for (const [ref, item] of externalInputs) if (item.senderId === senderId) {
      zeroTransient(item);
      externalInputs.delete(ref);
    }
    for (const [ref, item] of externalSecrets) if (item.senderId === senderId) {
      zeroTransient(item);
      externalSecrets.delete(ref);
    }
    for (const [key, waiter] of inputWaiters) if (waiter.senderId === senderId) {
      if (removeInputWaiter(key, waiter)) waiter.reject(makeIntegrationError(INTEGRATION_ERROR_CODES.AUTOMATION_NOT_ALLOWED));
    }
  }
  async function stopExecutionsForLease(lease, reason = "revoked") {
    const ids = executionsByLease.get(lease.leaseId) || new Set();
    for (const executionId of ids) {
      try { await requireMethod(personaApi, "WorkflowRunner", "stopExternalExecution")(lease.ownerSenderId, executionId); } catch {}
      discardExecutionTransient(lease.ownerSenderId, executionId);
      leaseLosses.set(executionId, { reason, expiresAt: Date.now() + 60 * 60_000 });
      while (leaseLosses.size > 512) leaseLosses.delete(leaseLosses.keys().next().value);
    }
    executionsByLease.delete(lease.leaseId);
  }
  async function reapExpiredLeaseUnderLock(key) {
    const lease = controlLeases.get(key);
    if (!lease || lease.expiresAt > Date.now()) return;
    controlLeases.delete(key);
    scheduleLeaseExpiry();
    await stopExecutionsForLease(lease, "expired");
  }
  async function reapExpiredControlLeases() {
    try {
      for (const [key, lease] of [...controlLeases]) {
        if (lease.expiresAt <= Date.now()) {
          await withPersonaLocks([key], () => reapExpiredLeaseUnderLock(key));
        }
      }
    } finally {
      scheduleLeaseExpiry();
    }
  }
  const leaseLosses = new Map();

  async function findArtifact(artifactId, sourceState = null, senderId = null) {
    const current = sourceState || await state();
    let matches = Object.values(current.scripts || {}).filter((script) => script?.externalArtifact?.artifactId === artifactId);
    if (senderId != null) {
      const expectedOwnerKey = await artifactOwnerKey(senderId);
      matches = matches.filter((script) => script.externalArtifact.ownerKey === expectedOwnerKey
        && script.externalArtifact.ownershipVerified !== false);
    }
    if (matches.length > 1) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT);
    return matches[0] || null;
  }
  async function assertArtifactIntegrity(script) {
    const identity = script?.externalArtifact;
    if (!identity || typeof identity.artifactId !== "string" || typeof identity.sha256 !== "string") {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND);
    }
    const actual = await sha256(utf8(script.code || ""));
    if (actual !== identity.sha256) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH);
    try { assertExternalArtifactMetadataMatchesSource(script, script.code); }
    catch { throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH); }
    return actual;
  }
  function artifactProjection(script, sourceState) {
    const identity = script.externalArtifact;
    const profiles = Object.values(sourceState.profiles || {}).filter((profile) =>
      profile?.managed && !profile.rotationRole && (script.profileIds || []).includes(profile.containerId));
    return {
      artifactId: identity.artifactId,
      sha256: identity.sha256,
      provenance: clone(identity.provenance),
      installedAt: identity.installedAt,
      scriptId: script.id,
      name: script.name,
      version: script.version,
      enabled: script.enabled !== false,
      autoRun: false,
      assignedPersonaUids: profiles.map((profile) => profile.personaUid).filter(Boolean)
    };
  }

  async function getScriptInputContext(tabId, scriptId) {
    const getContext = personaApi?.WorkflowRunner?.getExternalExecutionContext;
    if (typeof getContext !== "function") return null;
    return getContext(tabId, scriptId);
  }

  function scopedTransient(items, context, name, secret = false) {
    cleanExpiredTransient();
    const collection = secret ? externalSecrets : externalInputs;
    const item = [...collection.values()].find((entry) => entry.senderId === context.senderId
      && entry.executionId === context.executionId && entry.name === name
      && entry.executionId && entry.state !== "uploading"
      && entry.stepIds.includes(context.stepId) && entry.artifactIds.includes(context.artifactId));
    return item || null;
  }

  async function handleUserscriptInput({ tabId, scriptId, action, args = {} } = {}) {
    cleanExpiredTransient();
    const context = await getScriptInputContext(tabId, scriptId);
    if (!context) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
    const currentPolicy = await authorize(context.senderId);
    authorizedAutomation(currentPolicy);
    const name = String(args.name || "");
    if (!name || name.length > 128) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
    if (action === "wait") {
      const sensitivity = args.sensitivity === "secret" ? "secret" : "normal";
      const timeoutMs = Math.max(1000, Math.min(10 * 60_000, Number(args.timeoutMs) || 10 * 60_000));
      const waitId = `wait-${crypto.randomUUID()}`;
      const key = inputWaitKey(context.senderId, context.executionId, context.taskId || "", waitId);
      if (inputWaiters.has(key)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_REQUEST_NOT_ACTIVE);
      if (inputWaiters.size >= EXTERNAL_AUTOMATION_LIMITS.maxInputWaiters) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
      }
      const expiresAt = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const waiter = { senderId: context.senderId, executionId: context.executionId, waitId,
          stepId: context.stepId, taskId: context.taskId || null, artifactId: context.artifactId,
          name, sensitivity, expiresAt, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          if (removeInputWaiter(key, waiter)) reject(makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_EXPIRED));
        }, Math.max(0, expiresAt - Date.now()));
        waiter.timer?.unref?.();
        inputWaiters.set(key, waiter);
      });
    }
    const secret = action === "secret";
    const item = scopedTransient(null, context, name, secret);
    if (!item) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND);
    if (secret) {
      if (item.consumed) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND);
      item.consumed = true;
      const value = item.value;
      item.value = "";
      externalSecrets.delete(item.ref);
      return value;
    }
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const length = Math.max(0, Math.min(EXTERNAL_AUTOMATION_LIMITS.maxInputChunkBytes, Math.floor(Number(args.length) || 64 * 1024)));
    if (offset > item.bytes.length) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
    const bytes = item.bytes.subarray(offset, Math.min(item.bytes.length, offset + length));
    return { offset, nextOffset: offset + bytes.length, done: offset + bytes.length >= item.bytes.length,
      mediaType: item.mediaType, byteLength: item.bytes.length, dataBase64: bytesToBase64(bytes) };
  }

  async function authorize(senderId) {
    const current = await policy();
    if (senderId === INTERNAL_PCMS_INTEGRATION_SENDER_ID) {
      // Built-in PCMS is a first-party Integration-v1 principal. It bypasses
      // only the external-extension enable/trust-list gate; all operation-level
      // local authority flags remain exactly as configured by PersonaMonkey.
      return Object.freeze({ ...current, enabled:true });
    }
    if (!current.enabled) throw makeIntegrationError(INTEGRATION_ERROR_CODES.DISABLED, "Integration is disabled");
    if (selfExtensionId && senderId === selfExtensionId) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.UNAUTHORIZED, "Same-extension callers must use the PCMS Integration-v1 bridge or internal management API");
    }
    if (!isAuthorizedIntegrationSender(current, senderId)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.UNAUTHORIZED, "External extension is not authorized");
    }
    return current;
  }

  async function serializeKeyed(locks, key, task) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    locks.set(key, gate);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (locks.get(key) === gate) locks.delete(key);
    }
  }

  const serializeOperation = (senderId, operationId, task) =>
    serializeKeyed(operationLocks, operationKey(senderId, operationId), task);

  async function withArtifactLocks(artifactIds, task) {
    const keys = [...new Set((artifactIds || []).map((value) => String(value || "")).filter(Boolean))].sort();
    const enter = async (index) => index >= keys.length
      ? task()
      : serializeKeyed(artifactLocks, keys[index], () => enter(index + 1));
    return enter(0);
  }

  function emit({ type, entity = "system", entityId = null, data = null, revision } = {}) {
    let projectedData;
    try { projectedData = sanitizeIntegrationValue(data, { maxBytes: MAX_INTEGRATION_EVENT_BYTES }); }
    catch (error) {
      if (error?.code !== INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE) throw error;
      // Events are advisory and can be re-queried. An oversized event gives
      // an explicit recovery hint without failing an already applied mutation.
      projectedData = { requery: true };
    }
    const event = Object.freeze({
      version: INTEGRATION_PROTOCOL_VERSION,
      bootId,
      sequence: ++eventSequence,
      revision: Number.isInteger(revision) ? revision : stateManager.getRevision(),
      time: new Date().toISOString(),
      type: String(type || "state.changed").slice(0, 128),
      entity: String(entity || "system").slice(0, 64),
      entityId: entityId == null ? null : String(entityId).slice(0, 256),
      data: projectedData
    });
    for (const listener of [...subscribers]) {
      try { listener(event); } catch {}
    }
    return event;
  }

  async function refreshPersonaIndex() {
    const current = await state();
    for (const profile of Object.values(current.profiles || {})) {
      if (profile?.managed && !profile.rotationRole && profile.personaUid && profile.containerId) {
        personaIndex.set(profile.containerId, profile.personaUid);
      }
    }
    return current;
  }

  async function eventPersona(event) {
    const current = await state();
    const cookieStoreId = typeof event?.entityId === "string"
      ? event.entityId
      : (event?.data?.cookieStoreId || event?.data?.id || null);
    const profile = cookieStoreId ? current.profiles?.[cookieStoreId] : null;
    const personaUid = event?.data?.personaUid || profile?.personaUid || (cookieStoreId ? personaIndex.get(cookieStoreId) : null) || null;
    if (profile?.personaUid && profile?.containerId) personaIndex.set(profile.containerId, profile.personaUid);
    return { personaUid, cookieStoreId, current };
  }

  async function projectSourceEvent(event) {
    if (!event?.type) return;
    if (event.type === "state.changed") {
      // Keep the runtime-only correlation index current for Personas created
      // through the bundled management surface while preserving removed IDs
      // until their explicit removal event can be projected by UID.
      await refreshPersonaIndex();
      await reconcileAutomationAuthorization();
      await handlePersonaStateChange();
      emit({ type: "state.changed", entity: "state", data: { source: "personamonkey" }, revision: event.revision });
      return;
    }
    if (event.type === "persona.container.rotated" && event.data?.personaUid) {
      if (event.data.oldCookieStoreId) personaIndex.delete(event.data.oldCookieStoreId);
      if (event.data.newCookieStoreId) personaIndex.set(event.data.newCookieStoreId, event.data.personaUid);
      emit({
        type: "persona.container.rotated",
        entity: "persona",
        entityId: event.data.personaUid,
        data: {
          personaUid: event.data.personaUid,
          oldCookieStoreId: event.data.oldCookieStoreId || null,
          newCookieStoreId: event.data.newCookieStoreId || null,
          operationId: event.data.correlationOperationId || null,
          rotationOperationId: event.data.operationId || null
        },
        revision: event.revision
      });
      return;
    }
    if (["persona.changed", "persona.removed", "route.assignment.changed", "route.test.completed"].includes(event.type)) {
      const { personaUid, cookieStoreId } = await eventPersona(event);
      if (!personaUid) {
        // State events remain the recovery signal when a legacy event cannot be
        // correlated to a durable UID (for example, removal before a client connected).
        return;
      }
      const data = {
        personaUid,
        cookieStoreId,
        ...(event.type === "route.assignment.changed" ? { routeId: event.data?.routeId || null } : {}),
        ...(event.type === "route.test.completed" ? { result: publicRouteTest(event.data) } : {})
      };
      emit({ type: event.type, entity: "persona", entityId: personaUid, data, revision: event.revision });
      if (event.type === "persona.removed" && cookieStoreId) personaIndex.delete(cookieStoreId);
      return;
    }
    if (event.type.startsWith("workflow.job.")) {
      emit({ type: event.type, entity: "workflow-job", entityId: event.entityId || null, data: publicJob(event.data, await state()), revision: event.revision });
    }
  }
  let sourceProjectionTail = Promise.resolve();
  const unsubscribeSource = sourceEventHub?.subscribe
    ? sourceEventHub.subscribe((event) => {
        sourceProjectionTail = sourceProjectionTail
          .then(() => projectSourceEvent(event))
          .catch(() => {
            // Advisory events are not replayed. If projection itself fails,
            // emit only a generic recovery signal so consumers requery
            // authoritative state rather than receiving an unhandled rejection
            // or an out-of-order later event.
            emit({
              type: "state.changed",
              entity: "state",
              data: { requery: true },
              revision: stateManager.getRevision()
            });
          });
      })
    : null;

  async function resolvePersona(personaUid) {
    const current = await state();
    const matches = Object.values(current.profiles || {}).filter((profile) =>
      profile?.managed && !profile.rotationRole && String(profile.personaUid || "").toLowerCase() === String(personaUid || "").toLowerCase());
    if (matches.length !== 1) throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_NOT_FOUND, "Managed persona not found");
    const profile = matches[0];
    personaIndex.set(profile.containerId, profile.personaUid);
    return { profile, cookieStoreId: profile.containerId, state: current };
  }

  async function withPersonaLocks(personaUids, task) {
    const keys = [...new Set(personaUids.map((value) => String(value || "").toLowerCase()).filter(Boolean))].sort();
    const enter = (index) => index >= keys.length
      ? (async () => {
          for (const key of keys) await reapExpiredLeaseUnderLock(key);
          return task();
        })()
      : serializeKeyed(leaseLocks, keys[index], () => enter(index + 1));
    return enter(0);
  }

  async function requireOwnedLease(senderId, personaUid, expectedLeaseId = null) {
    cleanExpiredTransient();
    const key = String(personaUid || "").toLowerCase();
    const lease = controlLeases.get(key);
    if (!lease) {
      throw makeIntegrationError(expectedLeaseId ? INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST : INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID);
    }
    if (lease.ownerSenderId !== senderId) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID);
    }
    if (expectedLeaseId && lease.leaseId !== expectedLeaseId) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
    }
    if (lease.expiresAt <= Date.now()) {
      if (controlLeases.get(key) === lease) controlLeases.delete(key);
      scheduleLeaseExpiry();
      await stopExecutionsForLease(lease, "expired");
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
    }
    await resolvePersona(key);
    const current = await state();
    const matches = Object.values(current.profiles || {}).filter((profile) =>
      profile?.managed && !profile.rotationRole && String(profile.personaUid || "").toLowerCase() === key);
    if (matches.length !== 1) {
      if (controlLeases.get(key) === lease) controlLeases.delete(key);
      scheduleLeaseExpiry();
      await stopExecutionsForLease(lease, "persona-control-lease-lost");
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
    }
    const profile = matches[0];
    const currentRouteFingerprint = await routeFingerprint(profile, current);
    if (controlLeases.get(key) !== lease || lease.ownerSenderId !== senderId ||
        (expectedLeaseId && lease.leaseId !== expectedLeaseId) || lease.expiresAt <= Date.now()) {
      if (controlLeases.get(key) === lease && lease.expiresAt <= Date.now()) controlLeases.delete(key);
      scheduleLeaseExpiry();
      await stopExecutionsForLease(lease, lease.expiresAt <= Date.now() ? "expired" : "persona-control-lease-lost");
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
    }
    if (lease.routeId !== profile.routeId || lease.routeFingerprint !== currentRouteFingerprint || profile.archivedAt) {
      if (controlLeases.get(key) === lease) controlLeases.delete(key);
      scheduleLeaseExpiry();
      await stopExecutionsForLease(lease, "persona-control-lease-lost");
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
    }
    // The durable UID is authoritative across Firefox container rotation.
    lease.cookieStoreId = profile.containerId;
    return lease;
  }

  function assertFinalLeaseSet(senderId, personaUids, expectedLeaseIds, validatedLeases) {
    if (personaUids.length !== expectedLeaseIds.length || personaUids.length !== validatedLeases.length) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
    }
    for (let index = 0; index < personaUids.length; index += 1) {
      const key = String(personaUids[index] || "").toLowerCase();
      const lease = validatedLeases[index];
      if (!lease || controlLeases.get(key) !== lease || lease.ownerSenderId !== senderId ||
          lease.leaseId !== expectedLeaseIds[index]) {
        if (lease && controlLeases.get(key) !== lease) void stopExecutionsForLease(lease, "persona-control-lease-lost").catch(() => {});
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
      }
      if (lease.expiresAt <= Date.now()) {
        if (controlLeases.get(key) === lease) controlLeases.delete(key);
        scheduleLeaseExpiry();
        void stopExecutionsForLease(lease, "expired").catch(() => {});
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
      }
    }
  }

  function assertNoControlLease(personaUid) {
    const lease = activeLeaseForPersona(String(personaUid || "").toLowerCase());
    if (lease) throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);
  }

  function leaseProjection(lease) {
    return {
      leaseId: lease.leaseId,
      personaUid: lease.personaUid,
      owner: "self",
      operationId: lease.operationId,
      purpose: lease.purpose,
      acquiredAt: lease.acquiredAt,
      expiresAt: new Date(lease.expiresAt).toISOString()
    };
  }

  async function acquireControlLease(senderId, request) {
    const personaUid = request.params.personaUid;
    return serializeKeyed(leaseCapacityLocks, "registry", () => withPersonaLocks([personaUid], async () => {
      cleanExpiredTransient();
      const { profile } = await resolvePersona(personaUid);
      const key = String(profile.personaUid).toLowerCase();
      const current = activeLeaseForPersona(key);
      if (current && current.ownerSenderId !== senderId) throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);
      if (current) {
        await requireOwnedLease(senderId, profile.personaUid, current.leaseId);
        current.expiresAt = Date.now() + request.params.ttlMs;
        current.purpose = request.params.purpose;
        current.operationId = request.operationId;
        scheduleLeaseExpiry();
        return leaseProjection(current);
      }
      const senderLeaseCount = [...controlLeases.values()].filter((lease) => lease.ownerSenderId === senderId).length;
      if (controlLeases.size >= EXTERNAL_AUTOMATION_LIMITS.maxControlLeases
          || senderLeaseCount >= EXTERNAL_AUTOMATION_LIMITS.maxControlLeasesPerSender) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.OPERATION_CAPACITY, "Persona control lease capacity is full");
      }
      const activeProfileIds = typeof personaApi?.WorkflowRunner?.listActiveProfileIds === "function"
        ? await personaApi.WorkflowRunner.listActiveProfileIds()
        : (typeof personaApi?.WorkflowRunner?.listJobs === "function"
            ? (await personaApi.WorkflowRunner.listJobs(200)).flatMap((job) => [
                job.profileId,
                ...(job.stepProgress || []).map((step) => step?.profileId),
                ...(job.tasks || []).map((task) => task?.profileId)
              ]).filter(Boolean)
            : []);
      const profileId = profile.containerId;
      const conflictingJob = (Array.isArray(activeProfileIds) ? activeProfileIds : []).includes(profileId);
      if (conflictingJob) throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);
      const now = Date.now();
      const currentState = await state();
      const lease = {
        leaseId: `lease-${crypto.randomUUID()}`,
        personaUid: profile.personaUid,
        ownerSenderId: senderId,
        operationId: request.operationId,
        purpose: request.params.purpose.slice(0, 256),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: now + request.params.ttlMs,
        routeId: profile.routeId,
        routeFingerprint: await routeFingerprint(profile, currentState),
        cookieStoreId: profile.containerId
      };
      controlLeases.set(key, lease);
      scheduleLeaseExpiry();
      return leaseProjection(lease);
    }));
  }

  async function mutateControlLease(senderId, request) {
    cleanExpiredTransient();
    const candidate = [...controlLeases.values()].find((item) => item.leaseId === request.params.leaseId);
    if (!candidate) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID);
    }
    return withPersonaLocks([candidate.personaUid], async () => {
      const lease = controlLeases.get(String(candidate.personaUid).toLowerCase());
      if (!lease || lease.leaseId !== candidate.leaseId || lease.ownerSenderId !== senderId || lease.expiresAt <= Date.now()) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID);
      }
      await requireOwnedLease(senderId, lease.personaUid, lease.leaseId);
      if (request.command === "persona.control.renew") {
        lease.expiresAt = Date.now() + request.params.ttlMs;
        lease.operationId = request.operationId;
        scheduleLeaseExpiry();
        return leaseProjection(lease);
      }
      controlLeases.delete(String(lease.personaUid).toLowerCase());
      scheduleLeaseExpiry();
      await stopExecutionsForLease(lease, "released");
      return { leaseId: lease.leaseId, personaUid: lease.personaUid, released: true };
    });
  }

  function publicControlLease(lease, requesterId) {
    if (!lease) return { controlled: false };
    const owned = lease.ownerSenderId === requesterId;
    return {
      controlled: true,
      ...(owned ? { leaseId: lease.leaseId, purpose: lease.purpose } : {}),
      owner: owned ? "self" : "another-integration",
      personaUid: lease.personaUid,
      acquiredAt: lease.acquiredAt,
      expiresAt: new Date(lease.expiresAt).toISOString()
    };
  }

  async function listControlLeases() {
    cleanExpiredTransient();
    await reapExpiredControlLeases();
    const current = await state();
    return [...controlLeases.values()].map((lease) => {
      const profile = Object.values(current.profiles || {}).find((item) => item?.personaUid === lease.personaUid);
      return {
        leaseId: lease.leaseId,
        personaUid: lease.personaUid, personaName: String(profile?.name || "Persona").slice(0, 128),
        purpose: lease.purpose, acquiredAt: lease.acquiredAt,
        expiresAt: new Date(lease.expiresAt).toISOString(), status: "active"
      };
    });
  }

  async function withLocalMutationFence({ targetPersonaUids, blockPersonaUids = [], mode = "block", confirmedLeaseIds = [], revokeSenderIds = [], revokeDirectSenderIds = [], checkLeaseSnapshot = false } = {}, operation) {
    if (typeof operation !== "function" || !["block", "confirmed-human", "system-revoke"].includes(mode)) {
      throw new TypeError("Invalid local mutation fence request");
    }
    const resolveTargets = (source) => typeof targetPersonaUids === "function" ? targetPersonaUids(source) : targetPersonaUids;
    const resolveBlocked = (source) => typeof blockPersonaUids === "function" ? blockPersonaUids(source) : blockPersonaUids;
    return withWorkflowAdmissionLock(async () => {
      const firstState = await state();
      const targets = [...new Set((resolveTargets(firstState) || []).map((uid) => String(uid || "").trim().toLowerCase()).filter(Boolean))].sort();
      const blocked = [...new Set((resolveBlocked(firstState) || []).map((uid) => String(uid || "").trim().toLowerCase()).filter(Boolean))].sort();
      const lockTargets = [...new Set([...targets, ...blocked])].sort();
      return withPersonaLocks(lockTargets, async () => {
        const current = await state();
        const recheckedTargets = [...new Set((resolveTargets(current) || []).map((uid) => String(uid || "").trim().toLowerCase()).filter(Boolean))].sort();
        const recheckedBlocked = [...new Set((resolveBlocked(current) || []).map((uid) => String(uid || "").trim().toLowerCase()).filter(Boolean))].sort();
        if (!sameSortedStrings(targets, recheckedTargets) || !sameSortedStrings(blocked, recheckedBlocked)) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Mutation targets changed before admission", { retryable: true });
        }
        const confirmed = expectedLeaseSet(confirmedLeaseIds);
        if (mode === "confirmed-human" && !confirmed) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST, "The lease confirmation is invalid", { retryable: true });
        }
        const confirmedForTargets = (confirmed || []).filter((entry) => targets.includes(entry.personaUid));
        const relevant = [...new Set([...targets, ...blocked])].sort();
        const active = relevant.map((personaUid) => activeLeaseForPersona(personaUid)).filter(Boolean)
          .map((lease) => ({ personaUid: String(lease.personaUid).toLowerCase(), leaseId: lease.leaseId }))
          .sort((a, b) => a.personaUid.localeCompare(b.personaUid) || a.leaseId.localeCompare(b.leaseId));
        const activeForTargets = active.filter((entry) => targets.includes(entry.personaUid));
        if (mode === "confirmed-human" && !sameLeaseSet(confirmedForTargets, activeForTargets)) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST, "Persona control changed after confirmation", { retryable: true });
        }
        if (mode === "block" && checkLeaseSnapshot && !sameLeaseSet(confirmedForTargets, activeForTargets)) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST, "Persona control changed after confirmation", { retryable: true });
        }
        const allowedSenders = new Set((Array.isArray(revokeSenderIds) ? revokeSenderIds : []).map(String));
        const directOnlySenders = new Set((Array.isArray(revokeDirectSenderIds) ? revokeDirectSenderIds : []).map(String));
        const profileByPersonaUid = new Map(Object.values(current.profiles || {})
          .filter((profile) => profile?.managed && !profile.rotationRole && profile.personaUid)
          .map((profile) => [String(profile.personaUid).trim().toLowerCase(), profile]));
        const toRevoke = [];
        for (const entry of active) {
          const lease = controlLeases.get(entry.personaUid);
          if (!lease || lease.leaseId !== entry.leaseId) throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
          const isTarget = targets.includes(entry.personaUid);
          const isBlocked = blocked.includes(entry.personaUid);
          const revokeAll = isTarget && allowedSenders.has(lease.ownerSenderId);
          const revokeDirect = isTarget && directOnlySenders.has(lease.ownerSenderId)
            && profileByPersonaUid.get(entry.personaUid)?.routeId === DIRECT_ROUTE_ID;
          const revoke = revokeAll || revokeDirect;
          if (mode === "system-revoke") {
            if (isBlocked && !revoke && !allowedSenders.has(lease.ownerSenderId)) {
              throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);
            }
            if (revoke) toRevoke.push({ entry, lease });
          } else if ((isTarget || isBlocked) && mode === "block") {
            throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);
          } else if (isTarget && mode === "confirmed-human") {
            toRevoke.push({ entry, lease });
          }
        }
        // The complete lease set has been checked before any revocation, so a
        // retained owner in the block set cannot leave a partially applied fence.
        for (const { entry, lease } of toRevoke) {
          controlLeases.delete(entry.personaUid);
          scheduleLeaseExpiry();
          await stopExecutionsForLease(lease, mode === "system-revoke" ? "authorization-revoked" : "local-override");
        }
        return operation({ state: current, personaUids: targets, blockedPersonaUids: blocked });
      });
    });
  }

  async function overrideControlLocally(personaUid, expectedLeaseId) {
    const key = String(personaUid || "").toLowerCase();
    if (!key || typeof expectedLeaseId !== "string" || !expectedLeaseId.trim()) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID);
    }
    return withLocalMutationFence({ targetPersonaUids: [key], mode: "confirmed-human", confirmedLeaseIds: [{ personaUid: key, leaseId: expectedLeaseId }] },
      async () => ({ controlled: false, personaUid: key, overridden: true }));
  }

  async function runLocalWorkflow(workflowId, overrideConfirmation = null) {
    const hasConfirmation = isPlainObject(overrideConfirmation);
    const confirmation = hasConfirmation ? {
      expectedPersonaUids: expectedPersonaUidSet(overrideConfirmation.expectedPersonaUids),
      leases: expectedLeaseSet(overrideConfirmation.leases),
      takeControl: overrideConfirmation.takeControl === true
    } : null;
    if (hasConfirmation && (!confirmation.expectedPersonaUids || !confirmation.leases ||
        typeof overrideConfirmation.takeControl !== "boolean")) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Workflow control confirmation is invalid", { retryable: true });
    }

    const selectedPersonaUids = await withWorkflowAdmissionLock(async () => workflowPersonaUids(await state(), workflowId));
    if (confirmation && !sameSortedStrings(confirmation.expectedPersonaUids, selectedPersonaUids)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Workflow targets changed after confirmation", { retryable: true });
    }

    return withLocalMutationFence({
      targetPersonaUids: (current) => workflowPersonaUids(current, workflowId),
      mode: confirmation?.takeControl ? "confirmed-human" : "block",
      confirmedLeaseIds: confirmation?.leases || [], checkLeaseSnapshot: Boolean(confirmation)
    }, async ({ state: current, personaUids: currentPersonaUids }) => {
      if (!sameSortedStrings(currentPersonaUids, selectedPersonaUids) ||
          (confirmation && !sameSortedStrings(confirmation.expectedPersonaUids, currentPersonaUids))) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Workflow targets changed before run admission", { retryable: true });
      }

      return requireMethod(personaApi, "WorkflowRunner", "run")(workflowId);
    });
  }

  async function reconcileAutomationAuthorization() {
    const current = await policy();
    const availableSenders = new Set(current.enabled && current.allowExternalAutomation
      ? current.trustedExtensionIds
      : []);
    if (current.allowExternalAutomation) availableSenders.add(INTERNAL_PCMS_INTEGRATION_SENDER_ID);
    for (const senderId of automationSenders) {
      if (availableSenders.has(senderId)) continue;
      for (const [key, lease] of [...controlLeases]) if (lease.ownerSenderId === senderId) {
        await withPersonaLocks([key], async () => {
          if (controlLeases.get(key) !== lease) return;
          controlLeases.delete(key);
          scheduleLeaseExpiry();
          await stopExecutionsForLease(lease, "authorization-revoked");
        });
      }
      const recordList = await personaApi?.WorkflowRunner?.listExternalExecutions?.(senderId, 200).catch?.(() => []) || [];
      for (const execution of recordList) {
        if (["queued", "preparing", "running", "waiting-for-input", "stopping"].includes(String(execution.state).toLowerCase())) {
          try { await personaApi.WorkflowRunner.stopExternalExecution(senderId, execution.executionId); } catch {}
        }
        discardExecutionTransient(senderId, execution.executionId);
      }
      discardSenderTransient(senderId);
      for (const [port, record] of eventPorts) if (record.senderId === senderId) {
        record.disconnect?.();
        try { port.disconnect?.(); } catch {}
      }
      automationSenders.delete(senderId);
    }
    priorAuthorizedSenders = availableSenders;
  }

  async function handlePersonaStateChange() {
    for (const [key, candidate] of [...controlLeases]) {
      await withPersonaLocks([key], async () => {
        if (controlLeases.get(key) !== candidate) return;
        const current = await state();
        const profile = Object.values(current.profiles || {}).find((item) => item?.managed && !item.rotationRole
          && String(item.personaUid || "").toLowerCase() === key);
        const sameRoute = profile && !profile.archivedAt && profile.routeId === candidate.routeId
          && candidate.routeFingerprint === await routeFingerprint(profile, current);
        if (!sameRoute) {
          controlLeases.delete(key);
          scheduleLeaseExpiry();
          await stopExecutionsForLease(candidate, "persona-control-lease-lost");
        } else {
          candidate.cookieStoreId = profile.containerId;
        }
      });
    }
  }

  async function installArtifact(request, senderId) {
    const { artifactId, source, sha256: expectedHash, provenance } = request.params;
    const ownerKey = await artifactOwnerKey(senderId);
    const scriptId = EXTERNAL_ARTIFACT_SCRIPT_PREFIX
      + (await sha256(utf8(`${ownerKey}\0${artifactId}`))).slice(0, 32);
    const sourceBytes = utf8(source).byteLength;
    const commit = await stateManager.mutate(async (draft) => {
      const actualHash = await sha256(utf8(source));
      if (actualHash !== expectedHash) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH);
      const metadata = parseUserscriptMetadata(source, artifactId.slice(0, 200));
      const remoteResource = Object.values(metadata.resources || {}).some((value) => /^https?:/i.test(String(value)));
      if (metadata.requires.length || remoteResource || metadata.updateURL || metadata.downloadURL) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH, "External artifacts cannot use remote runtime dependencies or update URLs");
      }
      if (!metadata.compatibility?.compatible) throw makeIntegrationError(INTEGRATION_ERROR_CODES.USERSCRIPT_INCOMPATIBLE);
      const existing = Object.values(draft.scripts || {}).find((script) =>
        script?.externalArtifact?.artifactId === artifactId && script.externalArtifact.ownerKey === ownerKey);
      if (existing) {
        if (existing.externalArtifact.sha256 !== actualHash) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT);
        if (JSON.stringify(stable(existing.externalArtifact.provenance || {})) !== JSON.stringify(stable(provenance || {}))) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT,
            "External artifact provenance conflicts with the installed identity");
        }
        const existingHash = await sha256(utf8(existing.code || ""));
        if (existingHash !== actualHash) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT,
            "Imported artifact source does not match the authenticated install request");
        }
        try { assertExternalArtifactMetadataMatchesSource(existing, existing.code); }
        catch { throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT); }
        if (existing.externalArtifact.ownershipVerified === false) {
          existing.externalArtifact.ownershipVerified = true;
          existing.updatedAt = new Date().toISOString();
        }
        return clone(existing);
      }
      const externalScripts = Object.values(draft.scripts || {}).filter((script) => script?.externalArtifact);
      const ownerScripts = externalScripts.filter((script) => script.externalArtifact.ownerKey === ownerKey);
      const totalBytes = externalScripts.reduce((sum, script) => sum + utf8(script.code || "").byteLength, 0);
      const ownerBytes = ownerScripts.reduce((sum, script) => sum + utf8(script.code || "").byteLength, 0);
      if (externalScripts.length >= EXTERNAL_AUTOMATION_LIMITS.maxExternalArtifacts
          || ownerScripts.length >= EXTERNAL_AUTOMATION_LIMITS.maxExternalArtifactsPerSender
          || totalBytes + sourceBytes > EXTERNAL_AUTOMATION_LIMITS.maxExternalArtifactBytes
          || ownerBytes + sourceBytes > EXTERNAL_AUTOMATION_LIMITS.maxExternalArtifactBytesPerSender) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.OPERATION_CAPACITY, "External artifact capacity is full");
      }
      const installedAt = new Date().toISOString();
      const artifact = {
        artifactId, sha256: actualHash, ownerKey, ownershipVerified: true,
        provenance: clone(provenance), installedAt
      };
      const candidate = normalizeScript({
        ...metadata,
        id: scriptId,
        code: source,
        enabled: true,
        autoRun: false,
        profileIds: [],
        externalArtifact: artifact,
        updatedAt: installedAt
      }, scriptId);
      try { assertExternalArtifactMetadataMatchesSource(candidate, source); }
      catch { throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH); }
      draft.scripts ||= {};
      if (draft.scripts[scriptId]) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT);
      draft.scripts[scriptId] = clone(candidate);
      return clone(candidate);
    }, { expectedBootId: request.precondition.bootId, expectedRevision: request.precondition.revision });
    const current = commit.state || await state();
    const script = commit.result;
    await assertArtifactIntegrity(script);
    return artifactProjection(script, current);
  }

  async function artifactList(request, senderId) {
    const current = await state();
    const ownerKey = await artifactOwnerKey(senderId);
    const rows = Object.values(current.scripts || {}).filter((script) =>
      script?.externalArtifact?.ownerKey === ownerKey && script.externalArtifact.ownershipVerified !== false);
    for (const script of rows) await assertArtifactIntegrity(script);
    return pagedList(request, rows, (script) => script.externalArtifact.artifactId, (script) => artifactProjection(script, current));
  }

  async function artifactGet(artifactId, senderId) {
    const current = await state();
    const script = await findArtifact(artifactId, current, senderId);
    if (!script) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND);
    await assertArtifactIntegrity(script);
    return artifactProjection(script, current);
  }

  async function releaseArtifact(request, senderId) {
    if (request.params.confirm !== true) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Artifact release requires explicit confirmation");
    const current = await state();
    const script = await findArtifact(request.params.artifactId, current, senderId);
    if (!script) return { artifactId: request.params.artifactId, released: false };
    if ((script.profileIds || []).length || Object.values(current.workflows || {}).some((workflow) =>
      (workflow.steps || []).some((step) => (step.scriptIds || []).includes(script.id)))) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Artifact must be unassigned and unused by saved workflows before release");
    }
    for (const [executionId, ref] of executionArtifactRefs) {
      if (ref.senderId === senderId && ref.scriptIds.has(script.id)) {
        const execution = await personaApi.WorkflowRunner.getExternalExecution(senderId, executionId).catch?.(() => null);
        if (!execution || ["queued", "preparing", "running", "waiting-for-input", "stopping"].includes(String(execution.state).toLowerCase())) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Artifact is used by an active external execution");
        }
      }
    }
    await stateManager.mutate((draft) => { delete draft.scripts?.[script.id]; }, {
      expectedBootId: request.precondition.bootId, expectedRevision: request.precondition.revision
    });
    return { artifactId: request.params.artifactId, released: true };
  }

  function beginTransientInput(senderId, params) {
    cleanExpiredTransient();
    const senderRows = [...externalInputs.values()].filter((item) => item.senderId === senderId);
    if (externalInputs.size >= EXTERNAL_AUTOMATION_LIMITS.maxPendingInputs
        || senderRows.length >= EXTERNAL_AUTOMATION_LIMITS.maxPendingInputs) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
    }
    const total = senderRows.reduce((sum, item) => sum + Number(item.byteLength || 0), 0);
    if (total + params.byteLength > EXTERNAL_AUTOMATION_LIMITS.maxInputBytesPerSender) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
    }
    const inputRef = `input-${crypto.randomUUID()}`;
    const now = Date.now();
    const item = {
      ref: inputRef, senderId, name: params.name, mediaType: params.mediaType,
      byteLength: params.byteLength, sha256: params.sha256, stepIds: [...new Set(params.stepIds)],
      artifactIds: [...new Set(params.artifactIds)], expiresAt: now + params.ttlMs,
      state: "uploading", uploadedBytes: 0, chunks: [], executionId: null
    };
    externalInputs.set(inputRef, item);
    return { inputRef, byteLength: item.byteLength, expiresAt: new Date(item.expiresAt).toISOString(), state: item.state };
  }

  function appendTransientInput(senderId, params) {
    cleanExpiredTransient();
    const item = externalInputs.get(params.inputRef);
    if (!item || item.senderId !== senderId) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND);
    if (item.state !== "uploading") throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Input is already finalized");
    const chunk = base64ToBytes(params.chunkBase64);
    if (chunk.byteLength > EXTERNAL_AUTOMATION_LIMITS.maxInputChunkBytes) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
    if (params.offset !== item.uploadedBytes || item.uploadedBytes + chunk.byteLength > item.byteLength) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Input chunk offset does not match the staged input");
    }
    item.chunks.push(chunk);
    item.uploadedBytes += chunk.byteLength;
    return { inputRef: item.ref, uploadedBytes: item.uploadedBytes, byteLength: item.byteLength };
  }

  async function commitTransientInput(senderId, inputRef) {
    cleanExpiredTransient();
    const item = externalInputs.get(inputRef);
    if (!item || item.senderId !== senderId) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND);
    if (item.state === "committed") return { inputRef, state: item.state, byteLength: item.byteLength, sha256: item.sha256, expiresAt: new Date(item.expiresAt).toISOString() };
    if (item.uploadedBytes !== item.byteLength) throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Input is incomplete");
    const bytes = new Uint8Array(item.byteLength);
    let offset = 0;
    for (const chunk of item.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    item.chunks = [];
    const actual = await sha256(bytes);
    if (actual !== item.sha256) {
      externalInputs.delete(inputRef);
      bytes.fill(0);
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH, "Input SHA-256 does not match");
    }
    item.bytes = bytes;
    item.state = "committed";
    return { inputRef, state: item.state, byteLength: item.byteLength, sha256: item.sha256, expiresAt: new Date(item.expiresAt).toISOString() };
  }

  function discardTransient(senderId, ref, secret = false) {
    const collection = secret ? externalSecrets : externalInputs;
    const item = collection.get(ref);
    if (!item || item.senderId !== senderId) return { discarded: false };
    zeroTransient(item);
    collection.delete(ref);
    return { discarded: true };
  }

  function stageSecret(senderId, params) {
    cleanExpiredTransient();
    const size = utf8(params.value).byteLength;
    if (size > EXTERNAL_AUTOMATION_LIMITS.maxSecretBytes) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
    const senderRows = [...externalSecrets.values()].filter((item) => item.senderId === senderId);
    if (externalSecrets.size >= EXTERNAL_AUTOMATION_LIMITS.maxPendingSecrets
        || senderRows.length >= EXTERNAL_AUTOMATION_LIMITS.maxPendingSecrets
        || senderRows.reduce((sum, item) => sum + item.byteLength, 0) + size > EXTERNAL_AUTOMATION_LIMITS.maxSecretBytesPerSender) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
    }
    const secretRef = `secret-${crypto.randomUUID()}`;
    const now = Date.now();
    externalSecrets.set(secretRef, {
      ref: secretRef, senderId, name: params.name, value: params.value, byteLength: size,
      stepIds: [...new Set(params.stepIds)], artifactIds: [...new Set(params.artifactIds)],
      expiresAt: now + params.ttlMs, executionId: null, state: "committed", consumed: false
    });
    return { secretRef, expiresAt: new Date(now + params.ttlMs).toISOString(), byteLength: size };
  }

  function bindTransientRefs(senderId, executionId, plan, inputRefs = [], secretRefs = []) {
    const steps = new Map(plan.steps.map((step) => [step.id, new Set(step.artifacts)]));
    const staged = [];
    const bind = (collection, ref, secret) => {
      const item = collection.get(ref);
      if (!item || item.senderId !== senderId || item.expiresAt <= Date.now() || (secret ? item.state !== "committed" : item.state !== "committed")) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND);
      }
      if (item.executionId && item.executionId !== executionId) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
      const hasMatchingScope = [...steps].some(([stepId, artifacts]) => item.stepIds.includes(stepId)
        && item.artifactIds.some((artifactId) => artifacts.has(artifactId)));
      if (!hasMatchingScope) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
      if (!item.executionId) staged.push(item);
    };
    for (const ref of new Set(inputRefs)) bind(externalInputs, ref, false);
    for (const ref of new Set(secretRefs)) bind(externalSecrets, ref, true);
    for (const item of staged) item.executionId = executionId;
    return () => { for (const item of staged) if (item.executionId === executionId) item.executionId = null; };
  }

  function inputWaitKey(senderId, executionId, taskId, waitId) {
    return JSON.stringify([senderId, executionId, taskId, waitId]);
  }

  function submitWaitingInput(senderId, params) {
    const key = inputWaitKey(senderId, params.executionId, params.taskId, params.waitId);
    const waiter = inputWaiters.get(key);
    if (!waiter || waiter.expiresAt <= Date.now() || waiter.stepId !== params.stepId
        || waiter.taskId !== params.taskId || waiter.artifactId !== params.artifactId || waiter.name !== params.name) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_REQUEST_NOT_ACTIVE);
    }
    const isSecret = waiter.sensitivity === "secret";
    if ((params.secret === true) !== isSecret) throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
    if (utf8(params.value).byteLength > (isSecret
      ? EXTERNAL_AUTOMATION_LIMITS.maxSecretBytes
      : EXTERNAL_AUTOMATION_LIMITS.maxContinuationInputBytes)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.INPUT_CAPACITY);
    }
    for (const [waiterKey, value] of inputWaiters) if (value === waiter) {
      if (removeInputWaiter(waiterKey, waiter)) waiter.resolve(params.value);
      break;
    }
    return { executionId: params.executionId, waitId: params.waitId, stepId: params.stepId, taskId: params.taskId, name: params.name, accepted: true };
  }

  function executionWaitingInputs(senderId, executionId) {
    return [...inputWaiters.values()].filter((item) => item.senderId === senderId && item.executionId === executionId).map((item) => ({
      waitId: item.waitId, name: item.name, sensitivity: item.sensitivity,
      stepId: item.stepId, taskId: item.taskId, artifactId: item.artifactId,
      deadline: new Date(item.expiresAt).toISOString()
    }));
  }

  function executionStatus(job, executionId, senderId) {
    if (!job) throw makeIntegrationError(INTEGRATION_ERROR_CODES.EXECUTION_NOT_FOUND);
    let loss = leaseLosses.get(executionId);
    if (loss?.expiresAt <= Date.now()) {
      leaseLosses.delete(executionId);
      loss = null;
    }
    const waitingForInput = executionWaitingInputs(senderId, executionId);
    const state = waitingForInput.length && ["queued", "preparing", "running"].includes(String(job.state).toLowerCase())
      ? "waiting-for-input" : job.state;
    return {
      executionId,
      operationId: job.operationId || null,
      state,
      createdAt: job.createdAt || null,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      acknowledged: job.acknowledged === true || job.acknowledgedAt != null,
      progress: Array.isArray(job.stepProgress) ? job.stepProgress.map((step, index) => {
        const stepIndex = Number.isInteger(step.index) ? step.index : index;
        const stepPersonaUid = step.profileId ? (personaIndex.get(step.profileId) || null) : null;
        return {
        stepId: step.stepId || step.id || null, index: stepIndex, stepIndex,
        personaUid: stepPersonaUid, state: step.state || "unknown",
        completed: count(step.completed), failed: count(step.failed), stopped: count(step.stopped),
        retrying: count(step.retrying), active: count(step.active), total: count(step.total),
        startedAt: step.startedAt || null, finishedAt: step.finishedAt || null,
        tasks: (Array.isArray(job.tasks) ? job.tasks : []).filter((task) => task.stepIndex === stepIndex).map((task, taskIndex) => {
          const taskState = String(task.state || "unknown").toLowerCase();
          return {
            id: task.id, taskId: task.id, index: Number.isInteger(task.index) ? task.index : taskIndex,
            taskIndex: Number.isInteger(task.index) ? task.index : taskIndex, stepIndex,
            personaUid: task.profileId ? (personaIndex.get(task.profileId) || stepPersonaUid) : stepPersonaUid,
            state: task.state || "unknown", attempts: count(task.attempts),
            failed: taskState === "failed", stopped: taskState === "stopped",
            retrying: taskState === "retrying",
            active: ["opening", "loading", "waiting", "running"].includes(taskState),
            startedAt: task.startedAt || null, finishedAt: task.finishedAt || null,
            nextRetryAt: task.nextRetryAt || null
          };
        })
      }; }) : [],
      waitingForInput,
      failureCategory: loss ? INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST : (job.state === "failed" ? "EXECUTION_FAILED" : null),
      resultAvailable: ["completed", "failed", "stopped", "interrupted"].includes(String(job.state).toLowerCase())
        && job.acknowledged !== true && job.acknowledgedAt == null
    };
  }

  function operationFingerprintForExecution(params) {
    // Persist only a digest of the validated execution contract. Input payload
    // bytes and secret values remain exclusively in the memory-only broker.
    return sha256(utf8(JSON.stringify(stable({
      plan: params.plan,
      inputRefs: params.inputRefs || [],
      secretRefs: params.secretRefs || [],
      allowDirect: params.allowDirect === true
    }))));
  }

  async function makeInternalExternalPlan(rawPlan, senderId, expectedLeaseIds = null, allowDirectIntent = false) {
    const current = await state();
    assertDirectPersonaAuthority(current, rawPlan.steps.map((step) => step.personaUid),
      allowDirectIntent, await policy());
    const steps = [];
    const leaseIds = [];
    const leases = [];
    const artifactScriptIds = new Set();
    for (const rawStep of rawPlan.steps) {
      const resolved = await resolvePersona(rawStep.personaUid);
      const expectedLeaseId = expectedLeaseIds?.[leaseIds.length] || null;
      const lease = await requireOwnedLease(senderId, resolved.profile.personaUid, expectedLeaseId);
      leaseIds.push(lease.leaseId);
      leases.push(lease);
      const scriptIds = [];
      for (const artifactId of rawStep.artifacts) {
        const script = await findArtifact(artifactId, current, senderId);
        if (!script) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND);
        await assertArtifactIntegrity(script);
        if (script.enabled === false) throw makeIntegrationError(INTEGRATION_ERROR_CODES.USERSCRIPT_DISABLED);
        if (!script.profileIds?.includes(resolved.cookieStoreId)) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.USERSCRIPT_INCOMPATIBLE, "Artifact is not assigned to the requested Persona");
        }
        if (!analyzeGrants(script.grants || []).compatible) throw makeIntegrationError(INTEGRATION_ERROR_CODES.USERSCRIPT_INCOMPATIBLE);
        scriptIds.push(script.id);
        artifactScriptIds.add(script.id);
      }
      steps.push({
        id: rawStep.id,
        profileId: resolved.cookieStoreId,
        urls: [...rawStep.urls],
        scriptIds,
        concurrency: rawStep.concurrency || 1,
        completion: rawStep.completion || { mode: "signal", timeoutMs: 120000 },
        retries: rawStep.retries || 0,
        retryDelayMs: rawStep.retryDelayMs || 0,
        closeTabs: rawStep.closeTabs !== false,
        stopOnError: rawStep.stopOnError !== false
      });
    }
    return { workflow: { name: rawPlan.name || "External execution", enabled: true, steps }, leaseIds, leases, artifactScriptIds };
  }

  async function readStartRecord(senderId, operationId, requestHash) {
    if (!operationStore) return null;
    const record = await operationStore.get(senderId, operationId);
    if (!record) return null;
    if (record.command !== "execution.start" || record.requestFingerprint !== requestHash) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.OPERATION_CONFLICT);
    }
    return record;
  }

  async function writeStartRecord(senderId, request, requestHash, fields) {
    if (!operationStore) throw makeIntegrationError(INTEGRATION_ERROR_CODES.CAPABILITY_UNAVAILABLE, "Execution admission journal is unavailable");
    return operationStore.put(senderId, request.operationId, {
      command: "execution.start",
      fingerprint: fingerprint("execution.start", { requestFingerprint: requestHash }),
      requestFingerprint: requestHash,
      ...clone(fields)
    });
  }

  function executionAdmissionKey(senderId, operationId) {
    return JSON.stringify([String(senderId || ""), String(operationId || "")]);
  }

  async function reconcileAbandonedExecutionAdmissions(senderId, excludedOperationId = null) {
    if (typeof operationStore?.listForSender !== "function") return;
    const records = await operationStore.listForSender(senderId);
    for (const record of records) {
      if (record.command !== "execution.start" || record.state !== "pending"
          || record.operationId === excludedOperationId
          || activeExecutionAdmissions.has(executionAdmissionKey(senderId, record.operationId))) continue;

      let existing = record.executionId
        ? await requireMethod(personaApi, "WorkflowRunner", "getExternalExecution")(senderId, record.executionId)
        : null;
      if (!existing && record.requestFingerprint) {
        existing = await personaApi.WorkflowRunner.findExternalExecutionByOperation?.(
          senderId, record.operationId, record.requestFingerprint);
      }
      if (existing) {
        const executionId = existing.executionId || record.executionId;
        await operationStore.put(senderId, record.operationId, {
          ...record,
          state: "complete",
          executionId,
          result: executionStatus(existing, executionId, senderId),
          reconciledAt: new Date().toISOString()
        });
        continue;
      }

      await operationStore.put(senderId, record.operationId, {
        ...record,
        state: "failed",
        failureCode: INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE,
        terminalizedAt: new Date().toISOString()
      });
    }
  }

  const terminalAdmissionFailureCodes = new Set([
    INTEGRATION_ERROR_CODES.PERSONA_NOT_FOUND,
    INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND,
    INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH,
    INTEGRATION_ERROR_CODES.USERSCRIPT_DISABLED,
    INTEGRATION_ERROR_CODES.USERSCRIPT_INCOMPATIBLE,
    INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID,
    INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
    INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND,
    INTEGRATION_ERROR_CODES.INPUT_EXPIRED,
    INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED,
    INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED
  ]);

  function trackExternalExecution(senderId, executionId, leaseIds, artifactScriptIds) {
    const ownedLeaseIds = new Set(leaseIds || []);
    executionLeaseIds.set(executionId, ownedLeaseIds);
    for (const leaseId of ownedLeaseIds) {
      const executions = executionsByLease.get(leaseId) || new Set();
      executions.add(executionId);
      executionsByLease.set(leaseId, executions);
    }
    executionArtifactRefs.set(executionId, {
      senderId,
      scriptIds: new Set(artifactScriptIds || [])
    });
  }

  async function executeExternalStart(senderId, request) {
    const stepIds = (request.params.plan?.steps || []).map((step) => String(step.id || "").trim());
    const duplicateStepId = stepIds.find((stepId, index) => stepId && stepIds.indexOf(stepId) !== index);
    if (duplicateStepId) {
      const error = makeIntegrationError(INTEGRATION_ERROR_CODES.VALIDATION_FAILED, "External execution step IDs must be unique");
      error.issues = [{
        code: "step-id-duplicate",
        message: `External execution step id "${duplicateStepId.slice(0, 100)}" must be unique`,
        stepIndex: stepIds.indexOf(duplicateStepId)
      }];
      throw error;
    }
    await reconcileAbandonedExecutionAdmissions(senderId, request.operationId);
    const admissionKey = executionAdmissionKey(senderId, request.operationId);
    activeExecutionAdmissions.add(admissionKey);
    try {
    const requestHash = await operationFingerprintForExecution(request.params);
    let record = await readStartRecord(senderId, request.operationId, requestHash);
    if (record?.state === "complete") return clone(record.result);
    if (record?.state === "failed") {
      const code = Object.values(INTEGRATION_ERROR_CODES).includes(record.failureCode)
        ? record.failureCode : INTEGRATION_ERROR_CODES.INTERNAL_ERROR;
      throw makeIntegrationError(code);
    }

    const priorExecutionId = record?.state === "pending" ? record.executionId : null;
    let existing = priorExecutionId
      ? await requireMethod(personaApi, "WorkflowRunner", "getExternalExecution")(senderId, priorExecutionId)
      : null;
    if (!existing) {
      existing = await personaApi.WorkflowRunner.findExternalExecutionByOperation?.(senderId, request.operationId, requestHash);
    }
    if (existing) {
      const executionId = existing.executionId || priorExecutionId;
      const result = executionStatus(existing, executionId, senderId);
      await writeStartRecord(senderId, request, requestHash, { ...record, state: "complete", executionId, result });
      return result;
    }
    if (priorExecutionId && record?.admissionBootId !== bootId) {
      await writeStartRecord(senderId, request, requestHash, {
        ...record,
        state: "failed",
        failureCode: INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE,
        terminalizedAt: new Date().toISOString()
      });
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE,
        "Pending execution admission did not survive the previous background lifetime");
    }

    const requestedArtifactIds = request.params.plan.steps.flatMap((step) => step.artifacts);
    return serializeKeyed(executionAdmissionLocks, senderId, () => withArtifactLocks(requestedArtifactIds, async () => {
      await assertPrecondition(request);
      await requireExternalExecutionRuntime();
      let planResult;
      try {
        planResult = await makeInternalExternalPlan(request.params.plan, senderId, null, request.params.allowDirect === true);
      } catch (error) {
        if (priorExecutionId && terminalAdmissionFailureCodes.has(error?.code)) {
          await writeStartRecord(senderId, request, requestHash, {
            ...record,
            state: "failed",
            executionId: priorExecutionId,
            failureCode: error.code,
            terminalizedAt: new Date().toISOString()
          });
        }
        throw error;
      }
      const active = await requireMethod(personaApi, "WorkflowRunner", "listExternalExecutions")(senderId, 200);
      const activeCount = active.filter((job) => ["queued", "preparing", "running", "waiting-for-input", "stopping"].includes(String(job.state).toLowerCase())).length;
      if (activeCount >= EXTERNAL_AUTOMATION_LIMITS.maxExternalExecutions) throw makeIntegrationError(INTEGRATION_ERROR_CODES.OPERATION_CAPACITY);
      // Reuse the ID written before runner admission. If Firefox stopped after
      // the journal write but before the durable job write, the retry safely
      // admits the same owner/operation identity instead of poisoning the
      // operation as unresolved forever.
      const executionId = priorExecutionId || `execution-${crypto.randomUUID()}`;
      let rollbackBindings;
      try {
        rollbackBindings = bindTransientRefs(senderId, executionId, request.params.plan,
          request.params.inputRefs || [], request.params.secretRefs || []);
      } catch (error) {
        // Staged data is deliberately memory-only. After a background restart,
        // tell the caller to restage it using a fresh operation ID rather than
        // leaving an unrecoverable pending journal entry.
        if (priorExecutionId && error?.code === INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND) {
          await writeStartRecord(senderId, request, requestHash, {
            ...record, state: "failed", executionId, failureCode: INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND
          });
        }
        throw error;
      }
      // Persist the bounded admission before the orchestrator can create a job,
      // a tab, or any other browser side effect.
      if (!priorExecutionId) {
        try {
          await writeStartRecord(senderId, request, requestHash, {
            state: "pending", executionId, admittedAt: new Date().toISOString(),
            admissionBootId: bootId, fingerprintVersion: 1, leaseIds: [...planResult.leaseIds]
          });
        } catch (error) {
          rollbackBindings?.();
          throw error;
        }
      }
      const uids = request.params.plan.steps.map((step) => step.personaUid);
      const expectedLeaseIds = Array.isArray(record?.leaseIds) ? record.leaseIds : planResult.leaseIds;
      if (expectedLeaseIds.length !== planResult.leaseIds.length ||
          expectedLeaseIds.some((leaseId, index) => leaseId !== planResult.leaseIds[index])) {
        if (priorExecutionId) await writeStartRecord(senderId, request, requestHash, {
          ...record, state: "failed", executionId: priorExecutionId,
          failureCode: INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
          terminalizedAt: new Date().toISOString()
        });
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
      }
      const job = await withWorkflowAdmissionLock(() => withPersonaLocks(uids, async () => {
        // Re-resolve the explicit Persona UIDs and route/artifact contract
        // under the shared management admission gate, then require the exact leases observed
        // before the durable admission journal was written.
        const finalPlan = await makeInternalExternalPlan(request.params.plan, senderId, expectedLeaseIds, request.params.allowDirect === true);
        assertFinalLeaseSet(senderId, uids, expectedLeaseIds, finalPlan.leases);
        const admitted = await requireMethod(personaApi, "WorkflowRunner", "runExternalExecution")(
          finalPlan.workflow,
          { senderId, executionId, operationId: request.operationId, requestFingerprint: requestHash },
          () => assertFinalLeaseSet(senderId, uids, expectedLeaseIds, finalPlan.leases)
        );
        // Register owner references before releasing the same Persona locks
        // that fenced admission against release/revoke.
        trackExternalExecution(senderId, executionId, finalPlan.leaseIds, finalPlan.artifactScriptIds);
        return admitted;
      }));
      const result = executionStatus(job, executionId, senderId);
      await writeStartRecord(senderId, request, requestHash, { state: "complete", executionId, admittedAt: new Date().toISOString(), result });
      return result;
    }));
    } finally {
      activeExecutionAdmissions.delete(admissionKey);
    }
  }

  async function dispatchExternalAutomation(request, senderId, currentPolicy) {
    const params = request.params;
    const descriptor = getIntegrationCommandDescriptor(request.command);
    if (descriptor?.externalAutomation) authorizeAutomationSender(senderId, currentPolicy);
    if (descriptor?.executableInstall) authorizedExecutableInstall(currentPolicy);
    if (request.command.startsWith("persona.control.")) {
      if (request.command === "persona.control.acquire") return acquireControlLease(senderId, request);
      if (request.command === "persona.control.renew" || request.command === "persona.control.release") return mutateControlLease(senderId, request);
      return withPersonaLocks([params.personaUid], async () => {
        const lease = activeLeaseForPersona(String(params.personaUid).toLowerCase());
        return publicControlLease(lease, senderId);
      });
    }
    if (request.command === "userscript.artifact.install") {
      authorizedExecutableInstall(currentPolicy);
      return serializeKeyed(artifactCapacityLocks, "registry", () =>
        withArtifactLocks([params.artifactId], () => installArtifact(request, senderId)));
    }
    if (request.command === "userscript.artifact.list") return artifactList(request, senderId);
    if (request.command === "userscript.artifact.get") return artifactGet(params.artifactId, senderId);
    if (request.command === "userscript.artifact.assign" || request.command === "userscript.artifact.unassign") {
      authorizedExecutableInstall(currentPolicy);
      return withArtifactLocks([params.artifactId], async () => {
        const script = await findArtifact(params.artifactId, null, senderId);
        if (!script) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND);
        await assertArtifactIntegrity(script);
        const { cookieStoreId } = await resolvePersona(params.personaUid);
        const method = request.command.endsWith(".assign") ? "assign" : "unassign";
        const result = await requireMethod(personaApi, "UserscriptManager", method)(script.id, cookieStoreId, mutationOptions(request));
        const latest = await state();
        return { ...artifactProjection(await findArtifact(params.artifactId, latest, senderId), latest), assigned: method === "assign", personaUid: params.personaUid, userscript: result };
      });
    }
    if (request.command === "userscript.artifact.release") {
      authorizedExecutableInstall(currentPolicy);
      return withArtifactLocks([params.artifactId], () => releaseArtifact(request, senderId));
    }
    if (request.command === "execution.input.begin") return beginTransientInput(senderId, params);
    if (request.command === "execution.input.append") return appendTransientInput(senderId, params);
    if (request.command === "execution.input.commit") return commitTransientInput(senderId, params.inputRef);
    if (request.command === "execution.input.discard") return discardTransient(senderId, params.inputRef);
    if (request.command === "execution.secret.stage") return stageSecret(senderId, params);
    if (request.command === "execution.secret.discard") return discardTransient(senderId, params.secretRef, true);
    if (request.command === "execution.input.submit") return submitWaitingInput(senderId, params);
    if (request.command === "execution.start") return executeExternalStart(senderId, request);
    if (request.command === "execution.list") {
      await refreshPersonaIndex();
      const jobs = await requireMethod(personaApi, "WorkflowRunner", "listExternalExecutions")(senderId, params.limit || 50);
      return jobs.map((job) => executionStatus(job, job.executionId, senderId));
    }
    if (request.command === "execution.get") {
      await refreshPersonaIndex();
      const job = await requireMethod(personaApi, "WorkflowRunner", "getExternalExecution")(senderId, params.executionId);
      const result = executionStatus(job, params.executionId, senderId);
      if (["completed", "failed", "stopped", "interrupted"].includes(String(result.state).toLowerCase())) discardExecutionTransient(senderId, params.executionId);
      return result;
    }
    if (request.command === "execution.result.get") {
      const result = await requireMethod(personaApi, "WorkflowRunner", "getExternalExecutionResult")(senderId, params.executionId);
      if (!result) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESULT_NOT_AVAILABLE);
      return result;
    }
    if (request.command === "execution.result.ack") {
      await refreshPersonaIndex();
      const job = await requireMethod(personaApi, "WorkflowRunner", "acknowledgeExternalExecution")(senderId, params.executionId);
      discardExecutionTransient(senderId, params.executionId);
      return executionStatus(job, params.executionId, senderId);
    }
    if (request.command === "execution.cancel") {
      await refreshPersonaIndex();
      const job = await requireMethod(personaApi, "WorkflowRunner", "stopExternalExecution")(senderId, params.executionId);
      rejectExecutionWaiters(senderId, params.executionId);
      const result = executionStatus(job, params.executionId, senderId);
      if (["stopped", "completed", "failed", "interrupted"].includes(String(result.state).toLowerCase())) discardExecutionTransient(senderId, params.executionId);
      return result;
    }
    if (request.command === "execution.focus") {
      const result = await requireMethod(personaApi, "WorkflowRunner", "focusExternalExecution")(senderId, params.executionId, params.taskId || "");
      return { executionId: params.executionId, taskId: params.taskId || null, focused: result?.focused === true };
    }
    return null;
  }

  async function externalWorkflowToInternal(workflow, existing = null) {
    const current = await state();
    const profilesByUid = new Map(Object.values(current.profiles || {})
      .filter((profile) => profile?.managed && !profile.rotationRole && profile.personaUid && profile.containerId)
      .map((profile) => [String(profile.personaUid).toLowerCase(), profile]));
    const existingById = new Map((existing?.steps || []).map((step) => [step.id, step]));
    const steps = (workflow.steps || []).map((step) => {
      const profile = profilesByUid.get(String(step.personaUid || "").toLowerCase());
      if (!profile) throw makeIntegrationError(INTEGRATION_ERROR_CODES.PERSONA_NOT_FOUND, "Managed persona not found");
      const copy = clone(step);
      delete copy.cookieStoreId;
      delete copy.urlCount;
      if (copy.completion == null) delete copy.completion;
      const previous = existingById.get(step.id);
      if (previous && Array.isArray(previous.urls)) {
        // The external projection strips URL credentials/query/fragment. Keep
        // the original at the same step and index when a caller submits that
        // public URL unchanged, so a read/update round-trip cannot erase it.
        copy.urls = copy.urls.map((url, index) => {
          const old = previous.urls[index];
          return typeof old === "string" && sanitizeIntegrationValue(old) === url ? old : url;
        });
      }
      delete copy.personaUid;
      copy.profileId = profile.containerId;
      return copy;
    });
    const definition = clone(workflow);
    delete definition.id;
    delete definition.createdAt;
    delete definition.updatedAt;
    return { ...definition, steps };
  }

  async function assertPrecondition(request) {
    const actualBootId = stateManager.getBootId();
    const actualRevision = stateManager.getRevision();
    if (request.precondition.bootId !== actualBootId || request.precondition.revision !== actualRevision) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "State revision conflict", {
        retryable: true,
        details: {
          expectedBootId: request.precondition.bootId,
          actualBootId,
          expectedRevision: request.precondition.revision,
          actualRevision
        }
      });
    }
  }

  function mutationOptions(request, extra = {}) {
    return {
      expectedBootId: request.precondition?.bootId,
      expectedRevision: request.precondition?.revision,
      ...extra
    };
  }

  async function guardAuthority(request, currentPolicy) {
    const descriptor = getIntegrationCommandDescriptor(request.command);
    if (!descriptor) throw makeIntegrationError(INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND, "Unknown integration command");
    if (descriptor.externalAutomation) authorizedAutomation(currentPolicy);
    if (descriptor.executableInstall) authorizedExecutableInstall(currentPolicy);
    if (descriptor.destructive && (request.params.confirm !== true || currentPolicy.allowDestructive !== true)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED, "Destructive operation requires caller intent and durable local authority");
    }
    if (descriptor.directAuthority) {
      const requestsDirect = request.params.routeId === DIRECT_ROUTE_ID;
      if (requestsDirect && (request.params.allowDirect !== true || currentPolicy.allowDirect !== true)) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED, "Direct routing requires request intent and local authority");
      }
      // Commands that inherit an existing Persona route are rechecked at
      // their serialized side-effect boundary so the route snapshot cannot go stale.
    }
  }

  async function readOperation(senderId, request) {
    if (!operationStore || !request.operationId) return null;
    const record = await operationStore.get(senderId, request.operationId);
    if (!record) return null;
    if (record.command !== request.command || record.fingerprint !== fingerprint(request.command, request.params)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.OPERATION_CONFLICT, "operationId was already used for a different request");
    }
    return record;
  }

  async function writeOperation(senderId, request, record) {
    if (!operationStore) return null;
    return operationStore.put(senderId, request.operationId, {
      command: request.command,
      fingerprint: fingerprint(request.command, request.params),
      ...record
    });
  }

  async function executeCreate(senderId, request) {
    let record = await readOperation(senderId, request);
    if (record?.state === "complete") return clone(record.result);

    let personaUid = record?.personaUid || request.params.personaUid || null;
    if (!personaUid) personaUid = globalThis.crypto?.randomUUID?.();
    if (!personaUid) throw new Error("UUID generation is unavailable");

    const currentState = await state();
    const existing = Object.values(currentState.profiles || {}).find((profile) =>
      profile?.managed && !profile.rotationRole && String(profile.personaUid || "").toLowerCase() === personaUid.toLowerCase());
    if (existing) {
      if (!record) {
        throw makeIntegrationError(
          INTEGRATION_ERROR_CODES.PERSONA_UID_CONFLICT,
          "Caller-supplied personaUid already belongs to an existing Persona"
        );
      }
      const persona = await requireMethod(personaApi, "PersonaManager", "get")(existing.containerId);
      const result = { persona: publicPersona(persona || existing), reused: true };
      if (existing.containerId) personaIndex.set(existing.containerId, personaUid);
      await writeOperation(senderId, request, { state: "complete", personaUid, result });
      return result;
    }

    if (!record) {
      await assertPrecondition(request);
      record = await writeOperation(senderId, request, { state: "pending", personaUid });
    }

    const input = {
      name: request.params.name,
      color: request.params.color,
      icon: request.params.icon,
      description: request.params.description,
      routeId: request.params.routeId || BLOCK_ROUTE_ID,
      temporary: request.params.temporary,
      ttlHours: request.params.ttlHours,
      expiresAt: request.params.expiresAt,
      allowDirect: request.params.allowDirect === true,
      profile: { personaUid }
    };
    // Local policy can change while a correlated create waits on state or
    // storage. Recheck Direct authority at the actual browser-side boundary.
    await guardAuthority(request, await policy());
    const created = await requireMethod(personaApi, "PersonaManager", "create")(input, mutationOptions(request, {
      allowDirect: request.params.allowDirect === true
    }));
    const persona = await requireMethod(personaApi, "PersonaManager", "get")(created?.profile?.containerId || created?.container?.cookieStoreId);
    const result = { persona: publicPersona(persona || created?.profile), reused: false };
    const createdCookieStoreId = result.persona?.cookieStoreId || created?.profile?.containerId || created?.container?.cookieStoreId;
    if (createdCookieStoreId) personaIndex.set(createdCookieStoreId, personaUid);
    await writeOperation(senderId, request, { state: "complete", personaUid, result });
    emit({ type: "persona.changed", entity: "persona", entityId: personaUid, data: result.persona });
    return result;
  }

  async function executeWorkflowRun(senderId, request) {
    const record = await readOperation(senderId, request);
    if (record?.state === "complete") return clone(record.result);
    if (record?.state === "pending") {
      throw makeIntegrationError(
        INTEGRATION_ERROR_CODES.OPERATION_CONFLICT,
        "Workflow run status is ambiguous; requery jobs before choosing a new operationId",
        { retryable: true }
      );
    }
    const selectedPersonaUids = await withWorkflowAdmissionLock(async () =>
      workflowPersonaUids(await state(), request.params.workflowId));
    return withWorkflowAdmissionLock(() => withPersonaLocks(selectedPersonaUids, async () => {
      const current = await state();
      const currentPersonaUids = workflowPersonaUids(current, request.params.workflowId);
      assertDirectPersonaAuthority(current, currentPersonaUids, request.params.allowDirect === true, await policy());
      if (!sameSortedStrings(currentPersonaUids, selectedPersonaUids)) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.STATE_CONFLICT, "Workflow targets changed before run admission", { retryable: true });
      }
      for (const personaUid of currentPersonaUids) assertNoControlLease(personaUid);
      await assertPrecondition(request);
      await writeOperation(senderId, request, { state: "pending", workflowId: request.params.workflowId });
      let result;
      try {
        result = publicJob(
          await requireMethod(personaApi, "WorkflowRunner", "run")(request.params.workflowId),
          await state()
        );
      } catch (error) {
        // The bundled runner only rejects before durable job admission. Mark
        // the correlation failed so the same operation can be retried with a
        // fresh boot/revision precondition after correcting a pre-start error.
        await writeOperation(senderId, request, {
          state: "failed",
          workflowId: request.params.workflowId
        });
        throw error;
      }
      await writeOperation(senderId, request, {
        state: "complete",
        workflowId: request.params.workflowId,
        result
      });
      return result;
    }));
  }

  async function executeFullWipe(senderId, request) {
    let record = await readOperation(senderId, request);
    if (record?.state === "complete") return clone(record.result);

    const current = await state();
    const activeRotation = Object.values(current.personaRotations || {}).find((entry) =>
      String(entry?.personaUid || "").toLowerCase() === String(request.params.personaUid).toLowerCase());
    if (activeRotation && activeRotation.correlationOperationId !== request.operationId) {
      // The rotation layer resumes an active journal by UID. A different
      // external operation must not claim its result or event correlation.
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.OPERATION_CONFLICT, undefined, { retryable: true });
    }

    if (!record) {
      // A crash can leave the rotation journal intact while its separate
      // correlation record is missing. The matching journal is the recovery authority.
      const sourceCookieStoreId = activeRotation
        ? activeRotation.sourceCookieStoreId
        : (await resolvePersona(request.params.personaUid)).cookieStoreId;
      if (!activeRotation) await assertPrecondition(request);
      record = await writeOperation(senderId, request, {
        state: "pending",
        personaUid: request.params.personaUid,
        sourceCookieStoreId
      });
    } else {
      if (!activeRotation) {
        const matches = Object.values(current.profiles || {}).filter((profile) =>
          profile?.managed && !profile.rotationRole
          && String(profile.personaUid || "").toLowerCase() === String(request.params.personaUid).toLowerCase());
        if (matches.length === 1 && record.sourceCookieStoreId && matches[0].containerId !== record.sourceCookieStoreId) {
          const result = {
            personaUid: request.params.personaUid,
            oldCookieStoreId: record.sourceCookieStoreId,
            newCookieStoreId: matches[0].containerId,
            operationId: request.operationId,
            recovered: true
          };
          await writeOperation(senderId, request, { ...record, state: "complete", result });
          return result;
        }
      }
    }

    // Stage 3 resolves an active rotation by durable UID and deliberately
    // ignores the stale original precondition for recovery. If no journal
    // exists, the original boot/revision guard remains authoritative.
    const rotated = await requireMethod(personaApi, "StorageManager", "fullWipe")(
      request.params.personaUid,
      mutationOptions(request, { correlationOperationId: request.operationId })
    );
    const result = {
      personaUid: rotated.personaUid || request.params.personaUid,
      oldCookieStoreId: rotated.oldCookieStoreId || record.sourceCookieStoreId,
      newCookieStoreId: rotated.newCookieStoreId || rotated.profile?.containerId || null,
      operationId: request.operationId,
      rotationOperationId: rotated.operationId || null,
      recovered: false
    };
    await writeOperation(senderId, request, { ...record, state: "complete", result });
    return result;
  }

  async function execute(request, senderId, currentPolicy) {
    const descriptor = getIntegrationCommandDescriptor(request.command);
    if (!descriptor) throw makeIntegrationError(INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND, "Unknown integration command");
    const available = availability(personaApi);
    if ((descriptor.capability !== "system" && !available.has(descriptor.capability))
        || !commandAvailable(personaApi, request.command)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.CAPABILITY_UNAVAILABLE, "Capability is unavailable");
    }
    if (request.command === "persona.create" || request.command === "storage.fullWipe" || request.command === "workflow.run") {
      return serializeOperation(senderId, request.operationId, async () => {
        // Distinct external IDs must not race through the same Persona's rotation journal.
        const run = async () => {
          const correlated = await readOperation(senderId, request);
          if (correlated?.state === "complete") return clone(correlated.result);
          // A completed retry is a correlation lookup, not a new privileged side
          // effect. Pending/new work still requires current local authority.
          await guardAuthority(request, currentPolicy);
          if (request.command === "persona.create") {
            return withWorkflowAdmissionLock(() => executeCreate(senderId, request));
          }
          if (request.command === "storage.fullWipe") {
            return withPersonaLocks([request.params.personaUid], async () => {
              assertNoControlLease(request.params.personaUid);
              return executeFullWipe(senderId, request);
            });
          }
          return executeWorkflowRun(senderId, request);
        };
        return request.command === "storage.fullWipe"
          ? serializeKeyed(rotationLocks, String(request.params.personaUid).toLowerCase(), run)
          : run();
      });
    }

    await guardAuthority(request, currentPolicy);
    if (request.command === "execution.start") {
      return serializeOperation(senderId, request.operationId, () => dispatchExternalAutomation(request, senderId, currentPolicy));
    }
    if (descriptor.mutating || descriptor.sideEffecting) await assertPrecondition(request);

    if (descriptor.externalAutomation || descriptor.executableInstall || request.command.startsWith("persona.control.")) {
      return dispatchExternalAutomation(request, senderId, currentPolicy);
    }

    if (["persona.archive", "persona.destroy", "route.assign", "storage.clearCookies", "storage.clearSiteData"].includes(request.command)) {
      assertNoControlLease(request.params.personaUid);
    }

    if (request.command === "system.describe") {
      const runtime = await runtimeAvailability();
      const externalExecutionAvailableNow = externalExecutionAvailable(runtime);
      const describedCommands = listIntegrationCommandDescriptors()
        .filter((entry) => commandAvailable(personaApi, entry.command))
        .filter((entry) => !entry.destructive || currentPolicy.allowDestructive === true);
      return {
        product,
        productVersion,
        integrationProtocolVersion: INTEGRATION_PROTOCOL_VERSION,
        managementProtocolVersion,
        personaApiVersion,
        stateSchemaVersion: SCHEMA_VERSION,
        bootId,
        revision: stateManager.getRevision(),
        capabilities: [...new Set([
          ...listIntegrationCommandDescriptors()
            .filter((entry) => commandAvailable(personaApi, entry.command))
            .filter((entry) => !entry.destructive || currentPolicy.allowDestructive === true)
            .filter((entry) => !entry.externalAutomation || currentPolicy.allowExternalAutomation === true)
            .filter((entry) => !entry.executableInstall || currentPolicy.allowExecutableInstall === true)
            .map((entry) => entry.capability),
          ...(currentPolicy.allowExternalAutomation ? ["external-automation"] : []),
          ...(currentPolicy.allowExecutableInstall ? ["external-executable-install"] : []),
          ...(sourceEventHub ? ["events"] : [])
        ])],
        authority: {
          allowDestructive: currentPolicy.allowDestructive === true,
          allowDirect: currentPolicy.allowDirect === true,
          allowExternalAutomation: currentPolicy.allowExternalAutomation === true,
          allowExecutableInstall: currentPolicy.allowExecutableInstall === true
        },
        externalAutomation: {
          enabled: currentPolicy.allowExternalAutomation === true,
          executableInstallEnabled: currentPolicy.allowExecutableInstall === true,
          executionAvailable: externalExecutionAvailableNow,
          runtime: {
            userScriptsPermission: runtime.userScriptsPermission,
            userScriptsExecute: runtime.userScriptsExecute,
            tabOwnership: runtime.tabOwnership
          },
          limits: EXTERNAL_AUTOMATION_LIMITS
        },
        commands: describedCommands.map((entry) => {
          // Keep the command discoverable so clients can explain why execution
          // is unavailable, but do not label it usable until Firefox's optional
          // userscript API, permission, and tab-ownership support are ready.
          const available = entry.command !== "execution.start" || externalExecutionAvailableNow;
          return ({
            command: entry.command,
            capability: entry.capability,
            mutating: entry.mutating,
            sideEffecting: entry.sideEffecting,
            destructive: entry.destructive,
            externalAutomation: entry.externalAutomation,
            executableInstall: entry.executableInstall,
            batchable: entry.batchable,
            available,
            authorized: (entry.destructive ? currentPolicy.allowDestructive === true : true)
              && (entry.externalAutomation ? currentPolicy.allowExternalAutomation === true : true)
              && (entry.executableInstall ? currentPolicy.allowExecutableInstall === true : true)
              && available,
            directAuthorized: entry.directAuthority ? currentPolicy.allowDirect === true : null,
            required: entry.required,
            identifiers: entry.identifiers,
            params: entry.params,
            retry: entry.retry
          });
        })
      };
    }
    if (request.command === "system.status") {
      const diagnostics = personaApi.Diagnostics;
      const status = typeof diagnostics?.getSystemStatus === "function"
        ? await diagnostics.getSystemStatus()
        : await diagnostics.getStatus();
      return publicSystemStatus(status);
    }
    if (request.command === "persona.list") {
      return pagedList(request, await requireMethod(personaApi, "PersonaManager", "list")(), (persona) => persona.personaUid, publicPersona);
    }
    if (request.command === "persona.get") {
      const { cookieStoreId } = await resolvePersona(request.params.personaUid);
      const persona = await requireMethod(personaApi, "PersonaManager", "get")(cookieStoreId);
      return publicPersona(persona);
    }
    if (request.command === "persona.open") {
      return withPersonaLocks([request.params.personaUid], async () => {
        assertNoControlLease(request.params.personaUid);
        const current = await state();
        assertDirectPersonaAuthority(current, [request.params.personaUid], request.params.allowDirect === true, await policy());
        const { cookieStoreId } = await resolvePersona(request.params.personaUid);
        const tab = await requireMethod(personaApi, "PersonaManager", "open")(
          cookieStoreId,
          request.params.url,
          request.params.active !== false,
          mutationOptions(request)
        );
        const result = sanitizeIntegrationValue({ tabId: tab?.id ?? null, personaUid: request.params.personaUid, cookieStoreId });
        emit({
          type: "persona.changed",
          entity: "persona",
          entityId: request.params.personaUid,
          data: { personaUid: request.params.personaUid, cookieStoreId, opened: true }
        });
        return result;
      });
    }
    if (request.command === "persona.updateIdentity") {
      const { cookieStoreId } = await resolvePersona(request.params.personaUid);
      await requireMethod(personaApi, "PersonaManager", "updateIdentity")(cookieStoreId, request.params.changes, mutationOptions(request));
      const persona = await requireMethod(personaApi, "PersonaManager", "get")(cookieStoreId);
      const result = publicPersona(persona);
      emit({ type: "persona.changed", entity: "persona", entityId: request.params.personaUid, data: result });
      return result;
    }
    if (request.command === "persona.archive") {
      return withPersonaLocks([request.params.personaUid], async () => {
        assertNoControlLease(request.params.personaUid);
        const { cookieStoreId } = await resolvePersona(request.params.personaUid);
        await requireMethod(personaApi, "PersonaManager", "archive")(cookieStoreId, mutationOptions(request));
        const persona = await requireMethod(personaApi, "PersonaManager", "get")(cookieStoreId);
        const result = publicPersona(persona);
        emit({ type: "persona.changed", entity: "persona", entityId: request.params.personaUid, data: result });
        return result;
      });
    }
    if (request.command === "persona.destroy") {
      return withPersonaLocks([request.params.personaUid], async () => {
        assertNoControlLease(request.params.personaUid);
        const { cookieStoreId } = await resolvePersona(request.params.personaUid);
        await requireMethod(personaApi, "PersonaManager", "destroy")(cookieStoreId, mutationOptions(request));
        emit({ type: "persona.removed", entity: "persona", entityId: request.params.personaUid, data: { personaUid: request.params.personaUid, cookieStoreId } });
        personaIndex.delete(cookieStoreId);
        return { personaUid: request.params.personaUid, cookieStoreId, removed: true };
      });
    }
    if (request.command === "storage.inspect") {
      const { cookieStoreId } = await resolvePersona(request.params.personaUid);
      return publicStorage(await requireMethod(personaApi, "StorageManager", "inspect")(cookieStoreId));
    }
    if (request.command === "storage.clearCookies" || request.command === "storage.clearSiteData") {
      return withPersonaLocks([request.params.personaUid], async () => {
        assertNoControlLease(request.params.personaUid);
        const { cookieStoreId } = await resolvePersona(request.params.personaUid);
        const method = request.command === "storage.clearCookies" ? "clearCookies" : "clearSiteData";
        const result = await requireMethod(personaApi, "StorageManager", method)(cookieStoreId, mutationOptions(request));
        emit({ type: "persona.changed", entity: "persona", entityId: request.params.personaUid, data: { personaUid: request.params.personaUid, cookieStoreId, storageChanged: true } });
        return publicStorage(result);
      });
    }
    if (request.command === "route.list") {
      return pagedList(request, await requireMethod(personaApi, "RouteManager", "list")(), (route) => route.id, publicRoute);
    }
    if (request.command === "route.get") {
      const route = await requireMethod(personaApi, "RouteManager", "get")(request.params.routeId);
      if (!route) throw makeIntegrationError(INTEGRATION_ERROR_CODES.ROUTE_NOT_FOUND, "Route not found");
      return publicRoute(route);
    }
    if (request.command === "route.assign") {
      return withPersonaLocks([request.params.personaUid], async () => {
        assertNoControlLease(request.params.personaUid);
        const { cookieStoreId } = await resolvePersona(request.params.personaUid);
        await guardAuthority(request, await policy());
        const assigned = await requireMethod(personaApi, "RouteManager", "assign")(cookieStoreId, request.params.routeId, mutationOptions(request, {
          allowDirect: request.params.allowDirect === true
        }));
        emit({ type: "route.assignment.changed", entity: "persona", entityId: request.params.personaUid, data: { personaUid: request.params.personaUid, cookieStoreId, routeId: request.params.routeId } });
        return { persona: publicPersona(assigned?.profile), route: publicRoute(assigned?.route) };
      });
    }
    if (request.command === "route.test") {
      return withPersonaLocks([request.params.personaUid], async () => {
        const current = await state();
        assertDirectPersonaAuthority(current, [request.params.personaUid], request.params.allowDirect === true, await policy());
        const { cookieStoreId } = await resolvePersona(request.params.personaUid);
        const result = publicRouteTest(await requireMethod(personaApi, "RouteManager", "test")(cookieStoreId));
        emit({ type: "route.test.completed", entity: "persona", entityId: request.params.personaUid, data: { personaUid: request.params.personaUid, cookieStoreId, result } });
        return result;
      });
    }

    const currentState = await state();
    if (request.command === "userscript.list") {
      const ordinaryScripts = (await requireMethod(personaApi, "UserscriptManager", "list")())
        .filter((script) => !currentState.scripts?.[script.id]?.externalArtifact);
      return pagedList(request, ordinaryScripts, (script) => script.id, (script) => publicUserscript(script, currentState));
    }
    if (request.command === "userscript.get") {
      const script = await requireMethod(personaApi, "UserscriptManager", "get")(request.params.scriptId);
      if (!script || currentState.scripts?.[request.params.scriptId]?.externalArtifact) throw makeIntegrationError(INTEGRATION_ERROR_CODES.USERSCRIPT_NOT_FOUND, "Userscript not found");
      return publicUserscript(script, currentState);
    }
    if (request.command === "userscript.assign" || request.command === "userscript.unassign") {
      if (currentState.scripts?.[request.params.scriptId]?.externalArtifact) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.USERSCRIPT_NOT_FOUND, "Userscript not found");
      }
      const { cookieStoreId } = await resolvePersona(request.params.personaUid);
      const method = request.command === "userscript.assign" ? "assign" : "unassign";
      const script = await requireMethod(personaApi, "UserscriptManager", method)(
        request.params.scriptId,
        cookieStoreId,
        mutationOptions(request)
      );
      const result = publicUserscript(script, await state());
      emit({
        type: "userscript.assignment.changed",
        entity: "userscript",
        entityId: request.params.scriptId,
        data: {
          scriptId: request.params.scriptId,
          personaUid: request.params.personaUid,
          cookieStoreId,
          assigned: request.command === "userscript.assign"
        }
      });
      return result;
    }
    if (request.command === "workflow.list") {
      return pagedList(request, await requireMethod(personaApi, "WorkflowRunner", "list")(), (workflow) => workflow.id, (workflow) => publicWorkflow(workflow, currentState));
    }
    if (request.command === "workflow.get") {
      const workflow = await requireMethod(personaApi, "WorkflowRunner", "get")(request.params.workflowId);
      if (!workflow) throw makeIntegrationError(INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND, "Workflow not found");
      return publicWorkflow(workflow, currentState);
    }
    if (request.command === "workflow.create") {
      return withWorkflowAdmissionLock(async () => {
        const workflow = await requireMethod(personaApi, "WorkflowRunner", "create")(
          await externalWorkflowToInternal(request.params.workflow), mutationOptions(request));
        const result = publicWorkflow(workflow, await state());
        emit({ type: "workflow.changed", entity: "workflow", entityId: result?.id || null, data: result });
        return result;
      });
    }
    if (request.command === "workflow.update") {
      return withWorkflowAdmissionLock(async () => {
        const existing = await requireMethod(personaApi, "WorkflowRunner", "get")(request.params.workflowId);
        if (!existing) throw makeIntegrationError(INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND, "Workflow not found");
        const workflow = await requireMethod(personaApi, "WorkflowRunner", "update")(
          request.params.workflowId, await externalWorkflowToInternal(request.params.workflow, existing), mutationOptions(request));
        const result = publicWorkflow(workflow, await state());
        emit({ type: "workflow.changed", entity: "workflow", entityId: request.params.workflowId, data: result });
        return result;
      });
    }
    if (request.command === "workflow.delete") {
      return withWorkflowAdmissionLock(async () => {
        const result = await requireMethod(personaApi, "WorkflowRunner", "delete")(
          request.params.workflowId, mutationOptions(request));
        emit({ type: "workflow.removed", entity: "workflow", entityId: request.params.workflowId, data: { workflowId: request.params.workflowId } });
        return sanitizeIntegrationValue(result);
      });
    }
    if (request.command === "workflow.run") {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.INTERNAL_ERROR, "Correlated workflow run dispatch was bypassed");
    }
    if (request.command === "workflow.jobs.list") {
      return pagedList(request, await requireMethod(personaApi, "WorkflowRunner", "listJobs")({}), (job) => job.id, (job) => publicJob(job, currentState));
    }
    if (request.command === "workflow.jobs.get") {
      const job = await requireMethod(personaApi, "WorkflowRunner", "getJob")(request.params.jobId);
      if (!job) throw makeIntegrationError(INTEGRATION_ERROR_CODES.JOB_NOT_FOUND, "Workflow job not found");
      return publicJob(job, currentState);
    }
    if (request.command === "workflow.jobs.stop") {
      return publicJob(await requireMethod(personaApi, "WorkflowRunner", "stopJob")(request.params.jobId), await state());
    }
    if (request.command === "workflow.jobs.clearFinished") {
      return sanitizeIntegrationValue(await requireMethod(personaApi, "WorkflowRunner", "clearFinishedJobs")());
    }
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND, "Unknown integration command");
  }

  const boundedCorrelationId = (value) => typeof value === "string" ? value.slice(0, 256) : null;

  function failureResponse(rawRequest, error) {
    return {
      version: INTEGRATION_PROTOCOL_VERSION,
      requestId: boundedCorrelationId(rawRequest?.requestId),
      operationId: boundedCorrelationId(rawRequest?.operationId),
      ok: false,
      bootId,
      revision: stateManager.getRevision(),
      error: structuredIntegrationError(error)
    };
  }

  async function handleExternalRequest(rawRequest, sender = {}) {
    try {
      // Authorization precedes protocol parsing so disabled/untrusted callers
      // cannot use validation differences as a capability oracle.
      const currentPolicy = await authorize(sender?.id);
      await reapExpiredControlLeases();
      const request = validateIntegrationRequest(rawRequest);
      if (request.command.endsWith(".list")) {
        request.listRevision = stateManager.getRevision();
        request.listBootId = stateManager.getBootId();
      }
      const result = await execute(request, sender.id, currentPolicy);
      if (request.listRevision != null && (request.listRevision !== stateManager.getRevision() || request.listBootId !== stateManager.getBootId())) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.PAGE_STALE, undefined, { retryable: true });
      }
      return {
        version: INTEGRATION_PROTOCOL_VERSION,
        requestId: request.requestId,
        operationId: request.operationId || null,
        ok: true,
        bootId,
        revision: stateManager.getRevision(),
        // `system.describe` contains static schema names such as `source` and
        // `secret`, not user data. Retaining those literal names keeps its
        // feature-discovery contract usable; all runtime values keep normal
        // sensitive-field redaction.
        result: request.command === "execution.result.get"
          ? validateOwnerResultValue(result, { maxDepth: 12 })
          : sanitizeIntegrationValue(result, {
            maxDepth: request.command === "system.describe" ? 16 : 12,
            redactSensitive: request.command !== "system.describe"
          })
      };
    } catch (error) {
      return failureResponse(rawRequest, error);
    }
  }

  async function handleInternalRequest(rawRequest) {
    return handleExternalRequest(rawRequest, { id:INTERNAL_PCMS_INTEGRATION_SENDER_ID });
  }

  async function attachExternalPort(port) {
    if (port?.name !== INTEGRATION_EVENTS_PORT) {
      try { port?.disconnect?.(); } catch {}
      return false;
    }
    const senderId = port?.sender?.id;
    try {
      await authorize(senderId);
    } catch {
      try { port.disconnect?.(); } catch {}
      return false;
    }
    const senderKey = String(senderId || "");
    const senderPortCount = [...eventPorts.values()].filter((entry) => !entry.closed && entry.senderId === senderKey).length;
    if (eventPorts.size >= MAX_INTEGRATION_EVENT_PORTS_TOTAL || senderPortCount >= MAX_INTEGRATION_EVENT_PORTS_PER_SENDER) {
      try { port.disconnect?.(); } catch {}
      return false;
    }
    const record = { port, senderId: senderKey, closed: false, listener: null, disconnect: null };
    eventPorts.set(port, record);

    function disconnect() {
      if (record.closed) return;
      record.closed = true;
      if (record.listener) subscribers.delete(record.listener);
      eventPorts.delete(port);
    }
    record.disconnect = disconnect;
    try {
      if (typeof port.onDisconnect?.addListener !== "function") throw new Error("External event port has no disconnect lifecycle");
      port.onDisconnect.addListener(disconnect);
    } catch {
      disconnect();
      try { port.disconnect?.(); } catch {}
      return false;
    }

    try {
      await refreshPersonaIndex();
      await authorize(senderId);
      if (record.closed) return false;
    } catch {
      disconnect();
      try { port.disconnect?.(); } catch {}
      return false;
    }
    let deliveryTail = Promise.resolve();

    function listener(event) {
      if (record.closed) return;
      // Serialize this port's advisory stream. Authorization remains fresh for
      // every event, but a slower policy read for sequence N cannot allow
      // sequence N+1 to overtake it.
      deliveryTail = deliveryTail.then(async () => {
        if (record.closed) return;
        await authorize(senderId);
        if (record.closed) return;
        port.postMessage(event);
      }).catch(() => {
        disconnect();
        try { port.disconnect?.(); } catch {}
      });
    }

    record.listener = listener;
    subscribers.add(listener);
    return true;
  }

  async function attachInternalPort(port) {
    if (!port || port.name !== "PCMS_PERSONA_BROKER_EVENTS") {
      try { port?.disconnect?.(); } catch {}
      return false;
    }
    const delegated = Object.freeze({
      name: INTEGRATION_EVENTS_PORT,
      sender: Object.freeze({ id:INTERNAL_PCMS_INTEGRATION_SENDER_ID }),
      onDisconnect: port.onDisconnect,
      postMessage: (...args) => port.postMessage(...args),
      disconnect: () => port.disconnect()
    });
    return attachExternalPort(delegated);
  }

  async function reapTerminalExternalExecutions() {
    const getExecution = personaApi?.WorkflowRunner?.getExternalExecution;
    if (typeof getExecution !== "function") return;
    const tracked = [...executionArtifactRefs.entries()];
    await Promise.allSettled(tracked.map(async ([executionId, ref]) => {
      let job = null;
      try { job = await getExecution.call(personaApi.WorkflowRunner, ref.senderId, executionId); } catch {}
      if (!job || ["completed", "failed", "stopped", "interrupted"].includes(String(job.state).toLowerCase())) {
        discardExecutionTransient(ref.senderId, executionId);
      }
    }));
  }

  const transientMaintenanceTimer = setInterval(() => {
    cleanExpiredTransient();
    void reapExpiredControlLeases().catch(() => {});
    void reapTerminalExternalExecutions().catch(() => {});
  }, 30000);
  transientMaintenanceTimer?.unref?.();

  function dispose() {
    unsubscribeSource?.();
    clearInterval(transientMaintenanceTimer);
    if (leaseExpiryTimer !== null) clearTimeout(leaseExpiryTimer);
    leaseExpiryTimer = null;
    for (const item of externalInputs.values()) zeroTransient(item);
    for (const item of externalSecrets.values()) zeroTransient(item);
    externalInputs.clear();
    externalSecrets.clear();
    for (const [key, waiter] of inputWaiters) {
      if (removeInputWaiter(key, waiter)) waiter.reject(makeIntegrationError(INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE));
    }
    inputWaiters.clear();
    controlLeases.clear();
    for (const record of [...eventPorts.values()]) {
      record.disconnect?.();
      try { record.port.disconnect?.(); } catch {}
    }
    subscribers.clear();
  }

  return Object.freeze({
    bootId,
    handleExternalRequest,
    handleInternalRequest,
    failureResponse,
    attachExternalPort,
    attachInternalPort,
    authorize,
    handleUserscriptInput,
    listControlLeases,
    withLocalMutationFence,
    overrideControlLocally,
    runLocalWorkflow,
    emit,
    dispose,
    getSequence: () => eventSequence,
    listCommands: () => listIntegrationCommandDescriptors().map((entry) => entry.command)
  });
}
