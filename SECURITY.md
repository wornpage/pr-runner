# Security policy

## Reporting

Use GitHub private vulnerability reporting. Do not put Projects or GitHub
credentials, private service responses, repository source, or customer data in
a public issue.

## Runtime boundaries

- The local runner requires a credential-free HTTPS `PROJECTS_MCP_ENDPOINT`
  ending at `/mcp` and a Bearer `PROJECTS_MCP_TOKEN`. It has no default endpoint,
  anonymous mode, redirect following, or private-engine fallback.
- The Projects token and endpoint are removed from every child-process
  environment. They are never accepted in CLI arguments or written to the
  journal, reports, or output.
- The service sends only frozen protocol data. Exact per-action validators
  reject missing, unknown, contradictory, and irrelevant fields before effects.
- A separate local verb/action authority gate runs before journaling and again
  inside the exported host dispatcher. Cross-verb actions and cached reports
  cannot expand the user's requested command; `doctor` and `status` are always
  observation-only.
- Git and GitHub effects use fixed executables and constructed argument arrays.
  The service cannot choose shell, executable, argv, environment, or paths.
- Repository identity, fetch and push destinations, base/head refs, candidate
  worktree, action digests, and verification-command hash are checked locally.
  Symlink/junction escapes and broad cleanup targets are refused.
- The worker, outside the runner credential context, executes candidate
  verification. The runner records only its local hash and never executes it.
- The runner creates drafts only. It cannot ready, merge, auto-merge, deploy, or
  use GitHub administrative paths.
- Effects are journaled before execution. Dropped replies use saved reports;
  uncertain subprocess completion preserves the lock for manual reconciliation.
- Stack linking uses verified HTTPS PR URLs, never numeric or branch arguments.
  It refuses partial, mixed, or extra membership and rechecks the exact ordered
  chain after the official command returns.

The separately operated Projects service remains responsible for tenant
authorization, entitlement, rate limits, private decisions, and provider-backed
acceptance. See [docs/agent-trust.md](docs/agent-trust.md).
