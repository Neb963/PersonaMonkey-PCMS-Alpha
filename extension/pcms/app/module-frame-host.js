// Dashboard host of a runtime module page (pcms.ui-contribution/v1 §5, ADR-003 §6).
//
// The module's `ui` entry runs in pcms/sandbox/module-ui.html: a declared sandbox page
// (opaque origin, sandbox CSP without network) embedded with sandbox="allow-scripts". The
// host refuses a frame whose document it can reach. The frame receives one private
// MessagePort and can only *request*: reads of its own module's projections, its module's
// declared actions (risky ones confirmed by the Core dialog outside the frame), navigation
// to an EntityRef, and a bounded height. Every message is validated here; the frame never
// receives a Core, extension or other-module handle.
import { normalizePcmsUiEntityRef, pcmsUiEntityHref } from "../integration/ui-contribution-contract.js";

export const PCMS_MODULE_UI_PAGE="../sandbox/module-ui.html";
export const PCMS_MODULE_UI_BOOTSTRAP="pcms.module-ui.bootstrap";
export const PCMS_MODULE_UI_VERSION=1;
const METHODS=new Set(["listRows","getDetail","invoke","navigate","resize"]);
const MAX_INFLIGHT=16;
const MAX_MESSAGE_BYTES=64*1024;
const MIN_HEIGHT=120;
const MAX_HEIGHT=4000;

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function exact(value,required,optional=[]){
  if(!plain(value)) return false;
  const keys=Object.keys(value);
  return required.every((key)=>Object.hasOwn(value,key))&&keys.every((key)=>required.includes(key)||optional.includes(key));
}

