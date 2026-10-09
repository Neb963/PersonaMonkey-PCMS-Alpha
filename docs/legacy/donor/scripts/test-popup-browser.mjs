import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, extname, normalize, resolve } from "node:path";
import { captureBrowserScreenshot } from "./capture-browser-screenshot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(root, "extension");
const popupHtml = readFileSync(resolve(extensionRoot, "popup/popup.html"), "utf8");

const stub = `
<script>
(() => {
  const mode = new URL(location.href).searchParams.get("mode") || "managed";
  const clone = (value) => structuredClone(value);
  const route = { id:"r1", name:"Healthy Route", provider:"mullvad", country:"NL", city:"Amsterdam", enabled:true };
  const profile = { containerId:"firefox-container-1", name:"Work", managed:true, routeId:"r1", killSwitch:true, scriptIds:["signal"] };
  const snapshot = {
    state:{ global:{ enforcePrivacyControls:true }, routes:{ r1:route } },
    security:{ ready:true, privacySafe:true }
  };
  const container = { cookieStoreId:"firefox-container-1", name:"Work", color:"blue", colorCode:"#37adff", icon:"briefcase" };
  const control = { updates:[], tests:0, options:0, updateFailure:false, testFailure:false, updateDelay:0, testDelay:0 };
  window.__popupSmoke = control;

  const activeContext = () => {
    if (mode === "unmanaged") return { tab:{ cookieStoreId:"firefox-default" }, profile:null, container:null, route:null };
    const currentRoute = profile.routeId === "r1" ? route : null;
    return {
      tab:{ cookieStoreId:profile.containerId },
      profile:clone(profile),
      container:clone(container),
      route:currentRoute ? clone(currentRoute) : null,
      mullvadNative:currentRoute ? { ready:true, selected_entry:"entry-1" } : null,
      routeTest:{ ok:true, checkedAt:new Date().toISOString() }
    };
  };

  window.browser = {
    runtime:{
      async sendMessage(message){
        if (message.type === "GET_SNAPSHOT") return clone(snapshot);
        if (message.type === "GET_ACTIVE_CONTEXT") return activeContext();
        if (message.type === "UPDATE_PROFILE_ROUTE") {
          control.updates.push(clone(message));
          if (control.updateDelay) { const delay=control.updateDelay; control.updateDelay=0; await new Promise((resolve)=>setTimeout(resolve,delay)); }
          if (control.updateFailure) { control.updateFailure=false; throw new Error("Smoke route update failure"); }
          profile.routeId = message.routeId;
          return { ok:true };
        }
        if (message.type === "TEST_PROFILE") {
          control.tests += 1;
          if (control.testDelay) { const delay=control.testDelay; control.testDelay=0; await new Promise((resolve)=>setTimeout(resolve,delay)); }
          if (control.testFailure) return { ok:false, error:"Smoke route failure" };
          return { ok:true, data:{ ip:"198.51.100.7", city:"Amsterdam", country:"NL", mullvad_exit_ip:true } };
        }
        throw new Error("Unexpected popup message " + message.type);
      },
      openOptionsPage(){
        control.options += 1;
        return Promise.resolve();
      }
    }
  };
})();
</script>`;

