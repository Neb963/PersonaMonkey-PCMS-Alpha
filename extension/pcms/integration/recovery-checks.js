import { INTEGRATION_ERROR_CODES, integrationError } from "./errors.js";

function fail(code){throw integrationError(code);}
function plain(value){if(!value||typeof value!=="object"||Array.isArray(value))return false;const p=Object.getPrototypeOf(value);return p===Object.prototype||p===null;}
function method(value,name,label){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length)throw new TypeError(label+" is invalid");
  const d=Object.getOwnPropertyDescriptors(value);
  if(!Object.hasOwn(d,name)||!d[name].enumerable||!Object.hasOwn(d[name],"value")||typeof d[name].value!=="function")throw new TypeError(label+" is invalid");
  return d[name].value;
}

export function createIntegrationRecoveryChecks({accounts,providerProbes=[]}={}) {
  const reconcileBindings=method(accounts,"reconcileBindings","Accounts service");
  if(!Array.isArray(providerProbes)||providerProbes.length>32)throw new TypeError("Provider probes are invalid");
  const probes=providerProbes.map((provider,index)=>Object.freeze({
    probeCompatibility:method(provider,"probeCompatibility","Provider probe "+index)
  }));

  async function personaBindings(){
    let result;
    try{result=await reconcileBindings();}
    catch{return false;}
    return result?.complete===true;
  }

  async function providerCapabilities(){
    for(const probe of probes){
      let result;
      try{result=await probe.probeCompatibility();}
      catch{return false;}
      if(!plain(result)||typeof result.providerId!=="string"||result.providerId.length<1){
        return false;
      }
    }
    return true;
  }

  return Object.freeze({personaBindings,providerCapabilities});
}

export function assertIntegratedProviderSet(providerProbes){
  if(!Array.isArray(providerProbes)||providerProbes.length<1)fail(INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE);
  const ids=new Set();
  for(const probe of providerProbes){
    if(!plain(probe)||typeof probe.providerId!=="string"||probe.providerId.length<1||ids.has(probe.providerId)){
      fail(INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE);
    }
    ids.add(probe.providerId);
  }
  return Object.freeze([...ids].sort());
}
