import assert from "node:assert/strict";
import { createPersonaPackage, inspectPersonaPackage } from "../lib/persona-package.js";
import { PERSONA_PACKAGE_LIMITS } from "../lib/package-limits.js";

const SOURCE_PERSONA_UID = "60000000-0000-4000-8000-000000000001";

const state = {profiles:{p1:{containerId:"p1",personaUid:SOURCE_PERSONA_UID,managed:true,name:"Research",routeId:"r1",killSwitch:true,scriptIds:["s1"],lastUsedAt:"2026-01-01T00:00:00.000Z"}},routes:{r1:{id:"r1",name:"Mullvad NL",type:"socks",provider:"mullvad",host:"127.0.0.1",port:12000,proxyDNS:true,username:"secret",password:"secret"}},scripts:{s1:{id:"s1",name:"Helper",code:"// ==UserScript==\n// @name Helper\n// ==/UserScript==",profileIds:["p1"]}},workflows:{w1:{id:"w1",name:"Run",steps:[{id:"step-1",profileId:"p1",urls:["https://example.com"],scriptIds:["s1"]}]}}};
const zip = createPersonaPackage({profileId:"p1",state,container:{name:"Research",color:"purple",icon:"tree"},cookies:[{name:"sid",value:"cookie-secret",domain:"example.com",path:"/"}],appVersion:"0.7.4"});
const preview = await inspectPersonaPackage(zip);
assert.equal(preview.manifest.format, "persona.personamonkey");
assert.equal(preview.manifest.formatVersion,2);
assert.deepEqual(preview.identity,{name:"Research",color:"purple",icon:"tree",description:""});
assert.equal(preview.inventory.cookies,0,"cookies must be excluded by default");
assert.equal(preview.warnings.includes("Cookies excluded"),true);
assert.equal(preview.scripts[0].code.includes("@name Helper"),true);
assert.equal(preview.workflows[0].steps[0].profileId,"$persona");
assert.equal(preview.settings.personaUid,null,"portable import settings must not carry source logical identity");
assert.equal(new TextDecoder().decode(zip).includes(SOURCE_PERSONA_UID),false,"portable package excludes personaUid bytes");
assert.equal(Object.hasOwn(preview.route.route,"username"),false);
assert.equal(Object.hasOwn(preview.route.route,"password"),false);
assert.equal(new TextDecoder().decode(zip).includes("secret"),false,"route and cookie secrets must not enter default exports");
const sensitive = await inspectPersonaPackage(createPersonaPackage({profileId:"p1",state,container:{name:"Research"},cookies:[{name:"sid",value:"cookie-secret",domain:"example.com",path:"/"}],include:{cookies:true}}));
assert.equal(sensitive.inventory.cookies,1);
assert.equal(sensitive.warnings.includes("Package contains sensitive cookie data"),true);
await assert.rejects(
  inspectPersonaPackage(new Uint8Array(PERSONA_PACKAGE_LIMITS.maxCompressedBytes + 1)),
  /Persona package is too large/
);
console.log("persona package tests passed");
