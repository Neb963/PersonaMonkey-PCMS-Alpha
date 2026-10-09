import test from "node:test";
import assert from "node:assert/strict";

import {
  PCMS_V2_BUILTIN_MODULE_IDS,
  parsePcmsRouteV2,
  pcmsV2Href,
  resolvePcmsRouteV2
} from "../../../extension/pcms/app/router-v2.js";

test("A032-01 v2 routes are canonical and legacy Modules resolves to Settings",()=>{
  assert.equal(parsePcmsRouteV2("").href,"#/overview");
  assert.deepEqual(parsePcmsRouteV2("#/modules"),{
    route:"settings",id:null,query:"",filter:"",page:null,section:"modules",moduleId:null,view:null,objectId:null,
    legacy:true,href:"#/settings/modules"
  });
  assert.equal(pcmsV2Href("generators",{filter:"status:update,account:alice",page:2}),
    "#/generators?f=status%3Aupdate%2Caccount%3Aalice&p=2");
  assert.equal(parsePcmsRouteV2("#/m/deployer/history/release-1").href,"#/m/deployer/history/release-1");
  assert.equal(parsePcmsRouteV2("#/settings/diagnostics").section,"diagnostics");
  assert.equal(parsePcmsRouteV2("#/search?q=Alpha%20Beta").query,"Alpha Beta");
});

test("A032-01 filters and route grammar are closed, bounded and reject injection-like links",()=>{
  for(const value of [
    "https://example.com/",
    "#//example.com",
    "#/javascript:alert(1)",
    "#/accounts/a?next=https%3A%2F%2Fevil.example",
    "#/generators?f=unknown:value",
    "#/generators?f=status:update,status:drift",
    "#/settings/not-a-section",
    "#/m/../escape",
    "#/m/deployer/a/b/c",
    "#/search?q=x&next=y",
    "#/accounts/%00bad"
  ]) assert.equal(resolvePcmsRouteV2(value).valid,false,value);
});

test("A032-01 stale entity and module links fail closed to Overview with a visible reason",()=>{
  const stale=resolvePcmsRouteV2("#/accounts/missing",{accountIds:["present"]});
  assert.equal(stale.valid,false);
  assert.equal(stale.reason,"NOT_FOUND");
  assert.equal(stale.route.href,"#/overview");

  const module=resolvePcmsRouteV2("#/m/deployer",{moduleIds:PCMS_V2_BUILTIN_MODULE_IDS});
  assert.equal(module.valid,true);
  assert.equal(module.route.moduleId,"deployer");

  const missingModule=resolvePcmsRouteV2("#/m/not-installed",{moduleIds:PCMS_V2_BUILTIN_MODULE_IDS});
  assert.equal(missingModule.valid,false);
  assert.equal(missingModule.reason,"NOT_FOUND");
});

test("A032-01 canonicalization is explicit and never broadens authority",()=>{
  assert.equal(resolvePcmsRouteV2("#/modules").canonicalized,true);
  assert.equal(resolvePcmsRouteV2("#/overview").canonicalized,false);
  assert.equal(resolvePcmsRouteV2("#/").route.href,"#/overview");
  assert.equal(resolvePcmsRouteV2("#/").canonicalized,true);
});
