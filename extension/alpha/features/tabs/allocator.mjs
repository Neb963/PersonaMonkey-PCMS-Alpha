/** P404: tab opening is a fenced P201 operation, never a second browser authority.
 * Only Core-owned permits may be attached/reconciled/released. There is deliberately
 * no tab-close method: a UI/editor tab remains the operator's to close. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const ensure = (ok, code = 'INVALID_REQUEST') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const valid = value => typeof value === 'string' && ID.test(value);
const pending = task => task?.state === 'COMPLETED' && task.reviewPending === true &&
  task.approvalRevision === null && task.dispatchPhase === 'APPLIED';

export function createAlphaTabAllocator({ core, aiTasks, verifyBinding,
  now = () => new Date().toISOString() } = {}) {
  ensure(core?.tabs && core?.operations && core?.storage && aiTasks?.read &&
    typeof verifyBinding === 'function' && typeof now === 'function');
  const validateTask = (task, id) => {
    ensure(task?.id === id && pending(task), 'WAITING_HUMAN');
    ensure(valid(task.accountId) && valid(task.personaUid) && SLUG.test(task.key) &&
      Number.isSafeInteger(task.bindingEpoch) && task.bindingEpoch > 0, 'RECOVERY_HOLD');
    return task;
  };
  async function openPendingReview({ taskId, opId } = {}) {
    ensure(valid(taskId) && valid(opId));
    const original = validateTask((await aiTasks.read()).tasks.find(t => t.id === taskId), taskId);
    const observed = await verifyBinding({accountId: original.accountId, key: original.key,
      accountBindingEpoch: original.bindingEpoch});
    ensure(observed?.accountId === original.accountId && observed?.key === original.key &&
      observed?.personaUid === original.personaUid && observed?.epoch === original.bindingEpoch,
    'STALE_BINDING');
    // The only cross-feature tab allocator is the existing durable global Core budget.
    const binding = {owner: 'attention', generation: 1, accountId: original.accountId,
      personaUid: original.personaUid, epoch: original.bindingEpoch};
    const permit = await core.tabs.reserve({binding, opId, targetKey: original.key});
    try {
      const latest = validateTask((await aiTasks.read()).tasks.find(t => t.id === taskId), taskId);
      ensure(latest.revision === original.revision && latest.savedSourceHash === original.savedSourceHash &&
        latest.savedSourceRevision === original.savedSourceRevision, 'STALE_REVISION');
      const url = `https://perchance.org/${latest.key}#edit`;
      const snapshot = await core.storage.list('operation');
      const applied = await core.operations.execute({
        binding, expectedRevision: snapshot.revision,
        operation: {opId, kind: 'persona.open', targetKey: latest.key,
          sourceRevision: `ai-review-${latest.revision}`, accountBindingEpoch: latest.bindingEpoch,
          phase: 'PREPARED', startedAt: now()},
        dispatch: authority => authority.mutate('persona.open', {
          personaUid: binding.personaUid, url, active: true, allowDirect: false}),
        readback: async ({ result }) => {
          const opened = result?.result;
          ensure(result?.ok === true && opened?.personaUid === binding.personaUid &&
            Number.isSafeInteger(opened.tabId) && opened.tabId > 0, 'UNCERTAIN');
          return {phase: 'APPLIED', evidence: {tabId: opened.tabId, personaUid: binding.personaUid}};
        }
      });
      const tabId = applied?.remoteEvidence?.observation?.tabId;
      ensure(Number.isSafeInteger(tabId) && tabId > 0, 'RECOVERY_HOLD');
      await core.tabs.attach({permit, tabId}); // Core checks Persona container and tags the exact tab.
      return { phase: 'ACTIVE', tabId, permit, taskId };
    } catch (e) {
      // Release only if Core proves no dispatch occurred or the tab is gone.
      // Ambiguous opens retain their durable budget slot for reconciliation.
      try { await core.tabs.release({permit}); } catch { /* retain permit */ }
      throw e;
    }
  }
  return Object.freeze({
    openPendingReview,
    reconcileOwned({permit,binding}) { return core.tabs.reconcile({permit,binding}); },
    releaseWhenGone({permit}) { return core.tabs.release({permit}); }
  });
}
