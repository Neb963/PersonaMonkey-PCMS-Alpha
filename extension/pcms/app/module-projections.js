function frozenArray(value) {
  return Object.freeze(Array.isArray(value) ? value.map((item)=>Object.freeze({...item})) : []);
}

function moduleError(error) {
  return Object.freeze({
    available:false,
    code:typeof error?.code==="string" ? error.code : "PCMS_MODULE_UNAVAILABLE"
  });
}

async function capture(read) {
  try { return Object.freeze({available:true,value:await read()}); }
  catch(error) { return moduleError(error); }
}

export function createPcmsModuleProjectionService({runtime}={}) {
  if(!runtime||typeof runtime!=="object") throw new TypeError("PCMS module projections require runtime");
  const required=[
    ["deployer","listDeploymentViews"],
    ["explorer","listCandidates"],
    ["explorer","listReservations"],
    ["refresher","listCohortViews"],
    ["statistics","rebuild"],
    ["statistics","view"],
    ["provisioning","listAttempts"]
  ];
  for(const [owner,method] of required) {
    if(typeof runtime[owner]?.[method]!=="function") throw new TypeError("PCMS module runtime is incomplete");
  }

  async function snapshot() {
    const [deployer,candidates,reservations,refresher,statistics,provisioning]=await Promise.all([
      capture(()=>runtime.deployer.listDeploymentViews()),
      capture(()=>runtime.explorer.listCandidates()),
      capture(()=>runtime.explorer.listReservations()),
      capture(()=>runtime.refresher.listCohortViews()),
      capture(async()=>runtime.statistics.view(await runtime.statistics.rebuild())),
      capture(()=>runtime.provisioning.listAttempts())
    ]);

    return Object.freeze({
      deployer:deployer.available
        ? Object.freeze({available:true,revision:deployer.value.revision,items:frozenArray(deployer.value.deployments)})
        : deployer,
      explorer:Object.freeze({
        available:candidates.available&&reservations.available,
        candidates:candidates.available ? frozenArray(candidates.value.candidates) : Object.freeze([]),
        reservations:reservations.available ? frozenArray(reservations.value.reservations) : Object.freeze([]),
        error:(!candidates.available ? candidates.code : !reservations.available ? reservations.code : null)
      }),
      refresher:refresher.available
        ? Object.freeze({available:true,revision:refresher.value.revision,items:frozenArray(refresher.value.cohorts)})
        : refresher,
      statistics:statistics.available
        ? Object.freeze({available:true,cursor:statistics.value.cursor,lateEventCount:statistics.value.lateEventCount,items:frozenArray(statistics.value.metrics)})
        : statistics,
      provisioning:provisioning.available
        ? Object.freeze({available:true,items:Object.freeze(provisioning.value.map((row)=>Object.freeze({
            revision:row.revision,
            attemptId:row.value.attemptId,
            accountId:row.value.accountId,
            state:row.value.state,
            humanReason:row.value.humanReason ?? null
          })))})
        : provisioning
    });
  }

  return Object.freeze({snapshot});
}
