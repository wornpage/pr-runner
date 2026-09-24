# Changelog

## 3.0.0-beta.3 - 2026-09-24

- Adds the source-reviewed local AWS qualification sibling, pure policy contract,
  and exact package/runtime manifest inventory.
- Keeps single-use authorization and reservation state in the private Projects
  Workspace. The local operator selects the AWS CLI and profile; uncertain
  outcomes cannot automatically redispatch.
- Packages three current Codex role templates and preserves the frozen PR wire
  protocol and GitHub acceptance path.
- Updates the public package and plugin identities for this review commit.

## 3.0.0-beta.2 - 2026-09-13

- Updates public repository, homepage and issue links for the separate runner distribution.
- Preserves all eleven runtime files, the v1 protocol and existing license/provenance.

## 3.0.0-beta.1 - 2026-09-12

- Replaces the public PR Machine decision engine with a bounded local runner for
  the authenticated private Projects service.
- Removes public lifecycle policy, review strategy, merge/delivery commands,
  programmatic policy APIs, and their shipped source and tests.
- Keeps seven CLI verbs and adds explicit `publish` between worker evidence and
  owner readiness.
- Adds the frozen v1 wire schema and fixtures, exact action-specific validation,
  bounded JSON/SSE MCP transport, durable recovery journal, repository locking,
  and closed Git/GitHub actions.
- Enforces a local command-to-action matrix before journaling and inside the
  host dispatcher; read-only `doctor` and `status` cannot perform mutations.
- Keeps the Unix shell executable path inside its bounded host probe and emits
  a path-free `POSIX` capability marker on Linux and macOS.
- Adds a hash-pinned self-contained runtime manifest and a real package,
  clean-install, Git, replay, stack, and adversarial boundary gate.

Version 3 is intentionally incompatible with the embedded version 2 controller.
