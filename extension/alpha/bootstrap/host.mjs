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

export function createAlphaHost({ browserRef, personaMonkeyReady, createCore = null } = {}) {
  let pending = null, current = null, constructedCores = 0, backupService = null;
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
        const provider = { probe: unavailable, listGenerators: unavailable, observe: unavailable };
        const accounts = createAccountsService({ storage: core.storage, broker: { request: unavailable }, perchance: provider, contextForAccount: unavailable });
        services.accounts = Object.freeze(Object.fromEntries(['list', 'get', 'previewRebind'].map(k => [k, accounts[k]])));
        const facts=createInventoryFactsStore();
        const inventory = createInventoryService({ storage: core.storage, provider, facts });
        services.inventory = Object.freeze(Object.fromEntries(['list', 'get', 'inspectDrift', 'previewDelete', 'setIntent'].map(k => [k, inventory[k]])));
        // Backup runs under the SAME logical Alpha Core as all other flows.
        // The provider-owned import/export crosses only the strict in-process
        // typed Persona Broker backup port, never raw native or private state.
        const refreshLedger=createRefreshLedger(), attentionStore=createAttentionStore();
        const exporter=createBackupExporter({alphaStorage:core.storage,inventoryFactsStore:facts,
          refreshLedgerStore:refreshLedger,attentionStore,
          personaMonkeyExport:()=>personaEndpoint.backup({version:1,command:'export',consent:UNENCRYPTED_CONSENT})});
        const authority=createProductionBackupAuthority({core,storage:core.storage,facts,
          refreshLedger,attentionStore,personaEndpoint});
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
          async retain(){
            if(!backupService)return {ok:false,error:{code:'UNSUPPORTED_CAPABILITY'},revision:(await core.storage.snapshot()).revision};
            return {ok:true,result:await backupService.downloads.maintain(),revision:(await core.storage.snapshot()).revision};
          }
        });
        current = core; return core;
      } catch (error) { core.close(); throw error; }
    })().catch(async error => {
      pending = null; current = null;
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
    diagnostics: () => ({ constructedCores, activeCores: current === null ? 0 : 1 }),
    async handleAlarm(alarm) { const alreadyRunning = current !== null; const core = await ensureCore(); return alreadyRunning ? core.handleAlarm(alarm) : { started: true }; },
    wake: () => ensureCore(),
    async status() { return (await ensureCore()).readStatus(); }
  });
}
