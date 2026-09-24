# Projects Pack Delegation: trust guide

Read this before installing the Codex integration. It separates inspectable
local code from the hosted Projects service and from tools already present on
your computer.

## Installed surface

Version 4.0.0 installed:

- one `projects-pack-delegation` skill with `scripts/projects-pr.mjs`, its
  bounded relative dependencies, and the frozen protocol-v1 schema/fixtures;
- three custom-agent definitions: coordinator, worker, and reviewer;
- one `[mcp_servers.projects]` section in Codex `config.toml`;
- one platform manager and token-free
  `.projects-pack-delegation/install-state.json` under `CODEX_HOME`.

The state file records schema version 1, integration version and source
commit, platform, owned path hashes, the managed config-section hash, and PR
capability diagnostics. It does not contain the token.

Version 4.1.0 release source has 19 adapter assets,
including a sibling local AWS qualification CLI and pure closed contract.
They were not part of the older published/reviewed 4.0.0 installation,
which had 16 assets. The old public review source commit predates these bytes
and cannot attest them. A separately published and independently reviewed
public runner `3.0.0-beta.3` commit must contain the same portable assets and
this guide before its exact commit is pinned in the private release source.
The public runner version and private Codex integration version are distinct.
No source edit here installs the candidate or authorizes a paid CodeBuild call.

The integration installs no hook, daemon, background runner, model runtime,
Node runtime, Git client, GitHub CLI, or global command. Its JavaScript
runner is invoked only from its absolute path beside the installed skill.
There is no PATH lookup, npm/global-package path, or source-checkout fallback.

## Network and capability boundaries

The configured service endpoint is the Streamable HTTP MCP endpoint
`https://projectsdemo.org/mcp`. MCP calls can read or mutate the workspace
authorized by the token, including pack delegation and handoff operations.
Those effects come from the user's Codex session, prompts, Projects role, and
tool permissions. This integration is not an execution sandbox or an
access-control system.

Core delegation does not require the optional PR runner prerequisites. A
PR request first runs read-only `doctor` before `delegate_pack`. It checks Node
22 or newer, Git, PowerShell 7 on Windows or `/bin/sh` on Unix, GitHub CLI
authentication, the selected GitHub remote, safe local Git state, and the
private provider credential's live read access to the exact configured GitHub
repository and workflow. Missing prerequisites report the PR capability as unavailable;
they do not prevent core installation and are never installed automatically.

After `doctor`, the service binds an authenticated immutable assignment to one
worktree. The worker reports once; owner-authorized `publish` creates an
unreviewed draft. The owner independently marks that exact head ready before
trusted runner evidence and independent GitHub review can be accepted.
`finalize` invokes real Worker acceptance and retains its audit receipt before
cleanup. The local runner never executes candidate verification with
coordinator credentials. The operator runtime and global/included Git
configuration remain trusted; this is not an OS sandbox. Merge and close remain
owner decisions. The runner stores a path-only journal under the repository's
absolute Git common directory; the Workspace Durable Object owns lifecycle
state.

## Optional local AWS qualification boundary

The 4.1.0 source adds a separate, inactive qualification-only CLI. It imports
the installed package's pure closed AWS source/project/bucket/request contract,
not mutable `ci/aws-readiness` code from a candidate checkout. The Workspace
requires an explicit deployment-owned owner policy and durably consumes a
single-use reservation before returning the closed `StartBuild` request. The
CLI performs only fixed STS, CodeBuild and S3 preflight reads, then at most
one StartBuild attempt through an operator-supplied absolute installed AWS CLI
executable and named local profile. A lost response or timeout never triggers
automatic redispatch. The existing GitHub acceptance path remains active.

The AWS CLI may read the operator's standard local profile configuration and
SSO/session cache under that user's account. No AWS key or cache is uploaded
to Projects. The AWS subprocess receives a minimal allowlisted environment,
not the Projects token or GitHub credentials; ordinary PR Git, GitHub CLI and
Node subprocesses strip ambient `AWS_*` variables. Fixed HTTPS service
endpoints, TLS verification, one CLI attempt, bounded output and no shell
limit this specific action. These are process-level boundaries, not same-user
OS isolation: another process with the same user's file or process access may
still read local profile/cache or Projects configuration. Protect that user
account and review the installed executable and profile before authorization.

A returned build ID/ARN is only an operator-reported dispatch observation.
Local synthetic tests and a dry-run build do not establish a completed AWS
qualification, locked artifact, independent inspection, Projects acceptance,
or production deployment. Those hosted gates and policy enrollment remain
separate owner decisions; neither a public beta package nor this source edit
starts a customer build.

