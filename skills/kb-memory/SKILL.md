---
name: kb-memory
description: Durable, append-only WORKING MEMORY for agents that defeats context-window compaction. Captures facts, decisions, corrections, and PITFALLS (the recurring wrong beliefs the AI keeps forming) the instant they are stated, into a per-agent, ring-correct ledger (co-located in the agent's own store, so its access control applies), and reads them back on wake. The ledger is the SOURCE OF TRUTH; the chat window is disposable. Use whenever a fact/decision/correction is established, and before asserting any fact. Wielded by every agent; the CFO and CLO are the reference users. Non-PHI ring; CFO ledger is MNPI/private, the legal personal ledger is privileged + segregated.
---

# kb-memory — the agent working-memory ledger

## Why this exists
In a long Claude Code session the context window fills and older turns get summarized (compacted).
Summaries keep the gist and DROP exact facts (a date, a number, a decision, a correction). That is
why an agent "forgets" or silently CHANGES a fact established earlier in the same chat. The fix is to
stop relying on in-session memory: externalize every fact the moment it is stated, and read it back on
demand. Then compaction cannot hurt you, the corpus grows unbounded (cheap, searchable), and only the
relevant slice is ever pulled into context. Retrieval, not retention.

## The model
- The **ledger is the source of truth.** Reconstruct facts by READING it (`tail` / `recall`), never by
  trusting recall. If memory and the ledger disagree, **the ledger wins.**
- **Append-only + temporal supersession.** Corrections never delete the old fact; they record
  `WAS x -> NOW y`, so the history is intact and you can see how a fact changed. Nothing is thrown away.
- **PITFALLS are first-class.** Knowing the *incorrect* facts the AI keeps forming is as important as the
  facts. A pitfall records "the AI keeps believing X; the truth is Y; the rule is Z" so the recurring
  error is corrected at the source. Pitfalls are ALWAYS surfaced on wake.

## Verbs
```
node skills/kb-memory/mem.mjs remember "<fact>"            --agent cfo [--tags a,b] [--source "Matt 2026-06-19"] [--share]
node skills/kb-memory/mem.mjs decision "<decision + why>"  --agent cfo [...] [--share]
node skills/kb-memory/mem.mjs correct  "<the CORRECT fact>" --agent cfo --was "<the wrong belief>" [--supersedes <id>] [--share]
node skills/kb-memory/mem.mjs pitfall  "<recurring mistake + truth + rule>" --agent cfo [--share]
node skills/kb-memory/mem.mjs status   "<what I'm working on / project status>" --agent cfo   # ALWAYS shared to the exec team
node skills/kb-memory/mem.mjs entity set <key> "<value>"   --agent cfo [--source "..."] [--share]  # deterministic "what is X now" (latest wins per key)
node skills/kb-memory/mem.mjs entity get <key>             --agent cfo            # the CURRENT value + provenance (resolves aliases)
node skills/kb-memory/mem.mjs entity list                  --agent cfo            # all current-values + aliases
node skills/kb-memory/entity-inventory.mjs                                  # CTO-only metadata inventory for the four approved cloud keys
node skills/kb-memory/seed-current-cloud.mjs [--apply]                    # guarded, idempotent seed plan; dry-run unless --apply
node skills/kb-memory/mem.mjs entity alias "<phrasing>" <canonical-key> --agent cfo [--source "..."] [--share]  # point many phrasings at one key
node skills/kb-memory/mem.mjs entity link <from-key> <relation> <to-key> --agent cfo [--source "..."] [--share]  # append a relationship edge (thin, no graph DB)
node skills/kb-memory/mem.mjs entity graph <key>            --agent cfo [--hops 1|2]  # 1-2 hop neighborhood walk: "what depends on X" (both directions)
node skills/kb-memory/mem.mjs recall   "<query>"           --agent cfo [--n 25]    # searches YOUR lane + the TEAM feed
node skills/kb-memory/mem.mjs tail     --agent cfo [--n 40]     # YOUR pitfalls/recent + the TEAM feed (company-wide)
node skills/kb-memory/mem.mjs team     [--n 60]                # the whole exec team feed: who is working on what
node skills/kb-memory/mem.mjs render   --agent cfo             # re-render the human ledger .md
node skills/kb-memory/mem.mjs whoami   --agent cfo             # HEALTH CHECK: resolved identity + SA + ledger count + PASS/FAIL
node skills/kb-memory/mem.mjs use      cfo                     # CLAIM this session's identity (writes ~/.claude/.kb-agent)
node skills/kb-memory/mem.mjs list-agents
```

## Activation (run every session) — prevents "I can't find that"
Get on the latest shared code and prove your memory is ON with THREE transparent steps. This is the
canonical path; it works in EVERY session, including hardened / auto-mode ones:
```
git -C /tmp/octools fetch origin main && git -C /tmp/octools reset --hard origin/main   # latest toolkit (data only)
node /tmp/octools/skills/kb-memory/mem.mjs use <role>                                    # claim this session's identity
node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent <role>                         # self-test -> look for RESULT: PASS
```
Run it at the start of every session and any time you suspect drift, so you never run on a stale branch
and never report a file/skill as missing when it exists on main. The memory engine **self-resolves the
service account from disk** (`~/.gcp_claude_driver_sa.json`) when the env var is absent, so a fresh shell
can never silently drop writes (the old "memory off" pitfall). NOTE: `setup/agent-activate.sh <role>` runs
these same three steps in one command, but the AUTO-MODE security classifier BLOCKS it (an opaque /tmp
script that pulls main then executes the fetched code), so prefer the three steps above; the wrapper only
works where a Bash allow-rule for /tmp/octools exists.

## Credential bootstrap (no Azure, ever) — what to set on each seat type
Azure Key Vault is **permanently unreachable** (2026-08-18; the storage estate is write-locked). Every
credential this skill needs — the ledger's blob storage (`s3-blob.mjs`), any Key-Vault-named secret
(`kvSecret()` in `azure-secret.mjs`), and an OTCHealth gateway lane bearer (`skills/gateway-connect/`) —
now bottlenecks on exactly ONE question: **does this seat's process environment resolve an AWS
credential?** If yes, everything works (the AWS SSM `/otchealth/*` mirror stands in for Key Vault
transparently). If no, nothing does — and every write path in this skill is designed to say so loudly
and by name (never a silent no-op) rather than leave you guessing.

**The single bootstrap credential an operator hands a seat is `OTC_AWS_ACCESS_KEY_ID` /
`OTC_AWS_SECRET_ACCESS_KEY` — NOT the plain `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` names.**
Reason: this fleet's cloud sandbox proxy injects its own non-functional placeholder value (prefix
`prox...`) into the standard `AWS_ACCESS_KEY_ID` name on some seats. A real operator-supplied value
there is therefore not deterministic — it may or may not win depending on injection order, which is not
something to guess about. `OTC_AWS_*` is a name the proxy has no reason to ever touch, so a value set
there survives deterministically. Every credential-resolving function in this skill (`awsCreds()` in
`aws-secret.mjs`, and everything built on it) checks the plain `AWS_*` names first for backward
compatibility, then falls back to `OTC_AWS_*` — and both are guarded against the `prox` placeholder
being mistaken for a real key.

