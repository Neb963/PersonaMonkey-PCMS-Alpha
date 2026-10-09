// A034-01/A034-02/A034-03: exercise real Accounts component in the pinned packaged Firefox.
// Fixture is local to the disposable test page; it neither creates PersonaMonkey personas
// nor mutates actual PCMS Core/RemoteOperations.
import assert from "node:assert/strict";
import {mkdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileText,loadBrowserPin,sha256File,writeJson} from "../../../tools/firefox/lib.mjs";
import {PackagedFirefox,waitFor} from "../../../tools/firefox/packaged-harness.mjs";

const root=resolve(process.env.FIREFOX_PACKAGED_DIR||join(tmpdir(),"pcms-fde-p034"));
const reportPath=resolve(process.env.FIREFOX_P034_REPORT||join(root,"p034-report.json"));
const pin=await loadBrowserPin();
const manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve("dist/persona-route-manager-v"+manifest.version+".xpi");
const report={schemaVersion:1,phase:"P034",
 commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
 workflowRun:process.env.GITHUB_RUN_ID||null,version:pin.version,artifactSha256:pin.archive.sha256,
 productXpiSha256:await sha256File(xpi),checks:{}};
let h;
async function fixture(code){
 const wrapper=`const done=arguments[arguments.length-1];(async()=>{${code}})().then(
 value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),
 error=>done({ok:false,error:String(error?.stack||error)}));`;
 const result=await h.pageScript(wrapper,[],{async:true});
 if(!result.ok)throw new Error(result.error);
 return result.value;
}
try{
 await mkdir(root,{recursive:true});
 h=await PackagedFirefox.create({root:join(root,"profiles-p034")});
 await h.start();assert.equal(await h.install(xpi),"persona-route-manager@local");
 const handle=await h.openPage("persona-route-manager@local","pcms/app/index.html");
 await waitFor(()=>h.pageScript('return document.getElementById("brokerLiveStatus")?.dataset.state==="connected";'),
  "P034 packaged dashboard Core connected",30000);
 const result=await fixture(`
 const api=window.wrappedJSObject.browser;
 const original=document.getElementById("accountsV2");
 original.id="accountsV2-original";
 const fixtureRoot=document.createElement("div");fixtureRoot.id="accountsV2";document.body.appendChild(fixtureRoot);
 const accounts=Array.from({length:52},(_,i)=>{
   const num=String(i+1).padStart(2,"0");
   return {accountId:"acct-"+num,displayName:"Account "+num,providerId:"perchance",
     personaUid:"00000000-0000-4000-8000-"+(i+1).toString(16).padStart(12,"0"),bindingEpoch:1};
 });
 const personas=accounts.map(a=>({personaUid:a.personaUid,name:"Persona "+a.accountId,managed:true,
  cookieStoreId:"firefox-container-test",health:{status:"blocked",checkedAt:"2026-10-08T00:00:00Z"}}));
 for(let i=0;i<3;i++)personas[i].health.status="direct";
 const spare={personaUid:"00000000-0000-4000-8000-00000000ffff",name:"Spare",managed:true,
  cookieStoreId:"firefox-container-test-spare",health:{status:"direct"}};
 personas.push(spare);
 const module=await import(api.runtime.getURL("pcms/app/views/accounts/accounts-view.js"));
 const runtime={
   accounts:{
     listAccounts:async()=>({revision:52,accounts}),
     createAccount:async()=>{throw Error("fixture should not mutate Core");},
     rebindPersona:async()=>{throw Error("fixture must not rebind");}
   },
   remoteOps:{listUnresolved:async()=>[{value:{operationId:"operation:pending",state:"UNCERTAIN"}}]},
   personaBroker:{request:async()=>({ok:true,result:{items:personas,hasMore:false}})}
 };
 const view=module.createPcmsAccountsView({documentRef:document,windowRef:window,runtime});
 await view.render({accounts,revision:52,route:{id:null,filter:""}});
 const first=document.querySelectorAll("#accountsV2 .accounts-table tbody tr").length;
 const initialSummary=document.querySelector("#accountsV2 .accounts-summary").textContent;
 const searchBox=fixtureRoot.querySelector(".accounts-search");
 searchBox.value="Account 44";searchBox.dispatchEvent(new Event("input",{bubbles:true}));
 const searchCount=fixtureRoot.querySelectorAll(".accounts-table tbody tr").length;
 const searchHref=fixtureRoot.querySelector(".accounts-table tbody a")?.getAttribute("href");
 searchBox.value="";searchBox.dispatchEvent(new Event("input",{bubbles:true}));
 const sortBox=fixtureRoot.querySelector(".accounts-sort");
 sortBox.value="id";sortBox.dispatchEvent(new Event("change",{bubbles:true}));
 fixtureRoot.querySelector('[data-accounts-action="direction"]').click();
 const sortedFirst=fixtureRoot.querySelector(".accounts-table tbody a")?.getAttribute("href");
 fixtureRoot.querySelector('[data-accounts-action="direction"]').click();
 fixtureRoot.querySelector('[data-accounts-action="next"]').click();
 const second=document.querySelectorAll("#accountsV2 .accounts-table tbody tr").length;
 fixtureRoot.querySelector('[data-accounts-action="next"]').click();
 const third=document.querySelectorAll("#accountsV2 .accounts-table tbody tr").length;
 const lastHref=fixtureRoot.querySelector(".accounts-table tbody a").getAttribute("href");
 const filterBox=fixtureRoot.querySelector(".accounts-filter");
 filterBox.value="status:direct";filterBox.dispatchEvent(new Event("change",{bubbles:true}));
 const filterHash=location.hash;
 await view.render({accounts,revision:52,route:{id:null,filter:"status:direct"}});
 const filteredCount=fixtureRoot.querySelectorAll(".accounts-table tbody tr").length;
 await view.render({accounts,revision:52,route:{id:"acct-01",filter:""}});
 const details=fixtureRoot.querySelector(".accounts-details")?.textContent||"";
 const heading=fixtureRoot.querySelector(".accounts-detail h3")?.textContent||"";
 fixtureRoot.querySelector('[data-accounts-action="rebind"]').click();
 await new Promise(r=>setTimeout(r,0));
 const blocked=fixtureRoot.querySelector(".accounts-dialog-status")?.textContent||"";
 const disabled=fixtureRoot.querySelector('.accounts-dialog-actions button[type="submit"]')?.disabled;
 fixtureRoot.querySelector(".accounts-dialog-actions button[type=button]").click();
 await view.render({accounts,revision:52,route:{id:null,filter:""}});
 fixtureRoot.querySelector('[data-accounts-action="add"]').click();
 const freeText=fixtureRoot.querySelector(".accounts-dialog-form input:not([readonly])")!==null;
 const generated=fixtureRoot.querySelector(".accounts-advanced input")?.readOnly===true;
 const personaPicker=fixtureRoot.querySelector('.entity-picker [role="listbox"]')!==null;
 view.destroy();fixtureRoot.remove();original.id="accountsV2";
 return {first,second,third,initialSummary,searchCount,searchHref,sortedFirst,lastHref,filterHash,filteredCount,heading,details,blocked,disabled,freeText,generated,personaPicker};
 `);
 assert.deepEqual([result.first,result.second,result.third],[25,25,2]);
 assert.match(result.initialSummary,/52 account/);
 assert.equal(result.searchCount,1);
 assert.equal(result.searchHref,"#/accounts/acct-44");
 assert.equal(result.sortedFirst,"#/accounts/acct-52");
 assert.equal(result.filterHash,"#/accounts?f=status%3Adirect");
 assert.equal(result.filteredCount,3);
 assert.equal(result.lastHref,"#/accounts/acct-51");
 assert.equal(result.heading,"Account 01");
 assert.match(result.details,/acct-01/);
 assert.match(result.details,/Unknown/);
 assert.match(result.blocked,/unresolved operation/i);
 assert.equal(result.disabled,true);
 assert.equal(result.freeText,true);assert.equal(result.generated,true);assert.equal(result.personaPicker,true);
 report.checks.paged52InPackagedFirefox=true;
 report.checks.sortedAndFilteredInPackagedFirefox=true;
 report.checks.accountDetailDeepLink=true;
 report.checks.rebindFailClosed=true;
 report.checks.generatedIdsAndPicker=true;
 await h.closePage(handle);
 report.passed=true;
}catch(error){report.passed=false;report.failure=String(error?.stack||error);throw error;}
finally{
 await h?.stop();
 await writeJson(reportPath,report);
 if(h)await rm(h.profilePath,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
