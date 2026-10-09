import { git, json, requireThat } from './governance.mjs';
const report = json('.', '.agent-runs/alpha-ci.json');
const current = git('.', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
requireThat(current === (process.env.ALPHA_EVENT === 'push' ? report.headSha : report.validatedMainSha), 'Main moved during the suite; current-main verification must be rerun');
console.log(JSON.stringify({ passed: true, observedMainSha: current, headSha: report.headSha }));