const smoke = `
<script type="module">
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, label) => {
  for (let i = 0; i < 160; i += 1) {
    const value = fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("timeout " + label);
};

try {
  window.__popupSmokeErrors = [];
  window.addEventListener("error", (event) => window.__popupSmokeErrors.push(event.error?.stack || event.message || "unknown error"));
  window.addEventListener("unhandledrejection", (event) => window.__popupSmokeErrors.push(String(event.reason?.stack || event.reason || "unknown rejection")));
  const params = new URL(location.href).searchParams;
  const mode = params.get("mode") || "managed";
  const requestedWidth = Number(params.get("width") || 0);
  if (requestedWidth && requestedWidth <= 340 && window.innerWidth > 340) throw new Error("constrained popup smoke did not run at the requested narrow viewport: " + window.innerWidth);
  if (requestedWidth >= 370 && window.innerWidth < 360) throw new Error("standard popup smoke did not run at the expected width: " + window.innerWidth);
  if (!document.getElementById("route").disabled || !document.getElementById("test").disabled) throw new Error("popup route controls are interactive before state loads");
  await import("/popup/popup.js");
  await waitFor(() => document.getElementById("status").textContent !== "…", "popup load");

  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    throw new Error("popup overflows the available viewport");
  }
  if (document.getElementById("status").getAttribute("role") !== "status" || document.getElementById("status").getAttribute("aria-live") !== "polite") {
    throw new Error("popup status is not an accessible live region");
  }
  if (parseFloat(getComputedStyle(document.getElementById("test")).minHeight) < 40) {
    throw new Error("popup primary target is below 40px");
  }

  if (mode === "unmanaged") {
    if (document.getElementById("status").textContent !== "Not a persona") throw new Error("unmanaged state label missing");
    if (!document.getElementById("route").disabled || !document.getElementById("test").disabled) throw new Error("unmanaged route controls are enabled");
    if (!document.getElementById("actionHint").textContent.includes("not a managed persona")) throw new Error("unmanaged disabled reason missing");
    document.getElementById("options").click();
    await waitFor(() => window.__popupSmoke.options === 1, "open settings from unmanaged popup");
  } else {
    if (document.getElementById("status").textContent !== "Protected route") throw new Error("protected route state missing");
    const context = document.getElementById("context").textContent;
    if (!context.includes("Protection") || !context.includes("Enforced") || !context.includes("Healthy Route")) throw new Error("managed persona context is incomplete");
    if (document.getElementById("route").value !== "r1") throw new Error("active route is not selected");

    document.getElementById("options").click();
    await waitFor(() => window.__popupSmoke.options === 1, "open settings");

    window.__popupSmoke.testDelay = 120;
    document.getElementById("test").click();
    if (document.getElementById("test").getAttribute("aria-busy") !== "true" || !document.getElementById("test").disabled || !document.getElementById("test").textContent.includes("Verifying")) throw new Error("route verification has no pending control state");
    await waitFor(() => document.getElementById("result").textContent.includes("198.51.100.7"), "successful route verification");
    await waitFor(() => !document.getElementById("test").disabled && !document.getElementById("test").hasAttribute("aria-busy"), "route verification control reset");
    if (!document.getElementById("result").textContent.includes("Mullvad exit")) throw new Error("route verification result lost exit semantics");

    const routeSelect = document.getElementById("route");
    routeSelect.value = "__direct__";
    routeSelect.dispatchEvent(new Event("change", { bubbles:true }));
    if (window.__popupSmoke.updates.some((item) => item.routeId === "__direct__")) throw new Error("Direct route applied before confirmation");
    if (document.getElementById("directWarning").classList.contains("hidden")) throw new Error("Direct route warning did not appear");
    if (!document.getElementById("result").textContent.includes("requires confirmation")) throw new Error("Direct route pending state is not explained");
    document.getElementById("cancelDirect").click();
    if (window.__popupSmoke.updates.some((item) => item.routeId === "__direct__")) throw new Error("Cancelling Direct routing still changed the route");
    if (document.getElementById("route").value !== "r1" || !document.getElementById("directWarning").classList.contains("hidden")) throw new Error("Cancelling Direct routing did not restore the active route");
    routeSelect.value = "__direct__";
    routeSelect.dispatchEvent(new Event("change", { bubbles:true }));
    window.__popupSmoke.updateDelay = 120;
    document.getElementById("confirmDirect").click();
    if (routeSelect.getAttribute("aria-busy") !== "true" || !routeSelect.disabled || !document.getElementById("confirmDirect").disabled || !document.getElementById("cancelDirect").disabled) throw new Error("Direct route apply is not locked while pending");
    await waitFor(() => window.__popupSmoke.updates.some((item) => item.routeId === "__direct__"), "direct route update");
    await waitFor(() => document.getElementById("status").textContent === "Direct network" && !routeSelect.disabled, "direct route state");
    if (!document.getElementById("context").textContent.includes("Direct network")) throw new Error("direct network context missing");
    if (!document.getElementById("result").textContent.includes("Route applied")) throw new Error("route-change feedback missing");

    window.__popupSmoke.updateFailure = true;
    routeSelect.value = "r1";
    routeSelect.dispatchEvent(new Event("change", { bubbles:true }));
    await waitFor(() => document.getElementById("result").textContent.includes("Smoke route update failure"), "failed route change");
    if (routeSelect.value !== "__direct__" || routeSelect.disabled || !document.getElementById("directWarning").classList.contains("hidden")) throw new Error("failed route change did not restore the previous route and controls");
    window.__popupSmoke.testFailure = true;
    document.getElementById("test").click();
    await waitFor(() => document.getElementById("result").textContent.includes("Smoke route failure"), "failed route verification");
    const result = document.getElementById("result");
    if (result.getAttribute("role") !== "alert" || result.getAttribute("aria-live") !== "assertive") throw new Error("popup error feedback is not assertive");

    // Leave screenshot capture in a normal protected state instead of the
    // intentional failure state exercised above.
    window.__popupSmoke.testFailure = false;
    routeSelect.value = "r1";
    routeSelect.dispatchEvent(new Event("change", { bubbles:true }));
    await waitFor(() => document.getElementById("status").textContent === "Protected route" && !routeSelect.disabled, "review route state");
    document.getElementById("test").click();
    await waitFor(() => document.getElementById("result").textContent.includes("198.51.100.7"), "review verification state");
  }

  if (window.__popupSmokeErrors.length) throw new Error("browser errors " + JSON.stringify(window.__popupSmokeErrors));
  document.title = "PASS";
  if (window.parent !== window) window.parent.document.title = "PASS";
} catch (error) {
  const failure = error.stack || String(error);
  document.body.dataset.failure = failure;
  document.title = "FAIL";
  if (window.parent !== window) {
    window.parent.document.body.dataset.failure = failure;
    window.parent.document.title = "FAIL";
  }
}
</script>`;

