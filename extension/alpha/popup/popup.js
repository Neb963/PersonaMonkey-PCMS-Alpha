import {createUiClient} from '../ui/shell/client.js';
export async function checkStatus(runtime=globalThis.browser?.runtime){
  const result=await createUiClient(runtime).request('accounts.list',{limit:1});
  return result.ok?'Core responding':result.error?.code==='RECOVERY_HOLD'?
    'Core recovery hold — action required':'Core unavailable';
}
export function boot(doc=globalThis.document,api=globalThis.browser){
  doc.getElementById('dashboard')?.addEventListener('click',()=>{
    if(api?.tabs?.create&&api?.runtime?.getURL)
      void api.tabs.create({url:api.runtime.getURL('alpha/ui/shell/index.html')});
  });
  doc.getElementById('personas')?.addEventListener('click',()=>{
    if(api?.tabs?.create&&api?.runtime?.getURL)
      void api.tabs.create({url:api.runtime.getURL('popup/popup.html')});
  });
  void checkStatus(api?.runtime).then(status=>{
    const el=doc.getElementById('core-status');if(el)el.textContent=status;
  });
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')
    document.addEventListener('DOMContentLoaded',()=>boot(),{once:true});
  else boot();
}
