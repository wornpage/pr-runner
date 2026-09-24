---
name: projects-pack-delegation
description: Delegate independent code work to Codex subagents through tracked Projects packs and Worker Handoff v1. Use for Projects pack delegation, subagent pack work, a PR machine, "make this a PR", "turn this pack into a PR", a draft PR, or any request to turn tracked agent work into a pull request.
---

# Projects Pack Delegation

Use the current session as coordinator. Projects stores coordination state;
Codex executes the work.

The input is one concrete goal, its repository or working directory, completion
criteria, and any fixed verification command. Ask for missing information only
when it prevents a safe assignment. Never infer a pack state, test result,
completion receipt, or pull request URL; read or produce the evidence.

The 4.1.0 release source contains an opt-in sibling
`scripts/projects-aws-qualification.mjs` for one locally authorized CodeBuild
qualification. Public runner `3.0.0-beta.3` and private Codex integration
`4.1.0` are separate release identities; publishing either package does not
update an older installed 4.0.0 runtime or authorize a paid build. Do not run
or recommend `start` merely because the source or public package exists: it
requires an exactly reviewed 4.1.0 installation, explicit owner-enrolled
deployment policy, current private checkpoint, and the operator's existing
AWS CLI profile. It cannot replace normal PR or provider acceptance. Its
`status` is read-only; no lost or uncertain StartBuild is automatically
retried. The old 4.0.0 public review pin does not attest these new bytes.

## Automatic model routing

Before every worker or reviewer spawn, classify the assignment from its scope,
risk, ambiguity, and verification burden. Pass an explicit `model` and
`reasoning_effort` to the spawn; never silently inherit the coordinator's
model. Use only models advertised as available by the current Codex host. Start
with the cheapest tier that can reliably satisfy the assignment contract and
escalate only for concrete complexity or risk.

- **Light:** bounded discovery, documentation, formatting, deterministic data
  processing, or a narrow mechanical edit with a strong verification command.
  Use `gpt-5.6-luna` at `medium` for the worker.
- **Standard:** ordinary implementation, tests, a localized bug fix, or a
  coherent multi-file change with understood behavior. Use `gpt-5.6-terra` at
  `medium` for the worker; use `high` when meaningful edge cases remain. A
  bounded, additive, backward-compatible public API with a strong verification
  command is light or standard; do not escalate solely because code is exported,
  public, or spans multiple understood files.
- **Demanding:** ambiguous architecture, security/auth, concurrency, data
  migration, breaking or ambiguous public contracts, cross-cutting changes,
  high blast radius, or a prior failed attempt. Use `gpt-5.6-sol` at `high` for
  the worker; use `xhigh` only when the extra reasoning is justified by the
  assignment.

Route review independently. Use `gpt-5.6-terra` at `medium` for light work,
`gpt-5.6-terra` at `high` for standard work, and `gpt-5.6-sol` at `high` for
demanding work. A reviewer may be stronger than its worker but must not be
weaker than this floor. On rework caused by a reasoning or correctness miss,
increase the worker by one tier or one reasoning level while keeping the same
pack, delegation key, branch, and worktree. Do not escalate environmental or
purely procedural failures.

Spawn routed agents with only the assignment contract and required context so
unrelated conversation history is excluded. Report the selected model,
reasoning effort, and one-sentence routing rationale. Model choice never
relaxes verification, handoff, review, sandbox, or owner-decision requirements.

## Core delegation

For acceptance, include `expectedWorkspaceId`, `expectedVersion` and a stable
`idempotencyKey` alongside the exact attempt/revision. The Worker rechecks
transport authority at commit. Retry an uncertain result with the unchanged
request and key; a changed request requires a deliberate new decision.

Every new child requires an explicit `assignment` containing purpose, scope,
literal verificationCommand, credential-free HTTPS repository, full base/head
commit IDs, and context `{ ref, sha256 }`. Read the input revision and hash the
actual context before delegation; do not invent defaults. The purpose and
command must match top-level purpose and doneWhen. Pass the returned snapshot,
attempt and server-stamped revision to the worker and reviewer. Submit/review
calls require that exact attempt and revision. Only explicit coordinator rework
may change the assignment; it retains prior snapshots/handoffs. Legacy revision
0 requires a complete assignment on rework and cannot be newly accepted.

