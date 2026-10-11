/** R4-ISSUE99: trusted background-only restore ports.
 * PersonaMonkey is reached exclusively through its typed, in-process Broker
 * backup port; no Alpha code can read/write PersonaMonkey private state.
 * The P102 restore and each auxiliary DB are atomic individually, but NOT
 * globally atomic. A partial failure keeps P201 RECOVERY_HOLD persistently.
 */
import {decodeAlphaSnapshot,decodeInventoryFacts,decodeRestoreLocalSection}
  from '../bundle.js';
import {canonicalPjs} from '../../flows/refresh/comment.mjs';

const RECOVER='RESTORE UNENCRYPTED BACKUP';
const COMPONENTS=Object.freeze(['alpha.records','alpha.journal','alpha.inventoryFacts',
 'alpha.refreshLedger','alpha.attentionInbox',
 'personaMonkey.personas','personaMonkey.routes','personaMonkey.userscripts','personaMonkey.workflows']);
const err=code=>Object.assign(new Error('Backup restore requires reconciliation.'),{code});
function ensure(x,code='RECOVERY_HOLD'){if(!x)throw err(code);}
function state(list){return list?.items?.map(x=>x.record)||[];}
export function createProductionBackupAuthority({core,storage,facts,refreshLedger,attentionStore,
  personaEndpoint,perchance=null,contextForAccount=null}={}){
  ensure(core?.restore && storage?.restoreSnapshot && storage?.restoreReceipt &&
    facts?.replaceForRestore && refreshLedger?.replaceForRestore &&
    attentionStore?.replaceForRestore && typeof personaEndpoint?.backup==='function',
    'UNSUPPORTED_CAPABILITY');
  /**
   * Runtime-only reconciliation of restored identities and provider source.
   * The context MUST be freshly resolved from the Persona-bound P202 owner;
   * the P103 probe and authoritative inventory/read are required again AFTER
   * replacement. No restored session cookie or locally cached VERIFIED flag
   * is sufficient, and an unavailable executor never releases recovery hold.
   */
  async function verifyFreshFleet(accounts,generators,refresh){
    if(accounts.length===0)return {sessions:true,providers:generators.length===0};
    if(typeof contextForAccount!=='function' || typeof perchance?.probe!=='function' ||
      typeof perchance?.read!=='function')return {sessions:false,providers:false};
    const contexts=new Map();
    let sessions=true;
    for(const account of accounts){
      try {
        const context=await contextForAccount(Object.freeze({...account}));
        if(!context || context.accountId!==account.accountId ||
          context.personaUid!==account.personaUid || context.epoch!==account.epoch ||
          !Number.isSafeInteger(context.routeRevision) ||
          !Number.isSafeInteger(context.capabilityRevision)){
          sessions=false;continue;
        }
        const probe=await perchance.probe(context);
        if(probe?.ok!==true || !Array.isArray(probe.result) ||
          !probe.result.includes('generator.get') ||
          !probe.result.includes('generator.list')){
          sessions=false;continue;
        }
        contexts.set(account.accountId,context);
      }catch {sessions=false;}
    }
    if(!sessions)return {sessions:false,providers:false};
    let providers=true;
    for(const g of generators){
      const ctx=contexts.get(g.accountId);
      if(!ctx || g.personaUid!==ctx.personaUid || g.accountBindingEpoch!==ctx.epoch){
        providers=false;continue;
      }
      try {
        // P103.read includes a fresh authenticated ACCOUNT inventory check.
        // A direct editor URL or collaborator key never establishes ownership.
        const response=await perchance.read({context:ctx,targetKey:g.key});
        const observed=response?.result;
        if(response?.ok!==true || observed?.ownership!=='CONFIRMED' ||
           typeof observed.sourceRevision!=='string' || !observed.sourceRevision ||
           !['PUBLIC','UNLISTED'].includes(observed.listing) ||
           (g.listingObserved!=='UNKNOWN' && observed.listing!==g.listingObserved)){
          providers=false;continue;
        }
        if(g.releaseId!==null){
          const release=(await storage.read('release',g.releaseId)).item?.record;
          if(!release || release.source?.slug!==g.key || !observed.files){
            providers=false;continue;
          }
          // Any restored transient refresh suffix must be proven byte-exact
          // against P403's signed execution ledger, not stripped speculatively.
          await canonicalPjs(observed.files,release,refresh.jobs[g.key]?.comment??null);
        }
      }catch {providers=false;}
    }
    return {sessions,providers};
  }
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
      // Restored browser sessions cannot be trusted. This is a fresh
      // Persona-bound P103 probe and source readback with no provider mutation.
      const verified=await verifyFreshFleet(accounts,generators,refresh);
      return {core:receipt?.holdId===holdId && receipt.durable===true,
        bindings,sessions:verified.sessions,providers:verified.providers,
        operations:ops.every(o=>!['PREPARED','DISPATCHING','UNCERTAIN','HELD'].includes(o.phase)),
        inventory};
    },
    release:args=>core.restore.release(args)
  });
}