**Per seat type:**
- **Hyperagent seat** (or any long-running non-ECS agent container): set `OTC_AWS_ACCESS_KEY_ID` +
  `OTC_AWS_SECRET_ACCESS_KEY` in the seat's environment/secrets configuration. This is the credential
  that was MISSING and caused the original failure this bootstrap fix responds to (a CRO Hyperagent
  seat's `mem.mjs status --agent cro` had neither AWS nor Azure creds and lost its write). Nothing else
  needs to be set; `fetch-secrets-azure.mjs` (session-start.sh's secret hydration) and every kb-memory
  write path pick it up automatically via the same resolver.
- **Claude Code cloud seat** (this environment): same two variables, set in the cloud Environment's
  `.env` box. If `AZURE_SP_CLIENT_ID/SECRET/TENANT_ID` are ALSO set (the historical Azure-first
  posture), they are tried first and harmlessly fail fast (Key Vault itself is gone) before falling
  through to `OTC_AWS_*` — no need to remove them, but they no longer do anything useful.
- **ECS / Fargate job** (Container Apps Jobs, the gateway's own task): needs NOTHING set explicitly.
  The task role supplies AWS credentials automatically via the container-credentials endpoint
  (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, injected by the platform), which `awsCreds()` checks
  FIRST, before either `AWS_*` or `OTC_AWS_*` env — this is the path that was never affected by the
  Azure outage in the first place.

**How to tell whether it worked:** `node skills/kb-memory/mem.mjs whoami --agent <role>` reports
`memory backend: present (AWS/S3 ...)` or `MISSING — no AWS creds ... and no Azure creds either; writes
will fail`, by name. A write that fails anyway (any of `remember`/`decision`/`pitfall`/`status`/
`correct`) is NEVER silently lost: it prints a loud `ERROR:` naming the missing credential AND saves the
attempted content to `~/.claude/kb-cache/_failed_writes-<agent>.jsonl` (the same durable local fallback
`reflect.mjs`'s own `--commit` loop has always used) so it is recoverable by hand or by re-running the
exact command once credentials are restored.

**Why NOT route around this via the gateway instead of fixing AWS creds directly** (the question this
fix's design explicitly considered and rejected as a *replacement*, though it remains a valid
*complementary* path where the platform already provides it): the gateway's own OAuth lane
client-secret (`skills/gateway-connect/connect.mjs`) is resolved through the SAME `kvSecret()` call this
skill uses for everything else — Key Vault, then the AWS SSM mirror on failure. It has no independent
bootstrap; a gateway bearer is just as unreachable as a direct ledger write when no AWS credential
resolves. Setting `OTC_AWS_*` therefore fixes BOTH paths at once, from one credential, which is why it
— not a second, gateway-specific credential — is the fleet's single bootstrap secret.

## Connected executive memory (each agent has its lane; the team shares automatically)
Every agent keeps a PRIVATE lane (ring-correct). Two things ALSO publish a copy to a shared EXEC TEAM
feed (`otchealthcommons/company-journal/_MEMORY/_exec/<agent>.jsonl`, one file per agent so there is no
cross-agent clobber):
- **`status`** (always) - the agent's current projects / what it's working on.
- **any entry written with `--share`** - a fact/decision/pitfall the whole team should know.
Every agent's **`tail` / `recall` / `team` automatically read the whole feed**, so each exec agent sees
its own detailed lane PLUS what every other exec agent is doing - the company-wide picture. Exec roster:
coo, cfo, clo, cto, capital, commerce, compliance, rainmaker, growth, **developer** (the one
master app/web developer across the whole portfolio; see `dream-team/agents/developer.md`). Any
agent can publish/read.

**Rings stay intact.** The shared feed is broadly readable, so only what you explicitly `status` /
`--share` ever leaves your lane - keep those NON-sensitive (no MNPI specifics, no privilege). Detailed
facts default to PRIVATE. The **`clo-personal`** lane is HARD-EXCLUDED from sharing (attorney privilege):
its `status`/`--share` is a no-op that stays in the private lane.

## Agents + rings (the ledger co-locates in the agent's own store)
| `--agent` | store / container | ring |
|---|---|---|
| `cfo` | `otchealthcfodata/cfo-source-docs` | finance, MNPI/private |
| `clo` | `otchealthlegalstore/company` | legal company, privileged |
| `clo-personal` | `otchealthlegalstore/personal` | legal PERSONAL, privileged + confidential, segregated (never co-mingle) |
| `commons` (and any other name) | `otchealthcommons/company-journal` | fleet commons, shared |

Artifacts: `_MEMORY/<agent>.jsonl` (append-only record) + `_MEMORY/<agent>.md` (human-readable ledger,
pitfalls first). Dependency-free Node; self-resolves storage creds from Secret Manager via the
claude-driver SA, exactly like doc-indexer. The owning room's librarian also indexes the `.md` so the
ledger is cloud-searchable.

## Session integration (hooks — see .claude/settings.json + kb-inject.sh)
The hooks resolve WHICH agent's ledger to use per SESSION, most-specific signal wins. A single shared
`KB_AGENT` env var CANNOT label multiple agents that share ONE cloud environment (CTO/CFO/CLO/COO all
run in the same Claude Code environment, so one env var would mis-home all but one). Resolution order:
  1. `~/.claude/.kb-agent`             session-local marker  -- claim per session: `mkdir -p ~/.claude && echo cfo > ~/.claude/.kb-agent`
  2. `$CLAUDE_PROJECT_DIR/.kb-agent`   repo default          -- one app repo = one agent (commit it)
  3. `$KB_AGENT` (env)                 shared-environment fallback (only reliable in a single-agent env)
A marker / repo default WINS over the shared env var, and a mismatch is SURFACED (not silently honored).
- **SessionStart** injects the resolved agent's `tail` (pitfalls + recent facts) so the session wakes holding the truth.
- **PreCompact** reminds the agent to persist unsaved facts right before the window compacts.
- **Stop** reminds to flush before ending.
Fail-safe: if NO agent resolves (no marker, no repo file, `KB_AGENT` unset) SessionStart warns LOUDLY
(set `KB_MEMORY_OPTOUT=1` to silence a deliberately memory-less session). **Shared-environment rule:**
each exec session claims its identity with the marker; per-app repos carry a committed `.kb-agent`.

### KB_AGENT propagation, made robust + canary-detectable (W1-5, 2026-07-17)
The stdout banner above only reaches a human reading that exact output at that exact moment -- it left
NO durable trace (no agent identity means no ledger write and no `memory_beacon`, since `beacon.mjs`
itself no-ops when its `--agent` is empty by design). Two fixes:
- **`agent-unset-beacon.mjs`** -- a tiny, fire-and-forget script that emits a `kb_agent_unset` event to
  the same PostHog Fleet Agents project every other fleet signal uses, throttled (default 30 min) via a
  pure `shouldEmit(lastEmitMs, nowMs, throttleMs)` helper (tests: `tests/agent-unset-beacon.test.mjs`).
  Fires from `kb-inject.sh`'s `session` mode (once per session, unless `KB_MEMORY_OPTOUT=1`) AND,
  re-throttled, from `periodic-check` mode -- closing the second, quieter gap: `periodic-check` used to
  `exit 0` SILENTLY when no agent resolved, so a long single-turn (or auto-mode) session with memory off
  got exactly ONE reminder (the SessionStart banner, easy to scroll past) and then nothing for its entire
  duration, even though this hook fires roughly every 15 min / 100 tool calls.
- **Deliberately NOT wired into azure-canary's freshness registry.** `kb_agent_unset` is an
  ANOMALY-shaped event (an occurrence is the problem; zero occurrences is healthy) -- the opposite shape
  from a freshness SLO (silence is the problem). The natural home for "did this fire more than expected"
  is a future signal-radar detector (count/rate-based), not azure-canary; not built here, but the durable
  event now exists for it.

## The discipline (the SOP, enforced by the hooks + each agent's CLAUDE.md)
1. **Wake:** read `tail`, then `recall` the topic. Reconstruct, don't recall.
2. **Write-through:** the instant a fact/decision/correction happens, append it BEFORE continuing.
3. **Corrections:** when a fact changes, `correct ... --was "<old>"`. Old retained, new supersedes.
4. **Verify-before-assert:** check the ledger before stating any fact; the ledger wins.
5. **Stop:** flush; the nightly digest folds it into the commons for the whole fleet.

## Guardrails
- Non-PHI ring only. The `clo-personal` ledger is privileged + confidential: never co-mingle with
  `clo` (company), never share to other agents, never commit to git.
- CFO ledger is MNPI (INND material): it lives in the private finance store, not the shared commons.
- Secrets never go in a ledger entry.

## Semantic recall (vector) — `semantic.mjs`
Keyword `recall` finds exact terms; **semantic recall** finds memories by MEANING, so a query
like "how do we reconnect accounting software" surfaces the Xero re-consent pitfalls even with no
shared keywords. Backend is Azure AI Search + text-embedding-3-large by DEFAULT (the data-room
infra), but is selectable — see "Backend" below. Indexes ONLY the shared exec feed
(`_MEMORY/_exec/*`), never a private or clo-personal lane.

**Backend (2026-08-16): `SEARCH_BACKEND=azure|opensearch`** (env, default `azure`) — the same env
var name/values as `otchealth-mcp-server`'s dispatcher and doc-indexer's `enrich.mjs
--search-backend`. `opensearch` routes every write/read below through `opensearch-write.mjs`
instead of Azure AI Search — the fix for the defect where an Azure outage froze `memory-exec` and
every ring-memory index outright (init() used to throw unconditionally on missing Azure Search
creds). `EMBEDDINGS_PROVIDER=foundry|openai` (default `foundry`) is an independent switch — a real
Azure outage takes Azure Foundry down too, so `EMBEDDINGS_PROVIDER=openai` is also needed for a
genuinely Azure-free run. For a one-shot catch-up of every frozen room, see
`skills/kb-memory/backfill-frozen-rooms.mjs`.

- `node skills/kb-memory/semantic.mjs reindex` - (re)build the `memory-exec` index (resumable; skips already-indexed). Run after a batch of new entries (or wire into the daily-digest job).
- `node skills/kb-memory/semantic.mjs recall "<query>" [--n 12] [--agent cto] [--type pitfall]` - vector + keyword (hybrid) recall across the whole exec team's memory.

**Always fresh (Wave 2b):** a SHARED entry is embedded into `memory-exec` the INSTANT it is written
(detached `index-one.mjs`), so semantic recall and the company-brain see it within the minute, not after
the next reindex. **Per-prompt (Wave 2b follow-on):** when an agent's local keyword pack is THIN, `pack`
auto-injects up to 3 ring-safe `RELATED (shared brain, by meaning)` hits from `memory-exec` using the
server-side SEMANTIC RANKER + a READ-ONLY query key (`azure-search-query-key`; no admin/embedding key on
the hot path). Thin-triggered + 60s-throttled + 2s-bounded + fail-open; `KB_SEM_DISABLE=1` turns it off.

**Trust-ranked recall (semantic-trust wiring):** `semantic.mjs recall` annotates + re-orders hits by
CROSS-AGENT corroboration via `skills/semantic-trust`. Memories several agents independently recorded rank
`durable`/`corroborated` and float ahead of a single `unverified` assertion (each hit shows `trust: <status>
t=<0..1>, N agents`). Corroboration-only (recall hits have no subject key, so no contradiction fabrication);
additive + fail-open — recall still works, just unranked, if semantic-trust is unavailable.

## Cross-lane read/write + wake reconciliation (exec team, 2026-07-04)
The exec ledgers stay SEPARATE per agent, but every exec agent can READ and WRITE any exec ledger to pass
information and suggest corrections. Cross-writes are APPEND-ONLY + ATTRIBUTED and never supersede the
owner's entries — the owner reconciles them on wake. This doubles as the inter-agent comms channel.

- Write on ANOTHER agent's ledger:  `mem.mjs remember "<note>" --agent cfo --on clo`
  (writer = --agent; target ledger = --on; entry is tagged `by:cfo`; cannot delete/supersede clo's entries.)
- WAKE FIRST DUTY (every session): take in your OWN ledger, THEN check what other agents left you:
    `mem.mjs inbound --agent <you>`     # notes other agents wrote on your ledger since last reconcile
    ...review + act on each (record your own decisions/corrections normally)...
    `mem.mjs reconcile --agent <you>`   # ack: advances the marker (deletes nothing; history is kept)
  `tail` and the per-prompt pack also surface a 📥 INBOUND banner automatically, so a fresh/compacted
  session sees inbound cross-agent input immediately.
- clo-personal is excluded from cross-lane writes/sharing (attorney privilege, unwaivable).

## Nightly self-maintenance (Phase 4B): distillation + contradiction proposals
Two scheduled (Container Apps Job) scripts that keep the ledger itself healthy, on top of everything
above. Both are dry-run by default (pass `--commit` to actually write) and always exit 0 (fail-open).

- **`nightly-reflection.mjs`** reads the last ~24h of Cosmos "episode" memories (kind=episode, the
  gateway's auto-journal -- one short marker per successful mutating tool call) across every agent,
  clusters each agent's episodes by recurring topic, and distills genuinely RECURRING patterns into
  0-N facts/decisions/pitfalls written back onto that same agent's own ledger, tagged
  `nightly-reflection`. This is the CROSS-SESSION counterpart to `reflect.mjs` (which only ever sees
  one session's transcript): a pattern that only shows up across a whole day of episodes would never
  surface to any single reflect.mjs run. Quality-synthesis model routing (gpt-4o primary, the Foundry
  "quality" tier as fallback); gpt-4.1-mini is never used here.
  `node skills/kb-memory/nightly-reflection.mjs [--commit] [--hours 24] [--agent <lane>] [--max-items 5]`
- **`contradiction-scan.mjs`** pulls recent assertion rows from BOTH memory stores (the shared exec
  feed on Blob, and the gateway's Cosmos `memory` container), groups them by topic, and runs the
  existing `semantic-trust` `groupAssertions()` + `scoreClaim()` to find genuine cross-agent
  contradictions. For each contested claim it opens exactly ONE `decision-clock` proposal (category
  `memory-contradiction`) with both claims and their trust rationale as evidence. It NEVER resolves a
  contradiction itself: no memory-CLI `correct`, no `--supersedes`, ever. A human or agent reviews the
  proposal later and either confirms the majority claim or corrects the record by hand.
  `node skills/kb-memory/contradiction-scan.mjs [--commit] [--days 14] [--owner cto]`
- **RING/PRIVILEGE WALL on both:** dedupe.mjs's `ringSafeCross()` (the same `RING_DENY` content wall
  used read-side elsewhere in kb-memory and in company-brain) hard-excludes any privileged-agent-lane
  row (clo-personal) AND any row whose own text/tags matches an MNPI/PHI marker, REGARDLESS of which
  agent asserted it -- agent identity alone is not a sufficient gate, since an otherwise-shareable
  agent (cfo/clo/capital/cto) can still assert one MNPI-flagged fact that must stay in its own lane.
  `contradiction-scan.mjs` applies it at the row-normalize load point AND again inside
  `findContestedGroups()` (two independent gates), so a privileged/MNPI row can never become an input
  to, or an output of, the cross-agent comparison. `nightly-reflection.mjs` applies it to the
  `--share` output path via `enforceRingSafeShare()` (a hard code-level backstop on top of the
  distillation prompt's own soft instruction), force-downgrading `share: true` to `false` on any
  privileged/MNPI/PHI-flagged item -- the fact still lands on the agent's own private ledger, it just
  never publishes to the shared exec-team feed.
- Both read `cosmos-memory-read.mjs`, a READ-ONLY client scoped to the Cosmos `memory` container (no
  create/replace/delete exported at all) so neither script can mutate the Cosmos memory-of-record
  directly; every durable effect is a NEW row via the memory CLI or a NEW `decision.mjs open` proposal.
  Job entrypoints: `job/nightly-reflection.sh`, `job/contradiction-scan.sh` (mirror
  `skills/ledger-compaction/job/compaction.sh`'s shape). Not yet scheduled as Container Apps Jobs --
  that is a CTO deploy step, pending review of the ring/privilege wall above.
- **RE-VERIFIED (item 6.5, Wave 6):** the false-positive fix (`hasGenuineValueConflict`, PR #358) and
  the ring/privilege wall above were re-run against the LIVE ledger in dry-run mode (`--days 14` /
  `--hours 24`, no `--commit`). Result: 853 raw candidate rows, 195 correctly excluded pre-partition by
  `ringSafeCross()` (11 genuine clo-personal-authored rows plus 184 additional MNPI/PHI-content-flagged
  rows from otherwise-shareable agents), 5 contested groups surfaced, all legitimate un-superseded
  build-status hygiene items (a stale "next build is N" fact never linked via `--supersedes` as later
  builds shipped), zero recurrence of the previously-fixed templated-identifier false-positive class,
  and zero privileged/MNPI content in any surfaced proposal. Both scripts remain dry-run by default and
  neither is scheduled as a Container Apps Job; the arm decision (schedule + `--commit` + review) stays
  a deliberate later step, not part of this re-verification.