1. Call `whoami` once. Stop if the workspace is unresolved, write access is
   unavailable, or a required Projects tool is missing.
2. Create or claim the parent goal pack. Never complete it automatically.
3. Choose the execution mode before creating a child. Default to the current
   agent. Stay single-agent for one assignment, sequential or tightly coupled
   work, shared write scopes, or work whose coordination cost is likely to
   exceed its execution cost. Delegate only when two to four bounded
   assignments have independent scopes, disjoint write sets, concrete
   `doneWhen` evidence, and a credible concurrent critical-path benefit. An
   explicit request for subagents does not justify unsafe or artificial
   splitting. Before work starts, call `update_pack` on the parent with
   `agentExecution: { mode, reason, harness }`. If delegation does not qualify,
   perform and verify the parent work directly without creating child packs.
4. Call `delegate_pack` serially once per assignment, carrying the returned
   workspace version forward. Reuse its stable delegation key for rework.
5. Every delegated `doneWhen` must name exactly one literal required
   verification command and be exactly `Required verification command:
   \`your command\`.` The returned `verificationCommand` must match it. Spawn one
   native Codex child agent per returned assignment. Give each worker its
   `parentId`, `packId`, `workerId`, purpose, completion criteria, constraints,
   and exact verification command.
6. As soon as Codex creates each child task, call `bind_delegation_thread` with
   that returned assignment's `packId` as `id`, the provider-neutral native
   task identifier as `threadId`, and `threadUrl` only when Codex returns an
   absolute HTTPS URL. Bind before the worker submits its terminal handoff,
   then let assigned children run concurrently and wait through Codex task
   coordination; never poll Projects.
7. Spawn a separate reviewer agent to validate every Worker Handoff v1. The
   reviewer recommends only `accept` or `rework` and does not mutate Projects.
8. The coordinator alone calls `review_worker_handoff`, integrates accepted
   work, verifies the parent, and explicitly decides whether to complete it.

Workers call `submit_worker_handoff` exactly once per attempt. Construct its
`handoff` object with exactly `schemaVersion`, `packId`, `workerId`, `status`,
`filesChanged`, `tests`, `summary`, `blocker`, `completionEvidence`, and
`createdAt`; use `schemaVersion: 1` and `createdAt: new Date().toISOString()`.
Each `tests` entry has exactly `command`, `passed`, and `note`. A malformed
object becomes a durable `invalid_worker_handoff` failed receipt. Workers do
not resubmit or create replacement packs; the coordinator alone calls
`review_worker_handoff` with `rework` on that same child before another attempt.
Resume that same native Codex task and keep its immutable thread binding; do
not spawn or bind a replacement. Replaying the exact binding is idempotent,
while a different thread conflicts.
Completed handoffs require nonempty completion evidence, a null blocker, and no
failed reported test. Blocked or failed handoffs require a concrete blocker and
null completion evidence.

The thread binding contains only the provider-neutral task ID, optional HTTPS
URL, and Projects' server stamps. Do not place transcripts, access tokens,
session cookies, customer secrets, provider payloads, or unrelated conversation
history in bindings, packs, or handoffs. The immutable binding remains visible
on the child and parent receipt so the exact task can be identified and resumed
after interruption. Keep every child in the parent's workspace and assigned
scope. Stop on an unresolved workspace, missing tool, capacity error, or
authorization failure; never create substitute local state.

Report the parent pack ID, each child state, reported tests, completion
evidence, rework decisions, final integration checks, and whether the parent
was completed. Keep blocked or failed children visible.

## Candidate PR flow

For any PR-machine or draft-PR request, use exactly one low-energy worker and
this sequence. Low energy means passing only the assignment contract,
worktree, constraints, and verification context; do not fork unrelated
conversation history.

1. Resolve `<skill-root>` to the absolute directory containing this
   `SKILL.md`. Set the only runner path to
   `<skill-root>/scripts/projects-pr.mjs` and invoke it with Node. Do not search
   `PATH`, use a global package, fall back to a repository script, or recreate
   the workflow from memory.
