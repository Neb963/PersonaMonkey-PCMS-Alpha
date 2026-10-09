addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'p027.sandbox') return;
  let networkBlocked = false;
  try { await fetch(event.data.url); } catch { networkBlocked = true; }
  parent.postMessage({ type: 'p027.sandbox.result', value: (0, eval)(event.data.source),
    browserAbsent: typeof browser === 'undefined', chromeAbsent: typeof chrome === 'undefined', networkBlocked }, event.origin);
});
