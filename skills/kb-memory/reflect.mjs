#!/usr/bin/env node
// kb-memory reflect — the SELF-IMPROVING loop. At the end of a significant session, extract the
// durable, reusable lessons (pitfalls / decisions / facts) and write them to memory, deduped
// against what is already recorded. The safety net so the fleet keeps learning even when an agent
// forgets to write memory by hand. Stop-hook-friendly: significance-gated, dry-run by default;
// --commit writes via mem.mjs (which keeps the ring + sharing correct).
//
// EXIT CODE CONTRACT (revised 2026-08-28, see the FAIL LOUD note in main() below): every SKIP
// condition (no agent, no transcript, session below --min-tools) still exits 0, and a mem.mjs
// COMMIT-write failure still resolves to 0 at the end of a run (that failure has its own durable
// local-fallback safety net, see appendFailedWriteFallback below) -- kb-inject.sh's Stop-hook
// invocations absorb any exit code either way (`|| true`), so this was never required for hook
// safety. What changed: when the LLM STEP ITSELF fails (missing/invalid credentials, an
// unreachable provider, a malformed response), this script now exits NON-ZERO with a distinct
// "LLM call FAILED" stderr message, so that failure is never indistinguishable from the
// legitimate "the model ran and found nothing" outcome (see FND-20260819-c9bb: this exact
// silent-success shape let the fleet's memory loop run for days after Azure Foundry died on
// 2026-08-13, always reporting "no new durable lessons").
//
// LLM_PROVIDER=openai (default, 2026-08-28 port) | foundry|azure (opt-in, the original path).
// Azure Foundry (this file's sole LLM step until now) returns HTTP 401 forever since Azure
// subscription 55c84f6b was permanently deleted (2026-08-13) -- see FND-20260819-c9bb and this
// file's already-ported sibling, memory-librarian.mjs, whose LLM_PROVIDER default + openai-api-key
// secret name + api.openai.com call shape this port mirrors. LLM_PROVIDER=foundry/azure keeps the
// original Foundry-then-legacy-Azure path selectable, one env var away, if that estate is ever
// re-provisioned; it is not deleted, only demoted from default.
//
// Usage (Stop hook passes {transcript_path} JSON on stdin):
//   echo '{"transcript_path":"x.jsonl"}' | KB_AGENT=cto node reflect.mjs [--commit] [--min-tools 12]
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "./azure-secret.mjs";
import { chatBody, resolveTier, LEGACY_STANDARD } from "../../setup/model-routing.mjs";
import { logPrefixForText } from "../../setup/prompt-shape.mjs";
import { FAILED_WRITE_FILE, appendFailedWriteFallback } from "./local-fallback.mjs";
import { recordOpenAIUsage } from "../../setup/openai-usage.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
// Durable local fallback for a lesson that failed to persist to the real ledger (2026-08-18).
// MOVED to local-fallback.mjs (same day, the agent-seat credential bootstrap fix) so mem.mjs's own
// DIRECT CLI writes get the identical safety net, not just content that happens to route through this
// file's LLM-distillation loop. Re-exported here UNCHANGED so this file stays the stable import site
// existing callers/tests already use (`from "../reflect.mjs"`) -- nothing downstream needs to change.
export { FAILED_WRITE_FILE, appendFailedWriteFallback };
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COMMIT = argv.includes("--commit");
const MIN_TOOLS = parseInt(val("--min-tools", "12"), 10) || 12;
const AGENT = (process.env.KB_AGENT || val("--agent", "") || "").toLowerCase();
// PreCompact (the highest-stakes distill) passes --prefer-fallback. HISTORICAL meaning: use the
// uncontended foundry deployment as PRIMARY so the capture never blocks on the contended shared
// gpt-4o LEGACY deployment. As of 2026-08-01 this file's default PRIMARY already IS the foundry
// resource, so that original intent was already satisfied unconditionally under LLM_PROVIDER=foundry.
// Under the 2026-08-28 OpenAI default (see askOpenAI() below) it is a genuine no-op for a different
// reason: OpenAI-direct has no analogous "contended shared legacy deployment" to avoid, so there is
// nothing for this flag to prefer. Kept parsed for backward compat with existing callers (kb-inject.sh
// still passes it) and still meaningful again the moment LLM_PROVIDER=foundry is selected.
// intentional cheap-capture, non-summarization: this extracts 0-3 short durable-lesson candidates
// from a session (a cheap, bounded-output classification task), NOT decision-grade quality synthesis.
// Under LLM_PROVIDER=foundry it primaries on Foundry TIERS.standard (gpt-4.1) -- NOT
// TIERS.cheap/gpt-4.1-mini as primary, see initModel() -- with the legacy azure-openai resource as a
// last-resort fallback only (the ban targets quality summarization work, e.g. company-brain /
// focus-group-loop / agent-evals, not this task).
const PREFER_FB = argv.includes("--prefer-fallback") || !!process.env.REFLECT_PREFER_FALLBACK;
export const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();

