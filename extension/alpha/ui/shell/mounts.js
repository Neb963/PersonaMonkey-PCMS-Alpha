import { renderState } from './states.js';
import { createUiClient } from './client.js';
// Finite built-in views only. Never load scripts from user data or providers.
export const FIXED_VIEWS=Object.freeze([
  'overview','supply','review','refresher','accounts','generators','attention','settings'
]);
const LOADERS=Object.freeze({
  overview:()=>import('../views/overview/index.mjs'),
  supply:()=>import('../views/supply/index.mjs'),
  review:()=>import('../views/review/index.mjs'),
  refresher:()=>import('../views/refresher/index.mjs'),
  accounts:()=>import('../views/management/accounts.mjs'),
  generators:()=>import('../views/management/generators.mjs'),
  attention:()=>import('../views/attention/index.mjs'),
  settings:()=>import('../views/settings/index.mjs')
});
export function routeView(section,hash){
  return section==='supply'&&hash==='#supply/review'?'review':section;
}
export function createViewCoordinator(doc,view,{loaders=LOADERS,client=null}={}){
  if(!doc?.querySelector||!view?.location)throw new TypeError('Missing UI root');
  const api=client??createUiClient(view.browser?.runtime??globalThis.browser?.runtime);
  let epoch=0,dispose=null;
  async function activate(section,hash){
    if(!FIXED_VIEWS.includes(section))throw new TypeError('Unknown fixed route');
    const name=routeView(section,hash);
    const target=doc.querySelector('[data-panel="'+section+'"] .alpha-panel');
    if(!target)return;
    const ticket=++epoch;
    if(dispose){try{dispose();}finally{dispose=null;}}
    renderState(target,{kind:'loading',title:'Loading '+name});
    try{
      const loaded=await loaders[name]();
      if(ticket!==epoch)return;
      if(typeof loaded?.mount!=='function')throw new TypeError('Missing view');
      const teardown=await loaded.mount(target,{request:api.request,route:name});
      if(ticket!==epoch){if(typeof teardown==='function')teardown();return;}
      if(typeof teardown==='function')dispose=teardown;
    }catch{
      if(ticket===epoch)renderState(target,{
        kind:'error',title:'Section unavailable',
        message:'The built-in view could not be loaded. No operation was performed.',
        onRetry:()=>{if(ticket===epoch)void activate(section,hash);}
      });
    }
  }
  return Object.freeze({activate,close(){
    ++epoch;if(dispose){try{dispose();}finally{dispose=null;}}
  }});
}
