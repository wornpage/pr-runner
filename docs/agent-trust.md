# Agent and service trust

The public runner connects to a separately operated Projects service. That
service owns workspace membership, authorization, entitlement, rate limits,
lifecycle decisions, reviewer acceptance, readiness, provider evidence, and
audit records. This repository cannot prove the live service's availability,
retention, or operational controls.

Use a dedicated Projects personal token. Supply it only as
`PROJECTS_MCP_TOKEN`; revoke it through the Projects account surface. Removing
local files does not revoke it.

The runner keeps repository and GitHub credentials on the machine. They are
used only by fixed local Git/GitHub commands. The Projects token and endpoint
are stripped from those subprocesses. Candidate verification is performed by
the assigned worker, outside runner credentials.

Public protocol files document the wire boundary. The service response is still
untrusted input: the runner independently validates exact action fields and
local state before every effect. A service refusal, network failure, unknown
field, stale binding, changed ref, or uncertain process cannot activate a
fallback.

Local verification distinguishes package/runtime safety from live readiness.
`node test/verify-private-engine-boundary.mjs` uses disposable local Git and
controlled service/provider seams. It does not establish live authorization,
GitHub acceptance, or production availability.
