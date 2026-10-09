import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PCMS_ERROR_CODES, PCMS_EVENTS_PORT, PCMS_PROTOCOL_VERSION, PCMS_REQUEST_TYPE } from "../extension/lib/pcms-protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const installer = readFileSync(resolve(root, "install.sh"), "utf8");
const routerctl = readFileSync(resolve(root, "native/routerctl.py"), "utf8");
const diagnostics = readFileSync(resolve(root, "diagnose.sh"), "utf8");
const ciWorkflow = readFileSync(resolve(root, ".github/workflows/extension-tests.yml"), "utf8");
const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
const workflowExampleRoot = resolve(root, "examples/workflow-packages/mullvad-signal-check");
const workflowExampleManifest = JSON.parse(readFileSync(resolve(workflowExampleRoot, "manifest.json"), "utf8"));
const errors = [];

const canonicalCurrentDocs = [
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "DEVELOPMENT.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/getting-started/installation.md",
  "docs/guides/data-portability.md",
  "docs/guides/workflow-packages.md",
  "docs/development/branching.md",
  "docs/development/testing.md",
  "docs/development/release.md",
  "docs/architecture/overview.md",
  "docs/architecture/persona-model.md",
  "docs/api/management-v1.md",
  "docs/api/persona-os.md",
  "docs/api/integration-v1.md",
  "docs/reference/compatibility.md",
  "extension/README.md"
];

const currentDocText = new Map();
for (const path of canonicalCurrentDocs) {
  const full = resolve(root, path);
  if (!existsSync(full)) {
    errors.push(`missing canonical current document: ${path}`);
    continue;
  }
  currentDocText.set(path, readFileSync(full, "utf8"));
}

function markdownLinkTargets(markdown) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
    const titled = target.match(/^(\S+)(?:\s+["'][^"']*["'])$/);
    if (titled) target = titled[1];
    targets.push(target);
  }
  return targets;
}

function hasGitHubHeadingFragment(markdown, fragment) {
  let wanted = fragment;
  try { wanted = decodeURIComponent(fragment); } catch {}
  const occurrences = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const title = heading[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/<[^>]*>/g, "");
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const count = occurrences.get(slug) || 0;
    occurrences.set(slug, count + 1);
    if (count === 0 ? wanted === slug : wanted === `${slug}-${count}`) return true;
  }
  return false;
}

function requirePath(path, description = path) {
  if (!existsSync(resolve(root, path))) errors.push(`missing required ${description}: ${path}`);
}

const trackedResult = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
const trackedPaths = trackedResult.status === 0 ? trackedResult.stdout.split("\0").filter(Boolean) : [];

for (const path of ["extension", "native", "tests", "scripts", "examples", "docs"]) {
  const full = resolve(root, path);
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    errors.push(`missing required runtime/build directory: ${path}`);
  } else if (trackedResult.status === 0 && !trackedPaths.some((trackedPath) => trackedPath.startsWith(`${path}/`))) {
    errors.push(`runtime/build directory has no tracked content: ${path}`);
  }
}
for (const path of [
  "package.json",
  "extension/manifest.json",
  "install.sh",
  "uninstall.sh",
  "diagnose.sh",
  "scripts/build-extension.mjs",
  "scripts/build-workflow-examples.mjs",
  "scripts/validate-extension.mjs",
  ".github/workflows/extension-tests.yml"
]) {
  requirePath(path, "build/release entry point");
}

// Keep one predictable root entry-point set; planning and milestone material belongs in docs/history.
const rootMarkdown = ["AGENTS.md", "CHANGELOG.md", "CONTRIBUTING.md", "DEVELOPMENT.md", "README.md", "SECURITY.md"];
for (const path of rootMarkdown) requirePath(path, "root document");
if (trackedResult.status === 0) {
  const rootPlanningMarkdown = trackedPaths.filter((path) => !path.includes("/") && path.toLowerCase().endsWith(".md") &&
    /^(?:(?:specification|implementation[-_]?prompt|prompt|handoff|audit|release[-_]?gates?|milestone|plan(?:ning)?)(?:[-_.].*)?|v\d+(?:\.\d+)*[-_.].*(?:specification|prompt|plan|handoff|audit|gate|milestone))\.md$/i.test(path));
  if (rootPlanningMarkdown.length) errors.push(`root planning/milestone Markdown belongs under docs/history: ${rootPlanningMarkdown.join(", ")}`);
}

