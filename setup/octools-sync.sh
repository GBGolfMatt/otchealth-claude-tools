#!/usr/bin/env bash
# octools-sync.sh — in-session AUTO-refresh of the shared toolkit (the live-pull half of octools-version).
#
# Why: session-start.sh force-syncs the toolkit to origin/main AT SESSION START. A long-running session
# that began before a fix/SOP was merged keeps the OLD copy until it restarts (this caused the "the CTO
# changed something and the other agents are not connected to it" fragmentation). Wired as a
# UserPromptSubmit hook, this makes a running agent pick up changes to claude-tools/main on its NEXT
# prompt, with no restart and no lost context. main is the single source of truth; every agent re-pulls it.
#
# Safe by design: the auto-reset is throttled (default 300s, no per-message latency) and GUARDED to /tmp
# so it can NEVER reset a real working checkout (the CTO's own claude-tools checkout is left alone). The
# fleet-bulletin surfacing runs in any session. Always exits 0 so it can never block a prompt.
set -u
TOOLS_DIR="${OCTOOLS_DIR:-/tmp/octools}"
THROTTLE="${OCTOOLS_SYNC_THROTTLE:-300}"
STAMP="${HOME}/.claude/.octools-sync-last"
SKILLS_DST="${HOME}/.claude/skills"
MARKER="${HOME}/.claude/.octools-installed-commit"

git -C "$TOOLS_DIR" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# --- Auto-refresh: ONLY for an ephemeral /tmp consumption clone, never a real working checkout. ---
case "$TOOLS_DIR" in
  /tmp/*)
    now="$(date +%s 2>/dev/null || echo 0)"
    last="$(cat "$STAMP" 2>/dev/null || echo 0)"
    if [ "$now" -le 0 ] || [ $((now - last)) -ge "$THROTTLE" ]; then
      mkdir -p "${HOME}/.claude" 2>/dev/null || true
      echo "$now" > "$STAMP" 2>/dev/null || true
      if timeout 20 git -C "$TOOLS_DIR" fetch --depth 1 --quiet origin main 2>/dev/null; then
        remote="$(git -C "$TOOLS_DIR" rev-parse FETCH_HEAD 2>/dev/null || echo none)"
        installed="$(cat "$MARKER" 2>/dev/null || git -C "$TOOLS_DIR" rev-parse HEAD 2>/dev/null || echo none)"
        if [ "$remote" != "none" ] && [ "$remote" != "$installed" ] && git -C "$TOOLS_DIR" reset --hard --quiet FETCH_HEAD 2>/dev/null; then
          if [ -d "$TOOLS_DIR/skills" ]; then
            for skdir in "$TOOLS_DIR/skills/"*/; do
              sk="$(basename "$skdir")"
              rm -rf "${SKILLS_DST:?}/${sk}" 2>/dev/null || true
              cp -R "$skdir" "${SKILLS_DST}/${sk}" 2>/dev/null || true
            done
          fi
          # Keep the shared setup modules in step with the skills. skills/ and setup/ are siblings in
          # the git tree, and thirteen skills import "../../setup/<mod>.mjs"; if only skills/ refreshes
          # here, a skill that starts importing a NEW shared module mid-session breaks with
          # ERR_MODULE_NOT_FOUND until the next fresh session. Same *.mjs-only rule as session-start.sh.
          if [ -d "$TOOLS_DIR/setup" ]; then
            mkdir -p "${HOME}/.claude/setup" 2>/dev/null || true
            cp -f "$TOOLS_DIR/setup/"*.mjs "${HOME}/.claude/setup/" 2>/dev/null || true
          fi
          # Re-wire user-scope hooks idempotently so a NEWLY-ADDED hook (e.g. kb-recall) reaches an
          # already-RUNNING session on its next refresh, not only on the next fresh session. Additive,
          # only writes when changed, always exits 0.
          [ -f "$TOOLS_DIR/setup/install-octools-hook.mjs" ] && node "$TOOLS_DIR/setup/install-octools-hook.mjs" >/dev/null 2>&1 || true
          git -C "$TOOLS_DIR" rev-parse HEAD > "$MARKER" 2>/dev/null || true
          echo "[octools-sync] shared toolkit refreshed ${installed:0:7} -> ${remote:0:7} (live, no restart needed)."
        fi
      fi
    fi
    ;;
esac

