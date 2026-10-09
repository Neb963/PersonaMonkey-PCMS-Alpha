import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {parsePcmsRouteV2,resolvePcmsRouteV2,pcmsV2Href} from "../../../extension/pcms/app/router-v2.js";
import {ACCOUNT_PAGE_SIZE,suggestedAccountId,validateAccountDraft,visibleAccountPage,summarizePersona,unresolvedRebindReason}
  from "../../../extension/pcms/app/views/accounts/model.js";
const uid=n=>"00000000-0000-4000-8000-"+n.toString(16).padStart(12,"0");
const fixture=Array.from({length:52},(_,i)=>({
 accountId:"acct-"+String(i+1).padStart(2,"0"),
 displayName:"Account "+String(i+1).padStart(2,"0"),
 personaUid:uid(i+1),providerId:"perchance",bindingEpoch:1
}));
test("A034-01 generated keys are deterministic, collision-safe, bounded and never manually required",()=>{
 assert.equal(suggestedAccountId("Érin – Personal",[]),"erin-personal");
 assert.equal(suggestedAccountId("Erin",[ "erin","erin-2" ]),"erin-3");
 assert.equal(suggestedAccountId("☀",[]),"account");
 assert.ok(suggestedAccountId("X".repeat(1000),[]).length<=256);
 const people=[{personaUid:uid(1)}];
 assert.deepEqual(validateAccountDraft({displayName:"Erin",accountId:"erin",personaUid:uid(1)},[],people),
  {displayName:"Erin",accountId:"erin",personaUid:uid(1)});
 assert.throws(()=>validateAccountDraft({displayName:"Erin",accountId:"erin",personaUid:uid(1)},
  [{accountId:"old",personaUid:uid(1)}],people),/already bound/);
 assert.throws(()=>validateAccountDraft({displayName:" ",accountId:"x",personaUid:uid(1)},[],people),/display name/);
});
test("A034-03 52 account fixture pages, searches, filters and stable sorting",()=>{
 const rows=visibleAccountPage(fixture);assert.equal(rows.total,52);
 assert.equal(rows.items.length,ACCOUNT_PAGE_SIZE);assert.equal(rows.pages,3);assert.equal(rows.end,25);
 assert.equal(visibleAccountPage(fixture,{page:2}).items.length,25);
 assert.equal(visibleAccountPage(fixture,{page:3}).items.length,2);
 assert.equal(visibleAccountPage(fixture,{page:10000}).page,3);
 assert.equal(visibleAccountPage(fixture,{direction:"desc"}).items[0].accountId,"acct-52");
 assert.equal(visibleAccountPage(fixture,{search:"Account 44"}).items[0].accountId,"acct-44");
 const routes=new Map([[uid(9),{status:"direct",personaName:"Ninth"}],[uid(10),{status:"blocked",personaName:"Tenth"}]]);
 assert.equal(visibleAccountPage(fixture,{filter:"status:direct",routeByUid:routes}).items[0].accountId,"acct-09");
 assert.equal(visibleAccountPage(fixture,{search:"Ninth",routeByUid:routes}).total,1);
 assert.equal(visibleAccountPage(fixture,{filter:"persona:"+uid(10),routeByUid:routes}).total,1);
});
test("A034-03 every account has a canonical detail deep link and stale links fail closed",()=>{
 for(const account of fixture) {
  const href=pcmsV2Href("accounts",{id:account.accountId});
  assert.equal(parsePcmsRouteV2(href).id,account.accountId);
  assert.equal(resolvePcmsRouteV2(href,{accountIds:fixture.map(a=>a.accountId)}).valid,true);
 }
 assert.equal(resolvePcmsRouteV2("#/accounts/absent",{accountIds:fixture.map(a=>a.accountId)}).reason,"NOT_FOUND");
});
test("A034-03 route and session data never infer positive health from missing observations",()=>{
 assert.equal(summarizePersona({personaUid:uid(1),name:"Erin"}).route,"Not checked");
 assert.equal(summarizePersona({personaUid:uid(1),health:{status:"direct"}}).route,"Direct · no routing protection");
 assert.equal(summarizePersona({personaUid:uid(1),health:{status:"healthy",routeName:"Mullvad"}}).route,"Mullvad");
 assert.equal(summarizePersona({personaUid:"invalid"}),null);
 assert.match(unresolvedRebindReason([{}],"acct-01"),/Reconcile/);
 assert.match(unresolvedRebindReason(null,"acct-01"),/unavailable/);
 assert.equal(unresolvedRebindReason([],"acct-01"),null);
});
test("A034-01 visible Accounts workflow uses pickers, not free-text identifiers",async()=>{
 const [html,view,picker]=await Promise.all([
  readFile("extension/pcms/app/index.html","utf8"),
  readFile("extension/pcms/app/views/accounts/accounts-view.js","utf8"),
  readFile("extension/pcms/app/ui/picker/entity-picker.js","utf8")
 ]);
 assert.match(html,/id="accountsV2"/);
 // A040-03 supersedes the hidden P026 account forms kept for inheritance: they are removed.
 assert.doesNotMatch(html,/id="accountCreateForm"|id="accountRebindForm"|class="operations-grid"/);
 assert.match(view,/createEntityPicker/);assert.match(view,/key.readOnly=true/);
 assert.match(view,/runtime.accounts.createAccount/);assert.match(view,/runtime.accounts.rebindPersona/);
 assert.doesNotMatch(view,/innerHTML|browser\.(?:tabs|proxy|contextualIdentities)/);
 assert.match(picker,/role","listbox"/);assert.match(picker,/disabledReason/);
});