function sessionKey(){
  const bytes=new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

function safeError(error){
  return {code:typeof error?.code==="string"?error.code.slice(0,96):"PCMS_MODULE_UI_FAILED",message:String(error?.message||"Request failed").slice(0,200)};
}

// The frame host's request policy, separated from DOM plumbing so it is unit-testable.
export function createPcmsModuleFrameRequestHandler({runtime,frameInfo,runAction,navigate,resize}){
  const actions=new Map((frameInfo.actions||[]).map((action)=>[action.id,action]));
  const module=Object.freeze({moduleId:frameInfo.moduleId,title:frameInfo.title});
  let inflight=0;

  async function dispatch(method,params){
    if(method==="listRows"){
      if(!exact(params,["view"],["cursor"])||typeof params.view!=="string") throw new TypeError("listRows request is invalid");
      return runtime.ui.listRows(module.moduleId,params.view,params.cursor??null);
    }
    if(method==="getDetail"){
      if(!exact(params,["view","id"])||typeof params.view!=="string"||typeof params.id!=="string") throw new TypeError("getDetail request is invalid");
      return runtime.ui.getDetail(module.moduleId,params.view,params.id);
    }
    if(method==="invoke"){
      if(!exact(params,["actionId"],["target","input"])) throw new TypeError("invoke request is invalid");
      const action=actions.get(params.actionId);
      if(!action) throw Object.assign(new Error("The module did not declare this action"),{code:"PCMS_UI_ACTION_UNKNOWN"});
      const receipt=await runAction({module,action,target:params.target??null,input:params.input??null});
      return receipt.cancelled
        ?{cancelled:true}
        :{cancelled:false,status:receipt.status,message:receipt.message,subject:receipt.subject??null};
    }
    if(method==="navigate"){
      if(!exact(params,["entity"])) throw new TypeError("navigate request is invalid");
      const href=pcmsUiEntityHref(normalizePcmsUiEntityRef(params.entity));
      navigate(href);
      return {href};
    }
    if(method==="resize"){
      if(!exact(params,["height"])||!Number.isFinite(params.height)) throw new TypeError("resize request is invalid");
      const height=Math.max(MIN_HEIGHT,Math.min(MAX_HEIGHT,Math.round(params.height)));
      resize(height);
      return {height};
    }
    throw new TypeError("Unknown module UI request");
  }

  return async function handle(message){
    if(!exact(message,["version","sessionId","type","requestId","method","params"])
        ||typeof message.requestId!=="string"||!/^[A-Za-z0-9-]{1,32}$/.test(message.requestId)
        ||!METHODS.has(message.method)) {
      return null;
    }
    if(inflight>=MAX_INFLIGHT) return {requestId:message.requestId,ok:false,error:{code:"PCMS_MODULE_UI_CAPACITY",message:"Too many pending requests"}};
    inflight+=1;
    try{return {requestId:message.requestId,ok:true,result:JSON.parse(JSON.stringify(await dispatch(message.method,message.params)??null))};}
    catch(error){return {requestId:message.requestId,ok:false,error:safeError(error)};}
    finally{inflight-=1;}
  };
}

export function createPcmsModuleFrameHost({
  documentRef=globalThis.document,
  windowRef=globalThis.window,
  runtime,
  runAction,
  pageUrl=PCMS_MODULE_UI_PAGE,
  loadTimeoutMs=10000,
  MessageChannelRef=globalThis.MessageChannel
}={}){
  if(typeof runtime?.ui?.frame!=="function") throw new TypeError("Module frame host requires the PCMS UI client");
  if(typeof runAction!=="function") throw new TypeError("Module frame host requires the action runner");
  let current=null;

  function dispose(){
    const active=current;
    current=null;
    if(!active) return;
    try{active.port?.close();}catch{}
    try{active.frame.remove();}catch{}
  }

  function setState(container,state,text=null){
    container.dataset.frameState=state;
    const status=container.querySelector?.(".module-frame-status");
    if(status&&text!==null) status.textContent=text;
  }

  async function mount(container,moduleId){
    dispose();
    const token={};
    current={token,frame:{remove(){}},port:null};
    while(container.firstChild) container.removeChild(container.firstChild);
    const status=documentRef.createElement("p");
    status.className="module-frame-status";
    status.textContent="Loading module page…";
    container.appendChild(status);
    setState(container,"loading");
    let info;
    try{info=await runtime.ui.frame(moduleId);}
    catch(error){
      if(current?.token===token) setState(container,"error","Module page unavailable · "+safeError(error).code);
      return;
    }
    if(current?.token!==token) return;

    const frame=documentRef.createElement("iframe");
    frame.setAttribute("sandbox","allow-scripts");
    frame.setAttribute("title",info.title+" module page");
    frame.setAttribute("data-pcms-module",info.moduleId);
    frame.setAttribute("data-pcms-generation",String(info.generation));
    frame.setAttribute("height","480");
    frame.className="module-frame";
    current.frame=frame;
    const loaded=new Promise((resolve,reject)=>{
      const timer=windowRef.setTimeout(()=>reject(new Error("Module page did not load")),loadTimeoutMs);
      frame.addEventListener("load",()=>{windowRef.clearTimeout(timer);resolve();},{once:true});
    });
    frame.setAttribute("src",pageUrl);
    container.appendChild(frame);
    try{await loaded;}
    catch{if(current?.token===token) setState(container,"error","Module page did not load");return;}
    if(current?.token!==token) return;

    // Fail closed unless the page is opaque to the dashboard (declared sandbox page).
    let reachable=null;
    try{reachable=frame.contentDocument;}catch{reachable=null;}
    if(reachable){
      frame.remove();
      setState(container,"error","Module page is not isolated; it was not started");
      return;
    }
    container.dataset.frameIsolated="true";

    const sessionId=sessionKey();
    const channel=new MessageChannelRef();
    const port=channel.port1;
    current.port=port;
    const handle=createPcmsModuleFrameRequestHandler({
      runtime,
      frameInfo:info,
      runAction,
      navigate:(href)=>{windowRef.location.hash=href;},
      resize:(height)=>frame.setAttribute("height",String(height))
    });
    let requests=0;
    function send(message){port.postMessage({version:PCMS_MODULE_UI_VERSION,sessionId,...message});}
    port.addEventListener("message",(event)=>{
      if(current?.token!==token) return;
      const message=event.data;
      let size=Infinity;
      try{size=JSON.stringify(message).length;}catch{}
      if(!plain(message)||message.version!==PCMS_MODULE_UI_VERSION||message.sessionId!==sessionId||size>MAX_MESSAGE_BYTES) return;
      if(message.type==="ready"){
        send({type:"load",source:info.source,context:{moduleId:info.moduleId,title:info.title,generation:info.generation,
          actions:info.actions.map((action)=>({id:action.id,label:action.label,risk:action.risk,appliesTo:action.appliesTo}))}});
        return;
      }
      if(message.type==="loaded"){setState(container,"loaded","");return;}
      if(message.type==="load-failed"){setState(container,"error","Module page failed to start");return;}
      if(message.type==="request"){
        requests+=1;
        container.dataset.frameRequests=String(requests);
        container.dataset.frameLastRequest=String(message.method).slice(0,16);
        void handle(message).then((reply)=>{
          if(reply&&current?.token===token) send({type:"response",...reply});
        });
      }
    });
    port.start();
    frame.contentWindow.postMessage({type:PCMS_MODULE_UI_BOOTSTRAP,version:PCMS_MODULE_UI_VERSION,sessionId},"*",[channel.port2]);
    setState(container,"connecting","Starting module page…");
  }

  return Object.freeze({mount,dispose,get moduleId(){return current?.frame?.getAttribute?.("data-pcms-module")||null;}});
}
