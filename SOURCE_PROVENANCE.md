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
- package and adversarial boundary verification.

The private Projects service and installer are developed separately. The
checked runtime manifest lets private CI pin exact public bytes without
importing private service source into this repository. Existing copyright and
AGPL-3.0-only licensing remain unchanged.
