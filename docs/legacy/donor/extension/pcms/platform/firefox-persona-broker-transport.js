import { PERSONA_BROKER_INTEGRATION_EVENTS_PORT } from "../core/persona-broker.js";

export const PCMS_INTERNAL_BROKER_REQUEST_TYPE="PCMS_PERSONA_BROKER_REQUEST";
export const PCMS_INTERNAL_BROKER_EVENTS_PORT="PCMS_PERSONA_BROKER_EVENTS";

function runtimeApi(runtime) {
  if(!runtime||typeof runtime.sendMessage!=="function"||typeof runtime.connect!=="function") {
    throw new TypeError("Firefox PCMS transport requires browser.runtime");
  }
  return runtime;
}

export function createFirefoxPersonaBrokerTransport({runtime=globalThis.browser?.runtime}={}) {
  const api=runtimeApi(runtime);
  return Object.freeze({
    async send(envelope) {
      return api.sendMessage(Object.freeze({
        type:PCMS_INTERNAL_BROKER_REQUEST_TYPE,
        request:envelope
      }));
    },
    openEvents(portName,onEvent) {
      if(portName!==PERSONA_BROKER_INTEGRATION_EVENTS_PORT||typeof onEvent!=="function") {
        throw new TypeError("Firefox PCMS event transport request is invalid");
      }
      const port=api.connect({name:PCMS_INTERNAL_BROKER_EVENTS_PORT});
      if(!port||typeof port.disconnect!=="function"||typeof port.onMessage?.addListener!=="function") {
        try{port?.disconnect?.();}catch{}
        throw new TypeError("Firefox PCMS event transport is unavailable");
      }
      let closed=false;
      const listener=(event)=>{if(!closed)onEvent(event);};
      port.onMessage.addListener(listener);
      return Object.freeze({
        disconnect() {
          if(closed)return;
          closed=true;
          try{port.onMessage?.removeListener?.(listener);}catch{}
          try{port.disconnect();}catch{}
        }
      });
    }
  });
}
