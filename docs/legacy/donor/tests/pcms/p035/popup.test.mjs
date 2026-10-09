import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const js = await readFile("extension/popup/popup.js", "utf8");
const html = await readFile("extension/popup/popup.html", "utf8");
const css = await readFile("extension/popup/popup.css", "utf8");

function element(id) {
  const classes = new Set();
  return {
    id, className:"", disabled:false, hidden:false, textContent:"", innerHTML:"",
    value:"", title:"", attributes:{},
    classList:{toggle(name, enabled){if(enabled) classes.add(name); else classes.delete(name);},contains(name){return classes.has(name);}},
    setAttribute(name,value){this.attributes[name] = value;},
    removeAttribute(name){delete this.attributes[name];},
    getAttribute(name){return this.attributes[name];}
  };
}

async function mount({summary=null,personaUid="persona-alice",managed=true,tabs=[]}={}) {
  const ids=["pcmsBlock","pcmsState","pcmsAccount","pcmsAttention","pcmsAsOf","pcmsOpenAccount",
    "status","context","route","test","actionHint","directWarning","confirmDirect",
    "cancelDirect","result","options"];
  const nodes=Object.fromEntries(ids.map((id)=>[id,element(id)]));
  const opened={created:[],updated:[],focused:[],messages:[],listeners:[]};
  const profile=managed?{personaUid,containerId:"firefox-container-1",name:"Alice",managed:true,routeId:"r1",scriptIds:[]} :null;
  const active={profile,container:managed?{name:"Alice",color:"blue"}:null,
    tab:{cookieStoreId:managed?"firefox-container-1":"firefox-default"},
    route:managed?{name:"Route",provider:"mullvad"}:null,routeTest:null};
  const browser={
    storage:{
      session:{async get(key){assert.equal(key,"pcms.status.v1");return {[key]:summary};}},
      onChanged:{addListener(fn){opened.listeners.push(fn);}}
    },
    runtime:{
      async sendMessage(m){
        opened.messages.push(m.type);
        if(m.type==="GET_SNAPSHOT")return {
          state:{routes:{r1:{id:"r1",name:"Route"}},global:{enforcePrivacyControls:true}},
          security:{privacySafe:true}
        };
        if(m.type==="GET_ACTIVE_CONTEXT")return active;
        throw Error("unexpected popup message");
      },
      getURL(path){return "moz-extension://test-extension/"+path;},
      openOptionsPage:async()=>{}
    },
    tabs:{
      async query(){return tabs;},
      async update(id,opts){opened.updated.push({id,...opts});},
      async create(opts){opened.created.push(opts);}
    },
    windows:{async update(id,opts){opened.focused.push({id,...opts});}}
  };
  const code=js.replace(/^import\s+\{[^}]*\}\s+from\s+"..\/lib\/constants.js";/m,
    'const BLOCK_ROUTE_ID="__block__", DIRECT_ROUTE_ID="__direct__";');
  assert.ok(!code.startsWith("import "), "popup module import mock applied");
  runInNewContext(code,{browser,document:{getElementById(id){return nodes[id]??null;}},console});
  for(let i=0;i<12;i++) await new Promise((resolve)=>setImmediate(resolve));
  return {nodes,opened,browser};
}

const status=(overrides={})=>({
  schemaVersion:1,state:"RUNNING",asOf:new Date().toISOString(),
  counts:{attention:3,unresolvedOperations:1,accounts:1},
  recoveryState:"NORMAL",
  personaAccounts:[{personaUid:"persona-alice",accounts:[{accountId:"Alice:main",displayName:"Alice"}]}],
  ...overrides
});

