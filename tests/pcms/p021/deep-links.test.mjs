import test from "node:test";
import assert from "node:assert/strict";

import { PCMS_UI_ERROR_CODES } from "../../../extension/pcms/app/errors.js";
import { normalizePcmsSearchQuery, parsePcmsDeepLink, pcmsRouteHref, resolvePcmsDeepLink } from "../../../extension/pcms/app/deep-links.js";

test("A021-03 internal deep links are canonical and safely encode entity IDs",()=>{
  const href=pcmsRouteHref("accounts",{id:"folder/account-1"});
  assert.equal(href,"#/accounts/folder%2Faccount-1");
  assert.deepEqual(parsePcmsDeepLink(href),{
    route:"accounts",id:"folder/account-1",query:"",href
  });
  assert.equal(pcmsRouteHref("search",{query:"  Alpha Beta  "}),"#/search?q=Alpha%20Beta");
  assert.equal(parsePcmsDeepLink("#/search?q=Alpha%20Beta").query,"Alpha Beta");
});

test("A021-03 stale entity links fail closed to overview rather than authorizing a route",()=>{
  assert.deepEqual(resolvePcmsDeepLink("#/accounts/account-1",{accountIds:["account-2"],attentionIds:[]}),{
    valid:false,
    reason:"NOT_FOUND",
    route:{route:"overview",id:null,query:"",href:"#/overview"}
  });
  assert.equal(resolvePcmsDeepLink("#/attention/task-1",{accountIds:[],attentionIds:["task-1"]}).valid,true);
});

test("A021-03 external/unknown/injection-like deep links are rejected",()=>{
  for(const value of [
    "https://example.com/",
    "#//example.com",
    "#/javascript:alert(1)",
    "#/accounts/a?next=https%3A%2F%2Fevil.example",
    "#/search?q=x&next=y",
    "#/accounts/%00bad",
    "#/accounts/a/b"
  ]) {
    assert.throws(()=>parsePcmsDeepLink(value),e=>e?.code===PCMS_UI_ERROR_CODES.DEEP_LINK_INVALID);
  }
});

test("search query normalization is bounded and rejects controls",()=>{
  assert.equal(normalizePcmsSearchQuery("  test  "),"test");
  assert.throws(()=>normalizePcmsSearchQuery("x\n"),e=>e?.code===PCMS_UI_ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(()=>normalizePcmsSearchQuery("x".repeat(201)),e=>e?.code===PCMS_UI_ERROR_CODES.INVALID_ARGUMENT);
});
