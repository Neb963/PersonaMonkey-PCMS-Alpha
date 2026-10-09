import { readFile, writeFile } from "node:fs/promises";
const plan = JSON.parse(await readFile("docs/implementation/v1/plan.json", "utf8"));
function renderRoadmap() {
  const lines=["# ROADMAP","","> Generated from docs/implementation/v1/plan.json. Do not hand-edit.",""];
  for (const p of plan.phases) {
    lines.push("## "+p.id+" — "+p.title,"Status: **"+p.status+"**  ","Depends on: "+(p.dependsOn.length?p.dependsOn.join(", "):"none")+"  ","Merge wave: "+p.mergeWave,"");
    for (const t of p.tasks) lines.push("- ["+(p.status==="ACCEPTED"?"x":" ")+"] "+t.id+" — "+t.title);
    lines.push("");
  }
  return lines.join("\n")+"\n";
}
function renderStatus() {
  const accepted=plan.phases.filter(p=>p.status==="ACCEPTED").map(p=>p.id);
  const ready=plan.phases.filter(p=>p.status==="READY").map(p=>p.id);
  const active=plan.phases.filter(p=>["CLAIMED","IN_PROGRESS","PR_OPEN"].includes(p.status)).map(p=>p.id);
  return ["# Current implementation status","","> Generated from docs/implementation/v1/plan.json. Do not hand-edit.","","- Baseline: **"+plan.baseline+"**","- Accepted: **"+(accepted.join(", ")||"none")+"**","- Ready: **"+(ready.join(", ")||"none")+"**","- Claimed/In progress: **"+(active.join(", ")||"none")+"**","- Final live phases: **"+plan.executionModel.finalLivePhases.join(", ")+"**","- PersonaMonkey import baseline: `9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`","","Next normal instruction:","> Implement the next eligible phase.",""].join("\n");
}
const outputs={"ROADMAP.md":renderRoadmap(),"docs/progress/STATUS.md":renderStatus()};
if (process.argv.includes("--check")) {
  const failures=[];
  for (const [path,expected] of Object.entries(outputs)) { let actual=""; try { actual=await readFile(path,"utf8"); } catch {} if (actual!==expected) failures.push(path); }
  if (failures.length) { console.error("Generated views are stale: "+failures.join(", ")); process.exit(1); }
  console.log("Generated views are current.");
} else {
  for (const [path,content] of Object.entries(outputs)) await writeFile(path,content);
  console.log("Generated views updated.");
}
