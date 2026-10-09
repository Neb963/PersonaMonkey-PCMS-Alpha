import { createAlphaHost } from './host.mjs';
import { authorizeSender, failure, UI_TYPE } from '../core/ui.mjs';
import { NEXT_ALARM, HEARTBEAT_ALARM } from '../core/core.mjs';

const SINGLETON = Symbol.for('persona-monkey.alpha.background.v1');
export function installAlphaBackground({ browserRef = globalThis.browser, scope = globalThis, createHost = createAlphaHost } = {}) {
  if (scope[SINGLETON]) return scope[SINGLETON];
  let resolveBootstrap, bootstrapSet = false;
  const ready = new Promise(resolve => { resolveBootstrap = resolve; });
  const host = createHost({ browserRef, personaMonkeyReady: async () => { const bootstrap = await ready; await bootstrap(); } });
  const safeWake = () => { void host.wake().catch(() => {}); };
  const entry = Object.freeze({
    host,
    setPersonaMonkeyBootstrap(bootstrap) {
      if (bootstrapSet) return false;
      if (typeof bootstrap !== 'function') throw new TypeError('Alpha requires PersonaMonkey bootstrap');
      bootstrapSet = true; resolveBootstrap(bootstrap); safeWake(); return true;
    },
    onMessage(message, sender) {
      if (message?.type !== UI_TYPE) return undefined;
      if (!authorizeSender(sender, browserRef.runtime)) return Promise.resolve(failure('INVALID_REQUEST'));
      return host.handleUi(message, sender);
    },
    onAlarm(alarm) { if ([NEXT_ALARM, HEARTBEAT_ALARM].includes(alarm?.name)) void host.handleAlarm(alarm).catch(() => {}); }
  });
  // These listeners exist during static evaluation, before any asynchronous
  // bootstrap read. They wake one promise and never keep the event page alive.
  browserRef.runtime.onMessage.addListener(entry.onMessage);
  browserRef.alarms.onAlarm.addListener(entry.onAlarm);
  browserRef.runtime.onStartup.addListener(safeWake);
  browserRef.runtime.onInstalled.addListener(safeWake);
  Object.defineProperty(scope, SINGLETON, { value: entry, configurable: false, writable: false });
  return entry;
}

const entry = globalThis.browser?.runtime ? installAlphaBackground() : null;
export function setAlphaPersonaMonkeyBootstrap(bootstrap) { return entry?.setPersonaMonkeyBootstrap(bootstrap) ?? false; }
