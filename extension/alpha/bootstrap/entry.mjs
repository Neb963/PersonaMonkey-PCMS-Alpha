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
  for (const [event, listener] of [[browserRef.runtime?.onMessage, entry.onMessage], [browserRef.alarms?.onAlarm, entry.onAlarm],
    [browserRef.runtime?.onStartup, safeWake], [browserRef.runtime?.onInstalled, safeWake]]) {
    if (typeof event?.addListener === 'function') event.addListener(listener);
  }
  Object.defineProperty(scope, SINGLETON, { value: entry, configurable: false, writable: false });
  return entry;
}

// Keep every available listener synchronous in partial environments as well.
// Real Firefox exposes all four events; mandatory packaged acceptance checks
// actual startup, warm alarms and restart rather than inferring them here.
const entry = globalThis.browser?.runtime ? installAlphaBackground() : null;
export function setAlphaPersonaMonkeyBootstrap(bootstrap) { return entry?.setPersonaMonkeyBootstrap(bootstrap) ?? false; }
