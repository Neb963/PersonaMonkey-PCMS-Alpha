let selfPort;
const bootId = crypto.randomUUID();
// Registered synchronously, before the first await.
browser.runtime.onMessage.addListener(message => {
  if (message.type !== 'p027') return undefined;
  return handle(message);
});
browser.alarms.onAlarm.addListener(async alarm => {
  const { alarmEvents = [] } = await browser.storage.local.get('alarmEvents');
  await browser.storage.local.set({ alarmEvents: [...alarmEvents, { name: alarm.name, bootId }] });
});
browser.runtime.onConnect.addListener(port => {
  port.onMessage.addListener(() => port.postMessage({ bootId }));
});
async function handle(message) {
  switch (message.action) {
    case 'facts': return { bootId, window: typeof window, document: typeof document,
      session: await browser.storage.session.get(null) };
    case 'seed':
      await browser.storage.session.set({ p027Marker: 'survives-idle' });
      await browser.storage.local.set({ p027Marker: 'survives-restart' });
      return bootId;
    case 'portOnly': selfPort = browser.runtime.connect({name:'p027.self'}); return true;
    case 'timers':
      setTimeout(() => browser.storage.local.set({ domTimerFired: true }), 10000);
      await browser.alarms.create('p027.wake', { when: Date.now() + 3600000 });
      await browser.alarms.create('p027.wake', { when: Date.now() + 4000 });
      await browser.alarms.create('p027.session-only', { when: Date.now() + 3600000 });
      return { bootId, alarms: await browser.alarms.getAll() };
    default: throw new Error('Unknown probe action');
  }
}
