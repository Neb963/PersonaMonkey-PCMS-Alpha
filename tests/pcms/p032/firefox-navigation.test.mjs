import test from "node:test";
import assert from "node:assert/strict";
import { PackagedFirefox, matchesExtensionDocumentUrl } from "../../../tools/firefox/packaged-harness.mjs";

const extensionDocument="moz-extension://pcms-test-uuid/pcms/app/index.html";

test("A032-03 Firefox harness tolerates route canonicalization but still fences document identity",()=>{
  assert.equal(matchesExtensionDocumentUrl(extensionDocument+"#/overview",extensionDocument),true);
  assert.equal(matchesExtensionDocumentUrl(extensionDocument+"#/settings/diagnostics",extensionDocument+"#/overview"),true);
  assert.equal(matchesExtensionDocumentUrl(extensionDocument,extensionDocument+"#/accounts"),true);
  assert.equal(matchesExtensionDocumentUrl("moz-extension://other-uuid/pcms/app/index.html#/overview",extensionDocument),false);
  assert.equal(matchesExtensionDocumentUrl("https://example.org/pcms/app/index.html",extensionDocument),false);
  assert.equal(matchesExtensionDocumentUrl("about:blank",extensionDocument),false);
  assert.equal(matchesExtensionDocumentUrl("moz-extension://pcms-test-uuid/pcms/app/other.html#/overview",extensionDocument),false);
  assert.equal(matchesExtensionDocumentUrl(extensionDocument+"?unexpected=yes#/overview",extensionDocument),false);
  assert.equal(matchesExtensionDocumentUrl("not a url",extensionDocument),false);
});

test("A032-03 PackagedFirefox.openPage accepts a dashboard that canonicalized its hash before navigation check",async()=>{
  const fake=Object.create(PackagedFirefox.prototype);
  fake.extension=async()=>({url:"moz-extension://pcms-test-uuid/"});
  let handles=0, requestedUrl=null, pageReadCount=0;
  fake.client={
    async command(name){
      if(name==="WebDriver:GetWindowHandles"){
        handles++;
        return {value:handles===1?["old-tab"]:["old-tab","new-tab"]};
      }
      return {};
    },
    async script(_source,args){requestedUrl=args[0];}
  };
  fake.pageScript=async(source)=>{
    pageReadCount++;
    assert.equal(source,"return location.href");
    return extensionDocument+"#/overview";
  };
  const opened=await fake.openPage("persona-route-manager@local","pcms/app/index.html");
  assert.equal(opened,"new-tab");
  assert.equal(requestedUrl,extensionDocument);
  assert.equal(handles,2);
  assert.equal(pageReadCount,1);
});
