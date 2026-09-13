# Wornpage Projects PR runner

This package is the bounded local Git and GitHub runner for the separately
operated Projects PR Machine service. The private service decides lifecycle,
eligibility, review acceptance, readiness, and the next closed action. This
repository contains command parsing, authenticated MCP transport, local recovery
state, and a fixed set of mechanical host actions.

Version 3 is an intentional major transition. The public decision engine,
delivery policy, review strategy, and merge APIs from version 2 are removed.
There is no embedded or offline fallback.

## Boundary

| Concern | Owner |
| --- | --- |
| Lifecycle and eligibility | Private Projects service |
| Review and provider-backed acceptance | Private Projects service |
| Worktree, exact-ref push, draft PR, observation, cleanup | Local runner |
| Credentials and repository files | Local machine |
| Ready-for-review, merge, deploy | Repository owner outside this runner |

The runner accepts only `doctor`, `prepare`, `publish`, `finalize`, `status`,
`abort`, and `stack`. Server responses can request only the eleven actions in
the frozen [wire schema](integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/protocol/projects-pr-machine.schema.json).
Every action has an additional exact key-set validator before any effect.
The requested CLI verb is also checked against a closed local action matrix
before an action can enter the journal or reach the host dispatcher. `doctor`
and `status` authorize observations only.

The runner never executes the candidate verification command. The worker runs
that command without runner credentials and supplies its evidence to Projects.
The runner never marks a draft ready, enables auto-merge, merges, deploys, or
accepts server-selected paths, executables, shell, arguments, or credentials.

## Requirements

- Node.js 22 or newer
- Git
- GitHub CLI authenticated for `github.com`
- PowerShell 7 on Windows or `/bin/sh` on Unix
- `PROJECTS_MCP_ENDPOINT`: a credential-free HTTPS URL whose path is exactly `/mcp`
- `PROJECTS_MCP_TOKEN`: a Projects personal token supplied only through the local environment

There is no default endpoint. Redirects, anonymous access, oversized responses,
unsupported content types, malformed JSON/SSE, and service unavailability fail
closed.

## CLI

```text
projects-pr doctor --repo . --base main --remote origin
projects-pr prepare --pack-id ID --title TEXT --base main \
  --verify-command "node test/example.mjs" --repo . --remote origin
projects-pr publish --pack-id ID --head SHA --handoff-sha256 SHA --repo .
projects-pr finalize --pack-id ID --repo .
projects-pr status --pack-id ID --repo .
projects-pr abort --pack-id ID --repo .
projects-pr stack --pack-id BOTTOM --pack-id TOP --base main --repo . --remote origin
```

After an owner independently marks the exact draft head ready, `finalize` may
include all five provider references: `--github-pr`, `--github-run`,
`--github-attempt`, `--github-artifact`, and `--github-review`. The service
validates them. The runner does not infer or create them.

Stack linking accepts only an already valid chain of open drafts. The bottom
assignment targets the requested base; each upper assignment must have been
prepared from the preceding candidate head and branch. The runner passes exact
verified HTTPS PR URLs to the official `github/gh-stack` command, omits
`--open`, verifies exact stack membership through the GitHub API, and then
re-observes the unchanged base/head chain. `stacked` does not mean accepted.

## Recovery and packaging

Before each effect, the runner writes a bounded journal under the repository's
Git common directory. Operation IDs and action digests bind replays. A dropped
service response reuses the recorded report; a pending effect is reconciled
from actual Git, PR, or stack state. Conflicting processes are refused by a
repository-scoped lock. Subprocess uncertainty remains locked for manual
inspection.

The installable runtime is listed with SHA-256 hashes and dependency inventory
in `scripts/runtime-manifest.json` beside the skill entrypoint. Generate or
verify it with `npm run runtime:manifest` or `npm run runtime:manifest -- --check`.

Run the complete boundary gate with:

```text
node test/verify-private-engine-boundary.mjs
```

The gate covers the real packed and clean-installed bytes, a disposable bare
Git remote, controlled MCP/GitHub seams, every released verb, recovery and
replay, successful chained stacks, and adversarial protocol/host inputs. It
does not contact the live Projects service or create a hosted PR.

## License

Copyright © 2026 Wornpage. Source is available under
[GNU AGPL-3.0-only](LICENSE). See [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md).