function loadSA() { if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) { try { return JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); } catch {} } for (const p of [process.env.HOME + "/.gcp_claude_driver_sa.json", "/root/.gcp_claude_driver_sa.json"]) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} } return null; }
const _SA = loadSA(); // env var OR the file, so reflect does not silently no-op on a fresh shell
function saJwt(scope) { const sa = _SA; if (!sa || !sa.private_key) return null; const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv; const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
let EP, KEY, DEP, FB_EP, FB_KEY, FB_DEP;   // Foundry-only (LLM_PROVIDER=foundry/azure)
let OAI_KEY, OAI_DEP, OAI_FB_DEP;          // OpenAI-only (LLM_PROVIDER=openai, the default)
async function _initModel() {
  if (LLM_PROVIDER === "openai") {
    // OpenAI direct (2026-08-28 port; model resolution fixed 2026-08-29): same secret name
    // memory-librarian.mjs already uses (openai-api-key, via kvSecret -> AWS SSM by default), same
    // api.openai.com endpoint. REFLECT_MODEL/REFLECT_FALLBACK_MODEL now resolve through
    // setup/model-routing.mjs's OPENAI_TIERS (standard = mid tier, quality = top tier) instead of the
    // hardcoded literals 'gpt-4.1'/'gpt-4o' this file shipped with on 2026-08-28 -- those were a
    // point-in-time snapshot of what OPENAI_TIERS.standard/.quality happened to be THEN, not a link to
    // the tier itself, so this file would have stayed frozen on stale model names through every future
    // OPENAI_TIERS refresh (see the 2026-08-29 model-routing.mjs header note) had it not been fixed.
    // 'standard' (mid), never 'cheap': reflect is quality-critical lesson-extraction work (see this
    // file's own header, "the ban targets quality summarization work ... not this task" -- read
    // narrowly as "not banned from mid", not as "belongs on cheap"), never downgraded below mid/top.
    OAI_KEY = process.env.OPENAI_API_KEY || (await kvSecret("openai-api-key"));
    OAI_DEP = resolveTier(process.env.REFLECT_MODEL || "standard", "openai").deployment;
    OAI_FB_DEP = resolveTier(process.env.REFLECT_FALLBACK_MODEL || "quality", "openai").deployment;
    return;
  }
  // LLM_PROVIDER=foundry/azure: the ORIGINAL path, kept intact (not deleted) for a future
  // re-provisioned Azure estate. PRIMARY resolves to the FOUNDRY resource (2,000K TPM
  // GlobalStandard, ample headroom). FALLBACK resolves to the LEGACY azure-openai resource (its
  // gpt-4o deployment is capped at 50K TPM on the regional "Standard" SKU, already 100% subscribed
  // with zero headroom -- the confirmed root cause of the recurring "Azure OpenAI throttled
  // (blocked_calls)" Datadog page, 2026-08-01). See setup/model-routing.mjs LEGACY_STANDARD. Never
  // swap these back so the legacy resource is primary. NOTE: as of 2026-08-13 this whole estate is
  // permanently gone (Foundry returns HTTP 401) -- this branch only runs when explicitly selected.
  // Resolved via resolveTier()/LEGACY_STANDARD (2026-08-29 fix, value-identical to the prior hardcoded
  // 'gpt-4.1'/'gpt-4o' literals -- TIERS is untouched by the OpenAI-side refresh, so this is a pure
  // no-op behavior change that just stops duplicating the tier table's own values here).
  EP = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); KEY = await sm("azure-foundry-key"); DEP = resolveTier(process.env.REFLECT_MODEL || "standard", "azure").deployment;
  // Last-resort fallback only (see note above): the legacy resource.
  FB_EP = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); FB_KEY = await sm("azure-openai-key"); FB_DEP = process.env.REFLECT_FALLBACK_MODEL || LEGACY_STANDARD.deployment;
}
async function callChat(ep, key, dep, system, user, maxTokens, tries) {
  // chatBody() picks the family-correct request shape (2026-08-29 fix): the prior hardcoded
  // {max_tokens, temperature} literal here only "worked" because gpt-4.1/gpt-4o were both chat-family;
  // it would 400 the instant DEP resolved to a reasoning-family model (which OPENAI_TIERS.standard/
  // .quality now are, per the 2026-08-29 gpt-5.6 refresh -- see model-routing.mjs's header).
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, temperature: 0.3 });
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status); return (await r.json()).choices[0].message.content;
  }
  throw Object.assign(new Error("429"), { throttled: true });
}
async function askFoundry(system, user, maxTokens = 700) {
  const primary = () => callChat(EP, KEY, DEP, system, user, maxTokens, 4);
  const hasFB = FB_EP && FB_KEY;
  const fallback = () => hasFB ? callChat(FB_EP, FB_KEY, FB_DEP, system, user, maxTokens, 5) : Promise.reject(Object.assign(new Error("no fallback"), { throttled: true }));
  // --prefer-fallback (PreCompact) HISTORICALLY meant "try the uncontended foundry deployment FIRST,
  // gpt-4o (legacy, contended) only as backup" -- back when `primary` WAS the legacy resource. As of
  // the 2026-08-01 migration, `primary` already IS foundry by default (see initModel()), so that
  // original intent is now satisfied unconditionally. This branch is therefore an intentional NO-OP
  // (identical to the default branch below): it must NOT be reinterpreted as "call `fallback` first",
  // since `fallback` is now the legacy/contended resource and doing so would reintroduce exactly the
  // throttle contention this fix removes on the PreCompact hot path.
  if (PREFER_FB && hasFB) { try { return await primary(); } catch { return await fallback(); } }
  // default: primary (foundry), fall back to the legacy deployment (separate quota, last resort) on
  // sustained throttle.
  try { return await primary(); }
  catch (e) { if (e.throttled && hasFB) return await fallback(); throw e; }
}

