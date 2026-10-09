# per-gens — minimum rules for generator development agents

This file is only the *Alpha integration boundary*, not a comprehensive development workflow. Read latest `main` before changing any generator. Work on `generator/<slug>` branch, touching only that generator's folder unless explicitly assigned otherwise. Keep optional development files unconstrained.

A generator folder is eligible for Alpha deployment only when it has precisely one standalone line `Status: READY` in `DEPLOYMENT.md` on `main`, plus the configured deployable files. `Status: BLOCKED` and `Status: IN_DEVELOPMENT` prevent Alpha deployment. New reservation creates BLOCKED status only.

Before marking READY/merging, test generator source, inspect diff, and update from current `main`, preserving any PCMS-approved live-fix commits. Merge to `main` only after own checks succeed. Never force push, overwrite unexpected concurrent edits, add secrets to this repository, or rely on PCMS observing a development branch. Alpha may conditionally commit approved AI live fixes to the same generator's `main.pjs` and `index.html` on main; these are upstream input for the next development round.
