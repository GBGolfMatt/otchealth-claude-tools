# Current cloud entities

These commands are a reviewed data plan. Do not run them from CI or as part of installing this skill.
Re-read live AWS metadata immediately before execution. The values below were verified on 2026-09-07
from ECS, OpenSearch, RDS, and the gateway health evidence recorded by the CTO seat.

Before any write, run the bounded inventory wrapper. It reads the authoritative S3 shared feed with
the same storage functions as the memory CLI and emits only counts, the approved keys, owners, row IDs,
and structural safety findings. It never logs entity values or unrelated alias names.

```text
node skills/kb-memory/entity-inventory.mjs
node skills/kb-memory/seed-current-cloud.mjs
```

The four canonical current-value rows are:

```text
node skills/kb-memory/mem.mjs entity set otchealth_primary_cloud "AWS is the active company cloud estate." --agent cto --source "Live AWS metadata verification, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity set otchealth_gateway_runtime "AWS ECS on Fargate in us-east-1 at mcp.otchealth.app." --agent cto --source "Live ECS service and task definition verification, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity set otchealth_brain_backend "Amazon OpenSearch Service domain otchealth-brain on AWS, federated by brain_search." --agent cto --source "Live OpenSearch and gateway verification, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity set otchealth_agent_state_backend "Amazon RDS for PostgreSQL database otchealth-pg on AWS." --agent cto --source "Live RDS and gateway task definition verification, 2026-09-07" --share
```

After the canonical rows exist, these scoped aliases cover the two failed current-truth questions in
the 2026-09-07 bounded fast evaluation and three close variants:

```text
node skills/kb-memory/mem.mjs entity alias "what cloud platform is the company brain running on now and is azure still active" otchealth_brain_backend --agent cto --tags "current-value,exact-match-only" --source "bounded-fast-eval current-cloud, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity alias "what is the current search backend and live index architecture for brain_search" otchealth_brain_backend --agent cto --tags "current-value,exact-match-only" --source "bounded-fast-eval current-backend, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity alias "what is otchealth's current primary cloud" otchealth_primary_cloud --agent cto --tags "current-value,exact-match-only" --source "current cloud natural-query alias, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity alias "where is the otchealth gateway running now" otchealth_gateway_runtime --agent cto --tags "current-value,exact-match-only" --source "current gateway natural-query alias, 2026-09-07" --share
node skills/kb-memory/mem.mjs entity alias "what is the current otchealth agent state backend" otchealth_agent_state_backend --agent cto --tags "current-value,exact-match-only" --source "current state natural-query alias, 2026-09-07" --share
```

Every alias contains a current-time marker and a company or subsystem name. Do not add aliases named
`cloud`, `backend`, `search`, `state`, `brain`, or `azure`. Broad aliases would turn historical
questions into current-value lookups.

Alias rows carry the `exact-match-only` tag. Do not execute the alias commands until the gateway
version that honors this contract is deployed: tagged aliases may resolve only when the whole query
normalizes to the alias, and must be excluded from containment candidates. The guarded seed wrapper
refuses malformed or forked shared-feed inventory, skips identical rows, and stays dry-run unless
`--apply` is explicit. Historical Azure records remain in the ledger and document corpus.
Entity writes supersede only an earlier row with the same canonical key. Alias writes are owner-only;
`--agent <writer> --on <other-lane>` is rejected before storage access, and `clo-personal --share`
continues to be held in the private lane by the existing shared-feed gate.

## One-off execution limits

Run the seed in one isolated task while no other CTO memory writer is active. The current shared-feed
publisher updates the per-agent object with a read followed by an unconditional write, so concurrent
CTO writers can race. The wrapper forces `BLOB_BACKEND=s3`; legacy Azure may be consulted only as a
best-effort history read and is never a write target.

Each child CLI call has a 45-second limit. A timeout can occur after the private append but before
shared publication or process exit. The wrapper suppresses the child's stdout and stderr, then performs
an independent shared-feed inventory. It continues only when that exact approved row is confirmed;
otherwise it stops with a metadata-only failure. A final inventory must confirm all four entities and
five aliases. Live Brain recall remains a separate post-deploy acceptance check.
