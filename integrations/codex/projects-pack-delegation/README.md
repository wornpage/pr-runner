# Projects PR local runtime

This directory retains the public runtime installed beside the private Projects
integration. The separately operated service and its generated installer own
coordination, lifecycle, review, acceptance, and readiness decisions.

The installed entrypoint is:

```text
skills/projects-pack-delegation/scripts/projects-pr.mjs
```

All runtime imports resolve inside that skill tree. The exact required files,
hashes, identity markers, and dependency inventory are in
`skills/projects-pack-delegation/scripts/runtime-manifest.json`.

The runner requires `PROJECTS_MCP_ENDPOINT` and `PROJECTS_MCP_TOKEN`. It has no
endpoint or credential CLI flags and no local decision-engine fallback. Public
copies of the generic pack tool catalog and Worker Handoff v1 schema remain in
`contracts/`; the live private service is authoritative.