// OpenAI-direct call (2026-08-28 port), same request/response shape as callChat() above (a chat
// completions POST, 429-retry with backoff) but api.openai.com's own auth (bearer token, not an
// api-key header) and URL (no per-deployment path segment -- the model name goes in the body).
// Mirrors memory-librarian.mjs's openaiChat() exactly for this same reason: this is the SAME
// provider, called the SAME way, from a sibling file in the SAME 2026-08-27/28 porting effort.
async function callChatOpenAI(key, dep, system, user, maxTokens, tries) {
  // Same chatBody() family-aware shaping as callChat() above (2026-08-29 fix) -- required now that
  // OAI_DEP/OAI_FB_DEP resolve through OPENAI_TIERS, which moved 'standard'/'cheap' to reasoning-family
  // (see model-routing.mjs's header). model-routing.mjs is provider-agnostic, so the same helper works
  // for both the Foundry URL-based call above and this OpenAI body-based one. Named `reqBody` (not
  // `body`) to avoid shadowing the `const body = await r.text()...` a few lines below in the error path.
  const reqBody = { ...chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, temperature: 0.3 }), model: dep };
  for (let a = 0; a < tries; a++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1))); continue; }
    if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error("chat " + r.status + (body ? " " + body.slice(0, 160) : "")); }
    const j = await r.json();
    recordOpenAIUsage({
      model: dep,
      kind: "chat",
      promptTokens: j.usage?.prompt_tokens || 0,
      completionTokens: j.usage?.completion_tokens || 0,
      cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens || 0,
      caller: "kb-memory-reflect",
    });
    return j.choices?.[0]?.message?.content || "";
  }
  throw Object.assign(new Error("429 exhausted"), { throttled: true });
}

