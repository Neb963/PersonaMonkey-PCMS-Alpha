import { createPersonaBroker } from '../../../extension/pcms/core/persona-broker.js';
import { createFirefoxPersonaBrokerTransport } from '../../../extension/pcms/platform/firefox-persona-broker-transport.js';

// The request-only Marionette shim drives the existing Firefox transport and
// typed broker unchanged. Product mutations go through the packaged background
// endpoint; this harness neither uses raw management writes nor creates an
// execution engine. packaged.mjs verifies these imported bytes against the XPI.
export function packagedBroker(browser) {
  return createPersonaBroker({ transport: createFirefoxPersonaBrokerTransport({ runtime: {
    async sendMessage(message) {
      const result = await browser.pageScript(`const done=arguments[arguments.length-1];
        (async()=>{
          const value=await window.wrappedJSObject.browser.runtime.sendMessage(arguments[0]);
          if(value===undefined) return {ok:false,reason:"MISSING_RESPONSE"};
          return {ok:true,value:JSON.parse(JSON.stringify(value))};
        })().then(done,()=>done({ok:false,reason:"SEND_REJECTED"}));`, [message], { async: true });
      browser.lastBrokerTransportFailure = result.reason || null;
      if (!result.ok) throw new Error('Packaged broker sender or transport rejected');
      return result.value;
    },
    connect() { throw new Error('The baseline does not open event streams'); },
  } }) });
}
