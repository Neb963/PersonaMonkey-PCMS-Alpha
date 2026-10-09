// Module-UI sandbox runtime (ADR-003 §6, pcms.ui-contribution/v1 §5). A classic script: the
// declared sandbox page has an opaque origin and cannot fetch ES modules (P030 observation).
//
// The page is a manifest `sandbox` page with the shared sandbox CSP (no network, no frames,
// no workers), embedded by the dashboard with sandbox="allow-scripts": it has no extension
// APIs and cannot reach the dashboard DOM. It receives one private MessagePort, then the
// module's own `ui` entry source, which it evaluates with a Core UI kit. Every request the
// module UI makes (reads of its own projections, its declared actions, navigation to an
// EntityRef, a size change) is a message the dashboard validates; risky actions are
// confirmed by a Core dialog outside this frame.
(() => {
  "use strict";
  const BOOTSTRAP_TYPE = "pcms.module-ui.bootstrap";
  const VERSION = 1;
  const MAX_SOURCE_BYTES = 256 * 1024;
  const MAX_PENDING = 32;
  const REQUEST_TIMEOUT_MS = 60000;
  const TAGS = new Set(["div", "span", "p", "h2", "h3", "h4", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
    "button", "label", "input", "select", "option", "textarea", "strong", "em", "small", "section", "header", "footer", "form", "code", "dl", "dt", "dd"]);
  const TOKENS = new Set(["OK", "INFO", "ACTIVE", "WAITING_HUMAN", "WARNING", "ERROR", "UNCERTAIN", "HELD", "UNAVAILABLE"]);
  const ATTRIBUTES = new Set(["type", "name", "value", "placeholder", "min", "max", "maxlength", "for", "id", "title", "role", "aria-label", "colspan", "rowspan"]);
  const encoder = new TextEncoder();
  const root = document.getElementById("root");
  const statusLine = document.getElementById("moduleUiStatus");

  let port = null;
  let post = null;
  let sessionId = null;
  let loaded = false;
  let sequence = 0;
  const pending = new Map();

  function setStatus(text, state) {
    statusLine.textContent = text;
    statusLine.dataset.state = state;
  }

  function send(message) {
    if (!post) throw new Error("Module UI is not connected");
    post(Object.assign({ version: VERSION, sessionId }, message));
  }

  function request(method, params) {
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many pending module UI requests"));
    const requestId = "r" + (++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("PCMS did not answer"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      try {
        send({ type: "request", requestId, method, params: JSON.parse(JSON.stringify(params === undefined ? null : params)) });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  function h(tag, props, ...children) {
    if (typeof tag !== "string" || !TAGS.has(tag)) throw new TypeError("Element is not allowed in module UI: " + String(tag));
    const node = document.createElement(tag);
    const options = props || {};
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = String(value);
      else if (key === "className") node.className = String(value);
      else if (key === "onClick") node.addEventListener("click", (event) => { event.preventDefault(); value(event); });
      else if (key === "onChange") node.addEventListener("change", (event) => value(event));
      else if (key === "onSubmit") node.addEventListener("submit", (event) => { event.preventDefault(); value(event); });
      else if (key === "disabled" || key === "checked" || key === "required") node[key] = value === true;
      else if (key.startsWith("data-") && /^data-[a-z0-9-]{1,40}$/.test(key)) node.setAttribute(key, String(value));
      else if (ATTRIBUTES.has(key)) node.setAttribute(key, String(value));
      else throw new TypeError("Attribute is not allowed in module UI: " + key);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "object" && child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function statusPill(token, label) {
    const safe = TOKENS.has(token) ? token : "INFO";
    const pill = h("span", { className: "status-token", text: label || safe });
    pill.dataset.token = safe;
    return pill;
  }

  function table(columns, rows) {
    return h("table", { className: "ui-table" },
      h("thead", null, h("tr", null, columns.map((column) => h("th", { text: column.label })))),
      h("tbody", null, rows.map((row) => h("tr", null, columns.map((column) => {
        const value = row[column.id];
        if (value && typeof value === "object" && typeof value.token === "string") return h("td", null, statusPill(value.token, value.label));
        return h("td", { text: value === null || value === undefined ? "—" : String(value) });
      })))));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function makeKit(context) {
    return Object.freeze({
      context,
      root,
      h,
      clear,
      statusPill,
      table,
      listRows: (view, cursor = null) => request("listRows", { view, cursor }),
      getDetail: (view, id) => request("getDetail", { view, id }),
      invoke: (actionId, target = null, input = null) => request("invoke", { actionId, target, input }),
      navigate: (entity) => request("navigate", { entity }),
      resize: (height) => request("resize", { height })
    });
  }

  async function load(message) {
    if (loaded) throw new Error("Module UI is already loaded");
    const source = message.source;
    if (typeof source !== "string" || !source.trim() || encoder.encode(source).byteLength > MAX_SOURCE_BYTES) throw new Error("Module UI source is invalid");
    const context = Object.freeze(JSON.parse(JSON.stringify(message.context || {})));
    loaded = true;
    clear(root);
    let factory;
    try {
      factory = Function('"use strict"; return (' + source + "\n);")();
    } catch {
      throw new Error("Module UI source does not compile");
    }
    if (typeof factory !== "function") throw new Error("Module UI entry must evaluate to a function");
    document.title = String(context.title || "Module");
    await factory(makeKit(context));
    setStatus("", "ready");
  }

  function onPortMessage(event) {
    const message = event && event.data;
    if (!message || typeof message !== "object" || message.version !== VERSION || message.sessionId !== sessionId) return;
    if (message.type === "response") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else {
        const error = new Error(String(message.error && message.error.message || "Request failed").slice(0, 200));
        error.code = String(message.error && message.error.code || "PCMS_MODULE_UI_FAILED").slice(0, 96);
        entry.reject(error);
      }
      return;
    }
    if (message.type === "load") {
      load(message).then(
        () => send({ type: "loaded" }),
        (error) => {
          setStatus("Module UI failed to load.", "error");
          send({ type: "load-failed", message: String(error && error.message || "failed").slice(0, 200) });
        });
    }
  }

  function onBootstrap(event) {
    if (port || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== BOOTSTRAP_TYPE || data.version !== VERSION || typeof data.sessionId !== "string"
        || !/^[A-Za-z0-9-]{8,64}$/.test(data.sessionId) || !event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    sessionId = data.sessionId;
    post = port.postMessage.bind(port);
    window.removeEventListener("message", onBootstrap);
    port.addEventListener("message", onPortMessage);
    port.start();
    setStatus("Loading module…", "loading");
    send({ type: "ready" });
  }

  window.addEventListener("message", onBootstrap);
})();
