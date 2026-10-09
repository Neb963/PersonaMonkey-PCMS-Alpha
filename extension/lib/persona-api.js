export function createPersonaApi({
  personaManager,
  storageManager = personaManager,
  workflowRunner,
  diagnostics,
  routeManager = personaManager,
  userscriptManager = personaManager
} = {}) {
  if (!personaManager) throw new Error("Persona API requires PersonaManager");
  const required = (service, method, label) => (...args) => {
    if (typeof service?.[method] !== "function") throw new Error(`${label || method} is unavailable`);
    return service[method](...args);
  };
  return Object.freeze({
    PersonaManager: Object.freeze({
      list: required(personaManager, "list"),
      get: required(personaManager, "get"),
      create: required(personaManager, "create"),
      updateIdentity: required(personaManager, "updateIdentity"),
      clone: required(personaManager, "clone"),
      archive: required(personaManager, "archive"),
      destroy: required(personaManager, "destroy"),
      export: required(personaManager, "export"),
      import: required(personaManager, "import"),
      open: required(personaManager, "open"),
      // Compatibility aliases for v0.7.0 consumers.
      duplicate: required(personaManager, "duplicate"),
      fullWipe: required(personaManager, "fullWipe"),
      storage: required(personaManager, "storage"),
      clearStorage: required(personaManager, "clearStorage")
    }),
    StorageManager: Object.freeze({
      inspect: required(storageManager, "inspectStorage", "StorageManager.inspect"),
      clear: required(storageManager, "wipeStorage", "StorageManager.clear"),
      clearCookies: required(storageManager, "clearCookies", "StorageManager.clearCookies"),
      clearSiteData: required(storageManager, "clearSiteData", "StorageManager.clearSiteData"),
      fullWipe: required(storageManager, "wipeStorage", "StorageManager.fullWipe")
    }),
    UserscriptManager: Object.freeze({
      list: required(userscriptManager, "listUserscripts", "UserscriptManager.list"),
      get: required(userscriptManager, "getUserscript", "UserscriptManager.get"),
      assign: required(userscriptManager, "assignUserscript", "UserscriptManager.assign"),
      unassign: required(userscriptManager, "unassignUserscript", "UserscriptManager.unassign")
    }),
    WorkflowRunner: Object.freeze({
      list: required(workflowRunner, "list", "WorkflowRunner.list"),
      get: required(workflowRunner, "get", "WorkflowRunner.get"),
      create: required(workflowRunner, "create", "WorkflowRunner.create"),
      update: required(workflowRunner, "update", "WorkflowRunner.update"),
      delete: required(workflowRunner, "delete", "WorkflowRunner.delete"),
      run: required(workflowRunner, "run", "WorkflowRunner.run"),
      listJobs: required(workflowRunner, "listJobs", "WorkflowRunner.listJobs"),
      listActiveProfileIds: async (...args) => {
        if (typeof workflowRunner?.listActiveProfileIds === "function") return workflowRunner.listActiveProfileIds(...args);
        if (typeof workflowRunner?.listJobs !== "function") return [];
        const jobs = await workflowRunner.listJobs(200);
        return [...new Set((Array.isArray(jobs) ? jobs : [])
          .filter((job) => ["queued", "preparing", "running", "stopping"].includes(String(job?.state || "").toLowerCase()))
          .flatMap((job) => [job.profileId, ...(job.stepProgress || []).map((step) => step?.profileId), ...(job.tasks || []).map((task) => task?.profileId)])
          .filter(Boolean))];
      },
      getJob: required(workflowRunner, "getJob", "WorkflowRunner.getJob"),
      stopJob: required(workflowRunner, "stopJob", "WorkflowRunner.stopJob"),
      clearFinishedJobs: required(workflowRunner, "clearFinishedJobs", "WorkflowRunner.clearFinishedJobs"),
      runExternalExecution: required(workflowRunner, "runExternalExecution", "WorkflowRunner.runExternalExecution"),
      listExternalExecutions: required(workflowRunner, "listExternalExecutions", "WorkflowRunner.listExternalExecutions"),
      getExternalExecution: required(workflowRunner, "getExternalExecution", "WorkflowRunner.getExternalExecution"),
      findExternalExecutionByOperation: required(workflowRunner, "findExternalExecutionByOperation", "WorkflowRunner.findExternalExecutionByOperation"),
      getExternalExecutionResult: required(workflowRunner, "getExternalExecutionResult", "WorkflowRunner.getExternalExecutionResult"),
      stopExternalExecution: required(workflowRunner, "stopExternalExecution", "WorkflowRunner.stopExternalExecution"),
      acknowledgeExternalExecution: required(workflowRunner, "acknowledgeExternalExecution", "WorkflowRunner.acknowledgeExternalExecution"),
      focusExternalExecution: required(workflowRunner, "focusExternalExecution", "WorkflowRunner.focusExternalExecution"),
      getExternalExecutionContext: required(workflowRunner, "getExternalExecutionContext", "WorkflowRunner.getExternalExecutionContext")
    }),
    Diagnostics: Object.freeze({
      getPersonaStatus: required(personaManager, "getPersonaStatus", "Diagnostics.getPersonaStatus"),
      getRouteStatus: required(personaManager, "getRouteStatus", "Diagnostics.getRouteStatus"),
      getSystemStatus: (...args) => {
        if (typeof diagnostics?.getSystemStatus === "function") return diagnostics.getSystemStatus(...args);
        if (typeof diagnostics?.getStatus === "function") return diagnostics.getStatus(...args);
        return { status: "unavailable" };
      },
      // `getStatus` remains a v0.7 compatibility alias.
      getStatus: (...args) => {
        if (typeof diagnostics?.getStatus === "function") return diagnostics.getStatus(...args);
        if (typeof diagnostics?.getSystemStatus === "function") return diagnostics.getSystemStatus(...args);
        return { status: "unavailable" };
      }
    }),
    RouteManager: Object.freeze({
      list: required(routeManager, "listRoutes", "RouteManager.list"),
      get: required(routeManager, "getRoute", "RouteManager.get"),
      assign: required(routeManager, "assignRoute", "RouteManager.assign"),
      test: required(routeManager, "testRoute", "RouteManager.test")
    })
  });
}
