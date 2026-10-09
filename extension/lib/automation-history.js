/** Filter private external-automation records from ordinary workflow history views. */
export function filterOrdinaryAutomationJobs(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => job && typeof job === "object" && !job.externalOwner);
}

/** Replace imported ordinary history while retaining private live execution records. */
export function preserveExternalAutomationJobs(currentJobs = {}) {
  const entries = Array.isArray(currentJobs)
    ? currentJobs.map((job, index) => [job?.id || String(index), job])
    : Object.entries(currentJobs || {});
  return Object.fromEntries(entries.filter(([, job]) => job && typeof job === "object" && job.externalOwner));
}
