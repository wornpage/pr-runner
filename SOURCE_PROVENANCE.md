# Source provenance

Wornpage PR Machine predates this public repository. The original public source
was extracted on 2026-09-01 from the private Wornpage Projects repository at
commit `aaa7580ac2b8d057770d6d1947c99201c642ce29`.

On 2026-09-12 the current public tree was cut over to a client boundary. The old
controller, lifecycle and delivery policy, review strategy, decision contracts,
agent strategy templates, hosted rehearsal logic, and related tests were removed
from current source and package contents. Their behavior is not represented by
compatibility wrappers or an offline fallback.

The remaining public runtime contains only:

- CLI parsing and local receipts;
- authenticated bounded MCP transport;
- the frozen public v1 schema and fixtures;
- independent action-specific validation;
- local journal, lock, bounded-process, Git, and GitHub mechanics;
- an opt-in local AWS qualification command and pure closed contract; and
- three current Codex role templates for tracked assignments and independent
  handoff review;
- package and adversarial boundary verification.

The 2026-09-24 public mirror candidate stages the exact portable runtime and
Codex role assets from reviewed private source commit
`8bf60c8042a4d947eca1c4e1a8c78f0c871ecede`. The private Workspace remains
the authority for a single paid dispatch. No private service, credential,
customer account setting, or hosted acceptance engine is shipped here.

The release instruction and trust guide were subsequently clarified in the
private pre-pin source commit `88d1b4c53d9fec5e162d5d933f8d05855dd64fd9`.
All 19 portable installer assets and `docs/agent-trust.md` in this public
mirror match that pre-pin commit byte-for-byte. The private installer must pin
the actual reviewed public release commit after publication; this provenance
note is not an installation or a hosted qualification receipt.

The private Projects service and installer are developed separately. The
checked runtime manifest lets private CI pin exact public bytes without
importing private service source into this repository. Existing copyright and
AGPL-3.0-only licensing remain unchanged.