test("A035-01 — popup retains fixed 370px intrinsic ESR width and bounded height",()=>{
  assert.match(css,/body\s*\{[^}]*width:370px;/);
  assert.match(css,/main\s*\{\s*max-height:560px;\s*overflow-y:auto;/);
  assert.doesNotMatch(css,/body\s*\{[^}]*(?:\b\d+vw\b|min\()/);
  assert.match(css,/\.pcms-detail\s*\{[^}]*text-overflow:ellipsis;/);
  assert.match(html,/id="pcmsBlock"/);
  assert.match(html,/id="pcmsOpenAccount"/);
});

test("A035-02 — only safe summary fields are rendered, never raw sensitive fields",async()=>{
  const poisoned=status({cookieStoreId:"SENSITIVE_CONTAINER",
    secret:"SENSITIVE_SECRET",humanTaskInstructions:"SENSITIVE_INSTRUCTIONS",
    counts:{attention:2}});
  const {nodes,opened}=await mount({summary:poisoned});
  assert.equal(nodes.pcmsState.textContent,"Running");
  assert.equal(nodes.pcmsAccount.textContent,"Account: Alice");
  assert.equal(nodes.pcmsAttention.textContent,"2 items need attention");
  assert.equal(nodes.pcmsOpenAccount.hidden,false);
  assert.deepEqual(opened.messages,["GET_SNAPSHOT","GET_ACTIVE_CONTEXT"]);
  const rendered=["pcmsState","pcmsAccount","pcmsAttention","pcmsAsOf"].map((k)=>nodes[k].textContent).join("|");
  for(const forbidden of ["SENSITIVE_CONTAINER","SENSITIVE_SECRET","SENSITIVE_INSTRUCTIONS"])
    assert.equal(rendered.includes(forbidden),false);
});

test("A035-03 — linked account deep link focuses existing PCMS tab",async()=>{
  const existing={id:22,windowId:4,url:"moz-extension://test-extension/pcms/app/index.html#/overview"};
  const {nodes,opened}=await mount({summary:status(),tabs:[existing]});
  nodes.pcmsOpenAccount.onclick();
  for(let i=0;i<5;i++)await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(opened.updated,[{id:22,url:"moz-extension://test-extension/pcms/app/index.html#/accounts/Alice%3Amain",active:true}]);
  assert.deepEqual(opened.focused,[{id:4,focused:true}]);
  assert.deepEqual(opened.created,[]);
});

test("A035-03 — no prior PCMS tab opens one and rejects malformed IDs",async()=>{
  const created=await mount({summary:status()});
  created.nodes.pcmsOpenAccount.onclick();
  for(let i=0;i<4;i++)await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(created.opened.created.length,1);
  assert.equal(created.opened.created[0].url,"moz-extension://test-extension/pcms/app/index.html#/accounts/Alice%3Amain");
  const malformed=await mount({summary:status({personaAccounts:[{personaUid:"persona-alice",accounts:[{accountId:"<script>",displayName:"bad"}]}]})});
  assert.equal(malformed.nodes.pcmsOpenAccount.hidden,true);
  assert.equal(malformed.nodes.pcmsAccount.textContent,"No linked account for this Persona");
});

test("A035-03 — distinguishes explicit unavailable and idle-last-known states",async()=>{
  const idle=await mount({summary:status({asOf:new Date(Date.now()-300000).toISOString()})});
  assert.equal(idle.nodes.pcmsState.textContent,"Idle · last known");
  const unavailable=await mount({summary:status({state:"UNAVAILABLE",personaAccounts:[]})});
  assert.equal(unavailable.nodes.pcmsState.textContent,"Unavailable");
  assert.match(unavailable.nodes.pcmsAttention.textContent,/unavailable/);
});

test("A035-02/A035-03 — unmanaged context hides account block except attention or hold",async()=>{
  const attention=await mount({managed:false,summary:status()});
  assert.equal(attention.nodes.pcmsBlock.classList.contains("hidden"),false);
  assert.equal(attention.nodes.pcmsAccount.hidden,true);
  assert.equal(attention.nodes.pcmsOpenAccount.hidden,true);
  const empty=await mount({managed:false,summary:status({counts:{attention:0},recoveryState:"NORMAL"})});
  assert.equal(empty.nodes.pcmsBlock.classList.contains("hidden"),true);
  const hold=await mount({managed:false,summary:status({counts:{attention:0},recoveryState:"RECOVERY_HOLD"})});
  assert.equal(hold.nodes.pcmsBlock.classList.contains("hidden"),false);
  assert.equal(hold.nodes.pcmsAttention.textContent,"PCMS on hold after restore");
});

test("A035-03 — storage.session revision updates popup without any Core request",async()=>{
  const {nodes,opened}=await mount({summary:status()});
  assert.equal(opened.listeners.length,1);
  opened.listeners[0]({"pcms.status.v1":{newValue:status({counts:{attention:1}})}},"session");
  assert.equal(nodes.pcmsAttention.textContent,"1 item needs attention");
  assert.deepEqual(opened.messages,["GET_SNAPSHOT","GET_ACTIVE_CONTEXT"]);
});
