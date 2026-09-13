---
name: projects-pack-delegation
description: Use the authenticated Projects service to coordinate tracked work and invoke its bounded local PR runner.
---

# Projects pack delegation client

Projects owns coordination and PR lifecycle decisions. Use only tools returned
by the authenticated Projects MCP service and the skill-local runner at
`scripts/projects-pr.mjs`. Do not recreate service decisions from this file,
search `PATH` for another controller, use a repository copy, or create an
offline fallback.

Run the requested CLI verb with the exact fields supplied by the private
service or coordinator. Available verbs are `doctor`, `prepare`, `publish`,
`finalize`, `status`, `abort`, and `stack`. Treat each JSON receipt as bounded
evidence for that operation only. Follow a `refused` or failed receipt; do not
replace the operation with shell or GitHub commands.

`prepare` returns the local worktree path for the assigned worker. The worker
runs the assignment's literal verification command and submits Worker Handoff
v1. The runner never runs candidate verification. After accepted worker
evidence, `publish` may push the exact head and create an unreviewed draft.

`finalize` while the PR is draft reports that owner readiness is still needed.
The repository owner independently marks the exact head ready in GitHub and
provides exact run, attempt, artifact, and review references. Never ready a PR,
merge, enable auto-merge, deploy, or invent evidence through this runner.

For a stack, each upper assignment must have been prepared from the preceding
candidate branch and head. `stack` only registers an already valid chain of
unaccepted open drafts. A `stacked` receipt does not mean reviewed or accepted;
each layer continues through owner readiness and provider-backed acceptance.

The local environment must provide a credential-free HTTPS
`PROJECTS_MCP_ENDPOINT` ending in `/mcp` and `PROJECTS_MCP_TOKEN`. Never place
the token in prompts, CLI arguments, receipts, files, or messages.