# --- Gateway lane self-heal: reconnect the MCP gateway on this session's ring lane if it dropped or the
# token is aging, so a LONG-LIVED session regains brain_search/web_search WITHOUT a restart. Uses the
# SANCTIONED one-shot session-connect (--if-lane; resolves the lane from the repo .kb-agent, never guesses
# a privileged lane). Reconnect when NOT currently registered, else at most every ~50 min (token life ~1h).
# `claude mcp list` each prompt is a cheap local read; the costly mint only runs when actually needed.
# Fail-open, never blocks a prompt. Opt-out: OCTOOLS_NO_GATEWAY_SYNC=1.
if [ -z "${OCTOOLS_NO_GATEWAY_SYNC:-}" ] && command -v claude >/dev/null 2>&1 \
   && { [ -n "${OTC_AWS_ACCESS_KEY_ID:-}" ] || [ -n "${AWS_ACCESS_KEY_ID:-}" ] \
        || [ -n "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] \
        || [ -n "${GCP_CLAUDE_DRIVER_SA_JSON:-}" ] || [ -f "${HOME}/.gcp_claude_driver_sa.json" ]; }; then
  # Gate widened 2026-08-27: current seats bootstrap with OTC_AWS_*/task-role credentials only (GCP
  # is retired), so the old GCP-SA-presence check silently disabled the mid-session gateway
  # self-heal on every modern seat. The legacy GCP check is kept last for any straggler.
  GW_STAMP="${HOME}/.claude/.gateway-connect-last"
  GW_THROTTLE="${OCTOOLS_GATEWAY_THROTTLE:-3000}"
  gw_now="$(date +%s 2>/dev/null || echo 0)"
  gw_last="$(cat "$GW_STAMP" 2>/dev/null || echo 0)"
  gw_reg=0
  claude mcp list 2>/dev/null | grep -qiE 'otchealth-gateway|mcp\.otchealth\.app' && gw_reg=1
  # HEADERS-HELPER (2026-09-03): registration now sets a dynamic `headersHelper` (see connect.mjs /
  # headers-helper.mjs) whenever GATEWAY_CONNECT_HEADERS_HELPER != "0" -- the default. Once that is
  # active, Claude Code itself re-invokes the helper at session start and on reconnect/401, so THE
  # HELPER OWNS REFRESH and this hook's ~50-minute timed re-mint (and its remove+add reconnect churn)
  # is no longer needed for a trusted interactive session. It is NOT dropped entirely, though: per
  # SKILL.md the helper only runs once the workspace trust dialog is accepted and never in a
  # non-interactive `claude -p` run, and in those clients the static header registered at session
  # start is all there is -- so a LONG throttle (default 20h, inside the gateway's 24h token TTL)
  # keeps a belt-and-suspenders re-mint for them instead of letting that header silently expire.
  # The "not registered at all" repair stays live either way -- a dropped/never-added server entry
  # is a different failure than a stale token, and no headersHelper can fix a server that does not
  # exist. GATEWAY_CONNECT_HEADERS_HELPER=0 restores the exact prior behavior (the short throttle).
  gw_due=0
  if [ "${GATEWAY_CONNECT_HEADERS_HELPER:-}" = "0" ]; then
    if [ "$gw_reg" -eq 0 ] || [ "$gw_now" -le 0 ] || [ $((gw_now - gw_last)) -ge "$GW_THROTTLE" ]; then gw_due=1; fi
  else
    GW_THROTTLE_HELPER="${OCTOOLS_GATEWAY_THROTTLE_HELPER:-72000}"
    if [ "$gw_reg" -eq 0 ] || [ "$gw_now" -le 0 ] || [ $((gw_now - gw_last)) -ge "$GW_THROTTLE_HELPER" ]; then gw_due=1; fi
  fi
  if [ "$gw_due" -eq 1 ]; then
    echo "$gw_now" > "$GW_STAMP" 2>/dev/null || true
    [ -f "$TOOLS_DIR/skills/gateway-connect/session-connect.sh" ] \
      && timeout 45 bash "$TOOLS_DIR/skills/gateway-connect/session-connect.sh" 2>&1 | sed 's/^/[octools-sync] /' || true
  fi
fi

# --- Hookify plugin self-heal: same idempotent repair session-start.sh applies at boot (see there for
# the full explanation), re-run here so a session that was ALREADY RUNNING before that fix landed also
# self-heals, on its very next prompt, without needing to end and restart. session-start.sh's install/
# repair block only runs at a genuinely fresh session start, not on a resume of an existing one -- this
# is the exact "changed something, other agents/sessions aren't connected to it" gap the top of this
# file exists to close, just for a plugin-cache file instead of the toolkit checkout. Cheap (a couple
# [ -e ] tests), so no throttle needed; silent when already repaired or hookify isn't present at all.
_hookify_root="$HOME/.claude/plugins/cache/claude-code-plugins/hookify"
if [ -d "$_hookify_root" ] && [ ! -e "$_hookify_root/hookify" ]; then
  _hookify_ver="$(find "$_hookify_root" -maxdepth 1 -mindepth 1 -type d ! -name hookify 2>/dev/null | head -1)"
  if [ -n "$_hookify_ver" ] && [ -d "$_hookify_ver/core" ]; then
    ln -sfn "$_hookify_ver" "$_hookify_root/hookify" 2>/dev/null \
      && echo "[octools-sync] repaired hookify plugin import layout (was spamming every tool call in this already-running session)"
  fi
fi

# --- Fleet bulletin: surface what changed + why (any session; cheap local read). ---
node "$TOOLS_DIR/setup/bulletin.mjs" since 2>/dev/null || true

# --- Governed-skills audit: catch a shadow skill created MID-SESSION, not just at next session start. ---
# session-start.sh already runs the full --report once per session; this is the same cheap two-directory
# diff (microseconds, no network) re-run on every prompt via --if-changed, which stays SILENT unless the
# orphan set actually changed since the last check (mirrors the bulletin.mjs "since" idea above). Catches
# an agent authoring a doctrine-y "helpful" skill straight into ~/.claude/skills outside git review,
# without waiting for the next session to notice. Report-only (never prunes); fail-open.
[ -f "$TOOLS_DIR/setup/governed-skills-audit.mjs" ] && node "$TOOLS_DIR/setup/governed-skills-audit.mjs" --report --if-changed 2>/dev/null || true
exit 0