// The default (real) model call on OpenAI-direct: primary REFLECT_MODEL (gpt-4.1), falling back to
// REFLECT_FALLBACK_MODEL (gpt-4o) on a sustained throttle only -- same shape as askFoundry() above,
// resolved against the OpenAI key/models set in initModel(). Throws (never silently returns empty)
// on a missing key or an exhausted/failed call, so main()'s FAIL LOUD handling (see below) always
// sees a real error to report instead of a swallowed one.
async function askOpenAI(system, user, maxTokens = 700) {
  if (!OAI_KEY) throw new Error("missing openai-api-key (set OPENAI_API_KEY or the fleet secret)");
  try {
    return await callChatOpenAI(OAI_KEY, OAI_DEP, system, user, maxTokens, 4);
  } catch (e) {
    if (e.throttled && OAI_FB_DEP && OAI_FB_DEP !== OAI_DEP) {
      return await callChatOpenAI(OAI_KEY, OAI_FB_DEP, system, user, maxTokens, 5);
    }
    throw e;
  }
}

// Provider dispatch. Default LLM_PROVIDER=openai (see the file-header note); LLM_PROVIDER=foundry/
// azure selects the original Foundry-then-legacy path above, kept intact for a re-provisioned estate.
// initModel/ask exported (2026-08-29) so the model-resolution + request-shape fix above is directly
// regression-tested (mocking global.fetch), the same pattern skills/shark-tank/shark-round.mjs and the
// signal-radar detectors already use for their own OpenAI-port tests.
export async function initModel() { return _initModel(); }
export async function ask(system, user, maxTokens = 700) {
  return LLM_PROVIDER === "openai" ? askOpenAI(system, user, maxTokens) : askFoundry(system, user, maxTokens);
}

// DETERMINISTIC safety net: when the LLM is fully unavailable (sustained 429 / error), do not lose the
// session's key facts. Pull the highest-signal verbatim statements from the condensed body so they land
// in the recall-able ledger immediately (the journal also has the raw turns; this is the recall layer).
function extractDurable(body) {
  const SIG = /\b(merged to main|SHIPPED|stored .{0,40}Secret Manager|CORRECTION|CFBundleVersion \d+|build \d+\b|bundle id|App Store Connect|DONE:|DECISION|decided to|the (?:current |correct |right )?value is)\b/i;
  const out = [], seen = new Set();
  for (const ln of body.split("\n")) {
    if (!ln.startsWith("ASSISTANT:")) continue;
    for (const sent of ln.replace(/^ASSISTANT:\s*/, "").split(/(?<=[.!?])\s+/)) {
      const s = sent.trim();
      if (s.length >= 30 && s.length <= 280 && SIG.test(s)) {
        const k = s.slice(0, 64).toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(s); }
        break;
      }
    }
    if (out.length >= 3) break;
  }
  return out;
}

