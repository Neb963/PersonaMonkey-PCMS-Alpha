/** R4-ISSUE99: trusted background-only restore ports.
 * PersonaMonkey is reached exclusively through its typed, in-process Broker
 * backup port; no Alpha code can read/write PersonaMonkey private state.
 * The P102 restore and each auxiliary DB are atomic individually, but NOT
 * globally atomic. A partial failure keeps P201 RECOVERY_HOLD persistently.
 */
import {decodeAlphaSnapshot,decodeInventoryFacts,decodeRestoreLocalSection}
  from '../bundle.js';

const RECOVER='RESTORE UNENCRYPTED BACKUP';
const COMPONENTS=Object.freeze(['alpha.records','alpha.journal','alpha.inventoryFacts',
 'alpha.refreshLedger','alpha.attentionInbox',
 'personaMonkey.personas','personaMonkey.routes','personaMonkey.userscripts','personaMonkey.workflows']);
const err=code=>Object.assign(new Error('Backup restore requires reconciliation.'),{code});
function ensure(x,code='RECOVERY_HOLD'){if(!x)throw err(code);}
function state(list){return list?.items?.map(x=>x.record)||[];}
export function createProductionBackupAuthority({core,storage,facts,refreshLedger,attentionStore,
  personaEndpoint}={}){
  ensure(core?.restore && storage?.restoreSnapshot && storage?.restoreReceipt &&
    facts?.replaceForRestore && refreshLedger?.replaceForRestore &&
    attentionStore?.replaceForRestore && typeof personaEndpoint?.backup==='function',
    'UNSUPPORTED_CAPABILITY');
  return Object.freeze({
    async supported(){
      await core.assertCurrent();
      return [...COMPONENTS]; // Sensitive/session/native data are not available.
    },
    begin:args=>core.restore.begin(args),
    status:args=>core.restore.status(args),
    async replace({holdId,bundle,expectedDigest}={}){
      ensure(typeof holdId==='string' && bundle?.manifest?.encrypted===false &&
        /^[a-f0-9]{64}$/.test(expectedDigest),'INVALID_REQUEST');
      const held=await core.restore.status({holdId});
      ensure(held.phase==='PREPARED' && held.digest===expectedDigest);
      const alpha=decodeAlphaSnapshot(bundle.alpha);
      const absent=new Set(bundle.manifest.absentItems.map(x=>x.item));
      const extra={};
      if(!absent.has('alpha.inventoryFacts'))extra.facts=decodeInventoryFacts(bundle.inventoryFacts);
      if(!absent.has('alpha.refreshLedger'))
        extra.refresh=decodeRestoreLocalSection(bundle.refreshLedger,'refreshLedger');
      if(!absent.has('alpha.attentionInbox'))
        extra.attention=decodeRestoreLocalSection(bundle.attentionInbox,'attentionInbox');
      const hasPersona=bundle.personaMonkey?.length>0;
      let personaPreview=null;
      // Validate the PersonaMonkey import BEFORE destructive Alpha writes.
      if(hasPersona){
        const receipt=await personaEndpoint.backup({version:1,command:'previewImport',
          bytes:bundle.personaMonkey,holdId,consent:RECOVER});
        ensure(receipt?.holdId===holdId && typeof receipt.authorizationId==='string');
        personaPreview=receipt.authorizationId;
      }
      const expectedRevision=(await storage.snapshot()).revision;
      // A restore is never retried automatically on an uncertain outcome.
      await storage.restoreSnapshot({snapshot:alpha,expectedRevision,holdId});
      if(extra.facts)await facts.replaceForRestore(extra.facts);
      if(extra.refresh)await refreshLedger.replaceForRestore(extra.refresh);
      if(extra.attention)await attentionStore.replaceForRestore(extra.attention);
      if(personaPreview){
        const receipt=await personaEndpoint.backup({version:1,command:'commitImport',
          authorizationId:personaPreview,holdId,consent:RECOVER});
        ensure(receipt?.state==='APPLIED' && receipt.holdId===holdId);
      }
      return core.restore.markApplied({holdId});
    },
    async reconcile({holdId}={}){
      const hold=await core.restore.status({holdId});
      if(hold.phase!=='APPLIED')return {core:false,bindings:false,sessions:false,
        providers:false,operations:false,inventory:false};
      const receipt=await storage.restoreReceipt();
      const [accountsRow,generatorsRow,opsRow,localFacts,refresh,attention]=await Promise.all([
        storage.list('account'),storage.list('generator'),storage.list('operation'),
        facts.list(),refreshLedger.read(),attentionStore.read()]);
      const accounts=state(accountsRow),generators=state(generatorsRow),ops=state(opsRow);
      const known=new Map(accounts.map(a=>[a.accountId,a]));
      let bindings=accounts.every(a=>typeof a.personaUid==='string');
      for(const account of accounts){
        try {
          const p=await core.broker.read('persona.get',{personaUid:account.personaUid});
          if(p.result?.personaUid!==account.personaUid)bindings=false;
        } catch {bindings=false;}
      }
      bindings &&= generators.every(g=>known.get(g.accountId)?.personaUid===g.personaUid &&
        known.get(g.accountId)?.epoch===g.accountBindingEpoch);
      const inventory=localFacts.every(f=>generators.some(g=>g.key===f.key &&
        f.accountId===g.accountId && f.personaUid===g.personaUid &&
        f.accountBindingEpoch===g.accountBindingEpoch)) &&
        Object.values(refresh.jobs).every(j=>!['PREPARED','DISPATCHING','RELOADING','RECONCILE'].includes(j.state)) &&
        attention.items.every(i=>i.notice!=='DISPATCHING');
      // Restored browser sessions and Perchance source ownership are NEVER
      // evidence of current authentication. They need independent P202/P103
      // readback; until then a nonempty account/generator fleet stays held.
      return {core:receipt?.holdId===holdId && receipt.durable===true,
        bindings,sessions:accounts.length===0,providers:generators.length===0,
        operations:ops.every(o=>!['PREPARED','DISPATCHING','UNCERTAIN','HELD'].includes(o.phase)),
        inventory};
    },
    release:args=>core.restore.release(args)
  });
}