const docsIndex = currentDocText.get("docs/README.md") || "";
const linkedFromIndex = new Set(markdownLinkTargets(docsIndex).map((target) => {
  if (!target || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const localTarget = target.split("#")[0].split("?")[0];
  if (!localTarget) return null;
  let decoded = localTarget;
  try { decoded = decodeURIComponent(localTarget); } catch {}
  return resolve(dirname(resolve(root, "docs/README.md")), decoded);
}).filter(Boolean));
const currentDocsUnderDocs = trackedPaths.filter((path) => path.startsWith("docs/") && path !== "docs/README.md" && path.toLowerCase().endsWith(".md") && !path.startsWith("docs/history/"));
for (const path of currentDocsUnderDocs) {
  if (!linkedFromIndex.has(resolve(root, path))) errors.push(`documentation index does not link to current document: ${path}`);
}

const historicalPaths = trackedPaths.filter((path) => path.startsWith("docs/history/"));
for (const path of historicalPaths) {
  if (!path.startsWith("docs/history/releases/") && !path.startsWith("docs/history/planning/")) {
    errors.push(`historical material must be namespaced under docs/history/releases or docs/history/planning: ${path}`);
  }
}
for (const path of ["docs/history/releases", "docs/history/planning"]) {
  const full = resolve(root, path);
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    errors.push(`missing required historical documentation directory: ${path}`);
  } else if (trackedResult.status === 0 && !trackedPaths.some((trackedPath) => trackedPath.startsWith(`${path}/`))) {
    errors.push(`historical documentation directory has no tracked content: ${path}`);
  }
}
const misplacedHistory = trackedPaths.filter((path) => /^docs\/(?:releases?|planning|plans)\//i.test(path));
if (misplacedHistory.length) errors.push(`historical release/planning files must be under docs/history: ${misplacedHistory.join(", ")}`);

// Current prose can discuss version history, but must not present v0.8 or a completed stage as current work.
const currentTextPaths = trackedPaths.filter((path) =>
  (path === "README.md" || path === "DEVELOPMENT.md" || path === "SECURITY.md" || path === "AGENTS.md" || path === "CONTRIBUTING.md" || path === "extension/README.md" ||
    (path.startsWith("docs/") && path.toLowerCase().endsWith(".md") && !path.startsWith("docs/history/"))) && path !== "CHANGELOG.md"
);
const currentMilestonePattern = /\bcurrent\s+development\s+scope\b|\b(?:current|active)\s+(?:v0\.8(?:\.0)?|stage\s*[1-5])\b|\b(?:v0\.8(?:\.0)?|stage\s*[1-5])\s+(?:is|remains|represents)\s+(?:the\s+)?(?:current|active)\b|\bcurrent\s+(?:release|version|milestone)\s+(?:is|remains|:)\s*(?:v0\.8(?:\.0)?|stage\s*[1-5])\b|\b(?:v0\.8(?:\.0)?|stage\s*[1-5])\s+(?:is|remains)\s+(?:the\s+)?current\s+(?:release|version|milestone)\b/i;
for (const path of currentTextPaths) {
  const text = readFileSync(resolve(root, path), "utf8");
  if (currentMilestonePattern.test(text)) errors.push(`current documentation presents v0.8 or a Stage 1–5 milestone as current: ${path}`);
}

const productAuthorityDocs = [
  "README.md",
  "DEVELOPMENT.md",
  "docs/architecture/overview.md",
  "docs/api/persona-os.md",
  "docs/api/management-v1.md",
  "docs/api/integration-v1.md"
];
for (const path of productAuthorityDocs) {
  const markdown = currentDocText.get(path) || "";
  if (!markdown.includes("Perchance Central Management System")) {
    errors.push(`current product authority must define PCMS as Perchance Central Management System: ${path}`);
  }
}
if ((currentDocText.get("README.md") || "").includes("active v0.8 branch") ||
    (currentDocText.get("DEVELOPMENT.md") || "").includes("active v0.8 branch")) {
  errors.push("README.md and DEVELOPMENT.md must treat main as source of truth, not an active v0.8 branch");
}

const managementDoc = currentDocText.get("docs/api/management-v1.md") || "";
const compatibilityDoc = currentDocText.get("docs/reference/compatibility.md") || "";
if (!managementDoc.includes("PersonaMonkey Management API") || !managementDoc.includes("frozen compatibility names")) {
  errors.push("management documentation must name PersonaMonkey Management API and identify legacy wire identifiers as compatibility names");
}
for (const frozen of [
  PCMS_REQUEST_TYPE,
  PCMS_EVENTS_PORT,
  `PCMS_PROTOCOL_VERSION = ${PCMS_PROTOCOL_VERSION}`,
  "pcms.batch.completed",
  "profileId",
  "personaId",
  "cookieStoreId",
  "persona-route-manager@local",
  "com.persona.mullvad_router",
  "persona.personamonkey",
  "personamonkey.workflow-package",
  "personamonkey-backup",
  "personamonkey-cookies"
]) {
  if (!compatibilityDoc.includes(frozen)) errors.push(`compatibility register is missing frozen value: ${frozen}`);
}
for (const code of Object.values(PCMS_ERROR_CODES)) {
  if (!compatibilityDoc.includes(code)) errors.push(`compatibility register is missing management error literal: ${code}`);
}

if (packageMetadata.version !== manifest.version) {
  errors.push(`package.json version ${packageMetadata.version} does not match extension ${manifest.version}`);
}
if (installer.includes("packages/releases/") || diagnostics.includes("packages/releases/")) {
  errors.push("installer or diagnostics still references a tracked release-package directory");
}
if (installer.includes("BUNDLED_SOURCE")) {
  errors.push("installer still supports an in-repository private configuration bundle");
}
if (!installer.includes("systemctl is-active --quiet persona-mullvad-router.service") ||
    !installer.includes("router_ping") ||
    !installer.includes('runuser -u "$TARGET_USER" -- /usr/local/bin/persona-mullvad-router ping')) {
  errors.push("installer must verify a live daemon response instead of trusting socket existence alone");
}
if (!/sub\.add_parser\(["']ping["']\)/.test(routerctl) ||
    !/["']ping["']\s*:\s*["']ping["']/.test(routerctl)) {
  errors.push("routerctl must expose the daemon ping command used by installer health checks");
}
if (!ciWorkflow.includes("run: npm run release:check")) {
  errors.push("GitHub Actions must invoke npm run release:check so CI matches the local release gate");
}
if (/run:\s+node scripts\/test-(?:popup|options|data-management|pcms)-browser\.mjs/.test(ciWorkflow)) {
  errors.push("GitHub Actions must not duplicate individual browser smoke commands outside package.json");
}
const actionRefs = [...ciWorkflow.matchAll(/^\s*-\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
for (const actionRef of actionRefs) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(actionRef)) {
    errors.push(`GitHub Actions dependency must be pinned to a full commit SHA: ${actionRef}`);
  }
}
if (!/^permissions:\s*\n\s+contents:\s+read\s*$/m.test(ciWorkflow)) {
  errors.push("GitHub Actions must declare least-privilege workflow permissions (contents: read)");
}
if (!/^\s+runs-on:\s+ubuntu-24\.04\s*$/m.test(ciWorkflow)) {
  errors.push("GitHub Actions must use the stable ubuntu-24.04 runner label");
}
if (!/^\s+node-version:\s*["']22\.23\.3["']\s*$/m.test(ciWorkflow) ||
    !/^\s+python-version:\s*["']3\.12\.14["']\s*$/m.test(ciWorkflow)) {
  errors.push("GitHub Actions must pin the supported Node.js and Python patch versions");
}
if (!/chrome-version:\s*["']?\d+\.\d+\.\d+\.\d+["']?/.test(ciWorkflow) ||
    !/CHROME_BIN:\s*\$\{\{\s*steps\.chrome\.outputs\.chrome-path\s*\}\}/.test(ciWorkflow)) {
  errors.push("GitHub Actions must provision a pinned Chrome version and pass its path to browser tests");
}
for (const ignoreRule of ["/*.xpi", "/*.log", "/browser-profiles/", "/browser-scratch/", "/.browser-test/"]) {
  if (!gitignore.split(/\r?\n/).includes(ignoreRule)) errors.push(`.gitignore is missing scoped local test-artifact rule: ${ignoreRule}`);
}
if (!(currentDocText.get("docs/api/management-v1.md") || "").includes("persona.container.rotated")) {
  errors.push("Management API event documentation is missing persona.container.rotated");
}
if (!(currentDocText.get("docs/api/integration-v1.md") || "").includes("policy-gated `workflow.delete`")) {
  errors.push("Integration API destructive command documentation is missing policy-gated workflow.delete");
}
if (!(currentDocText.get("docs/guides/workflow-packages.md") || "").includes("60 minutes (3,600,000 ms)")) {
  errors.push("workflow package documentation must state the 60-minute completion timeout maximum");
}

for (const script of workflowExampleManifest.scripts || []) {
  const data = readFileSync(resolve(workflowExampleRoot, script.file));
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== script.sha256) {
    errors.push(`workflow example SHA-256 mismatch for ${script.file}: expected ${script.sha256}, got ${actual}`);
  }
}

for (const script of ["install.sh", "uninstall.sh", "diagnose.sh"]) {
  const full = resolve(root, script);
  const syntax = spawnSync("bash", ["-n", full], { encoding: "utf8" });
  if (syntax.status !== 0) errors.push(`${script} syntax failed: ${syntax.stderr.trim()}`);
  if ((statSync(full).mode & 0o111) === 0) errors.push(`${script} is not executable`);
}

const tracked = trackedResult;
if (tracked.status !== 0) {
  errors.push(`git ls-files failed: ${tracked.stderr.trim()}`);
} else {
  const paths = trackedPaths;
  for (const path of paths.filter((entry) => entry.toLowerCase().endsWith(".md"))) {
    const markdown = readFileSync(resolve(root, path), "utf8");
    if (!path.startsWith("docs/history/") && /\[skip\s+ci\]|skip-ci|skip ci/i.test(markdown)) {
      errors.push(`active contributor documentation must not direct users to skip CI: ${path}`);
    }
    for (const rawTarget of markdownLinkTargets(markdown)) {
      if (!rawTarget || rawTarget.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
      const hashIndex = rawTarget.indexOf("#");
      const fragment = hashIndex === -1 ? "" : rawTarget.slice(hashIndex + 1).split("?")[0];
      const localTarget = rawTarget.split("#")[0].split("?")[0];
      if (!localTarget && !fragment) continue;
      let decoded = localTarget;
      try { decoded = decodeURIComponent(localTarget); } catch {}
      const linked = decoded ? resolve(dirname(resolve(root, path)), decoded) : resolve(root, path);
      if (!existsSync(linked)) errors.push(`broken local Markdown link in ${path}: ${rawTarget}`);
      else if (fragment && linked.toLowerCase().endsWith(".md") && !hasGitHubHeadingFragment(readFileSync(linked, "utf8"), fragment)) {
        errors.push(`broken Markdown heading fragment in ${path}: ${rawTarget}`);
      }
    }
  }
  const canonicalReleaseXpi = `dist/persona-route-manager-v${manifest.version}.xpi`;
  const canonicalReleaseChecksum = `${canonicalReleaseXpi}.sha256`;
  const forbidden = paths.filter((path) =>
    path.startsWith("persona-mullvad-router-v0.3.0/") ||
    path.startsWith("packages/releases/") ||
    path.startsWith("bundle/") ||
    /(?:^|\/)persona-mullvad-router-private-v0\.3\.0\.zip$/.test(path) ||
    (/\.conf$/i.test(path) && !(path.startsWith("examples/") && path.endsWith(".example.conf"))) ||
    /\.(?:key|pem|p12|pfx)$/i.test(path) ||
    (/\.(?:xpi|zip)$/i.test(path) && path !== canonicalReleaseXpi)
  );
  if (forbidden.length) errors.push(`obsolete/private tracked artifacts: ${forbidden.join(", ")}`);

  if (paths.includes(canonicalReleaseXpi)) {
    if (!paths.includes(canonicalReleaseChecksum)) {
      errors.push(`tracked release XPI requires checksum: ${canonicalReleaseChecksum}`);
    } else {
      const releaseBytes = readFileSync(resolve(root, canonicalReleaseXpi));
      const actualDigest = createHash("sha256").update(releaseBytes).digest("hex");
      const checksumText = readFileSync(resolve(root, canonicalReleaseChecksum), "utf8").trim();
      const expectedLine = `${actualDigest}  ${canonicalReleaseXpi.split("/").at(-1)}`;
      if (checksumText !== expectedLine) {
        errors.push(`tracked release XPI checksum mismatch: expected "${expectedLine}"`);
      }
    }
  }
}

const help = spawnSync("bash", [resolve(root, "install.sh"), "--help"], { cwd: root, encoding: "utf8" });
if (help.status !== 0) errors.push(`install.sh --help failed: ${help.stderr.trim()}`);
if (!help.stdout.includes(`PersonaMonkey Mullvad Router ${manifest.version}`)) {
  errors.push("installer does not report the current extension version");
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Repository layout and installer metadata validated for v${manifest.version}`);
