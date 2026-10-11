import { createAlphaStorage } from '../storage/store.js';
import { createControlStore } from '../core/control-store.mjs';
import { createAlphaCore } from '../core/core.mjs';
import { createUiDispatcher } from '../core/ui.mjs';
import { createPersonaBroker } from '../../pcms/core/persona-broker.js';
import { createPcmsInternalBrokerEndpoint } from '../../lib/pcms-internal-broker-endpoint.js';
import { createAccountsService } from '../features/accounts/service.mjs';
import { createInventoryService } from '../features/inventory/service.mjs';
import { createInventoryFactsStore } from '../features/inventory/facts.mjs';
import {createRefreshLedger} from '../flows/refresh/ledger.mjs';
import {createAttentionStore} from '../features/attention/store.mjs';
import {createBackupExporter,decodeBackupFile,UNENCRYPTED_CONSENT} from '../backup/bundle.js';
import {createBackupIntegration} from '../backup/integration/index.mjs';
import {createFirefoxBackupDownloads} from '../backup/integration/downloads.mjs';
import {createProductionBackupAuthority} from '../backup/integration/authority.mjs';
import {createSupplyFlow} from '../flows/supply/service.mjs';
import {createReleaseFlow} from '../flows/release/service.mjs';
import {createRefreshExecution} from '../flows/refresh/service.mjs';
import {createAiTaskStore} from '../features/ai/store.mjs';
import {createAttentionService,createDesktopAttentionNotifier} from '../features/attention/service.mjs';
import {createAlphaTabAllocator} from '../features/tabs/allocator.mjs';
import {createRefresherService} from '../features/refresher/service.mjs';

/** Static R4 graph, not a general scheduler/automation runtime. Every port
 * must be a compiled, trusted background adapter; no UI/runtime module can
 * supply scripts or raw browser/native execution. Core remains the sole
 * owner of storage, mutating operations and the global tab ceiling.
 */
export function createR4Flows({core,ports,ledger,attention}={}){
  if(!core?.storage || !core?.assertMutationAllowed || !core?.assertCurrent ||
    !ports || typeof ports!=='object' || !ledger?.read || !attention?.raise)
    throw new TypeError('R4 requires verified Core, ports, ledger and attention');
  // All R4 services must consume one trusted P103 instance and one source
  // catalog. A second browser executor or conflicting source reader can
  // otherwise invalidate release and refresh readbacks.
  if(!ports.supply || !ports.release || !ports.refresh ||
    !ports.supply.perchance || ports.supply.perchance!==ports.release.provider ||
    ports.supply.perchance!==ports.refresh.provider ||
    ports.supply.sources!==ports.release.sourceCatalog ||
    ports.release.journal!==ports.refresh.journal ||
    typeof ports.supply.contextForAccount!=='function')
    throw new TypeError('R4 requires one shared Persona-bound P103 executor, source catalog and journal');
  const supply=createSupplyFlow({...ports.supply,storage:core.storage,
    assertMutationAllowed:()=>core.assertMutationAllowed()});
  const release=createReleaseFlow({...ports.release,storage:core.storage,core,
    inventory:ports.inventory,facts:ports.facts});
  const refresh=createRefreshExecution({...ports.refresh,storage:core.storage,core,
    ledger,attention});
  return Object.freeze({supply,release,refresh,attention});
}


