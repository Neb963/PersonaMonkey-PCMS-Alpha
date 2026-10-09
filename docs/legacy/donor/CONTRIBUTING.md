# Contributing / Agent Workflow

Read `AGENTS.md` first.

The implementation authority is:
- `docs/implementation/v1/plan.json`
- `docs/implementation/v1/policies.json`
- active claim records under `docs/implementation/v1/claims/`

Normal workflow:
1. identify an eligible phase/task;
2. acquire a non-conflicting claim;
3. branch from the claim's exact `baseMainSha`;
4. implement only the claim;
5. add/run mapped evidence;
6. push checkpoints;
7. open/update the PR;
8. pass independent CI and integration-wave checks;
9. merge;
10. update acceptance/claim state through repository machinery;
11. stop.

Do not manually edit generated roadmap/status views.