// condense the transcript to the SIGNAL: user asks + assistant conclusions, tool noise dropped, capped
function condense(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let tools = 0; const turns = [];
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const m = o.message || o;
    if (o.type === "user" || m?.role === "user") { const c = m?.content; const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join(" ") : ""; if (t && !t.includes("tool_result")) turns.push("USER: " + t.slice(0, 400)); }
    else if (o.type === "assistant" || m?.role === "assistant") { const c = m?.content; if (Array.isArray(c)) { for (const x of c) { if (x.type === "tool_use") tools++; if (x.type === "text" && x.text && x.text.trim().length > 40) turns.push("ASSISTANT: " + x.text.slice(0, 600)); } } }
  }
  // keep the last ~50 signal turns, capped ~16k chars
  let body = turns.slice(-50).join("\n"); if (body.length > 16000) body = body.slice(-16000);
  return { tools, body };
}
function recentMemory() { try { return execFileSync("node", [join(HERE, "mem.mjs"), "tail", "--agent", AGENT, "--n", "30"], { encoding: "utf8" }).slice(0, 6000); } catch { return ""; } }

// Exported (2026-08-28, FAIL LOUD port) so this file's LLM-distillation step is unit-testable
// without any network call or real credential: pass a fake `chatFn` (matching nightly-reflection.mjs's
// `distillAgent()` convention in this same skill) and this never touches fetch/kvSecret/env.
// `modelConfigured`/`provider` are passed in explicitly rather than read from module state so a test
// never has to fight module-level `await initModel()` side effects.
//
// Returns { items, llmError }:
//   - llmError === null, items === []       -> the model ran and GENUINELY found nothing. This is
//     the ONLY combination main() reports as "reflect: no new durable lessons." (exit 0).
//   - llmError === null, items.length > 0    -> the model ran and found real lessons.
//   - llmError instanceof Error (items may be [] or the deterministic-fallback salvage below)
//                                             -> the LLM STEP ITSELF failed: missing/invalid
//     credentials, an unreachable provider, or a response that was not parsable JSON / not an
//     array. NEVER collapsed into the legitimate-empty shape above -- main() reports this
//     distinctly and exits non-zero (see the FAIL LOUD note there). extractDurable() still runs as
//     a best-effort salvage belt (a dead LLM should not also cost the session's most explicit
//     verbatim facts), but salvaging 0 or more items never changes the fact that this run reports
//     FAILURE -- that is the entire point of this function returning llmError separately from items
//     instead of folding a failure into "items happened to come out empty".
export async function distill({ agent, toolCount = 0, body = "", known = "", chatFn = ask, modelConfigured = true, provider = LLM_PROVIDER } = {}) {
  const sys = `You are the memory-reflection step for agent "${agent}". From the session below, extract ONLY genuinely DURABLE, REUSABLE lessons that are NOT already in the agent's recent memory. Prefer: pitfalls (a wrong belief or trap + the fix), decisions (a standing choice + why), or facts (a stable identifier/config). Be strict: 0-3 items, each one sentence, specific and self-contained. If nothing new and durable, return []. Mark share=true ONLY if it is non-sensitive and useful cross-team (no MNPI/PHI/privileged). Return ONLY a JSON array: [{"type":"pitfall|decision|remember","text":"..","share":bool}].`;
  const user = `AGENT RECENT MEMORY (do NOT duplicate these):\n${known}\n\n===== SESSION SIGNAL (${toolCount} tool calls) =====\n${body}`;
  // Prompt-caching hygiene (2026-09-02): `sys` is static PER AGENT (varies only by the fixed agent
  // name for repeated calls from the SAME agent, never per-session); `known`+`body` in `user` are
  // both genuinely per-session variable, with `known` (recent memory, comparatively more stable
  // across nearby calls) already placed before `body` (the highly volatile transcript) -- already
  // the cache-friendly order (most-stable-first among the variable parts, fully-static system
  // message first overall). Observability only, not a reorder.
  logPrefixForText(`kb-memory-reflect:${agent}`, sys);

  let items = [];
  let llmError = null;
  if (!modelConfigured) {
    llmError = new Error(provider === "openai" ? "missing openai-api-key (set OPENAI_API_KEY or the fleet secret)" : "missing azure-foundry-openai-endpoint/-key");
  } else {
    try {
      const raw = await chatFn(sys, user);
      const match = raw && raw.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("model response contained no JSON array" + (raw ? ` (got: ${String(raw).slice(0, 160)})` : ""));
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) throw new Error("model response JSON was not an array");
      items = parsed;
    } catch (e) {
      llmError = e;
    }
  }

  if (llmError) {
    // Deterministic best-effort salvage (kept as a belt, not a substitute -- see the header note
    // above): pull the highest-signal verbatim assistant statements straight out of the transcript.
    const verbatim = extractDurable(body);
    items = verbatim.map((t) => ({ type: "remember", text: t, share: false, _fallback: true }));
  }
  items = (Array.isArray(items) ? items : []).filter((x) => x && x.text && /^(pitfall|decision|remember)$/.test(x.type)).slice(0, 3);
  return { items, llmError };
}

