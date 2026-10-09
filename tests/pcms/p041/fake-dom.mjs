// Minimal DOM for driving the P041 Settings view in Node. Supports only what the view uses:
// elements, text, dataset, attributes, events, [data-*] / #id / tag selectors and closest().

function camel(name) { return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()); }

function parseSelector(selector) {
  const s = selector.trim();
  let m = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/.exec(s);
  if (m) return (node) => node.dataset && Object.hasOwn(node.dataset, camel(m[1])) && (m[2] === undefined || node.dataset[camel(m[1])] === m[2]);
  m = /^#([A-Za-z0-9_-]+)$/.exec(s);
  if (m) return (node) => node.getAttribute?.("id") === m[1];
  m = /^([a-z0-9]+)\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/.exec(s);
  if (m) return (node) => node.tagName === m[1].toUpperCase() && Object.hasOwn(node.dataset || {}, camel(m[2])) && (m[3] === undefined || node.dataset[camel(m[2])] === m[3]);
  if (/^[a-z0-9]+$/.test(s)) return (node) => node.tagName === s.toUpperCase();
  throw new Error("Unsupported selector " + selector);
}

class FakeNode {
  constructor(doc, tagName = null, text = "") {
    this.ownerDocument = doc;
    this.tagName = tagName ? tagName.toUpperCase() : null;
    this.childNodes = [];
    this.parentNode = null;
    this._text = text;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.className = "";
    this.files = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((node) => node.tagName); }
  get textContent() { return this.tagName ? this._text + this.childNodes.map((node) => node.textContent).join("") : this._text; }
  set textContent(value) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this._text = String(value); }
  appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === "string" ? this.ownerDocument.createTextNode(node) : node); }
  prepend(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.childNodes.unshift(node); }
  removeChild(node) { this.childNodes = this.childNodes.filter((child) => child !== node); node.parentNode = null; return node; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  async dispatch(type, init = {}) {
    const event = { type, target: init.target || this, preventDefault() {}, ...init };
    const results = [];
    for (let node = this; node; node = node.parentNode) {
      for (const fn of node.listeners.get(type) || []) results.push(fn.call(node, event));
    }
    await Promise.all(results);
    await settle();
  }
  click() { if (this.disabled) return Promise.resolve(); return this.dispatch("click"); }
  closest(selector) {
    const match = parseSelector(selector);
    for (let node = this; node; node = node.parentNode) if (node.tagName && match(node)) return node;
    return null;
  }
  *walk() { for (const child of this.childNodes) { if (child.tagName) { yield child; yield* child.walk(); } } }
  querySelectorAll(selector) { const match = parseSelector(selector); return [...this.walk()].filter(match); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
}

export async function settle(turns = 30) { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)); }

export function makeDocument(ids = []) {
  const doc = {
    body: null,
    createElement(tag) { return new FakeNode(doc, tag); },
    createTextNode(text) { return new FakeNode(doc, null, text); },
    getElementById(id) { return doc.body.querySelector("#" + id); }
  };
  doc.body = new FakeNode(doc, "body");
  for (const id of ids) { const node = doc.createElement("div"); node.setAttribute("id", id); doc.body.appendChild(node); }
  return doc;
}

export function makeWindow() {
  const urls = [];
  return {
    urls,
    URL: { createObjectURL(blob) { urls.push(blob); return "blob:fake/" + urls.length; }, revokeObjectURL() {} },
    Blob: class { constructor(parts, options) { this.text = parts.join(""); this.type = options?.type; } }
  };
}

export function fakeFile(name, text) { return { name, size: text.length, async text() { return text; } }; }
