import { readdir, readFile } from "node:fs/promises";
const plan=JSON.parse(await readFile("docs/implementation/v1/plan.json","utf8"));
const phaseIds=new Set(plan.phases.map(p=>p.id));
const dir="docs/implementation/v1/claims";
const names=(await readdir(dir)).filter(n=>n.endsWith(".json")&&n!=="CLAIM.schema.json");
const claims=[]; for (const name of names) claims.push(JSON.parse(await readFile(dir+"/"+name,"utf8")));
const errors=[]; const active=claims.filter(c=>["ACTIVE","PR_OPEN"].includes(c.state));
const sha=/^[0-9a-f]{40}$/; const claimId=/^CLM-P[0-9]{3}-[0-9]{3}$/; const branch=/^agent\/[^/]+\/p[0-9]{3}-t[0-9]{3}-[0-9]+$/;
for (const c of claims) {
 if(c.schemaVersion!==1) errors.push((c.claimId||"claim")+": schemaVersion must be 1");
 if(!claimId.test(c.claimId||"")) errors.push((c.claimId||"claim")+": invalid claimId");
 if(!phaseIds.has(c.phaseId)) errors.push(c.claimId+": unknown phase "+c.phaseId);
 if(!Number.isInteger(c.claimEpoch)||c.claimEpoch<1) errors.push(c.claimId+": invalid claimEpoch");
 if(!sha.test(c.baseMainSha||"")) errors.push(c.claimId+": invalid baseMainSha");
 if(!branch.test(c.branch||"")) errors.push(c.claimId+": invalid branch");
}
function norm(p){return String(p).replace(/\*\*.*$/,"").replace(/\*.*$/,"").replace(/\/$/,"");}
function pathConflict(a,b){const x=norm(a),y=norm(b);return x===y||x.startsWith(y+"/")||y.startsWith(x+"/");}
for(let i=0;i<active.length;i++) for(let j=i+1;j<active.length;j++){
 const a=active[i],b=active[j];
 for(const x of a.writePaths||[]) for(const y of b.writePaths||[]) if(pathConflict(x,y)) errors.push(a.claimId+"/"+b.claimId+": write-path conflict "+x+" <> "+y);
 for(const x of a.contractWrites||[]) if((b.contractWrites||[]).includes(x)) errors.push(a.claimId+"/"+b.claimId+": contract-write conflict "+x);
 const br=new Map((b.resources||[]).map(r=>[r.key,r.mode]));
 for(const r of a.resources||[]) if(br.has(r.key)&&(r.mode==="exclusive"||br.get(r.key)==="exclusive")) errors.push(a.claimId+"/"+b.claimId+": resource conflict "+r.key);
 for(const m of a.migrationSlots||[]) if((b.migrationSlots||[]).includes(m)) errors.push(a.claimId+"/"+b.claimId+": migration conflict "+m);
 if(a.phaseId===b.phaseId&&a.taskId===b.taskId) errors.push(a.claimId+"/"+b.claimId+": duplicate active task claim");
}
if(errors.length){for(const e of errors) console.error("ERROR:",e);process.exit(1);}
console.log("Claims verified: "+claims.length+" total, "+active.length+" active.");
