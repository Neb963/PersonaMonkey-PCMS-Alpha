import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "options/options.html"), "utf8");
const bootstrap = readFileSync(resolve(root, "options/recovery-ui.js"), "utf8");
const css = readFileSync(resolve(root, "options/v062.css"), "utf8");

assert.match(html, /src="recovery-ui\.js"/, "options page must load the v0.6 data UI bootstrap");
assert.match(bootstrap, /href\s*=\s*["']v062\.css["']/, "bootstrap must load the v0.6.2 stylesheet");
assert.match(bootstrap, /import\(["']\.\/cookies\.js["']\)/, "bootstrap must load the dedicated Cookies workspace");
assert.match(bootstrap, /import\(["']\.\/profile-ui\.js["']\)/, "bootstrap must load persona quick actions and visuals");
assert.match(css, /\.topbar\s*\{[^}]*min-height:\s*50px/s, "desktop header must stay compact");
assert.match(css, /\.brand-block\s+p\s*\{\s*display:\s*none/s, "verbose header copy must be hidden");
assert.match(css, /\.brand-block\s+\.eyebrow\s*\{\s*display:\s*block/s, "compact product identity must remain visible");
assert.match(css, /\.profile-cookie-manager\s*\{\s*display:\s*none\s*!important/s, "legacy embedded cookie manager must remain hidden");

console.log("v0.6.2 options bootstrap tests passed");