## Token, data, and retention

Use a separate personal Projects MCP token for this connection. The installer
asks for it privately and writes it as a Bearer Authorization header in local
Codex configuration; do not paste it into prompts, commits, issue trackers, or
shell history. The config and temporary transaction material receive private
permissions where the platform supports them. Successful transactions remove
their rollback material instead of maintaining a fixed credential-bearing
backup.

Version 1 installers may have left `config.toml.projects-backup`, which can
contain a token. Version 2 does not claim or delete that unknown legacy file;
inspect and remove it yourself when safe.

The repository documents a 365-day / 200-entry limit for the workspace's hot
audit trail, with the shorter limit winning. That is not a retention guarantee
for all MCP request data, tool content, logs, local configuration, backups, or
vendor systems. The separately operated Projects service audit-retention
policy describes this limited published audit trail.

## Manifest, source review, and trust boundary

The moving [Codex install
manifest](https://projectsdemo.org/install/codex-manifest.json) uses schema
version 2. The 4.0.0 manifest named publisher `Wornpage`,
the repository and exact source commit, an immutable release base under
`/install/releases/4.0.0/<sourceCommit>/`, and SHA-256 hashes and destinations
for both bootstrap scripts and all sixteen installed adapter assets (previously six).
The 4.1.0 manifest must name integration version `4.1.0`, the exact
private source commit, all nineteen installed adapter assets, and immutable
`/install/releases/4.1.0/<sourceCommit>/` URLs. It must not become the moving
public manifest until separately reviewed and deployed.

The Agents page validates that complete contract before enabling its install
copy control. The copied command downloads the manifest-selected immutable
bootstrap and verifies its hash before execution. The installer stages the
complete release, verifies every asset, and only then begins a transaction.
The build rejects a dirty source tree or a source-commit claim that differs
from Git HEAD.

These same-origin hashes prove release consistency and artifact/source
correspondence. They do not provide an independent publisher signature and do
not prove hosted-service behavior. Users needing independent trust should
clone the named commit, inspect the integration and build inputs, and compare
the published bytes before installation.

The Projects service is a separate hosted system. This repository's code and
tests do not prove its uptime, authorization enforcement, logging, retention,
incident response, or future behavior. Treat the service's current policies
and the workspace's live permissions as authoritative.

## Transaction, updates, and recovery

The installer acquires an exclusive lock, stages on the destination volume,
verifies the complete bundle, checks ownership and concurrent config changes,
and replaces active config last. It records install state only after
post-verification. A failure restores prior bytes and permissions or leaves an
explicit pending transaction for recovery; it must not claim success after a
partial change.

Reinstalling the same version from the same source commit is idempotent. The
installer refuses a conflicting republish with the same version and a
different commit, as well as downgrades, unknown collisions, and modified
managed files. Stateless version 1 can be adopted only when its four installed
assets exactly match the hashes pinned by both production version 1 installers
at source commit
`8f28a46e27b9e236e6b617117710b9207f1234c4` and its Projects config section is
unambiguous. There is no general force flag.

The 4.0.0 upgrade verifies every file owned by the prior install before the
transaction, backs up retired paths in the same rollback journal, and removes
old controller/dependency files that are absent from the new manifest. A
modified or unowned file is never retired. Fresh and upgraded installs therefore
contain the same bounded public runner surface.

The 4.1.0 upgrade must verify the older 4.0.0 owned files before
installing the 19-asset release; it cannot republish changed bytes as 4.0.0.

Before accepting an update, use the manifest's `repository` and `sourceCommit`
to compare the skill, agent definitions, controller, installers, and this guide
at that exact commit. Review changes to endpoints, credentials, installed
paths, capabilities, and tool
instructions.

## Remove access

Use the durable local manager, not a temporary downloaded installer:

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
pwsh -NoProfile -File (Join-Path $codexHome '.projects-pack-delegation/manage.ps1') -Uninstall
```

```sh
codex_home="${CODEX_HOME:-$HOME/.codex}"
/bin/sh "$codex_home/.projects-pack-delegation/manage.sh" --uninstall
```

Uninstall removes only unchanged state-owned files and the exact managed
Projects config section. It refuses modified or ambiguous files rather than
deleting them. Then revoke the personal token on
[Agents](https://projectsdemo.org/agents) and restart Codex. Removing local
files alone does not revoke a hosted credential.