async function main() {
  if (!AGENT) { console.error("no KB_AGENT; skipping reflect"); process.exit(0); }
  // FIX 2026-07-05 (FAILLOUD-ADOPT): same vestigial GCP-only gate found in kb-journal.mjs — fired
  // unconditionally once GCP retired, silently disabling the memory distiller fleet-wide. Removed;
  // sm() below is Azure-first and already fails loud with a named message if truly unavailable.
  let stdin = {}; try { stdin = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const path = val("--transcript", "") || stdin.transcript_path;
  if (!path) { console.error("no transcript_path; skipping"); process.exit(0); }
  let c; try { c = condense(path); } catch (e) { console.error("condense: " + e.message); process.exit(0); }
  if (c.tools < MIN_TOOLS) { console.error(`session not significant (${c.tools} tools < ${MIN_TOOLS}); skipping reflect`); process.exit(0); }
  await initModel();
  const modelConfigured = LLM_PROVIDER === "openai" ? Boolean(OAI_KEY) : Boolean(EP && KEY);
  const known = recentMemory();
  const { items: rawItems, llmError } = await distill({ agent: AGENT, toolCount: c.tools, body: c.body, known, modelConfigured });
  let items = rawItems;

  // FAIL LOUD (2026-08-28 port off dead Azure Foundry, FND-20260819-c9bb). A dead/misconfigured LLM
  // must NEVER look like "ran and found no lessons" -- that exact silent-success shape is what let
  // this file's memory loop run for days after Foundry returned HTTP 401, always printing "no new
  // durable lessons" (see the top-of-file EXIT CODE CONTRACT note). This distinguishes the two
  // outcomes the same way the same day's critic-pass port distinguishes "unreachable" from
  // "malformed": a failure announces itself, it does not collapse into the legitimate-empty shape.
  if (llmError) {
    console.error(`reflect: LLM call FAILED (provider=${LLM_PROVIDER}): ${llmError.message} — NOT the same as 'no lessons'.`);
    console.error(items.length
      ? `reflect: deterministic fallback salvaged ${items.length} fact(s) from the raw transcript (best-effort only; NOT a substitute for the real LLM reflection that failed above).`
      : "reflect: deterministic fallback found nothing either; zero lessons were extracted this session because the LLM call failed.");
  }
  if (!items.length) {
    if (!llmError) console.log("reflect: no new durable lessons.");
    process.exit(llmError ? 1 : 0);
  }
  console.log(`reflect: ${items.length} candidate lesson(s)${COMMIT ? " (committing)" : " (dry-run; pass --commit to write)"}:`);
  // FAIL-LOUD + DURABLE FALLBACK (2026-08-18). A per-item mem.mjs COMMIT failure below must never
  // silently abort this loop or change items/llmError above (a Stop hook must never block a session
  // over a best-effort memory distill) -- but the OLD code used to also discard the evidence of that
  // narrower failure: `stdio: "ignore"` threw away mem.mjs's own stderr (the actual "ERROR: put
  // 403 ..." detail), the catch block logged one generic "write failed" line, and on the "stop" hook
  // path THAT line is itself piped to /dev/null by kb-inject.sh's invocations of this same script
  // (see kb-inject.sh's three call sites) -- so a session could exit clean while every one of its
  // distilled lessons silently vanished, with no trace anywhere. A failure reported as a plausible
  // success is worse than an ugly one, because nobody goes looking for it.
  let failures = 0;
  for (const it of items) {
    console.log(`  [${it.type}${it.share ? ",share" : ""}] ${it.text}`);
    if (COMMIT) {
      try {
        const a = [join(HERE, "mem.mjs"), it.type, it.text, "--agent", AGENT, "--tags", it._fallback ? "auto-extract-fallback" : "auto-reflect"];
        if (it.share) a.push("--share");
        // Capture stderr (was `stdio: "ignore"`, which threw the real diagnostic away) so a genuine
        // failure names its actual cause instead of a bare "Command failed" message.
        execFileSync("node", a, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        failures++;
        const detail = (e.stderr ? String(e.stderr) : e.message || String(e)).trim().slice(0, 500);
        console.error("=".repeat(78));
        console.error(`[reflect] LOST WRITE: a durable lesson for agent '${AGENT}' failed to persist and was NOT recorded.`);
        console.error(`  type=${it.type} text=${JSON.stringify(it.text).slice(0, 200)}`);
        console.error(`  cause: ${detail}`);
        console.error(`  saved to the local fallback below so this content is recoverable, not gone.`);
        console.error("=".repeat(78));
        appendFailedWriteFallback(AGENT, it, detail);
      }
    }
  }
  // ── CBP-1 (Checkpoint Bridge Protocol, 2026-07-05): after the existing per-item commit loop
  // above, ALSO sync the distilled item texts + a checkpoint marker into _STATE/<agent>.json via
  // mem.mjs state-sync, so cold-resume-test.mjs / any fresh instance can see what was just learned
  // without replaying the whole ledger. The catch preserves the reflection diagnostics, but an
  // unconfirmed state checkpoint makes this run exit non-zero so callers cannot report completion.
  let stateSyncFailed = false;
  if (COMMIT && items.length) {
    try {
      const factsJson = JSON.stringify(items.map((it) => it.text));
      const syncSource = process.env.KB_SYNC_SOURCE || "stop";
      const sessionId = process.env.KB_SESSION_ID || "";
      execFileSync("node", [join(HERE, "mem.mjs"), "state-sync", "--agent", AGENT, "--facts", factsJson, "--source", syncSource, "--session-id", sessionId], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      stateSyncFailed = true;
      console.error("  state-sync failed: durable state checkpoint was not confirmed, so this run will exit non-zero. " + String(e.stderr || e.message || e).trim().slice(0, 300));
    }
  }
  // A plain container-log summary line: even where stdout/stderr both end up redirected to
  // /dev/null by a caller (kb-inject.sh's three invocations of this script do exactly that), a
  // human or a future audit grepping raw logs for "LOST WRITE" or this summary still finds the
  // fallback file's path named right here, once, unconditionally.
  if (COMMIT) console.log(`reflect: ${items.length - failures}/${items.length} lesson(s) committed${failures ? `, ${failures} LOST (recovered to ${FAILED_WRITE_FILE(AGENT)})` : ""}.`);
  // FAIL LOUD tail: an LLM failure or an unconfirmed state checkpoint decides the exit code. A
  // per-item lesson write failure is retained in its local fallback and does not itself change a
  // successful LLM result. A successful salvage commit also never converts an LLM failure to success.
  process.exit(llmError || stateSyncFailed ? 1 : 0);
}
// GUARDED (2026-08-18): only run the CLI flow (which calls process.exit()) when this file is the
// entry point, not merely imported. Previously main() ran unconditionally at module load, so even
// `import { appendFailedWriteFallback } from "./reflect.mjs"` for a unit test would read real stdin
// and terminate the importing process via process.exit(0) as a side effect of the import itself —
// invisible in a normal `node reflect.mjs` invocation (it IS the entry point there) but a landmine
// for any future test or tool that imports this file, exactly the gap that made this file untestable
// before today. Matches nightly-reflection.mjs's existing isMain guard, this file's own closest sibling.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => { console.error("reflect ERROR: " + e.message); process.exit(0); });
}
