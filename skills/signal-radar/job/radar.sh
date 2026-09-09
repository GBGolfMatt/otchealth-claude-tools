#!/bin/sh
# signal-radar (Container Apps Job, every ~30 min): scans the fleet's existing telemetry for
# high-precision signals and, above threshold, persists + dispatches to the owning agent's inbox.
# Report/observe only; never acts on prod. Tier-1 autonomy (Azure cron, ZERO Max-plan draw). One
# secret: the claude-driver SA self-resolves every Azure/PostHog/Sentry key from Secret Manager.
# Persistence or dispatch uncertainty exits non-zero so the scheduler surfaces actionable recovery.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[signal-radar] $(date -u +%FT%TZ) - scanning fleet telemetry -> emit signals + route to owner inboxes"
node "$ROOT/skills/signal-radar/radar.mjs" scan --emit "$@"
echo "[signal-radar] done"