2. Before `delegate_pack`, run:

   ```text
   node <absolute-runner-path> doctor --repo <repository-root> --base <base-branch> --remote <remote>
   ```

   Continue only when the protocol-v1 receipt reports `status: "ready"`.
   A missing or incompatible provider policy or credential is non-ready, even
   when local Git and GitHub access work. Show the bounded refusal and stop the
   PR flow before delegation or mutation. Do not install tools. Core delegation
   remains available if the user chooses it separately.
3. Create or claim the parent, then call `delegate_pack` once for one child.
   Before spawning that worker, run:

   ```text
   node <absolute-runner-path> prepare --pack-id <child-pack-id> --title <title> --base <base-branch> --verify-command <fixed-command> --repo <repository-root> --remote <remote>
   ```

4. Spawn one native Codex worker in the absolute `plan.worktreePath` returned
   by `prepare`. Require one or more commits, a clean worktree, the fixed
   verification command, and Worker Handoff v1. Immediately bind the spawned
   task through `bind_delegation_thread` using the child `packId`, native task
   ID, and an optional absolute HTTPS URL before its terminal handoff.
5. Ask a separate native reviewer to review the handoff. This recommendation
   does not accept the report. Inspect `status` and obtain owner authorization
   for its exact candidate head and handoff SHA-256 before publication:

   ```text
   node <absolute-runner-path> publish --pack-id <child-pack-id> --head <candidate-SHA> --handoff-sha256 <report-SHA256> --repo <repository-root>
   ```

   This creates one open draft labeled `candidate_published` and unreviewed,
   then retains the worktree. It does not run candidate code with coordinator
   credentials or accept the handoff.
6. Use the fixed provider-binding metadata from that exact publication to
   dispatch the trusted GitHub workflow. The owner must independently mark the
   same head ready in GitHub; the runner never changes draft readiness. Collect
   the exact run/attempt/artifact and an independent approval for that ready
   head. Then run:

   ```text
   node <absolute-runner-path> finalize --pack-id <child-pack-id> --run-id <run> --run-attempt <attempt> --artifact-id <artifact> --review-id <review> --repo <repository-root>
   ```

   Before readiness, finalize returns `awaiting_owner_readiness`; after
   readiness but without complete references it returns
   `awaiting_provider_evidence`. With the exact references it invokes real
   Worker acceptance and saves its validated receipt before safe cleanup.
   Report the candidate URL, audit event, accepted request index and
   owner-decision receipt. Never merge or close the PR automatically.

Use `status --pack-id <id> --repo <root>` to inspect or resume recorded state.
Set the credential-free HTTPS `/mcp` URL in PROJECTS_MCP_ENDPOINT and privately
supply PROJECTS_MCP_TOKEN in the operator environment. For GitHub App
publication, privately supply a freshly minted repository-scoped installation
token as GH_TOKEN. The runner verifies the installation-token REST surface and
exact repository identity, then admits App write capability only when the same
token returns one exact unchanged porcelain row from an effect-free receive-pack
dry run of the bound base SHA/ref. All-false repository user-permission flags,
read-only/invalid/revoked tokens and ambiguous results remain denied. It routes
that identity to GitHub API/PR and Git network operations and refuses ambient
fallback when the explicit token fails.
It never accepts an App private key or JWT. Existing human-worker sessions with
no GH_TOKEN retain the named `ambient_human_compatibility_v1` path during
migration. The runner has no endpoint or credential flags, defaults, redirects,
or local engine fallback.
Never persist credentials. Retry an uncertain action only through the exact
saved operation and service-directed observation; never infer rollback from an
error. An uncertain stack link remains unconfirmed because the pre-existing
base chain cannot prove the official command ran. Historical controller state
cannot be silently upgraded or used as current acceptance. Rework can reuse a
prepared worktree only for the next explicit assigned attempt/revision when its
exact target is clean and unpublished; preserve prior binding history.
This source skill requires reviewed installation before use. Do not replace an
installed skill or activate provider policy, runner or deployment implicitly.
Use `abort --pack-id <id> --repo <root>` only when the owner explicitly
abandons an unchanged, unpushed preparation; honor any refusal.
