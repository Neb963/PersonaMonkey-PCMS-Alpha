import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const manifest = JSON.parse(await readFile(resolve(root, "docs/upstream/import-manifest.json"), "utf8"));
const work = await mkdtemp(join(tmpdir(), "pcms-personamonkey-baseline-"));

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: work, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
}

try {
  for (const entry of manifest.entries) {
    const from = resolve(root, entry.destinationPath);
    const to = resolve(work, entry.sourcePath);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    await chmod(to, entry.mode === "100755" ? 0o755 : 0o644);
  }

  run("git", ["init", "-q"]);
  run("git", ["add", "-A"]);

  run("npm", ["test"]);
  run("npm", ["run", "validate"]);
  run("npm", ["run", "build"]);

  const xpi = await readFile(join(work, "dist", "persona-route-manager-v1.2.0.xpi"));
  const digest = createHash("sha256").update(xpi).digest("hex");
  if (digest !== manifest.upstream.expectedXpiSha256) {
    throw new Error(`XPI digest drift: expected ${manifest.upstream.expectedXpiSha256}, got ${digest}`);
  }
  const sidecar = (await readFile(join(work, "dist", "persona-route-manager-v1.2.0.xpi.sha256"), "utf8")).trim();
  if (sidecar !== `${digest}  persona-route-manager-v1.2.0.xpi`) {
    throw new Error(`XPI sidecar mismatch: ${sidecar}`);
  }

  console.log(JSON.stringify({
    passed: true,
    upstreamCommit: manifest.upstream.commitSha,
    upstreamTree: manifest.upstream.treeSha,
    upstreamCiRunId: manifest.upstream.frozenCiRunId,
    xpiSha256: digest,
    note: "Exact upstream npm test + validate + build rerun in reconstructed tree; frozen upstream browser-smoke evidence retained separately."
  }));
} finally {
  await rm(work, { recursive: true, force: true });
}
