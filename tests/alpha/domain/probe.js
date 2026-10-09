import { runStorageCases, verifyAfterBrowserRestart } from './storage-cases.js';
// Let the document finish loading before running the asynchronous fixture suite.
void (async () => {
  try {
    const result = await (new URL(location.href).searchParams.get('stage') === 'restart' ? verifyAfterBrowserRestart() : runStorageCases());
    document.body.textContent = JSON.stringify(result);
  } catch (error) {
    document.body.textContent = JSON.stringify({ passed: false, error: error.code || error.message, providerLive: false });
  }
})();