export function createAlphaHost({ browserRef, personaMonkeyReady, createCore = null, r4Ports = null } = {}) {
  let pending = null, current = null, constructedCores = 0, backupService = null, composedR4 = null;
  const services = Object.create(null);
  async function ensureCore() {
    if (pending) return pending;
    pending = (async () => {
      await personaMonkeyReady();
      const storage = createAlphaStorage(), control = createControlStore();
      const personaEndpoint=createPcmsInternalBrokerEndpoint();
      const broker = createPersonaBroker({ transport: personaEndpoint });
      const tabApi = {
        tag: (tabId, value) => browserRef.sessions.setTabValue(tabId, 'alphaOwnedPermit', value),
        async inspect(tabId) { const tab = await browserRef.tabs.get(tabId); return { cookieStoreId: tab.cookieStoreId, tag: await browserRef.sessions.getTabValue(tabId, 'alphaOwnedPermit') }; },
        async findOwned(value) {
          const owned = [];
          for (const tab of await browserRef.tabs.query({})) if (await browserRef.sessions.getTabValue(tab.id, 'alphaOwnedPermit') === value) owned.push({ id: tab.id, cookieStoreId: tab.cookieStoreId });
          return owned;
        },
        async isGone(_tabId, value) {
          // Firefox session tags survive restart. Search the actual live tabs,
          // never assume a reused numeric ID proves ownership or absence.
          const tabs = await browserRef.tabs.query({});
          for (const tab of tabs) if (await browserRef.sessions.getTabValue(tab.id, 'alphaOwnedPermit') === value) return false;
          return true;
        }
      };
      constructedCores++;
      const core = createCore ? createCore() : createAlphaCore({ storage, control, broker, alarms: browserRef.alarms, session: browserRef.storage.session, tabs: tabApi });
      try {
        await core.initialize();
        // Existing local service projections are immediately usable. Provider
        // executors, enrollment mutations and source configuration are composed
        // by their assigned flows; an absent bridge cannot fabricate authority.
        const unavailable = async () => { throw new Error('UNSUPPORTED_CAPABILITY'); };
        const configured=r4Ports?.supply?.perchance;
        const provider = configured && ['probe','read','observe','listGenerators'].every(
          key=>typeof configured[key]==='function') ? configured :
          {probe:unavailable,read:unavailable,listGenerators:unavailable,observe:unavailable};
        const contextForAccount = r4Ports?.supply?.contextForAccount ?? unavailable;
        const accounts = createAccountsService({
          storage:core.storage,broker,
          perchance:provider,contextForAccount
        });
        services.accounts = Object.freeze(Object.fromEntries(
          ['list','get','enroll','verifySession','previewRebind','rebind'].map(k => [k, accounts[k]])));
        const facts=createInventoryFactsStore();
        const inventory = createInventoryService({ storage: core.storage, provider, facts });
        services.inventory = Object.freeze(Object.fromEntries(
          ['list','get','inspectDrift','previewDelete','setIntent','observe','delete']
            .map(k => [k, inventory[k]])));
        // Backup runs under the SAME logical Alpha Core as all other flows.
        // The provider-owned import/export crosses only the strict in-process
        // typed Persona Broker backup port, never raw native or private state.
        const refreshLedger=createRefreshLedger(), attentionStore=createAttentionStore();
        const exporter=createBackupExporter({alphaStorage:core.storage,inventoryFactsStore:facts,
          refreshLedgerStore:refreshLedger,attentionStore,
          personaMonkeyExport:()=>personaEndpoint.backup({version:1,command:'export',consent:UNENCRYPTED_CONSENT})});
        const authority=createProductionBackupAuthority({core,storage:core.storage,facts,
          refreshLedger,attentionStore,personaEndpoint,
          // Only a compiled trusted P103 executor can verify a restored
          // account's LIVE session and unchanged provider source. With no
          // installed bridge, a nonempty fleet stays RECOVERY_HOLD.
          perchance:r4Ports?.supply?.perchance??null,
          contextForAccount:r4Ports?.supply?.contextForAccount??null});
        if(browserRef?.downloads?.onChanged?.addListener && browserRef?.storage?.local){
          const downloads=createFirefoxBackupDownloads({firefox:browserRef});
          backupService=createBackupIntegration({exporter,decodeFile:decodeBackupFile,downloads,authority});
        }
        // Background command transport is bounded by Alpha UI validation and
        // does not accept raw backup bytes. Later UI design may use a dedicated
        // permissioned file-picking entry, not user script eval.
        services.backup=Object.freeze({
          async previewExport(){
            return {ok:true,result:exporter.previewExport(),revision:(await core.storage.snapshot()).revision};
          },
          // A consented local download returns metadata only, never archive bytes.
          // Sensitive entries cannot be selected by a generic UI message.
          async export(params){
            if(!params?.options || Object.keys(params.options).length!==1 ||
              params.options.consent!==UNENCRYPTED_CONSENT)
              throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
            if(!backupService)
              throw Object.assign(new Error('UNSUPPORTED_CAPABILITY'),{code:'UNSUPPORTED_CAPABILITY'});
            const receipt=await backupService.exportToDownloads({
              consent:UNENCRYPTED_CONSENT,includeSensitive:[]});
            return {ok:true,result:receipt,revision:(await core.storage.snapshot()).revision};
          },
          async retain(){
            if(!backupService)return {ok:false,error:{code:'UNSUPPORTED_CAPABILITY'},revision:(await core.storage.snapshot()).revision};
            return {ok:true,result:await backupService.downloads.maintain(),revision:(await core.storage.snapshot()).revision};
          }
        });
        // P404's one durable inbox is independently usable even before
        // any Perchance executor is admitted. Editor opening always requires
        // independently verified Persona+session binding from a trusted port.
        const aiTasks=createAiTaskStore();
        const tabAllocator=createAlphaTabAllocator({core,aiTasks,
          verifyBinding:r4Ports?.verifyBinding ?? unavailable});
        const notifier=browserRef.notifications?.create ?
          createDesktopAttentionNotifier({notifications:browserRef.notifications}) : null;
        const attention=createAttentionService({store:attentionStore,aiTasks,
          tabs:tabAllocator,notifier,
          readRevision:async()=>(await core.storage.snapshot()).revision});
        services.attention=attention;
        // P304 retains scheduler ownership. UI cannot invoke the planning pass.
        // Its ledger revision is distinct from P102's global optimistic revision.
        const policy=r4Ports?.refresh?.refresher ?? createRefresherService({storage:core.storage});
        services.refresher=Object.freeze({
          status:params=>policy.status(params),
          async configure(params){
            const source=params?.options;
            if(!source || !Number.isSafeInteger(source.ledgerRevision) ||
              source.ledgerRevision<0)
              throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
            const {ledgerRevision,...settings}=source;
            return policy.configure({expectedRevision:ledgerRevision,options:settings});
          },
          async setEligibility(params){
            const opts=params?.options;
            if(!opts || !Number.isSafeInteger(opts.ledgerRevision) || opts.ledgerRevision<0)
              throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
            return policy.setEligibility({...params,expectedRevision:opts.ledgerRevision,
              options:{action:opts.action}});
          }
        });
        // With no PersonaMonkey-owned P103 executor or authenticated GitHub
        // source adapter, do not pretend R4 mutations are available.
        if(r4Ports){
          // The background-built graph shares projections and the actual P204
          // facts store. No duplicate inventory service or Core is created.
          const ports={...r4Ports,inventory:r4Ports.inventory??inventory,
            facts:r4Ports.facts??facts};
          composedR4=createR4Flows({core,ports,ledger:refreshLedger,attention});
        }
        // The UI sees only validated commands, not r4(), provider adapters,
        // Persona control leases or a generic scripting/execution gateway.
        const unavailableR4=()=>{throw Object.assign(
          new Error('UNSUPPORTED_CAPABILITY'),{code:'UNSUPPORTED_CAPABILITY'});};
        const r4=()=>composedR4??unavailableR4();
        services.supply=Object.freeze({
          preview:params=>r4().supply.preview(params),
          processBatch:params=>r4().supply.processBatch(params)
        });
        const methods=Object.freeze({
          stage:['aiOpId'],startAi:['stageOpId','aiOpId'],
          markReady:['stageOpId','taskId','expectedTaskRevision','editorUrl'],
          resume:[],reconcile:[],failUpdate:['stageOpId']
        });
        async function releaseCall(method,params){
          const opts=params?.options??{};
          if(!opts || typeof opts!=='object' || Array.isArray(opts) ||
            Object.keys(opts).some(k=>!methods[method].includes(k)))
            throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
          const account=(await core.storage.read('account',params.accountId)).item?.record;
          if(!account || account.sessionState!=='VERIFIED')
            throw Object.assign(new Error('WAITING_HUMAN'),{code:'WAITING_HUMAN'});
          if(account.epoch!==params.accountBindingEpoch)
            throw Object.assign(new Error('STALE_BINDING'),{code:'STALE_BINDING'});
          const resolver=r4Ports?.supply?.contextForAccount;
          if(typeof resolver!=='function')unavailableR4();
          const ctx=await resolver(Object.freeze({...account}));
          if(!ctx || ctx.accountId!==account.accountId ||
            ctx.personaUid!==account.personaUid ||
            ctx.epoch!==account.epoch ||
            !Number.isSafeInteger(ctx.routeRevision) ||
            !Number.isSafeInteger(ctx.capabilityRevision))
            throw Object.assign(new Error('STALE_BINDING'),{code:'STALE_BINDING'});
          // Only the background-resolved context ever reaches P402.
          return r4().release[method]({
            key:params.key,accountId:params.accountId,
            accountBindingEpoch:params.accountBindingEpoch,
            opId:params.opId,context:ctx,...opts
          });
        }
        services.release=Object.freeze({
          scanReady:params=>r4().release.scanReady(params),
          ...Object.fromEntries(Object.keys(methods).map(method=>
            [method,params=>releaseCall(method,params)]))
        });
        // P303's journal owns AI review records. Never expose native session
        // IDs, privileged dispatch data or user-provided prompt content.
        const aiProject=t=>({
          id:t.id,key:t.key,accountId:t.accountId,state:t.state,
          sourceHash:t.sourceHash,provenanceRefs:t.provenanceRefs,
          approvalRevision:t.approvalRevision
        });
        services.aiReview=Object.freeze({
          async queue(params={}){
            const state=await aiTasks.read();
            const limit=params.limit??100;
            if(!Number.isSafeInteger(limit)||limit<1||limit>200)
              throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
            let offset=0;
            if(params.cursor!==undefined){
              const match=/^v1\.(\d+)\.(\d+)$/.exec(params.cursor);
              if(!match || Number(match[1])!==state.revision)
                throw Object.assign(new Error('STALE_REVISION'),{code:'STALE_REVISION'});
              offset=Number(match[2]);
            }
            const rows=state.tasks.filter(t=>params.accountId===undefined ||
              t.accountId===params.accountId).sort((a,b)=>a.id.localeCompare(b.id));
            if(!Number.isSafeInteger(offset)||offset>rows.length)
              throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
            const end=offset+limit;
            return {ok:true,revision:(await core.storage.snapshot()).revision,
              result:{items:rows.slice(offset,end).map(aiProject),
                cursor:end<rows.length?'v1.'+state.revision+'.'+end:null,
                asOf:new Date().toISOString()}};
          },
          async get(params){
            const state=await aiTasks.read();
            const task=state.tasks.find(t=>t.id===params.key);
            if(!task)throw Object.assign(new Error('NOT_APPLIED'),{code:'NOT_APPLIED'});
            return {ok:true,revision:(await core.storage.snapshot()).revision,
              result:aiProject(task)};
          }
        });
        current = core; return core;
      } catch (error) { core.close(); throw error; }
    })().catch(async error => {
      pending = null; current = null; composedR4=null;
      // Wake failures stay visible without persisting raw provider exceptions.
      try { await browserRef.storage.session.set({ alphaCoreStatus: { version: 1, state: error?.code === 'RECOVERY_HOLD' ? 'RECOVERY_HOLD' : 'UNAVAILABLE' } }); } catch {}
      throw error;
    });
    return pending;
  }
  const ui = createUiDispatcher({ runtime: browserRef.runtime, ensureCore, services });
  return Object.freeze({ ensureCore, handleUi: ui.handle,
    /** Privileged background-only backup entry for operator-confirmed file handling.
     * There is no public raw-byte UI transport in Alpha. */
    backup: Object.freeze({
      async previewExport(){await ensureCore();return services.backup.previewExport();},
      async exportToDownloads(input){await ensureCore();if(!backupService)throw new Error('UNSUPPORTED_CAPABILITY');return backupService.exportToDownloads(input);},
      async stageRestore(file){await ensureCore();if(!backupService)throw new Error('UNSUPPORTED_CAPABILITY');return backupService.stageRestore(file);},
      async applyRestore(input){await ensureCore();if(!backupService)throw new Error('UNSUPPORTED_CAPABILITY');return backupService.applyRestore(input);},
      async reconcileRestore(input){await ensureCore();if(!backupService)throw new Error('UNSUPPORTED_CAPABILITY');return backupService.reconcileRestore(input);},
      async retain(){await ensureCore();if(!backupService)throw new Error('UNSUPPORTED_CAPABILITY');return backupService.downloads.maintain();}
    }),
    // Background-only compositions. There is no R5 UI command or remote
    // provider execution admission in this surface.
    async r4(){await ensureCore();if(!composedR4)
      throw Object.assign(new Error('R4 provider adapters unverified'),{code:'UNSUPPORTED_CAPABILITY'});
      return composedR4;},
    diagnostics: () => ({ constructedCores, activeCores: current === null ? 0 : 1 }),
    async handleAlarm(alarm) { const alreadyRunning = current !== null; const core = await ensureCore(); return alreadyRunning ? core.handleAlarm(alarm) : { started: true }; },
    wake: () => ensureCore(),
    async status() { return (await ensureCore()).readStatus(); }
  });
}
