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
        window.wrappedJSObject.browser.runtime.sendMessage(arguments[0]).then(
          value=>done({ok:true,value:JSON.parse(JSON.stringify(value))}),
          ()=>done({ok:false}));`, [message], { async: true });
      if (!result.ok) throw new Error('Packaged broker sender or transport rejected');
      return result.value;
    },
    connect() { throw new Error('The baseline does not open event streams'); },
  } }) });
}
