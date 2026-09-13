# Projects PR runner contract

The public CLI is a local actuator for one authenticated tool,
`projects_pr_machine`. It does not contain a workflow engine.

## Local command mapping

| CLI verb | Wire request | Local effect class |
| --- | --- | --- |
| `doctor` | Repository identity and requested base | Observation only |
| `prepare` | Title and verification-command SHA-256 | Private-planned worktree creation |
| `publish` | Candidate head and handoff SHA-256 | Exact push and draft creation |
| `finalize` | Optional exact provider references | Observation and accepted cleanup |
| `status` | Empty request for one pack | Observation/recovery |
| `abort` | Empty request for one pack | Safe local cleanup only when directed |
| `stack` | Ordered pack IDs, base, remote | Register an existing exact draft chain |

The literal verification command never crosses MCP. No request or response
contains an absolute local path, credentials, source, shell, or argv.
On non-Windows hosts, `shell.version` is the fixed `POSIX` capability marker;
it is not a measured shell version or the local `/bin/sh` executable path.

## Transport

The endpoint must be credential-free HTTPS with path exactly `/mcp`. Requests
use Streamable HTTP JSON-RPC `tools/call`, Bearer authentication, and tool name
`projects_pr_machine`. JSON and `text/event-stream` responses are supported.
Redirects are refused. Deadlines, bodies, SSE events, content types, RPC IDs,
MCP envelopes, and tool results are bounded and validated.

## Local action boundary

The frozen schema defines eleven action names. The client also enforces one
exact required key set per action. Generic schema parameters cannot authorize
an effect. Every action must match the current local repository, remote,
assignment binding, base/head, branch, and relevant hashes.

The CLI verb independently limits which actions can run:

| Verb | Locally authorized actions |
| --- | --- |
| `doctor` | `observe_host`, `observe_repository` |
| `prepare` | `observe_host`, `observe_repository`, `create_worktree` |
| `publish` | `observe_candidate`, `observe_repository`, `push_branch`, `create_pull_request`, `observe_pull_request` |
| `finalize` | `observe_pull_request`, `remove_worktree`, `observe_repository` |
| `status` | `observe_repository`, `observe_pull_request` |
| `abort` | `observe_repository`, `remove_worktree`, `remove_local_branch` |
| `stack` | `observe_host`, `link_stack`, `observe_stack` |

The gate runs before an action record is created and again at the exported host
dispatcher. A valid action from another verb, including a previously journaled
action ID, is refused. This preserves local command intent even if the service
is malformed or compromised.

`create_worktree` derives the only local path from a validated `worktreeName`
under the fixed sibling `.projects-pr-worktrees` directory. Cleanup applies
only to a branch and worktree created and retained by the same journal.

`push_branch` uses one exact refspec. `create_pull_request` always supplies
`--draft` and a fixed public body. Pull-request observation binds number, URL,
repository, base, branch, and head.

`link_stack` requires sequential assignments. It derives each exact PR URL from
the locally retained candidate journal, checks existing GitHub stack membership,
and invokes official `gh stack link` with those URLs. It never passes a number,
branch name, or `--open`. Any partial or extra existing membership is refused.

## Recovery

The local journal is stored under the real Git common directory with a bounded
schema and file size. It binds workspace, pack, attempt, revision, repository,
assignment base/head, verification hash, operation ID, action ID, and action
digest. The journal is written before effects and atomically replaced after an
outcome. Concurrent mutation uses a repository lock. A changed action under the
same ID, a changed assignment, or a changed repository fails closed.

Service failure remains failure. No local code decides the next lifecycle phase
and no offline/private engine is present.
