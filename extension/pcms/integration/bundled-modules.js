// The bundled (built-in) module list (03 §7). Adding a built-in module's UI is one entry here
// plus the module's own `pcms-modules/<id>/ui.js` exporting createUiContribution(api); no
// edits to app.js, index.html, the route grammar, Overview, Attention, Search or Activity.
// Cross-module service wiring stays explicit in composition.js.
//
// `ui` is an extension-absolute path: the background imports it lazily, so this list stays
// importable outside the packaged extension (tests inject their own loader).
export const PCMS_DEPLOYER_BUNDLED_MODULE=Object.freeze({moduleId:"deployer",service:"repository",ui:"/pcms-modules/p015/ui.js",dependsOn:Object.freeze([])});
export const PCMS_BUNDLED_MODULES=Object.freeze([
  Object.freeze({moduleId:"statistics",service:"statistics",ui:"/pcms-modules/p018/ui.js",dependsOn:Object.freeze([])})
]);
// P040: Refresher, Explorer and Provisioning pages replace the P026 legacy operator forms. Each
// receives only its composition-built service bundle (composition.js), never raw Core. They ship
// in the default list; a caller that passes its own list (a test fixture) gets exactly that list.
export const PCMS_P040_BUNDLED_MODULES=Object.freeze([
  Object.freeze({moduleId:"refresher",service:"refresherUi",ui:"/pcms-modules/p017/ui.js",dependsOn:Object.freeze([])}),
  Object.freeze({moduleId:"explorer",service:"explorerUi",ui:"/pcms-modules/p016/ui.js",dependsOn:Object.freeze([])}),
  Object.freeze({moduleId:"provisioning",service:"provisioningUi",ui:"/pcms-modules/p019/ui.js",dependsOn:Object.freeze([])})
]);
export const PCMS_SHIPPED_BUNDLED_MODULES=Object.freeze([...PCMS_BUNDLED_MODULES,...PCMS_P040_BUNDLED_MODULES]);

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

// Resolves each entry to {moduleId, dependsOn, uiContribution}. A module whose UI cannot be
// loaded still appears (as incompatible), so one broken built-in never breaks the shell.
export function createPcmsBundledModuleLoader({core,entries=PCMS_SHIPPED_BUNDLED_MODULES,importModule=(path)=>import(path)}={}){
  if(!core||typeof core!=="object") throw new TypeError("Bundled modules require the Core services");
  if(!Array.isArray(entries)||typeof importModule!=="function") throw new TypeError("Bundled module list is invalid");
  return async function loadBundled(){
    const out=[];
    // Deployer v2 is a background built-in. Keep the old default fixtures stable
    // when the optional repository service was not registered.
    const requested=(core.repository?[...entries,PCMS_DEPLOYER_BUNDLED_MODULE]:entries)
      .filter((entry)=>!PCMS_P040_BUNDLED_MODULES.includes(entry)||core[entry.service]);
    for(const entry of requested){
      if(!plain(entry)||typeof entry.moduleId!=="string"||typeof entry.ui!=="string"||!entry.ui.startsWith("/pcms-modules/")) continue;
      out.push(Object.freeze({
        moduleId:entry.moduleId,
        dependsOn:Object.freeze([...(entry.dependsOn||[])]),
        async uiContribution(){
          const loaded=await importModule(entry.ui);
          if(typeof loaded?.createUiContribution!=="function") throw new TypeError("Built-in module UI has no createUiContribution");
          return loaded.createUiContribution(Object.freeze({moduleId:entry.moduleId,service:entry.service?core[entry.service]:null}));
        }
      }));
    }
    return out;
  };
}