const page = popupHtml.replace('<script type="module" src="popup.js"></script>', stub + smoke);
const mime = new Map([[".js","text/javascript; charset=utf-8"],[".css","text/css; charset=utf-8"],[".png","image/png"]]);

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/popup/popup-smoke-frame.html") {
    const requestedWidth = Math.max(1, Math.min(1000, Number(url.searchParams.get("width") || 370)));
    const mode = url.searchParams.get("mode") || "managed";
    const innerSrc = `/popup/popup-smoke.html?mode=${encodeURIComponent(mode)}&width=${requestedWidth}`;
    res.writeHead(200, { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title></head>
<body style="margin:0"><iframe id="smoke" title="Popup smoke viewport" src="${innerSrc}" style="display:block;width:${requestedWidth}px;height:700px;border:0"></iframe>
</body></html>`);
    return;
  }
  if (url.pathname === "/popup/popup-smoke.html") {
    res.writeHead(200, { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" });
    res.end(page);
    return;
  }
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const target = resolve(extensionRoot, relative);
  if (!target.startsWith(extensionRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(target);
    res.writeHead(200, { "Content-Type":mime.get(extname(target)) || "application/octet-stream", "Cache-Control":"no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const port = server.address().port;
const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean);
const cases = [
  { mode:"managed", width:370 },
  { mode:"managed", width:320 },
  { mode:"unmanaged", width:320 }
];
let browser = null;

for (const command of candidates) {
  let unavailable = false;
  for (const testCase of cases) {
    const pageUrl = `http://127.0.0.1:${port}/popup/popup-smoke-frame.html?mode=${testCase.mode}&width=${testCase.width}`;
    const child = spawn(command, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=520,760",
      "--virtual-time-budget=12000",
      "--dump-dom",
      pageUrl
    ], { stdio:["ignore","pipe","pipe"] });
    const chunks = [], errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const childResult = await new Promise((resolveChild) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveChild({ code:124 }); }, 35000);
      child.on("error", (error) => { clearTimeout(timer); resolveChild({ code:null, error }); });
      child.on("close", (code) => { clearTimeout(timer); resolveChild({ code }); });
    });
    if (childResult.error?.code === "ENOENT") {
      unavailable = true;
      break;
    }
    const stdout = Buffer.concat(chunks).toString("utf8");
    const stderr = Buffer.concat(errors).toString("utf8");
    if (childResult.code !== 0) {
      server.close();
      throw new Error(`${command} popup smoke exited ${childResult.code} for ${testCase.mode} at ${testCase.width}px\n${stderr.slice(-3000)}`);
    }
    if (!stdout.includes("<title>PASS</title>")) {
      server.close();
      const failure = stdout.match(/<body[^>]*\bdata-failure="([^"]*)"/i)?.[1]
        ?.replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
      throw new Error(`Popup browser smoke failed using ${command} for ${testCase.mode} at ${testCase.width}px.${failure ? `\nBrowser assertion:\n${failure}` : ""}\nDOM tail:\n${stdout.slice(-10000)}\nBrowser stderr:\n${stderr.slice(-3000)}`);
    }
    await captureBrowserScreenshot({
      command,
      url:pageUrl,
      width:520,
      height:760,
      name:`popup-${testCase.mode}-${testCase.width}`,
      virtualTimeBudget:12000
    });
  }
  if (!unavailable) {
    browser = command;
    break;
  }
}

server.close();
if (!browser) throw new Error("No Chrome/Chromium executable available for popup browser smoke test");
console.log(`Popup browser smoke passed in ${browser} for managed/unmanaged and constrained-width states`);
