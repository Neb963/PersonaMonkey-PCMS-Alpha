import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(root, "extension");
const manifestPath = resolve(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const errors = [];

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}
function requirePath(path, label = path) {
  requireCondition(existsSync(resolve(extensionDir, path)), `Missing ${label}: ${path}`);
}

requireCondition(manifest.manifest_version === 3, "manifest_version must remain 3");
requireCondition(/^\d+\.\d+\.\d+$/.test(String(manifest.version || "")), "manifest version must be x.y.z");
requireCondition(manifest.browser_specific_settings?.gecko?.id === "persona-route-manager@local", "Gecko extension ID must remain persona-route-manager@local");
requireCondition(manifest.background?.type === "module", "background must remain an ES module");
for (const permission of ["storage", "proxy", "webRequest", "webRequestBlocking", "webNavigation", "tabs", "sessions", "cookies", "browsingData", "contextualIdentities", "privacy", "scripting", "nativeMessaging", "alarms"]) {
  requireCondition(manifest.permissions?.includes(permission), `Required permission missing: ${permission}`);
}
requireCondition(manifest.optional_permissions?.includes("userScripts"), "userScripts must remain an optional permission");

for (const file of manifest.background?.scripts || []) requirePath(file, "background script");
if (manifest.action?.default_popup) requirePath(manifest.action.default_popup, "popup");
if (manifest.options_ui?.page) requirePath(manifest.options_ui.page, "options page");
for (const entry of manifest.content_scripts || []) for (const file of entry.js || []) requirePath(file, "content script");
for (const file of Object.values(manifest.icons || {})) requirePath(file, "icon");
for (const file of Object.values(manifest.action?.default_icon || {})) requirePath(file, "action icon");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(extensionDir);
for (const full of files.filter((file) => /\.(?:m?js)$/i.test(file))) {
  const checked = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
  if (checked.status !== 0) errors.push(`Syntax check failed for ${relative(extensionDir, full)}: ${checked.stderr.trim()}`);
}
for (const full of files) {
  const rel = relative(extensionDir, full).replaceAll("\\", "/");
  if (/wireguard|private.*key|mullvad_wireguard/i.test(rel)) errors.push(`Credential-bearing file must not be inside extension source: ${rel}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Extension manifest ${manifest.version} validated (${files.length} source files)`);
